// =============================================================================
// Steering (spec 2026-09-20-pi-parity-plan, Phase 1): a message queued on the
// loop mid-turn is the model's next user message without the run being
// aborted; a steer landing after the model stopped forces one more call; an
// undelivered steer is handed back so the server can re-park it.
//
// Same rig as signals/loop-poke.test.ts: real loop, fake provider, recorder in
// a temp dir.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestLayer } from "../effect/layers.js";
import { makeRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import { createAgentLoopEffect, type AgentLoop } from "./loop.js";
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
import { bus } from "../bus/index.js";

const info = {
  id: "steer-fake",
  name: "steer-fake",
  defaultModel: "fake-model",
  supportsStreaming: true,
  supportsTools: true,
};

/** Last user message of every request — where a steer must ride. */
const lastUserSeen: string[] = [];
/** Set by each test: what the fake does per request index. */
let script: Array<"tool" | "text"> = [];
/** Set by each test: called at the start of request N, before it answers. */
let onRequest: ((loop: AgentLoop, n: number) => void) | undefined;
let loopRef: AgentLoop | undefined;

registerProvider("steer-fake" as ProviderId, {
  info,
  create: (): AIProvider => ({
    info,
    execute: async (): Promise<ExecuteResult> => ({
      content: "",
      stopReason: "stop",
      provider: "steer-fake",
      model: "fake-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    stream: async function* (opts: ExecuteOptions): AsyncGenerator<ProviderChunk> {
      const n = lastUserSeen.length;
      const users = (opts.messages ?? []).filter((m) => m.role === "user");
      const last = users[users.length - 1];
      lastUserSeen.push(
        last?.parts.map((p) => (p.type === "text" ? p.content : "")).join("") ?? "",
      );
      if (onRequest && loopRef) onRequest(loopRef, n);
      const step = script[n] ?? "text";
      if (step === "tool") {
        // A read-only call the loop will actually execute; the steer is
        // queued while it runs, i.e. before the next model call.
        yield {
          type: "tool_call",
          id: `call-${n}`,
          name: "glob",
          args: { pattern: "*.nothing-matches" },
        };
      } else {
        yield { type: "text", text: "All done." };
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

async function runLoop(
  sessionId: string,
  opts: { afterRunSteer?: string; beforeRun?: (loop: AgentLoop) => void } = {},
) {
  lastUserSeen.length = 0;
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-steer-rollout-"));
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-steer-project-"));
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
  const store = await runtime.runPromise(SessionStoreTag);
  await store.createSession({ title: "t", projectPath, provider: "steer-fake" }, sessionId);
  const loop = await runtime.runPromise(
    createAgentLoopEffect(sessionId, { maxIterations: 10 }),
  );
  loopRef = loop;
  const streamed: Array<{ type: string; id?: string; content?: string }> = [];
  const unsub = bus.subscribe("stream", (e) => {
    streamed.push((e as { event: { type: string } }).event);
  });
  opts.beforeRun?.(loop);
  const result = await loop.run({
    prompt: "Do the thing",
    sessionId,
    provider: "steer-fake",
    projectPath,
    agentMode: "explore",
  });
  if (opts.afterRunSteer) loop.steer(opts.afterRunSteer);
  const undelivered = loop.takeUndeliveredSteers().map((s) => s.text);
  unsub();
  await runtime.dispose();
  const events = readEvents(rolloutDir);
  const stored = await store.getMessages(sessionId, projectPath);
  rmSync(rolloutDir, { recursive: true, force: true });
  rmSync(projectPath, { recursive: true, force: true });
  loopRef = undefined;
  onRequest = undefined;
  return { result, events, stored, streamed, undelivered };
}

test("a steer queued during a tool batch is the next request's last user message", async () => {
  script = ["tool", "tool", "text"];
  // Queued while request 0 is in flight — i.e. before its tool batch runs.
  onRequest = (loop, n) => {
    if (n === 0) loop.steer("Actually, use the other API.");
  };
  const { events, stored, streamed } = await runLoop("steer-mid");

  assert.equal(lastUserSeen.length, 3);
  assert.equal(lastUserSeen[0], "Do the thing");
  assert.equal(lastUserSeen[1], "Actually, use the other API.", "delivered on the very next call");

  const steer = stored.find((m) => m.synthetic === "steer");
  assert.ok(steer, "persisted as a user message");
  assert.equal(steer!.role, "user");

  const recorded = events.filter((e) => e.type === "message.steered");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.messageId, steer!.id);
  assert.equal(recorded[0]!.remaining, 0);
  assert.ok(!JSON.stringify(recorded[0]).includes("other API"), "text never enters the log");

  const evt = streamed.find((e) => e.type === "message_steered");
  assert.ok(evt, "frontend told when it reached the model");
  assert.equal(evt!.id, steer!.id);
});

test("a steer that lands as the model stops forces one more turn", async () => {
  // Request 0 answers with text → the loop would end. The steer is queued
  // while that request is in flight, so it is pending at the stop decision.
  script = ["text", "text"];
  onRequest = (loop, n) => {
    if (n === 0) loop.steer("One more thing: also update the README.");
  };
  const { result } = await runLoop("steer-at-stop");
  assert.equal(result.success, true);
  assert.equal(lastUserSeen.length, 2, "the steer earned a second model call");
  assert.equal(lastUserSeen[1], "One more thing: also update the README.");
});

test("a steer that never reached the model is handed back for re-parking", async () => {
  script = ["text"];
  const { undelivered } = await runLoop("steer-late", { afterRunSteer: "too late" });
  assert.deepEqual(undelivered, ["too late"]);
});

test("a task notification rides the steer path but persists as its own kind", async () => {
  script = ["tool", "text", "text"];
  onRequest = (loop, n) => {
    if (n === 0) loop.steer("<task-notification>done</task-notification>", "n1", "task_notification");
  };
  const { stored, streamed } = await runLoop("notify-mid");
  assert.equal(lastUserSeen[1], "<task-notification>done</task-notification>");
  const note = stored.find((m) => m.id === "n1");
  assert.equal(note?.synthetic, "task_notification");
  assert.ok(
    !streamed.some((e) => e.type === "message_steered" && e.id === "n1"),
    "no queued row exists to promote",
  );
});

test("a steer queued before run() starts is not dropped by the run's reset", async () => {
  script = ["text", "text"];
  const { undelivered } = await runLoop("steer-early", {
    beforeRun: (loop) => loop.steer("early", "e1", "task_notification"),
  });
  assert.equal(lastUserSeen[0], "early", "delivered before the first model call");
  assert.deepEqual(undelivered, []);
});
