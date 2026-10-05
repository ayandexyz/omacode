// =============================================================================
// Codemode Tool — the model writes a JavaScript script that calls other tools
// in a QuickJS sandbox; only what the script outputs reaches the transcript
// (spec 2026-10-05-codemode.md, Phase 1).
//
// The sandbox has no capability of its own. Every `tools.<name>()` call goes
// through `ctx.callTool`, which the loop binds to its own executeTool — so
// permissions, hooks, mode enforcement and the unattended envelope apply to a
// nested call exactly as to a direct one. Without `ctx.callTool` (codemode
// disabled, or a caller that is not the loop) the tool refuses to run.
// =============================================================================

import type { ToolContext } from "./types.js";
import type { Tool, ToolExecutionResult, JsonSchema } from "./tool.types.js";
import { buildTool } from "./factory.js";
import { getToolDefs, type ProviderToolDef } from "./defs-cache.js";
import { NOT_CALLABLE_FROM_CODEMODE } from "../codemode/settings.js";
import { discoveryGlobals } from "../codemode/discovery.js";
import {
  CodemodeSourceError,
  parseCodemodeSource,
  type CodemodeStoreWrites,
  type CodemodeTool as SandboxTool,
} from "@earendil-works/pi-codemode";
import { createCodemodeSandbox } from "../codemode/runtime.js";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  formatCodemodeResult,
} from "../codemode/format.js";

export { NOT_CALLABLE_FROM_CODEMODE };

/** pi's limit: a script's VM gets 256 MB. */
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

interface CodemodeParams {
  script: string;
}

const codemodeSchema: JsonSchema = {
  type: "object",
  properties: {
    script: {
      type: "string",
      description:
        "JavaScript source: the body of an async function. Not JSON, not a markdown fence.",
    },
  },
  required: ["script"],
};

const DESCRIPTION = `Run a JavaScript script that calls your other tools, and get back only what the script outputs. Use it to fan out many calls in parallel (Promise.all), or to filter a large result (grep, bash, MCP) down to what you need, instead of one tool call per turn.

The script is the body of an async function: top-level await and return work. It runs in a sandbox with no Node APIs, file system, network or timers; it reaches the outside world only through tools.

- tools.<name>(args): call a documented callable tool with the same arguments. Names with characters invalid in identifiers use _ (mcp__my-server__x is tools.mcp__my_server__x). Most calls resolve to the full output string; declarations name structured exceptions (bash returns output and exit_code, glob returns string[], MCP returns CallToolResult). Calls reject with an Error on execution failure or denial. Use Promise.allSettled to keep partial results. Not callable: ${[...NOT_CALLABLE_FROM_CODEMODE].filter((t) => t !== "finish_iteration").join(", ")}.
- text(value), console.log(...): add to the output. return value adds it too. exit() ends the script. Do not redeclare tools, text, store, load or ALL_TOOLS.
- ALL_TOOLS: [{ name, description }] for every callable tool, including MCP tools. searchTools(query, { limit? }) ranks them; describeTool(name) returns one's TypeScript declaration.
- store(key, value) / load(key): keep small JSON values (ids, cursors, summaries) for later codemode calls in this session; storing undefined deletes. Kept only if the script succeeds.

Every call goes through the same permission checks as a direct call. Calls made before a failure are not undone. Optional first line: // @options: {"max_output_tokens": ${DEFAULT_MAX_OUTPUT_TOKENS}, "timeout_ms": 60000}`;

function validateCodemodeInput(
  params: unknown,
): { valid: true } | { valid: false; error: string } {
  if (!params || typeof params !== "object") {
    return { valid: false, error: "Expected object parameters" };
  }
  const p = params as Record<string, unknown>;
  if (typeof p.script !== "string" || p.script.trim().length === 0) {
    return {
      valid: false,
      error: "script is required and must be a non-empty string",
    };
  }
  return { valid: true };
}

/** What the mode offers the model, minus the excluded. */
function callableDefs(ctx: ToolContext): ProviderToolDef[] {
  return [
    ...(ctx.codemodeTools ?? getToolDefs(ctx.agentMode ?? "build")),
  ].filter((d) => !NOT_CALLABLE_FROM_CODEMODE.has(d.name));
}

/** The tools a script sees. */
function sandboxTools(
  ctx: ToolContext,
  defs: ProviderToolDef[],
): SandboxTool[] {
  const callTool = ctx.callTool!;
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.parameters,
    outputSchema: d.result ?? { type: "string" },
    // pi aborts `signal` when the script ends (unawaited calls included),
    // times out, or is aborted: a nested call still running is cancelled.
    execute: async (args: unknown, { signal }) => {
      const result = await callTool(
        d.name,
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {},
        signal,
      );
      if (result.error !== undefined) throw new Error(result.error);
      return result.value;
    },
  }));
}

async function executeCodemode(
  params: CodemodeParams,
  ctx: ToolContext,
): Promise<
  ToolExecutionResult<{
    title: string;
    output: string;
    metadata?: Record<string, unknown>;
  }>
> {
  if (!ctx.callTool) {
    return {
      success: false,
      error:
        "codemode is not enabled in this session. Call the tools directly. (Enable with codemode.enabled in .freecode/settings.json or FREECODE_CODEMODE=1.)",
    };
  }

  let parsed;
  try {
    parsed = parseCodemodeSource(params.script);
  } catch (err) {
    const message =
      err instanceof CodemodeSourceError ? err.message : String(err);
    return { success: false, error: `Invalid script: ${message}` };
  }

  const defs = callableDefs(ctx);
  const sandbox = createCodemodeSandbox({
    tools: sandboxTools(ctx, defs),
    globals: discoveryGlobals(defs),
    // No default deadline: a nested call may sit on a permission prompt. The
    // loop's abort (Esc / stop) still ends the script.
    timeoutMs: parsed.options.timeoutMs ?? Infinity,
    memoryLimitBytes: MEMORY_LIMIT_BYTES,
  });
  const started = Date.now();
  try {
    const stored = ctx.codemodeStore ?? {};
    const result = await sandbox.execute(parsed.code, {
      signal: ctx.abort,
      store: stored,
    });
    const text = formatCodemodeResult(
      result,
      Date.now() - started,
      parsed.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    );
    const metadata = {
      ok: result.ok,
      calls: result.calls.length,
      failedCalls: result.calls.filter((c) => c.status !== "ok").length,
      scriptChars: params.script.length,
      ...(result.ok ? {} : { errorKind: result.error.kind }),
      // The whole map, only when this script changed it: the loop persists it
      // on the tool message (session/store.ts `codemodeStore`).
      ...(result.ok && storeChanged(result.storeWrites)
        ? { codemodeStore: applyStoreWrites(stored, result.storeWrites) }
        : {}),
    };
    // A failed script still carries its partial output; the error text is the
    // whole formatted result so the model sees both.
    if (!result.ok) return { success: false, error: text };
    return {
      success: true,
      result: { title: "codemode", output: text, metadata },
    };
  } finally {
    await sandbox.close();
  }
}

function storeChanged(writes: CodemodeStoreWrites): boolean {
  return Object.keys(writes.set).length > 0 || writes.delete.length > 0;
}

export function applyStoreWrites(
  base: Readonly<Record<string, unknown>>,
  writes: CodemodeStoreWrites,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base, ...writes.set };
  for (const key of writes.delete) delete next[key];
  return next;
}

export const CodemodeTool: Tool<CodemodeParams> = buildTool({
  id: "codemode",
  description: DESCRIPTION,
  schemas: {
    parameters: codemodeSchema,
  },
  permissions: {
    // No capability of its own: each nested call is permission-checked.
    operations: [],
    requiresApproval: false,
  },
  behavior: {
    // A script may write, so it runs alone in its batch...
    isConcurrencySafe: false,
    // ...and is never retried by the orchestrator: a re-run would repeat
    // every side effect. The loop does not count it as a mutation itself —
    // the nested calls are counted one by one.
    isDestructive: true,
    interruptBehavior: "await",
    userFacingName: "Codemode",
  },
  execute: executeCodemode,
  validateInput: validateCodemodeInput,
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: false }),
});
