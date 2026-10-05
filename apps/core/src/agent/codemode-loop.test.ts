// =============================================================================
// Codemode through the real loop (spec 2026-10-05-codemode.md §4.2, §7): a
// script's tool calls must go through executeTool, so a read-only mode refuses
// a script's write exactly as it refuses a direct one, and leaves the same
// `function.denied` trace. Same rig as signals/loop-poke.test.ts: real loop,
// fake provider, recorder in a temp dir, settings through a temp project.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestLayer } from "../effect/layers.js";
import { makeRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import { createAgentLoopEffect } from "./loop.js";
import { MemoryService } from "../compaction/service.js";
import { createRecorder } from "../rollout/recorder.js";
import { registerProvider } from "../providers/registry.js";
import type { ProviderId } from "../providers/config.js";
import type {
  AIProvider,
  ExecuteOptions,
  ExecuteResult,
  ProviderChunk,
} from "../providers/types.js";
import type { SessionStore } from "../session/store.js";
import type { AgentRole } from "./definitions/types.js";

type SessionStoreLike = Pick<SessionStore, "getMessages" | "navigate">;

const info = {
  id: "codemode-fake",
  name: "codemode-fake",
  defaultModel: "fake-model",
  supportsStreaming: true,
  supportsTools: true,
};

/** The script the fake model sends on the first turn of the current run. */
let script = "";
/** Run number, so each run's codemode call gets its own id (cm-1, cm-2, …). */
let runNo = 0;
let sentThisRun = false;
/** Optional hallucinated top-level call used to pin only-mode enforcement. */
let topLevelCall: { name: string; args: Record<string, unknown> } | undefined;
/** Tool names offered on each request. */
const offered: string[][] = [];
/** Tool descriptions and system prompt text of the first request. */
let firstDescriptions: Record<string, string> = {};
let firstSystem = "";
/** The codemode tool result the model got back, per run. */
const codemodeResults: string[] = [];
let codemodeResult = "";

registerProvider("codemode-fake" as ProviderId, {
  info,
  create: (): AIProvider => ({
    info,
    execute: async (): Promise<ExecuteResult> => ({
      content: "",
      stopReason: "stop",
      provider: "codemode-fake",
      model: "fake-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    stream: async function* (
      opts: ExecuteOptions,
    ): AsyncGenerator<ProviderChunk> {
      offered.push(
        (opts.tools ?? []).map(
          (t) =>
            (t as { name?: string; id?: string }).name ??
            (t as { id: string }).id,
        ),
      );
      if (offered.length === 1) {
        firstDescriptions = Object.fromEntries(
          (opts.tools ?? []).map((t) => {
            const d = t as { name: string; description: string };
            return [d.name, d.description];
          }),
        );
        firstSystem =
          typeof opts.system === "string"
            ? opts.system
            : (opts.system ?? []).map((b) => b.text).join("\n");
      }
      if (!sentThisRun) {
        sentThisRun = true;
        if (topLevelCall) {
          yield {
            type: "tool_call",
            id: `direct-${runNo}`,
            name: topLevelCall.name,
            args: topLevelCall.args,
          };
          yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
          return;
        }
        yield {
          type: "tool_call",
          id: `cm-${runNo}`,
          name: "codemode",
          args: { script },
        };
      } else {
        for (const m of opts.messages ?? []) {
          for (const p of m.parts) {
            if (p.type === "tool" && p.tool.id === `cm-${runNo}`)
              codemodeResult = String(p.result ?? "");
          }
        }
        codemodeResults[runNo - 1] = codemodeResult;
        yield { type: "text", text: "Done." };
      }
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
});

function readEvents(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function runLoop(opts: {
  sessionId: string;
  enabled: boolean;
  mode?: "on" | "only";
  agentMode: "build" | "explore";
  role?: AgentRole;
  /** `__PROJECT__` is replaced with the project's absolute path. */
  script: string;
  /** Further runs in the same session, each one codemode call. */
  moreScripts?: string[];
  /** Called before run i (0-based) of moreScripts, e.g. to navigate the tree. */
  beforeMore?: (
    i: number,
    store: SessionStoreLike,
    sessionId: string,
    projectPath: string,
  ) => Promise<void>;
  permissions?: Record<string, unknown>;
  files?: Record<string, string>;
  /** Wait this long after the last run, for calls that would outlive it. */
  settleMs?: number;
  /** Make the fake provider call this directly instead of codemode. */
  topLevelCall?: { name: string; args: Record<string, unknown> };
}) {
  offered.length = 0;
  codemodeResults.length = 0;
  codemodeResult = "";
  runNo = 0;
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-codemode-rollout-"));
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-codemode-project-"));
  topLevelCall = opts.topLevelCall
    ? {
        ...opts.topLevelCall,
        args: Object.fromEntries(
          Object.entries(opts.topLevelCall.args).map(([key, value]) => [
            key,
            typeof value === "string"
              ? value.replaceAll("__PROJECT__", projectPath)
              : value,
          ]),
        ),
      }
    : undefined;
  mkdirSync(join(projectPath, ".freecode"), { recursive: true });
  writeFileSync(
    join(projectPath, ".freecode", "settings.json"),
    JSON.stringify({
      codemode: {
        enabled: opts.enabled,
        ...(opts.mode ? { mode: opts.mode } : {}),
      },
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    }),
    "utf-8",
  );
  const scripts = [opts.script, ...(opts.moreScripts ?? [])].map((x) =>
    x.replaceAll("__PROJECT__", projectPath),
  );
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    writeFileSync(join(projectPath, name), content, "utf-8");
  }

  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () =>
          new MemoryService(opts.sessionId, {
            storage: {
              save: () => {},
              load: () => undefined,
              listSessions: () => [],
              delete: () => {},
            } as never,
          }),
      },
      recorderFactory: {
        forSession: (id: string) => createRecorder(id, { rolloutDir }),
      },
    }),
  );
  const store = await runtime.runPromise(SessionStoreTag);
  await store.createSession(
    { title: "t", projectPath, provider: "codemode-fake" },
    opts.sessionId,
  );
  const loop = await runtime.runPromise(
    createAgentLoopEffect(opts.sessionId, { maxIterations: 20 }),
  );
  const prevEnv = process.env.FREECODE_CODEMODE;
  delete process.env.FREECODE_CODEMODE;
  try {
    for (let i = 0; i < scripts.length; i++) {
      if (i > 0)
        await opts.beforeMore?.(i - 1, store, opts.sessionId, projectPath);
      script = scripts[i];
      runNo = i + 1;
      sentThisRun = false;
      await loop.run({
        agentMode: opts.agentMode,
        prompt: "go",
        sessionId: opts.sessionId,
        provider: "codemode-fake",
        projectPath,
        role: opts.role,
      });
    }
    if (opts.settleMs) await new Promise((r) => setTimeout(r, opts.settleMs));
  } finally {
    if (prevEnv !== undefined) process.env.FREECODE_CODEMODE = prevEnv;
    await runtime.dispose();
  }
  const events = readEvents(rolloutDir);
  const written = existsSync(join(projectPath, "evil.txt"));
  rmSync(rolloutDir, { recursive: true, force: true });
  rmSync(projectPath, { recursive: true, force: true });
  return { events, written };
}

test("a script cannot reach a tool its mode does not offer", async () => {
  const { events, written } = await runLoop({
    sessionId: "codemode-explore",
    enabled: true,
    agentMode: "explore",
    script: `
      try { await tools.write({ filePath: "__PROJECT__/evil.txt", content: "x" }); text("WROTE"); }
      catch (e) { text("REFUSED: " + e.message); }`,
  });
  assert.equal(written, false);
  assert.ok(
    offered[0].includes("codemode"),
    "offered in explore: it can only read there",
  );
  assert.ok(!offered[0].includes("write"));
  assert.ok(
    !events.some((e) => e.type === "function.call" && e.tool === "write"),
  );
  assert.match(codemodeResult, /REFUSED: tools\.write does not exist/);
  assert.doesNotMatch(codemodeResult, /WROTE/);
});

test("a script's call is permission-checked by the loop like a direct one", async () => {
  // read IS offered to the script, so only executeTool's rule check stands
  // between it and the file — the bypass this whole design exists to prevent.
  const { events } = await runLoop({
    sessionId: "codemode-deny",
    enabled: true,
    agentMode: "build",
    files: { "secret.txt": "TOP-SECRET" },
    permissions: { deny: ["Read(./secret.txt)"] },
    script: `
      try { text(await tools.read({ filePath: "__PROJECT__/secret.txt" })); }
      catch (e) { text("DENIED: " + e.message); }`,
  });
  const denied = events.filter(
    (e) => e.type === "function.denied" && e.tool === "read",
  );
  assert.equal(denied.length, 1);
  assert.equal(denied[0].source, "rule");
  assert.ok(
    !events.some((e) => e.type === "function.call" && e.tool === "read"),
  );
  assert.match(
    codemodeResult,
    /DENIED: Permission denied by rule: Read\(\.\/secret\.txt\)/,
  );
  assert.doesNotMatch(codemodeResult, /TOP-SECRET/);
});

test("a script's calls run, are traced under the codemode call, and see full output", async () => {
  const big = Array.from(
    { length: 3000 },
    (_, i) => `line ${i} needle${i % 1000 === 0 ? "-hit" : ""}`,
  ).join("\n");
  const { events } = await runLoop({
    sessionId: "codemode-build",
    enabled: true,
    agentMode: "build",
    files: { "big.txt": big },
    script: `
      const [a, b] = await Promise.all([
        tools.read({ filePath: "__PROJECT__/big.txt", limit: 5000 }),
        tools.grep({ pattern: "needle\\\\d*-hit", path: "__PROJECT__" }),
      ]);
      return { full: a.length > 30000 && a.includes("line 1500 ") && !a.includes("[truncated"), grepHits: b.split("\\n").filter((l) => l.includes("-hit")).length };`,
  });
  const nested = events.filter(
    (e) => e.type === "function.call" && e.parentCallId === "cm-1",
  );
  assert.deepEqual(nested.map((e) => e.tool).sort(), ["grep", "read"]);
  assert.match(codemodeResult, /^Script completed in [\d.]+s \(2 tool calls\)/);
  // Over the model's 30 KB head+tail cap, so only the OutputStore copy has
  // the middle line and no truncation marker.
  assert.match(codemodeResult, /"full": true/);
  assert.match(codemodeResult, /"grepHits": 3/);
});

test("disabled: not offered, and a hallucinated call is refused", async () => {
  const { events } = await runLoop({
    sessionId: "codemode-off",
    enabled: false,
    agentMode: "build",
    script: `text("ran")`,
  });
  assert.ok(!offered[0].includes("codemode"));
  assert.ok(!events.some((e) => e.type === "function.call" && e.parentCallId));
  assert.match(codemodeResult, /codemode is not enabled/);
  assert.doesNotMatch(firstDescriptions.read, /Codemode:/);
  assert.doesNotMatch(firstSystem, /Use codemode to batch/);
});

test("store() persists across turns, and a /tree branch sees only its own path", async () => {
  let afterFirst = "";
  await runLoop({
    sessionId: "codemode-store",
    enabled: true,
    agentMode: "build",
    script: `store("cursor", 1); store("tmp", "x"); return load("cursor");`,
    moreScripts: [
      `store("cursor", load("cursor") + 1); store("tmp", undefined); return [load("cursor"), load("tmp") ?? "gone"];`,
      `return load("cursor");`,
      `throw new Error("no");`,
      `return load("cursor");`,
    ],
    beforeMore: async (i, store, sessionId, projectPath) => {
      if (i === 0) {
        // Remember the codemode message of run 1 to branch back to later.
        const msgs = await store.getMessages(sessionId, projectPath);
        afterFirst = msgs.findLast((m) =>
          m.parts.some((p) => p.codemodeStore),
        )!.id;
      }
      if (i === 1) await store.navigate(sessionId, afterFirst, projectPath);
    },
  });
  assert.match(codemodeResults[0], /\n1$/);
  assert.match(codemodeResults[1], /\[\s*2,\s*"gone"\s*\]/);
  // Run 3 branched back to just after run 1: run 2's write is not on its path.
  assert.match(codemodeResults[2], /\n1$/);
  // A failed script keeps no writes (it wrote none here, but must not crash).
  assert.match(codemodeResults[3], /^Script failed/);
  assert.match(codemodeResults[4], /\n1$/);
});

test("a write still queued when the script ends never runs", async () => {
  // bash is not concurrency-safe, so the write queues behind it; the script
  // returns without awaiting either, which aborts the write before it starts.
  const { events, written } = await runLoop({
    sessionId: "codemode-cancel",
    enabled: true,
    agentMode: "build",
    settleMs: 1500,
    permissions: { allow: ["Bash", "Write"] },
    script: `
      tools.bash({ command: "sleep 1" });
      tools.write({ filePath: "__PROJECT__/evil.txt", content: "x" });
      return "returned";`,
  });
  assert.ok(
    events.some((e) => e.type === "function.call" && e.tool === "bash"),
    "bash ran",
  );
  assert.equal(written, false);
  assert.ok(
    !events.some((e) => e.type === "function.call" && e.tool === "write"),
  );
  assert.match(codemodeResult, /returned/);
});

test('enabled: tools and system prompt point at codemode, as pi\'s mode "on" does', async () => {
  await runLoop({
    sessionId: "codemode-presentation",
    enabled: true,
    agentMode: "build",
    script: `return 1`,
  });
  assert.match(
    firstDescriptions.read,
    /Codemode: `tools\.read\(args\)` resolves to a string\.$/,
  );
  assert.match(firstDescriptions.bash, /Codemode: `tools\.bash\(args\)`/);
  // Not callable from a script, so no hint.
  assert.doesNotMatch(firstDescriptions.agent ?? "", /Codemode:/);
  assert.doesNotMatch(firstDescriptions.codemode, /Codemode: `tools\.codemode/);
  assert.match(firstSystem, /Use codemode to batch independent tool calls/);
});

test("only mode hides direct declarations but scripts retain their structured tools", async () => {
  await runLoop({
    sessionId: "codemode-only",
    enabled: true,
    mode: "only",
    agentMode: "build",
    script: `
      const files = await tools.glob({ pattern: "*.txt", path: "__PROJECT__" });
      return { array: Array.isArray(files), files };`,
    files: { "one.txt": "1", "two.txt": "2" },
  });
  assert.deepEqual(offered[0], ["codemode"]);
  assert.match(
    firstDescriptions.codemode,
    /Callable tools in codemode-only mode/,
  );
  assert.match(firstDescriptions.codemode, /glob\(args:/);
  assert.match(firstSystem, /Direct tool declarations are hidden/);
  assert.match(codemodeResult, /"array": true/);
  assert.match(codemodeResult, /one\.txt/);
});

test("only mode refuses an undeclared top-level direct call", async () => {
  const { events, written } = await runLoop({
    sessionId: "codemode-only-direct-deny",
    enabled: true,
    mode: "only",
    agentMode: "build",
    script: `return "unused"`,
    topLevelCall: {
      name: "write",
      args: { filePath: "__PROJECT__/evil.txt", content: "bypass" },
    },
  });
  assert.equal(written, false);
  assert.ok(
    events.some(
      (event) =>
        event.type === "function.denied" &&
        event.tool === "write" &&
        event.source === "mode",
    ),
  );
  assert.ok(
    !events.some(
      (event) => event.type === "function.call" && event.tool === "write",
    ),
  );
});

test("a role's allowlist also bounds the script catalog", async () => {
  await runLoop({
    sessionId: "codemode-role",
    enabled: true,
    agentMode: "build",
    role: { name: "reader", prompt: "Read only.", tools: ["codemode", "read"] },
    script: `return ALL_TOOLS.map((tool) => tool.name);`,
  });
  assert.deepEqual(offered[0].sort(), ["codemode", "read"]);
  assert.match(codemodeResult, /\[\s*"read"\s*\]/);
  assert.doesNotMatch(codemodeResult, /"bash"/);
});

test("bash resolves to a structured result inside codemode", async () => {
  await runLoop({
    sessionId: "codemode-bash-result",
    enabled: true,
    agentMode: "build",
    permissions: { allow: ["Bash"] },
    script: `
      const result = await tools.bash({ command: "printf structured" });
      return { output: result.output, exit: result.exit_code };`,
  });
  assert.match(codemodeResult, /"output": "structured"/);
  assert.match(codemodeResult, /"exit": 0/);
});

test("a script receives complete nested output larger than 1 MiB", async () => {
  await runLoop({
    sessionId: "codemode-full-nested-output",
    enabled: true,
    mode: "only",
    agentMode: "build",
    permissions: { allow: ["Bash"] },
    script: `
      const result = await tools.bash({
        command: "yes x | head -c 1200000; printf THE_END"
      });
      return {
        length: result.output.length,
        complete: result.output.endsWith("THE_END")
      };`,
  });
  assert.match(codemodeResult, /"length": 1200007/);
  assert.match(codemodeResult, /"complete": true/);
});
