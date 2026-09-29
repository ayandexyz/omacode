import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { countTestFiles, judge, parseSummary } from "./test-guard.mjs";

test("parseSummary reads both node:test formats: TAP (CI, Node 22) and ℹ (newer Node)", () => {
  assert.deepEqual(parseSummary("ok 1 - x\n# tests 12\n# pass 12\n# fail 0\n# cancelled 0\n"), {
    tests: 12,
    fail: 0,
    cancelled: 0,
  });
  assert.deepEqual(parseSummary("✔ x\nℹ tests 7\nℹ pass 6\nℹ fail 1\nℹ cancelled 0\n"), {
    tests: 7,
    fail: 1,
    cancelled: 0,
  });
  assert.equal(parseSummary("no summary here").tests, undefined);
  assert.equal(parseSummary("  # tests in this file are slow\n").tests, undefined, "prose is not a count");
});

const base = { tests: 100, files: 10 };
const ok = { exitCode: 0, tests: 100, files: 10 };

test("judge passes at the baseline and only notes growth", () => {
  assert.deepEqual(judge("core", ok, base), { problems: [], notes: [] });
  const grown = judge("core", { ...ok, tests: 120, files: 11 }, base);
  assert.deepEqual(grown.problems, []);
  assert.match(grown.notes[0], /baseline is stale/);
});

test("judge fails a drop in tests or files, a failing script, and a suite that ran nothing", () => {
  assert.match(judge("core", { ...ok, tests: 60 }, base).problems[0], /60 tests ran, baseline is 100 \(40 missing\)/);
  assert.match(judge("core", { ...ok, files: 9 }, base).problems[0], /9 test files, baseline is 10/);
  assert.match(judge("core", { ...ok, exitCode: 1 }, base).problems[0], /exited 1/);
  assert.match(judge("core", { ...ok, tests: 0 }, base).problems[0], /ran no tests \(summary says 0\)/);
  assert.match(judge("core", { ...ok, tests: undefined }, base).problems[0], /summary missing/);
});

test("judge without a baseline still fails an empty run, and asks for one", () => {
  const v = judge("new", { exitCode: 0, tests: 0, files: 0 }, undefined);
  assert.equal(v.problems.length, 2);
  assert.match(v.notes[0], /no baseline recorded/);
});

test("countTestFiles finds *.test.ts(x) and skips node_modules", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  fs.mkdirSync(path.join(d, "a", "node_modules"), { recursive: true });
  for (const f of ["x.test.ts", "a/y.test.tsx", "a/z.ts", "a/node_modules/w.test.ts"]) {
    fs.writeFileSync(path.join(d, f), "");
  }
  assert.equal(countTestFiles(d), 2);
});
