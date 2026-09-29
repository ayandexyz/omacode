import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { ToolResultMessage, type ToolResultMessageOptions } from "./tool-result-message.js";

function msg(over: Partial<ToolResultMessageOptions>): ToolResultMessage {
  return new ToolResultMessage({ toolCallId: "t1", toolName: "bash", args: {}, success: true, ...over });
}
const view = (m: ToolResultMessage, width = 100) => m.render(width).map(stripAnsi);

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const DIFF = ["  10 const a = 1;", "- 11 const b = 2;", "+ 11 const b = 3;"].join("\n");

test("a run with output is one collapsed row: caret, Run(command), duration", () => {
  const m = msg({ args: { command: "ls -la" }, result: lines(3), duration_ms: 1500 });
  const rows = view(m);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^▶ ● Run\(ls -la\) \(1\.5s\)$/);
  assert.equal(m.isToggleLine(0), true);
});

test("expanding a run shows Output, the first 5 lines and how many are hidden", () => {
  const m = msg({ args: { command: "seq 8" }, result: lines(8) });
  m.toggle();
  const rows = view(m);
  assert.equal(rows[0], "", "an expanded block is framed by blank lines");
  assert.match(rows[1], /^▼ ● Run\(seq 8\)/);
  assert.match(rows[2], /└─ Output/);
  assert.deepEqual(rows.slice(3, 8).map((r) => r.trim()), ["line 1", "line 2", "line 3", "line 4", "line 5"]);
  assert.match(rows[8], /… \+3 lines/);
  assert.equal(rows.at(-1), "");
  assert.equal(m.isToggleLine(1), true, "only the header toggles");
  assert.equal(m.isToggleLine(3), false, "a click in the body is a selection, not a collapse");
});

test("a multi-line command is flattened into one header row", () => {
  const rows = view(msg({ args: { command: "node -e '\n  console.log(1)\n'" }, result: "1" }));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /Run\(node -e ' console\.log\(1\) '\)/);
});

test("a read is a single bodyless row naming the file and the line range", () => {
  const file = path.join(process.cwd(), "src", "x.ts");
  const m = msg({ toolName: "read", args: { filePath: file, offset: 10, limit: 10 }, result: "contents" });
  const rows = view(m);
  assert.deepEqual(rows.length, 1);
  assert.match(rows[0], /^● Read\(src\/x\.ts:10-19\)$/, "cwd is stripped; no caret, nothing to expand");
  assert.equal(m.isToggleLine(0), false);
  assert.match(view(msg({ toolName: "read", args: { filePath: file, offset: 5 } }))[0], /x\.ts:5\+\)/);
});

test("an edit shows its diff at once: Update(file), stats, rows, never collapsible", () => {
  const m = msg({ toolName: "edit", args: { filePath: "/elsewhere/a.ts" }, result: DIFF });
  const rows = view(m);
  assert.match(rows[1], /^● Update\(\/elsewhere\/a\.ts\)/);
  assert.equal(rows[2], "└─ Added 1 line, removed 1 line");
  assert.match(rows[3], /^ {3} {2}10 const a = 1;/);
  assert.match(rows[4], /- 11 const b = 2;/);
  assert.equal(m.isToggleLine(1), false);
});

test("a long diff stops at 30 rows and says how many more", () => {
  const big = Array.from({ length: 40 }, (_, i) => `+ ${i + 1} line`).join("\n");
  const rows = view(msg({ toolName: "write", args: { filePath: "/a.ts" }, result: big }));
  assert.equal(rows[2], "└─ Added 40 lines");
  assert.equal(rows.filter((r) => /\+ \d+ line/.test(r)).length, 30);
  assert.ok(rows.some((r) => /… \+10 lines/.test(r)));
});

test("a markdown bullet list from a prose tool is output, not a 'Removed N lines' diff", () => {
  const m = msg({ toolName: "webfetch", args: { url: "https://x" }, result: "- one\n- two" });
  m.toggle();
  const screen = view(m).join("\n");
  assert.doesNotMatch(screen, /Removed|Added/);
  assert.match(screen, /- one/);
});

test("JSON {output} results are unwrapped for display", () => {
  const m = msg({ toolName: "grep", args: { pattern: "x" }, result: JSON.stringify({ title: "t", output: "a.ts:1:x" }) });
  m.toggle();
  const screen = view(m).join("\n");
  assert.match(screen, /a\.ts:1:x/);
  assert.doesNotMatch(screen, /"title"/);
});

test("a failed call shows ✖; a successful empty one says (no output)", () => {
  assert.match(view(msg({ success: false, args: { command: "false" }, result: "exit 1" }))[0], /✖ Run\(false\)/);
  const empty = msg({ args: { command: "true" } });
  empty.toggle();
  assert.ok(view(empty).some((r) => /└─ \(no output\)/.test(r)));
});

test("no rendered row is wider than the width it was given", () => {
  const cases = [
    msg({ args: { command: "x".repeat(300) }, result: "y".repeat(300) }),
    msg({ toolName: "edit", args: { filePath: "/a.ts" }, result: `+ 1 ${"z".repeat(300)}` }),
  ];
  for (const m of cases) {
    m.toggle();
    for (const width of [30, 80]) {
      for (const row of m.render(width)) assert.ok(stringWidth(stripAnsi(row)) <= width, `${width}: ${stripAnsi(row)}`);
    }
  }
});
