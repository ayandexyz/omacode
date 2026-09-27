import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry, MAX_AGENTS_PER_ROOT } from "./registry.js";
import { parseAgentActivity as parseActivity } from "@thisisayande/freecode-shared";
import { BusEvents } from "../../bus/index.js";

function spawn(reg: AgentRegistry, id: string, parentId: string) {
  return reg.register({ id, parentId, task: `task ${id}`, prompt: `prompt ${id}`, agentType: "agent" });
}

test("an agent spawned by a root session sits at depth 1 under that root", () => {
  const reg = new AgentRegistry();
  const summary = spawn(reg, "a1", "root");
  assert.equal(summary.depth, 1);
  assert.equal(summary.rootId, "root");
  assert.equal(reg.rootOf("a1"), "root");
  // A session that is not an agent is its own root, which is what lets
  // agents.list take the root session id and resolve the whole tree.
  assert.equal(reg.rootOf("root"), "root");
  assert.equal(reg.depthOf("root"), 0);
  reg.disposeAll();
});

test("a subagent may not spawn a subagent", () => {
  const reg = new AgentRegistry();
  spawn(reg, "a1", "root");
  assert.throws(
    () => spawn(reg, "a2", "a1"),
    /may not spawn subagents/,
    "depth 2 must be refused — nothing else bounds the spawn tree",
  );
  reg.disposeAll();
});

test("concurrent subagents under one root are capped", () => {
  const reg = new AgentRegistry();
  for (let i = 0; i < MAX_AGENTS_PER_ROOT; i++) spawn(reg, `a${i}`, "root");
  assert.throws(() => spawn(reg, "overflow", "root"), /Too many subagents/);

  // A settled one frees its slot: the cap is on RUNNING agents, so a session
  // that delegates twenty short tasks in sequence is not blocked at eight.
  reg.settle("a0", "completed");
  assert.doesNotThrow(() => spawn(reg, "after", "root"));
  reg.disposeAll();
});

test("the cap is per root, so two sessions do not starve each other", () => {
  const reg = new AgentRegistry();
  for (let i = 0; i < MAX_AGENTS_PER_ROOT; i++) spawn(reg, `a${i}`, "root-a");
  assert.doesNotThrow(() => spawn(reg, "b0", "root-b"));
  assert.equal(reg.listForRoot("root-b").length, 1);
  reg.disposeAll();
});

test("stream events for a registered agent are folded into its activity log", () => {
  const reg = new AgentRegistry();
  spawn(reg, "a1", "root");

  BusEvents.stream("a1", {
    type: "tool_start",
    toolCallId: "t1",
    toolName: "grep",
    args: { pattern: "createToolOrchestrator" },
  });
  // Deltas are not kept: the turn-end snapshot carries the same characters.
  BusEvents.stream("a1", { type: "text_delta", delta: "fou" });
  BusEvents.stream("a1", { type: "text", content: "found it" });
  // Another session's events must not bleed into this agent's log.
  BusEvents.stream("root", { type: "text", content: "MAIN" });

  const read = reg.readFrom("a1", 0);
  assert.equal(read.found, true);
  const events = parseActivity(read.text);
  assert.deepEqual(
    events.map((e) => e.type),
    ["tool_start", "text"],
  );
  assert.match(read.text, /createToolOrchestrator/);
  assert.match(read.text, /found it/);
  assert.ok(!read.text.includes("MAIN"));
  reg.disposeAll();
});

test("readFrom is positional: a second read returns only what is new", () => {
  const reg = new AgentRegistry();
  spawn(reg, "a1", "root");
  BusEvents.stream("a1", { type: "text", content: "one" });

  const first = reg.readFrom("a1", 0);
  BusEvents.stream("a1", { type: "text", content: "two" });
  const second = reg.readFrom("a1", first.nextCursor);

  assert.deepEqual(parseActivity(second.text), [{ type: "text", content: "two" }]);
  reg.disposeAll();
});

test("a settled agent stops recording activity", () => {
  const reg = new AgentRegistry();
  spawn(reg, "a1", "root");
  reg.settle("a1", "completed");
  BusEvents.stream("a1", { type: "text", content: "late" });
  assert.equal(reg.readFrom("a1", 0).text, "");
  reg.disposeAll();
});

test("stop interrupts the loop and settles the row without waiting for it", () => {
  const reg = new AgentRegistry();
  let interrupted = false;
  const exits: string[] = [];
  reg.register({
    id: "a1",
    parentId: "root",
    task: "t",
    prompt: "p",
    agentType: "agent",
    interrupt: () => {
      interrupted = true;
    },
    onExit: (_id, status) => exits.push(status),
  });

  assert.equal(reg.stop("a1"), true);
  assert.equal(interrupted, true);
  assert.equal(reg.get("a1")?.status, "killed");
  assert.deepEqual(exits, ["killed"]);

  // The loop unwinding later must not fire a second exit notification, or the
  // frontend's running counter goes stale.
  reg.settle("a1", "failed");
  assert.deepEqual(exits, ["killed"]);
  assert.equal(reg.stop("a1"), false);
  reg.disposeAll();
});

test("remove refuses a running agent and accepts a settled one", () => {
  const reg = new AgentRegistry();
  spawn(reg, "a1", "root");
  assert.equal(
    reg.remove("a1"),
    false,
    "dropping the record would strand the loop",
  );
  reg.settle("a1", "completed");
  assert.equal(reg.remove("a1"), true);
  assert.equal(reg.listForRoot("root").length, 0);
  reg.disposeAll();
});

test("disposeRoot stops and forgets only that root's tree", () => {
  const reg = new AgentRegistry();
  let stopped = 0;
  reg.register({
    id: "a1",
    parentId: "root-a",
    task: "t",
    prompt: "p",
    agentType: "agent",
    interrupt: () => {
      stopped++;
    },
  });
  spawn(reg, "b1", "root-b");

  reg.disposeRoot("root-a");
  assert.equal(stopped, 1);
  assert.equal(reg.listForRoot("root-a").length, 0);
  assert.equal(reg.listForRoot("root-b").length, 1);
  reg.disposeAll();
});

test("the bus subscription is released once the registry empties", () => {
  const reg = new AgentRegistry();
  spawn(reg, "a1", "root");
  reg.disposeAll();
  // Nothing is registered, so a stray event must be a no-op rather than
  // resurrecting a record — and the handler itself should be gone.
  BusEvents.stream("a1", { type: "text", content: "late" });
  assert.equal(reg.readFrom("a1", 0).found, false);
});

test("a stop that lands before the interrupt is attached fires on attach", () => {
  const reg = new AgentRegistry();
  // The loop does not exist yet when the agent is registered: `k` in the
  // panel during the SubagentStart hook used to settle the row and lose the
  // interrupt entirely, so the loop ran to completion behind a "killed" row.
  spawn(reg, "a1", "root");
  assert.equal(reg.stop("a1"), true);
  assert.equal(reg.get("a1")?.status, "killed");

  let interrupted = 0;
  reg.attachInterrupt("a1", () => interrupted++);
  assert.equal(interrupted, 1, "pending stop must be honoured on attach");

  // Not re-fired: a second attach is a fresh handle, not a second stop.
  reg.attachInterrupt("a1", () => interrupted++);
  assert.equal(interrupted, 1);
  reg.disposeAll();
});

test("assertCanRegister refuses what register would, without registering", () => {
  const reg = new AgentRegistry();
  spawn(reg, "a1", "root");
  assert.throws(() => reg.assertCanRegister("a1"), /may not spawn subagents/);
  assert.doesNotThrow(() => reg.assertCanRegister("root"));
  assert.equal(reg.listForRoot("root").length, 1);
  reg.disposeAll();
});
