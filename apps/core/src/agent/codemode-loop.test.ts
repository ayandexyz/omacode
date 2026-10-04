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

const info = {
  id: "codemode-fake",
  name: "codemode-fake",
  defaultModel: "fake-model",
  supportsStreaming: true,
  supportsTools: true,
};

/** The script the fake model sends on its first turn. */
let script = "";
/** Tool names offered on each request. */
const offered: string[][] = [];
/** The codemode tool result the model got back. */
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
    stream: async function* (opts: ExecuteOptions): AsyncGenerator<ProviderChunk> {
      offered.push((opts.tools ?? []).map((t) => (t as { name?: string; id?: string }).name ?? (t as { id: string }).id));
      if (offered.length === 1) {
        yield { type: "tool_call", id: "cm-1", name: "codemode", args: { script } };
      } else {
        for (const m of opts.messages ?? []) {
          for (const p of m.parts) {
            if (p.type === "tool" && p.tool.id === "cm-1") codemodeResult = String(p.result ?? "");
          }
        }
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
  agentMode: "build" | "explore";
  /** `__PROJECT__` is replaced with the project's absolute path. */
  script: string;
  permissions?: Record<string, unknown>;
  files?: Record<string, string>;
}) {
  offered.length = 0;
  codemodeResult = "";
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-codemode-rollout-"));
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-codemode-project-"));
  mkdirSync(join(projectPath, ".freecode"), { recursive: true });
  writeFileSync(
    join(projectPath, ".freecode", "settings.json"),
    JSON.stringify({
      codemode: { enabled: opts.enabled },
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    }),
    "utf-8",
  );
  script = opts.script.replaceAll("__PROJECT__", projectPath);
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
    createAgentLoopEffect(opts.sessionId, { maxIterations: 4 }),
  );
  const prevEnv = process.env.FREECODE_CODEMODE;
  delete process.env.FREECODE_CODEMODE;
  try {
    await loop.run({
      agentMode: opts.agentMode,
      prompt: "go",
      sessionId: opts.sessionId,
      provider: "codemode-fake",
      projectPath,
    });
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
  assert.ok(offered[0].includes("codemode"), "offered in explore: it can only read there");
  assert.ok(!offered[0].includes("write"));
  assert.ok(!events.some((e) => e.type === "function.call" && e.tool === "write"));
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
  const denied = events.filter((e) => e.type === "function.denied" && e.tool === "read");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].source, "rule");
  assert.ok(!events.some((e) => e.type === "function.call" && e.tool === "read"));
  assert.match(codemodeResult, /DENIED: Permission denied by rule: Read\(\.\/secret\.txt\)/);
  assert.doesNotMatch(codemodeResult, /TOP-SECRET/);
});

test("a script's calls run, are traced under the codemode call, and see full output", async () => {
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i} needle${i % 1000 === 0 ? "-hit" : ""}`).join("\n");
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
  const nested = events.filter((e) => e.type === "function.call" && e.parentCallId === "cm-1");
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
});
