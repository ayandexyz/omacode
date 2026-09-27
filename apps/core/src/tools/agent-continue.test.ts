// =============================================================================
// agent({ continue }): a finished sub-agent's next assignment starts from its
// history, runs as the same type, gets a new id, and is refused whenever the
// caller could not have meant it.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freecode-agent-cont-home-"));
process.env.HOME = home;

const { registerProvider } = await import("../providers/registry.js");
const { tools } = await import("./index.js");
const { getAgentRegistry } = await import("../agent/registry/index.js");
const { createHookRuntime } = await import("../hooks/runtime.js");

const info = { id: "cont-fake", name: "cont-fake", defaultModel: "m", supportsStreaming: true, supportsTools: true };
const requests: string[] = [];
registerProvider("cont-fake" as never, {
  info,
  create: () => ({
    info,
    execute: async () => ({ content: "", stopReason: "stop", provider: "cont-fake", model: "m", usage: { inputTokens: 1, outputTokens: 1 } }),
    stream: async function* (...args: unknown[]) {
      requests.push(JSON.stringify(args));
      yield { type: "text_delta", delta: `ANSWER-${requests.length}` };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  }),
} as never);

test.after(() => rmSync(home, { recursive: true, force: true }));

const ctx = (sessionId: string, project: string) =>
  ({ sessionId, cwd: project, projectPath: project, hooks: createHookRuntime() }) as never;

function idOf(r: Awaited<ReturnType<typeof tools.agent.execute>>): string {
  return String(r.success && r.result.metadata?.subagentId);
}

test("a continuation sees the first run's history, keeps its type, and gets a new id", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-cont-"));
  requests.length = 0;
  try {
    const first = await tools.agent.execute(
      { task: "Map auth", prompt: "FIRST-PROMPT: map the auth flow", subagent_type: "reviewer", model: "cont-fake" },
      ctx("root-cont", project),
    );
    assert.equal(first.success, true);
    const firstId = idOf(first);

    const second = await tools.agent.execute(
      { task: "Follow up", prompt: "SECOND-PROMPT: which file checks tokens?", continue: firstId },
      ctx("root-cont", project),
    );
    assert.equal(second.success, true);
    const secondId = idOf(second);
    assert.notEqual(secondId, firstId);
    assert.equal(second.success && second.result.metadata?.continuedFrom, firstId);
    assert.match(first.success ? first.result.output : "", new RegExp(`Agent id: ${firstId}`), "the model can see the id");
    assert.match(second.success ? second.result.output : "", new RegExp(`Agent id: ${secondId} \\(continued from ${firstId}\\)`));

    const req = requests.at(-1)!;
    assert.match(req, /FIRST-PROMPT[\s\S]*ANSWER-1[\s\S]*SECOND-PROMPT/, "history, then the new prompt");
    assert.match(req, /# Your role: reviewer/, "same type as the original");
    const names = [...req.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(!names.includes("bash"), "same read-only tool set as the original");

    // The continuation is itself continuable.
    const third = await tools.agent.execute(
      { task: "Again", prompt: "THIRD", continue: secondId },
      ctx("root-cont", project),
    );
    assert.equal(third.success, true);
    assert.match(requests.at(-1)!, /FIRST-PROMPT[\s\S]*SECOND-PROMPT[\s\S]*THIRD/);
  } finally {
    getAgentRegistry().disposeRoot("root-cont");
    rmSync(project, { recursive: true, force: true });
  }
});

test("refused: someone else's agent, a running one, one the caller stopped, or a changed type", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-cont-"));
  const agents = getAgentRegistry();
  try {
    const done = await tools.agent.execute(
      { task: "t", prompt: "p", model: "cont-fake" },
      ctx("root-refuse", project),
    );
    const doneId = idOf(done);
    const err = async (params: Record<string, unknown>, session = "root-refuse") => {
      const r = await tools.agent.execute({ task: "t", prompt: "p", ...params } as never, ctx(session, project));
      assert.equal(r.success, false);
      return r.success ? "" : r.error;
    };

    assert.match(await err({ continue: doneId }, "someone-else"), /No agent .* started by this session/);
    assert.match(await err({ continue: "subagent-nope" }), /No agent subagent-nope/);
    assert.match(await err({ continue: "explorer" }), /takes the agent's id .* not its type/);
    assert.match(await err({ continue: doneId, subagent_type: "explorer" }), /drop subagent_type/);
    assert.match(await err({ continue: doneId, readOnly: false }), /drop readOnly/);

    agents.register({ id: "cont-running", parentId: "root-refuse", task: "t", prompt: "p", agentType: "general" });
    assert.match(await err({ continue: "cont-running" }), /still running\. Use agent_send/);

    agents.stop("cont-running", true);
    assert.match(await err({ continue: "cont-running" }), /You stopped cont-running with agent_stop/);

    agents.register({ id: "cont-verifier", parentId: "root-refuse", task: "t", prompt: "p", agentType: "verifier" });
    agents.settle("cont-verifier", "completed");
    assert.match(await err({ continue: "cont-verifier" }), /cannot be continued/);
  } finally {
    agents.disposeRoot("root-refuse");
    rmSync(project, { recursive: true, force: true });
  }
});
