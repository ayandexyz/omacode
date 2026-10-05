// =============================================================================
// Tool Defs Cache — memoized provider-facing tool definitions (Phase 5)
// PRIMARY: Avoids rebuilding the { name, description, parameters } array on
//          every turn (it was computed twice per turn: prompt compile + send)
// INVALIDATION: Bus events `tools.changed` / `mcp.tools.changed` — the only
//          runtime sources of tool-set mutation (skills register through the
//          same registry and emit tools.changed).
// =============================================================================

import {
  renderToolSample,
  toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
import {
  NOT_CALLABLE_FROM_CODEMODE,
  type CodemodeMode,
} from "../codemode/settings.js";
import { listTools, getTool } from "./index.js";
import { bus } from "../bus/index.js";
import { isReadOnlyMode, modeEnforcement } from "../permission/mode-policy.js";
import type { AgentMode } from "../agent/types.js";

export interface ProviderToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Result a codemode script receives; never sent as a provider input schema. */
  result?: Record<string, unknown>;
}

let cachedAll: ProviderToolDef[] | null = null;
// A read-only mode's filtered view, keyed by mode — small (plan/review/explore
// only) and rebuilt from cachedAll, so invalidation only needs to clear both.
const cachedReadOnly = new Map<AgentMode, ProviderToolDef[]>();
let subscribed = false;

const MCP_CODEMODE_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    content: { type: "array", items: { type: "object" } },
    structuredContent: { type: "object" },
    isError: { type: "boolean" },
  },
  required: ["content"],
};

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  bus.subscribe("tools.changed", invalidateToolDefs);
  bus.subscribe("mcp.tools.changed", invalidateToolDefs);
}

/**
 * Offered only inside an unattended run (`freecode night`), so it is filtered
 * out of the shared list and added back by `unattendedToolDefs`. An attended
 * session must never see a tool whose whole job is to end an iteration.
 */
export const UNATTENDED_ONLY_TOOLS = new Set(["finish_iteration"]);

/**
 * Off by default (spec 2026-10-05-codemode.md §4.9), so kept out of the shared
 * list and added back by `withCodemode` for a loop that has it enabled. A
 * session that never turns it on sends the same tool list as before.
 */
export const CODEMODE_TOOL = "codemode";

function buildAll(): ProviderToolDef[] {
  return listTools()
    .filter((t) => !UNATTENDED_ONLY_TOOLS.has(t.id) && t.id !== CODEMODE_TOOL)
    .map((t) => {
      const toolDef = getTool(t.id);
      return {
        name: t.id,
        description: t.description,
        parameters: (toolDef?.schemas.parameters ?? {
          type: "object",
          properties: {},
        }) as unknown as Record<string, unknown>,
        result: (toolDef?.schemas.result ??
          (t.id.startsWith("mcp__")
            ? MCP_CODEMODE_RESULT_SCHEMA
            : undefined)) as Record<string, unknown> | undefined,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Provider-facing tool list, pruned to the tools a read-only mode
 * (plan/review/explore) could actually run — otherwise the model routinely
 * calls `write`/`edit`/`bash`, learns only from the hard-deny at execution
 * time, and burns a full round trip finding out (fixed docs-audit gap, TODO.md).
 */
export function getToolDefs(mode?: AgentMode): ProviderToolDef[] {
  ensureSubscribed();
  if (!cachedAll) cachedAll = buildAll();
  if (!mode || !isReadOnlyMode(mode)) return cachedAll;

  let filtered = cachedReadOnly.get(mode);
  if (!filtered) {
    // modeEnforcement, not raw toolKind: review mode carves out `bash` for
    // rule-allowed read-only commands, and that carve-out must stay in sync
    // with permission/mode-policy.ts rather than be re-derived here.
    filtered = cachedAll.filter(
      (t) => modeEnforcement(mode, t.name) === undefined,
    );
    cachedReadOnly.set(mode, filtered);
  }
  return filtered;
}

/**
 * The unattended tool list: everything the mode allows, plus the tools only an
 * unattended run may call. Not cached — one build per iteration, not per turn,
 * and an iteration is minutes long.
 */
export function unattendedToolDefs(mode?: AgentMode): ProviderToolDef[] {
  return [...getToolDefs(mode), ...[...UNATTENDED_ONLY_TOOLS].flatMap(defFor)];
}

/**
 * `defs` plus the `codemode` tool, with pi's `mode: "on"` presentation: every
 * tool a script can call says in one line how a script calls it, so the model
 * meets codemode at each tool it reaches for, not only in codemode's own
 * description (spec §4.12). Codemode is appended last.
 */
export function withCodemode(
  defs: ProviderToolDef[],
  mode: Exclude<CodemodeMode, "off"> = "on",
): ProviderToolDef[] {
  const callable = defs.filter((d) => !NOT_CALLABLE_FROM_CODEMODE.has(d.name));
  if (mode === "only") {
    const [codemode] = defFor(CODEMODE_TOOL);
    if (!codemode) return [];
    const declarations = callable.map((d) =>
      renderToolSample({
        name: d.name,
        description: d.description,
        inputSchema: d.parameters,
        outputSchema: d.result ?? { type: "string" },
      }),
    );
    return [
      {
        ...codemode,
        description: `${codemode.description}\n\nCallable tools in codemode-only mode:\n\n${declarations.join("\n\n")}`,
      },
    ];
  }
  const described = defs.map((d) =>
    NOT_CALLABLE_FROM_CODEMODE.has(d.name)
      ? d
      : {
          ...d,
          description: `${d.description.trim()}\n\nCodemode: \`tools.${toCodemodeIdentifier(d.name)}(args)\` resolves to ${codemodeResultSummary(d)}.`,
        },
  );
  return [...described, ...defFor(CODEMODE_TOOL)];
}

function codemodeResultSummary(def: ProviderToolDef): string {
  if (def.name === "bash") return "`{ output, exit_code, ... }`";
  if (def.name === "glob") return "`string[]`";
  if (def.name.startsWith("mcp__")) return "an MCP `CallToolResult` object";
  return "a string";
}

function defFor(id: string): ProviderToolDef[] {
  const tool = getTool(id);
  if (!tool) return [];
  return [
    {
      name: id,
      description: tool.description,
      parameters: tool.schemas.parameters as unknown as Record<string, unknown>,
      result: tool.schemas.result as Record<string, unknown> | undefined,
    },
  ];
}

export function invalidateToolDefs(): void {
  cachedAll = null;
  cachedReadOnly.clear();
}
