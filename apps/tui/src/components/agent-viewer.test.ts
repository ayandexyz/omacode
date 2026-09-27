import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSummary, StreamEvent } from "@thisisayande/freecode-shared";
import { AgentViewer } from "./agent-viewer.js";

const ESC = "";
const KEY_ESC = ESC;
const KEY_PGUP = `${ESC}[5~`;
const KEY_PGDN = `${ESC}[6~`;
//  escape rather than a literal ESC byte.
const ANSI = /\[[0-9;]*m/g;

const strip = (rows: string[]): string => rows.join("\n").replace(ANSI, "");

const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  id: "a1",
  parentId: "root",
  rootId: "root",
  task: "Find every call site",
  prompt: "",
  background: false,
  agentType: "agent",
  depth: 1,
  status: "running",
  startedAt: Date.now() - 12_000,
  bufferedChars: 0,
  truncated: false,
  ...over,
});

const viewer = (
  over: { onStop?: (id: string) => void; onBack?: () => void } = {},
): AgentViewer =>
  new AgentViewer({
    onStop: over.onStop ?? ((): void => {}),
    onBack: over.onBack ?? ((): void => {}),
  });

const text = (content: string): StreamEvent => ({ type: "text", content });
const toolStart = (id: string, toolName = "grep"): StreamEvent => ({
  type: "tool_start",
  toolCallId: id,
  toolName,
  args: { pattern: "loop" },
});
const toolDone = (id: string, toolName = "grep"): StreamEvent => ({
  type: "tool_complete",
  toolCallId: id,
  toolName,
  result: "matched 3 files",
  success: true,
});

test("renders nothing until an agent is opened", () => {
  const v = viewer();
  v.setMaxRows(20);
  assert.deepEqual(v.render(80), [], "the main area stays with the message list");
  assert.equal(v.agentId(), undefined);
});

test("shows the agent's task, status and replayed activity", () => {
  const v = viewer();
  v.setMaxRows(20);
  v.open(agent(), [toolStart("t1"), toolDone("t1"), text("matched 3 files")]);

  const out = strip(v.render(80));
  assert.match(out, /Subagent: Find every call site/);
  assert.match(out, /running/);
  assert.match(out, /matched 3 files/);
  assert.equal(v.agentId(), "a1");
  assert.equal(v.messageCount(), 2, "one tool group and one assistant row");
});

test("the parent's prompt opens the transcript as a user message", () => {
  const v = viewer();
  v.setMaxRows(30);
  v.open(agent({ prompt: "Grep for runSessionTurn and report callers" }), [
    text("found 2 callers"),
  ]);
  const out = strip(v.render(80));
  assert.match(out, /Grep for runSessionTurn and report callers/);
  assert.ok(
    out.indexOf("Grep for runSessionTurn") < out.indexOf("found 2 callers"),
    "the prompt comes before the agent's reply",
  );
  assert.equal(v.messageCount(), 2);
});

test("a background agent is labelled as one", () => {
  const v = viewer();
  v.setMaxRows(20);
  v.open(agent({ background: true }), []);
  assert.match(strip(v.render(80)), /Background subagent: Find every call site/);
});

test("an empty transcript says so instead of rendering blank rows", () => {
  const v = viewer();
  v.setMaxRows(20);
  v.open(agent(), []);
  assert.match(strip(v.render(80)), /no activity yet/);
});

test("live events render through the same rows as the main transcript", () => {
  const v = viewer();
  v.setMaxRows(20);
  v.open(agent(), []);
  assert.equal(v.apply({ type: "text_delta", delta: "half a " }), true);
  v.apply({ type: "text_delta", delta: "sentence" });
  assert.equal(v.messageCount(), 1, "deltas share one streaming row");
  assert.match(strip(v.render(80)), /half a sentence/);

  v.apply(toolStart("t1", "read"));
  assert.equal(v.messageCount(), 2, "a tool start is a progress row");
  v.apply(toolDone("t1", "read"));
  assert.equal(v.messageCount(), 2, "its completion replaces the progress row");

  // Panel events are a side channel, not transcript rows.
  assert.equal(
    v.apply({ type: "agent_output", agentId: "a1", chunk: "x" }),
    false,
  );
});

test("reopening on another agent discards the previous transcript", () => {
  const v = viewer();
  v.setMaxRows(20);
  v.open(agent(), [text("first agent")]);
  v.open(agent({ id: "a2", task: "second" }), [text("second agent")]);
  const out = strip(v.render(80));
  assert.match(out, /second agent/);
  assert.ok(!out.includes("first agent"));
  assert.equal(v.messageCount(), 1);
});

test("it is a bounded window, not a growing transcript", () => {
  const v = viewer();
  v.setMaxRows(12);
  v.open(agent(), []);
  for (let i = 0; i < 100; i++) v.apply(text(`line ${i}`));

  const rows = v.render(80);
  assert.ok(rows.length <= 12, `rendered ${rows.length} rows for a 12-row budget`);
  // Following the tail: the newest line is on screen, the oldest is not.
  const out = strip(rows);
  assert.match(out, /line 99/);
  assert.ok(!out.includes("line 0\n"));
});

test("pgup scrolls back and pgdn/end returns to following the tail", () => {
  const v = viewer();
  v.setMaxRows(12);
  v.open(agent(), []);
  for (let i = 0; i < 100; i++) v.apply(text(`line ${i}`));
  v.render(80); // scroll math needs one measured frame

  v.handleInput(KEY_PGUP);
  v.handleInput(KEY_PGUP);
  assert.ok(!strip(v.render(80)).includes("line 99"), "scrolled off the tail");

  v.handleInput("G");
  assert.match(strip(v.render(80)), /line 99/);

  v.handleInput(KEY_PGUP);
  v.handleInput(KEY_PGDN);
  v.handleInput(KEY_PGDN);
  assert.match(strip(v.render(80)), /line 99/);
});

test("esc hands the main area back to the conversation", () => {
  let back = 0;
  const v = viewer({
    onBack: () => {
      back++;
    },
  });
  v.setMaxRows(20);
  v.open(agent(), []);
  v.handleInput(KEY_ESC);
  assert.equal(back, 1);
});

test("k stops a running agent and does nothing once it has settled", () => {
  const stopped: string[] = [];
  const v = viewer({ onStop: (id) => stopped.push(id) });
  v.setMaxRows(20);
  v.open(agent(), []);
  v.handleInput("k");
  assert.deepEqual(stopped, ["a1"]);

  v.update(agent({ status: "completed", endedAt: Date.now() }));
  v.handleInput("k");
  assert.deepEqual(stopped, ["a1"], "a settled agent has nothing to stop");
});

test("a roster refresh updates status but never disturbs the transcript", () => {
  const v = viewer();
  v.setMaxRows(20);
  v.open(agent(), [text("important output")]);

  v.update(agent({ status: "completed", endedAt: Date.now() }));
  const out = strip(v.render(80));
  assert.match(out, /completed/);
  assert.match(out, /important output/);

  // An update for a DIFFERENT agent must not retarget the view.
  v.update(agent({ id: "other", task: "someone else" }));
  assert.match(strip(v.render(80)), /Find every call site/);
  assert.equal(v.agentId(), "a1");
});

test("every rendered row fits the requested width", () => {
  const v = viewer();
  v.setMaxRows(12);
  v.open(agent({ task: "t".repeat(300) }), []);
  v.apply(text("x".repeat(400)));
  for (const row of v.render(60)) {
    assert.ok(
      row.replace(ANSI, "").length <= 60,
      `row overflowed: ${row.replace(ANSI, "").length}`,
    );
  }
});
