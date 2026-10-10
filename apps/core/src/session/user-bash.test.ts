// `!cmd` / `!!cmd` (session/user-bash.ts): the result is recorded as a
// `user_bash` message for the next turn and never starts one; `!!` records
// nothing. Goes through handleRequest with a real store, like navigate.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../server.js";
import { getAppRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import {
  USER_BASH_MAX_CHARS,
  deferUserBash,
  formatUserBash,
  takeDeferredUserBash,
} from "./user-bash.js";

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const res = (await handleRequest({ jsonrpc: "2.0", id: 1, method, params })) as any;
  if (res.error) throw new Error(res.error.message);
  return res.result;
}

test("session.bash records `!` output for the next turn and nothing for `!!`", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-bang-"));
  const { sessionId } = await rpc("session.start", { projectPath, provider: "anthropic" });
  const store = await getAppRuntime().runPromise(SessionStoreTag);
  try {
    const ran = await rpc("session.bash", { sessionId, command: "pwd; exit 3" });
    assert.equal(ran.exitCode, 3);
    assert.equal(ran.deferred, false);
    assert.match(ran.output, new RegExp(projectPath), "runs in the session's project");

    await rpc("session.bash", { sessionId, command: "echo hidden", exclude: true });

    const messages = await store.getMessages(sessionId, projectPath);
    assert.equal(messages.length, 1, "`!!` is not recorded");
    const [msg] = messages;
    assert.equal(msg!.role, "user");
    assert.equal(msg!.synthetic, "user_bash");
    const body = msg!.parts[0]!.content!;
    assert.match(body, /I ran `pwd; exit 3`/);
    assert.match(body, /exited with code 3/);
  } finally {
    await rpc("session.delete", { sessionId, purge: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
});

test("formatUserBash keeps the tail of long output and says so", () => {
  const text = formatUserBash("cat big", "x".repeat(USER_BASH_MAX_CHARS) + "END", 0);
  assert.match(text, /\[… 3 earlier chars truncated\]/);
  assert.match(text, /END\n```$/);
  assert.equal(formatUserBash("true", "", 0), "I ran `true` myself.\n(no output)");
});

test("results held during a turn come back once, in order", () => {
  deferUserBash("s1", "a");
  deferUserBash("s1", "b");
  assert.deepEqual(takeDeferredUserBash("s1"), ["a", "b"]);
  assert.deepEqual(takeDeferredUserBash("s1"), []);
});
