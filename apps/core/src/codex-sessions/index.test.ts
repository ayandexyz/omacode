import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createSessionStore } from "../session/store.js";
import { importCodexSession, listCodexSessions } from "./index.js";

const ID = "019f02c8-88b4-7a42-b778-a3cddb4eba12";

// Mirrors a real Codex rollout: the prompt and Codex's injected context
// (AGENTS.md, environment) are both response_item user messages.
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  const dir = path.join(home, "sessions", "2026", "06", "26");
  await fs.mkdir(dir, { recursive: true });
  const item = (payload: object) => ({
    timestamp: "2026-06-26T07:15:55.000Z",
    type: "response_item",
    payload,
  });
  const lines = [
    {
      type: "session_meta",
      payload: {
        id: ID,
        cwd: "/tmp/proj",
        timestamp: "2026-06-26T07:15:24.479Z",
      },
    },
    item({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "<permissions instructions>" }],
    }),
    item({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "# AGENTS.md instructions for /tmp/proj" },
      ],
    }),
    item({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<environment_context>\n  <cwd>/tmp/proj</cwd>",
        },
        { type: "input_text", text: "write the docs" },
      ],
    }),
    item({ type: "reasoning", summary: [] }),
    item({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Looking." }],
    }),
    item({
      type: "function_call",
      name: "exec_command",
      call_id: "c1",
      arguments: '{"cmd":"ls"}',
    }),
    item({ type: "function_call_output", call_id: "c1", output: "README.md" }),
    item({
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "c2",
      input: "*** Begin Patch",
    }),
    item({
      type: "custom_tool_call_output",
      call_id: "c2",
      output: "Success.",
    }),
    item({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Done." }],
    }),
  ];
  await fs.writeFile(
    path.join(dir, `rollout-2026-06-26T12-45-24-${ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  await fs.writeFile(
    path.join(home, "session_index.jsonl"),
    JSON.stringify({ id: ID, thread_name: "Write docs" }) + "\n",
  );
  const store = await createSessionStore(
    await fs.mkdtemp(path.join(os.tmpdir(), "fc-store-")),
  );
  return { home, store };
}

test("listCodexSessions reads meta, thread name and typed-turn count", async () => {
  const { home } = await fixture();
  const rows = await listCodexSessions({ codexHome: home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, ID);
  assert.equal(rows[0]!.title, "Write docs");
  assert.equal(rows[0]!.projectPath, "/tmp/proj");
  assert.equal(rows[0]!.turnCount, 1);
});

test("importCodexSession flattens to text, skips injected context, is idempotent", async () => {
  const { home, store } = await fixture();
  const id = await importCodexSession(store, ID, "openai", { codexHome: home });
  assert.equal(id, `codex_${ID}`);

  const msgs = await store.getMessages(id, "/tmp/proj");
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(msgs[0]!.parts[0]!.content, "write the docs");
  const reply = msgs[1]!.parts[0]!.content!;
  assert.match(reply, /^Looking\./);
  assert.match(
    reply,
    /\[Codex tool call: exec_command \{"cmd":"ls"\}\]\n\[result\]\nREADME\.md/,
  );
  assert.match(
    reply,
    /\[Codex tool call: apply_patch \*\*\* Begin Patch\]\n\[result\]\nSuccess\./,
  );
  assert.match(reply, /Done\.$/);
  assert.doesNotMatch(reply, /AGENTS|permissions|environment_context/);

  const meta = (await store.list()).find((m) => m.id === id)!;
  assert.equal(meta.title, "Write docs");

  await store.appendMessage(
    id,
    {
      id: "x",
      role: "user",
      parts: [{ type: "text", content: "more" }],
      timestamp: Date.now(),
    },
    "/tmp/proj",
  );
  assert.equal(
    await importCodexSession(store, ID, "openai", { codexHome: home }),
    id,
  );
  assert.equal((await store.getMessages(id, "/tmp/proj")).length, 3);
});

test("importCodexSession rejects an unknown id", async () => {
  const { home, store } = await fixture();
  await assert.rejects(
    importCodexSession(store, "nope", "openai", { codexHome: home }),
    /not found/,
  );
});
