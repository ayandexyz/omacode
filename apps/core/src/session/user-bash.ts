// =============================================================================
// User bash (`!cmd` in the composer — pi's bash mode, Claude Code's `!`).
// The user runs a command themselves; its output becomes context for their
// NEXT prompt. It never starts a turn: the result is persisted as a
// `synthetic: "user_bash"` user message that the next loop loads with the
// rest of the history. `!!cmd` runs it without recording anything.
//
// While a turn is running the result is held and written once the turn ends,
// so it can never land between a tool call and its result, nor race the
// running loop's own appends to the session store and compaction transcript.
// =============================================================================

import { randomUUID } from "node:crypto";
import type { SerializedMessage } from "./store.js";

/** Tail kept for the model; a `!cat` of a big file must not flood the context. */
export const USER_BASH_MAX_CHARS = 20_000;

/** The text the model sees (pi's `bashExecutionToText`). */
export function formatUserBash(
  command: string,
  output: string,
  exitCode: number | null | undefined,
): string {
  let body = output.trim();
  if (body.length > USER_BASH_MAX_CHARS) {
    const dropped = body.length - USER_BASH_MAX_CHARS;
    body = `[… ${dropped} earlier chars truncated]\n` + body.slice(-USER_BASH_MAX_CHARS);
  }
  let text = `I ran \`${command}\` myself.\n`;
  text += body ? "```\n" + body + "\n```" : "(no output)";
  if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
    text += `\n\nCommand exited with code ${exitCode}`;
  }
  return text;
}

export function userBashMessage(text: string): SerializedMessage {
  return {
    id: randomUUID(),
    role: "user",
    parts: [{ type: "text", content: text }],
    timestamp: Date.now(),
    synthetic: "user_bash",
  };
}

const deferred = new Map<string, string[]>();

/** Hold a result until the session's running turn ends. */
export function deferUserBash(sessionId: string, text: string): void {
  const list = deferred.get(sessionId) ?? [];
  list.push(text);
  deferred.set(sessionId, list);
}

/** Results held for this session, in the order they ran; clears them. */
export function takeDeferredUserBash(sessionId: string): string[] {
  const list = deferred.get(sessionId) ?? [];
  deferred.delete(sessionId);
  return list;
}
