// =============================================================================
// Deferred tool loading through the real loop (spec 2026-10-10 §4.2 path B):
// an MCP tool is held back, a premature call is refused, tool_search loads it,
// and the next request declares it.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestLayer } from "../effect/layers.js";
import { makeRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import { createAgentLoopEffect } from "./loop.js";
import { MemoryService } from "../compaction/service.js";
import { createRecorder } from "../rollout/recorder.js";
import { registerProvider } from "../providers/registry.js";
import { registerMcpTool, unregisterMcpTools } from "../tools/index.js";
import { invalidateToolDefs } from "../tools/defs-cache.js";
import { buildTool } from "../tools/factory.js";
import type { ProviderId } from "../providers/config.js";
import type { AIProvider, ProviderChunk } from "../providers/types.js";

const MCP_TOOL = "mcp__fakeserver__render_design";

function info(id: string) {
  return {
    id,
    name: id,
    defaultModel: "fake-model",
    supportsStreaming: true,
    supportsTools: true,
  };
}

// Tool names offered on each request, and one scripted reply per request.
const offered: string[][] = [];
const script: ProviderChunk[][] = [
  [{ type: "tool_call", id: "c1", name: MCP_TOOL, args: {} }],
  [{ type: "tool_call", id: "c2", name: "tool_search", args: { query: "render design" } }],
  [{ type: "tool_call", id: "c3", name: MCP_TOOL, args: {} }],
  [{ type: "text_delta", delta: "done" }],
];

registerProvider("deferral-fake" as ProviderId, {
  info: info("deferral-fake"),
  create: (): AIProvider => ({
    info: info("deferral-fake"),
    execute: async () => ({ content: "", stopReason: "stop", provider: "deferral-fake", model: "fake-model" }),
    stream: async function* (opts): AsyncGenerator<ProviderChunk> {
      offered.push((opts.tools ?? []).map((t) => t.name));
      for (const chunk of script[offered.length - 1] ?? []) yield chunk;
    },
  }),
});

let executions = 0;

function readEvents(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test("a deferred MCP tool is refused until tool_search loads it", async () => {
  const sessionId = "deferral-e2e";
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-deferral-test-"));
  const previousEnv = process.env.FREECODE_DEFER_TOOLS;
  process.env.FREECODE_DEFER_TOOLS = "1";
  registerMcpTool(
    buildTool({
      id: MCP_TOOL,
      // Big enough to clear the default 4000-token threshold.
      description: `Render a design node to code. ${"detail ".repeat(3000)}`,
      schemas: { parameters: { type: "object", properties: {} } as never },
      execute: async () => {
        executions++;
        return { success: true, result: { title: "render", output: "<div/>" } };
      },
    }),
  );
  invalidateToolDefs();

  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () =>
          new MemoryService(sessionId, {
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
  try {
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession(
      { title: "t", projectPath, provider: "deferral-fake" },
      sessionId,
    );
    const loop = await runtime.runPromise(
      createAgentLoopEffect(sessionId, { maxIterations: 6 }),
    );
    await loop.run({
      prompt: "render the design",
      sessionId,
      provider: "deferral-fake",
      projectPath,
      agentMode: "danger",
    });

    assert.equal(offered.length, 4);
    // Requests 1–2: held back, tool_search offered.
    assert.ok(!offered[0].includes(MCP_TOOL));
    assert.ok(offered[0].includes("tool_search"));
    assert.ok(!offered[1].includes(MCP_TOOL));
    // After the search: declared, and tool_search stays (no flip-flop).
    assert.ok(offered[2].includes(MCP_TOOL));
    assert.ok(offered[2].includes("tool_search"));
    // Only the call made after loading ran.
    assert.equal(executions, 1);

    const events = readEvents(rolloutDir);
    const denied = events.filter((e) => e.type === "function.denied");
    assert.equal(denied.length, 1);
    assert.equal(denied[0].source, "deferred");
    const counts = events
      .filter((e) => e.type === "model.request")
      .map((e) => e.deferredCount);
    assert.deepEqual(counts, [1, 1, 0, 0]);
  } finally {
    if (previousEnv === undefined) delete process.env.FREECODE_DEFER_TOOLS;
    else process.env.FREECODE_DEFER_TOOLS = previousEnv;
    unregisterMcpTools("mcp__fakeserver__");
    invalidateToolDefs();
    await runtime.dispose();
    rmSync(rolloutDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
});
