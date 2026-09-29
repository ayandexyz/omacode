// Every tool call on the wire must be answered by its result, immediately.
// Anthropic rejects a request with an unanswered `tool_use`, and the history
// is re-sent every turn, so one orphan fails every later request in the
// session. Borrowed from freebuff's context-pruning e2e check, as a unit test:
// no model is needed to see a broken pair.
//
// Why compaction cannot break a pair today: the loop persists each tool call
// AFTER it runs, with its result in the same stored message
// (`appendToolMessage`), and compaction keeps or drops whole messages. The
// in-memory history can briefly hold a call without a result, but a fresh
// AgentLoop is built per message and `run()` reloads from the store, so that
// state never reaches a later turn. These tests pin the conversion half of
// that argument.

import test from "node:test";
import assert from "node:assert/strict";
import { convertToCoreMessages } from "./utils.js";

let n = 0;
const user = (text: string) => ({ id: `u${n++}`, role: "user", parts: [{ type: "text", content: text }] });
const text = (content: string) => ({ id: `a${n++}`, role: "assistant", parts: [{ type: "text", content }] });
/** What `loadHistory` makes of a message `appendToolMessage` wrote. */
const tool = (name: string, result: string | undefined) => {
  const id = `m${n++}`;
  return {
    id,
    role: "assistant",
    parts: [{ type: "tool", tool: { id: `tool-${id}-0`, tool: name, args: {}, execution: "sequential" }, result }],
  };
};

function assertPaired(wire: any[]): void {
  wire.forEach((m, i) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    const calls = m.content.filter((c: any) => c.type === "tool-call").map((c: any) => c.toolCallId);
    if (calls.length === 0) return;
    const next = wire[i + 1];
    assert.equal(next?.role, "tool", `message ${i}: tool call(s) ${calls} not followed by a tool message`);
    const answered = next.content.map((r: any) => r.toolCallId);
    assert.deepEqual(answered, calls, `message ${i}: results do not answer the calls`);
  });
}

test("any whole-message subset of a persisted history converts to paired calls", () => {
  const history = [
    user("fix the bug"),
    text("Looking."),
    tool("read", "file contents"),
    tool("grep", "3 matches"),
    user("and the test"),
    tool("edit", "ok"),
    tool("bash", "1 passed"),
    text("Done."),
  ];
  // Compaction keeps the head (first prompt) plus recent messages; every
  // suffix, with and without the head, covers both shapes it produces.
  for (let cut = 0; cut < history.length; cut++) {
    for (const kept of [history.slice(cut), [history[0], ...history.slice(cut)]]) {
      assertPaired(convertToCoreMessages(kept as never));
    }
  }
});

test("a tool part with no result still reaches the wire answered, and says why", () => {
  const wire = convertToCoreMessages([user("go"), tool("bash", undefined), text("next")] as never) as any[];
  assertPaired(wire);
  const result = wire.find((m) => m.role === "tool").content[0];
  assert.match(result.output.value, /no result was recorded/);
});

test("an empty-string result is a real result, not a missing one", () => {
  const wire = convertToCoreMessages([user("go"), tool("bash", "")] as never) as any[];
  assert.equal(wire.find((m) => m.role === "tool").content[0].output.value, "");
});
