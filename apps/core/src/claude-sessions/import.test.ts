import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createSessionStore } from "../session/store.js";
import { importClaudeSession } from "./import.js";

const ID = "44444444-4444-4444-4444-444444444444";

async function fixture(): Promise<{ claudeDir: string; store: Awaited<ReturnType<typeof createSessionStore>> }> {
  const claudeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-import-"));
  const dir = path.join(claudeDir, "projects", "-tmp-proj");
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    { type: "user", cwd: "/tmp/proj", isMeta: true, message: { role: "user", content: "caveat" } },
    { type: "user", cwd: "/tmp/proj", message: { role: "user", content: "read foo" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Reading." }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "foo" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "FOO BODY" }] } },
    { type: "assistant", message: { role: "assistant", content: "done" } },
  ];
  await fs.writeFile(path.join(dir, `${ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const store = await createSessionStore(await fs.mkdtemp(path.join(os.tmpdir(), "fc-store-")));
  return { claudeDir, store };
}

test("importClaudeSession flattens tools to text and merges same-role runs", async () => {
  const { claudeDir, store } = await fixture();
  const id = await importClaudeSession(store, ID, "anthropic", { claudeConfigDir: claudeDir });
  assert.equal(id, `cc_${ID}`);

  const msgs = await store.getMessages(id, "/tmp/proj");
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
  assert.equal(msgs[0]!.parts[0]!.content, "read foo");
  const reply = msgs[1]!.parts[0]!.content!;
  assert.ok(msgs.every((m) => m.parts.every((p) => p.type === "text")));
  assert.match(reply, /Reading\./);
  assert.match(reply, /\[Claude Code tool call: Read \{"file_path":"foo"\}\]\n\[result\]\nFOO BODY/);
  assert.match(reply, /done$/);
  assert.doesNotMatch(reply, /hm|caveat/);

  const meta = (await store.list()).find((m) => m.id === id)!;
  assert.equal(meta.projectPath, "/tmp/proj");
  assert.equal(meta.title, "read foo");
});

test("importClaudeSession is idempotent and keeps FreeCode-side turns", async () => {
  const { claudeDir, store } = await fixture();
  const id = await importClaudeSession(store, ID, "anthropic", { claudeConfigDir: claudeDir });
  await store.appendMessage(id, { id: "x", role: "user", parts: [{ type: "text", content: "continued in freecode" }], timestamp: Date.now() }, "/tmp/proj");

  assert.equal(await importClaudeSession(store, ID, "anthropic", { claudeConfigDir: claudeDir }), id);
  const msgs = await store.getMessages(id, "/tmp/proj");
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2]!.parts[0]!.content, "continued in freecode");
});

test("importClaudeSession rejects an unknown id", async () => {
  const { claudeDir, store } = await fixture();
  await assert.rejects(
    importClaudeSession(store, "nope", "anthropic", { claudeConfigDir: claudeDir }),
    /not found/,
  );
});
