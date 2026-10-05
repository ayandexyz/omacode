import test from "node:test";
import assert from "node:assert/strict";
import type { SerializedMessage } from "./store.js";
import { carryCodemodeStore, keepLastNUserTurns } from "./compact-apply.js";

function msg(role: SerializedMessage["role"], text: string): SerializedMessage {
  return {
    id: `${role}-${text}`,
    role,
    parts: [{ type: "text", content: text }],
    timestamp: 0,
  };
}

test("keepLastNUserTurns keeps the last N user turns and everything after", () => {
  const messages = [
    msg("user", "u1"),
    msg("assistant", "a1"),
    msg("user", "u2"),
    msg("assistant", "a2"),
    msg("user", "u3"),
    msg("assistant", "a3"),
  ];

  const kept = keepLastNUserTurns(messages, 2);
  assert.deepEqual(
    kept.map((m) => m.id),
    ["user-u2", "assistant-a2", "user-u3", "assistant-a3"],
  );
  // Still starts on a user turn → valid conversation.
  assert.equal(kept[0].role, "user");
});

test("keepLastNUserTurns keeps everything when fewer than N user turns", () => {
  const messages = [msg("user", "u1"), msg("assistant", "a1")];
  assert.deepEqual(keepLastNUserTurns(messages, 2), messages);
});

test("keepLastNUserTurns with n<=0 keeps nothing", () => {
  assert.deepEqual(keepLastNUserTurns([msg("user", "u1")], 0), []);
});

test("keepLastNUserTurns falls back to the last N assistant turns on a single-prompt history", () => {
  const messages = [
    msg("user", "prompt"),
    msg("assistant", "t1"),
    msg("assistant", "t2"),
    msg("assistant", "t3"),
    msg("assistant", "t4"),
  ];
  assert.deepEqual(
    keepLastNUserTurns(messages, 2).map((m) => m.id),
    ["user-prompt", "assistant-t3", "assistant-t4"],
  );
  // Nothing before the tail to drop → untouched.
  assert.equal(keepLastNUserTurns(messages.slice(0, 3), 2).length, 3);
});

test("carryCodemodeStore moves the latest store snapshot into the preserved tail", () => {
  const old = msg("assistant", "script");
  old.parts[0] = { ...old.parts[0], codemodeStore: { cursor: 1 } };
  const newer = msg("assistant", "script 2");
  newer.parts[0] = { ...newer.parts[0], codemodeStore: { cursor: 2 } };
  const tail = [msg("user", "q"), msg("assistant", "a")];
  const out = carryCodemodeStore([old, newer, ...tail], tail);
  assert.deepEqual(out[0].parts[0].codemodeStore, { cursor: 2 });
  assert.equal(tail[0].parts[0].codemodeStore, undefined, "input not mutated");
});

test("carryCodemodeStore leaves a tail that already has a snapshot alone", () => {
  const kept = msg("assistant", "script");
  kept.parts[0] = { ...kept.parts[0], codemodeStore: { cursor: 3 } };
  const dropped = msg("assistant", "old");
  dropped.parts[0] = { ...dropped.parts[0], codemodeStore: { cursor: 1 } };
  const tail = [msg("user", "q"), kept];
  assert.equal(carryCodemodeStore([dropped, ...tail], tail), tail);
});
