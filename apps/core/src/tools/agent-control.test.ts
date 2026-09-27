// =============================================================================
// agent_send / agent_stop: the parent steers or cancels a running background
// agent; nobody else can; a stop by the parent owes it no notification.
// Real AgentLoop, fake provider whose first call blocks until released, so the
// agent is reliably mid-run when the parent acts.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freecode-agent-ctl-home-"));
process.env.HOME = home;
process.env.FREECODE_TASK_NOTIFY = "1";

const { registerProvider } = await import("../providers/registry.js");
const { tools } = await import("./index.js");
const { getAgentRegistry } = await import("../agent/registry/index.js");
const { setTaskNotificationSink } = await import("../agent/task-notify.js");
const { createHookRuntime } = await import("../hooks/runtime.js");

const info = {
  id: "ctl-fake",
  name: "ctl-fake",
  defaultModel: "fake-model",
  supportsStreaming: true,
  supportsTools: true,
};

/** Every request the fake saw, serialised, so a test can look for a steer. */
const requests: string[] = [];
let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
function holdNextCall(): void {
  gate = new Promise((r) => (release = r));
}

registerProvider("ctl-fake" as never, {
  info,
  create: () => ({
    info,
    execute: async () => ({
      content: "",
      stopReason: "stop",
      provider: "ctl-fake",
      model: "fake-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    stream: async function* (...args: unknown[]) {
      requests.push(JSON.stringify(args));
      const wait = gate;
      gate = Promise.resolve();
      await wait;
      yield { type: "text", text: "Looked around." };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
} as never);

test.after(() => rmSync(home, { recursive: true, force: true }));

const ctx = (sessionId: string, project: string) =>
  ({ sessionId, cwd: project, projectPath: project, hooks: createHookRuntime() }) as never;

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function spawn(root: string, project: string): Promise<string> {
  const r = await tools.agent.execute(
    { task: "Survey", prompt: "Survey the repo", agentType: "ctl-fake", run_in_background: true },
    ctx(root, project),
  );
  assert.equal(r.success, true);
  return String(r.success && r.result.metadata?.subagentId);
}

test("agent_send reaches the running agent as its next user message", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-ctl-"));
  const notes: string[] = [];
  const prev = setTaskNotificationSink((_s, text) => notes.push(text));
  requests.length = 0;
  holdNextCall();
  try {
    const id = await spawn("root-send", project);
    await until(() => requests.length === 1); // mid-call, loop attached
    const sent = await tools.agent_send.execute(
      { agent_id: id, message: "Only look at src/api." },
      ctx("root-send", project),
    );
    assert.equal(sent.success && sent.result.metadata?.sent, true);
    release();
    await until(() => notes.length === 1);
    assert.ok(requests.length >= 2, "the steer bought the agent another turn");
    assert.match(requests.at(-1)!, /Message from the agent that started you:\\nOnly look at src\/api\./);
    assert.doesNotMatch(notes[0]!, /not delivered/);
  } finally {
    release();
    setTaskNotificationSink(prev);
    getAgentRegistry().disposeRoot("root-send");
    rmSync(project, { recursive: true, force: true });
  }
});

test("agent_stop by the parent returns its activity and no notification follows", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-ctl-"));
  const notes: string[] = [];
  const prev = setTaskNotificationSink((_s, text) => notes.push(text));
  requests.length = 0;
  holdNextCall();
  try {
    const id = await spawn("root-stop", project);
    await until(() => requests.length === 1);
    const r = await tools.agent_stop.execute({ agent_id: id }, ctx("root-stop", project));
    assert.equal(r.success && r.result.metadata?.stopped, true);
    assert.match(r.success ? r.result.output : "", /Stopped .*No task notification will follow/s);
    assert.equal(getAgentRegistry().get(id)?.status, "killed");
    release();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(notes.length, 0);
  } finally {
    release();
    setTaskNotificationSink(prev);
    getAgentRegistry().disposeRoot("root-stop");
    rmSync(project, { recursive: true, force: true });
  }
});

test("only the parent may send or stop, and only while it runs", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-ctl-"));
  const prev = setTaskNotificationSink(() => {});
  requests.length = 0;
  holdNextCall();
  try {
    const id = await spawn("root-own", project);
    const stranger = await tools.agent_stop.execute({ agent_id: id }, ctx("someone-else", project));
    assert.match(stranger.success ? stranger.result.output : "", /No agent .* started by this session/);
    assert.equal(getAgentRegistry().get(id)?.status, "running");
    release();
    await until(() => getAgentRegistry().get(id)?.status === "completed");
    const late = await tools.agent_send.execute({ agent_id: id, message: "x" }, ctx("root-own", project));
    assert.match(late.success ? late.result.output : "", /already ended \(completed\)/);
    const missing = await tools.agent_stop.execute({ agent_id: "subagent-nope" }, ctx("root-own", project));
    assert.match(missing.success ? missing.result.output : "", /No agent subagent-nope/);
  } finally {
    release();
    setTaskNotificationSink(prev);
    getAgentRegistry().disposeRoot("root-own");
    rmSync(project, { recursive: true, force: true });
  }
});

test("registry: a message sent before the loop exists is delivered on attach; one never attached is returned", () => {
  const agents = getAgentRegistry();
  agents.register({ id: "reg-a", parentId: "root-reg", task: "t", prompt: "p", agentType: "agent" });
  agents.register({ id: "reg-b", parentId: "root-reg", task: "t", prompt: "p", agentType: "agent" });
  try {
    assert.equal(agents.send("reg-a", "first"), true);
    assert.equal(agents.send("reg-a", "second"), true);
    const got: string[] = [];
    agents.attachSteer("reg-a", (t) => got.push(t));
    assert.deepEqual(got, ["first", "second"]);

    agents.send("reg-b", "orphan");
    agents.settle("reg-b", "failed");
    assert.equal(agents.send("reg-b", "late"), false);
    assert.deepEqual(agents.takeUndelivered("reg-b"), ["orphan"]);
  } finally {
    agents.disposeRoot("root-reg");
  }
});
