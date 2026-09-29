import { test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { getDiffStats, getLanguageFromFilename, looksLikeDiff, renderDiff } from "./diff-view.js";

// The shape core's generateDiffString produces: indicator, line number, text.
const DIFF = [
  "  10 const a = 1;",
  "- 11 const b = 2;",
  "+ 11 const b = 3;",
  "+ 12 const c = 4;",
  "     …",
].join("\n");

test("looksLikeDiff needs an added or removed row, and scans past leading context", () => {
  assert.equal(looksLikeDiff(DIFF), true, "opens with a context line");
  assert.equal(looksLikeDiff("  10 only context\n  11 more"), false);
  assert.equal(looksLikeDiff("plain output\nno markers"), false);
});

test("looksLikeDiff also fires on a markdown bullet (why prose tools opt out)", () => {
  // Pinned so the opt-out in tool-result-message.ts stays necessary and known.
  assert.equal(looksLikeDiff("- a bullet\n- another"), true);
});

test("getDiffStats counts added and removed rows only", () => {
  assert.deepEqual(getDiffStats(DIFF), { added: 2, removed: 1 });
  assert.deepEqual(getDiffStats(""), { added: 0, removed: 0 });
});

test("getLanguageFromFilename maps extensions, case-insensitively, and knows when it does not know", () => {
  assert.equal(getLanguageFromFilename("a/b.TS"), "typescript");
  assert.equal(getLanguageFromFilename("x.tsx"), "typescript");
  assert.equal(getLanguageFromFilename("x.yml"), "yaml");
  assert.equal(getLanguageFromFilename("x.hpp"), "cpp");
  assert.equal(getLanguageFromFilename("Makefile"), undefined);
  assert.equal(getLanguageFromFilename("x.unknownext"), undefined);
  assert.equal(getLanguageFromFilename(undefined), undefined);
});

test("renderDiff keeps one row per line and the text intact, with or without highlighting", () => {
  for (const filename of [undefined, "a.ts"]) {
    const rows = renderDiff(DIFF, 60, filename).map(stripAnsi);
    assert.equal(rows.length, 5);
    assert.equal(rows[0], "  10 const a = 1;", `context row, ${filename ?? "no language"}`);
    assert.equal(rows[1].trimEnd(), "- 11 const b = 2;");
    assert.equal(rows[2].trimEnd(), "+ 11 const b = 3;");
    assert.equal(rows[4], "     …", "a non-diff row passes through");
  }
});

test("renderDiff pads added and removed rows to the full width, so the background spans it", () => {
  const rows = renderDiff(DIFF, 40);
  for (const i of [1, 2, 3]) assert.equal(stringWidth(stripAnsi(rows[i])), 40, `row ${i}`);
  assert.ok(stringWidth(stripAnsi(rows[0])) < 40, "context rows are not padded");
});

test("renderDiff never exceeds the width, even for a long line", () => {
  const long = `+ 1 ${"x".repeat(200)}`;
  for (const width of [10, 40, 80]) {
    for (const row of renderDiff(`${long}\n  2 ${"y".repeat(200)}\nplain ${"z".repeat(200)}`, width, "a.ts")) {
      assert.ok(stringWidth(stripAnsi(row)) <= width, `width ${width}`);
    }
  }
});
