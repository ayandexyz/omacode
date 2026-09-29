import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { codexArgs, codexComplete, codexUsage, JUDGE_OUTPUT_SCHEMA } from "./codex-complete.js";
import type { JudgeUsage } from "./core-complete.js";

const judge = { id: "judge-gpt", provider: "codex", model: "gpt-5.5" };

test("codexArgs pins the model, isolates from the owner's setup, and constrains the reply", () => {
  const a = codexArgs("gpt-5.5", "/tmp/d", "/tmp/s.json", "/tmp/o.json");
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(a[0], "exec");
  assert.equal(after("-m"), "gpt-5.5");
  assert.equal(after("-s"), "read-only");
  assert.equal(after("-C"), "/tmp/d");
  assert.equal(after("--output-schema"), "/tmp/s.json");
  assert.equal(after("-o"), "/tmp/o.json");
  for (const f of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--json"]) {
    assert.ok(a.includes(f), f);
  }
  for (const feature of ["hooks", "plugins", "apps", "multi_agent"]) {
    assert.ok(a.some((x, i) => x === "--disable" && a[i + 1] === feature), feature);
  }
  assert.equal(a.at(-1), "-", "the message is read from stdin, never argv");
});

test("the output schema is BuffBench's six fields, with scores bounded 0–10", () => {
  assert.deepEqual(JUDGE_OUTPUT_SCHEMA.required, [
    "analysis",
    "strengths",
    "weaknesses",
    "completionScore",
    "codeQualityScore",
    "overallScore",
  ]);
  const s = JUDGE_OUTPUT_SCHEMA.properties.overallScore;
  assert.equal(s.minimum, 0);
  assert.equal(s.maximum, 10);
  assert.match(s.description, /0 to 10 scale/);
});

test("codexUsage takes the turn.completed usage and ignores other events", () => {
  const jsonl = [
    '{"type":"thread.started"}',
    '{"type":"item.completed","item":{"type":"agent_message"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10367,"cached_input_tokens":1408,"output_tokens":146}}',
    "not json",
  ].join("\n");
  assert.deepEqual(codexUsage(jsonl), { inputTokens: 10367, outputTokens: 146 });
  assert.deepEqual(codexUsage(""), { inputTokens: 0, outputTokens: 0 });
});

// A fake `codex` that behaves like the real one: reads -o, writes the reply
// there, prints a turn.completed event. Proves stdin is closed (it would hang
// otherwise) and that the reply comes from the -o file, not stdout.
function fakeCodex(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  const bin = path.join(dir, "codex");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
const out = a[a.indexOf("-o") + 1];
${body}
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("codexComplete returns the -o file and records tokens", async () => {
  const bin = fakeCodex(`
require("fs").writeFileSync(out, '{"ok":true}');
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }));
`);
  const usage: JudgeUsage = {};
  const text = await codexComplete(usage, bin)(judge, "SYS", "PROMPT", new AbortController().signal);
  assert.equal(text, '{"ok":true}');
  assert.deepEqual(usage["judge-gpt"], { inputTokens: 5, outputTokens: 2, calls: 1 });
});

test("codexComplete rejects on a non-zero exit, with stderr in the reason", async () => {
  const bin = fakeCodex(`console.error("usage limit reached"); process.exit(1);`);
  await assert.rejects(
    codexComplete({}, bin)(judge, "S", "P", new AbortController().signal),
    /exited 1: usage limit reached/,
  );
});

test("codexComplete kills the process on abort", async () => {
  const bin = fakeCodex(`setTimeout(() => {}, 60000);`);
  const controller = new AbortController();
  const pending = codexComplete({}, bin)(judge, "S", "P", controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /exited null/);
});

test("a message over Linux's 128KB argument cap reaches codex whole, through stdin", async () => {
  const bin = fakeCodex(`
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  require("fs").writeFileSync(out, JSON.stringify({ bytes: input.length, tail: input.slice(-3) }));
});
`);
  const message = "x".repeat(300_000) + "END";
  const text = await codexComplete({}, bin)(judge, "SYS", message, new AbortController().signal);
  const got = JSON.parse(text);
  assert.equal(got.tail, "END");
  assert.ok(got.bytes > 300_000);
});
