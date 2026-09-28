// =============================================================================
// The morning report — spec 2026-09-28-overnight-runs.md §4.10, §7.
//
// The report is what a night is FOR: nobody watched it happen, so this file is
// the only account of it. These tests are mostly about order and omission.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { duration, renderReport, type ReportInput } from "./report.js";
import type { Decision, IterationRecord, WaitRecord } from "./types.js";

const iteration = (over: Partial<IterationRecord> = {}): IterationRecord => ({
  kind: "iteration",
  n: 1,
  sessionId: "sess-1",
  startedAt: 1_000,
  endedAt: 2_000,
  turns: 4,
  ...over,
});

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  runId: "7f3c",
  status: "stopped",
  provider: "anthropic",
  model: "claude-opus-5",
  usd: 3.84,
  startedAt: 0,
  endedAt: 9 * 3_600_000,
  night: {
    objective: "reduce the TUI's render cost",
    branch: "night/reduce-the-tui-render-cost",
    iterations: 2,
    commits: ["abc1234def"],
    waitedMs: 0,
    fallbackIterations: [],
    stopReason: "deadline",
  },
  records: [iteration({ n: 1, commit: "abc1234def", summary: "cache wrapped lines" })],
  decisions: [],
  ...over,
});

test("the title and headline say what happened without scrolling", () => {
  const md = renderReport(input());
  assert.match(md, /^# Night run 7f3c — reduce the TUI's render cost/);
  assert.match(md, /Stopped: deadline/);
  assert.match(md, /9h00m/);
  assert.match(md, /\$3\.84/);
  assert.match(md, /anthropic\/claude-opus-5/);
});

test("needs-you comes first, before anything the run achieved", () => {
  const md = renderReport(
    input({
      decisions: [
        { kind: "needs_human", iteration: 6, at: 1, item: "regenerate golden files?" },
        { kind: "denied", iteration: 4, at: 1, tool: "bash", rule: "Bash(git commit:*)" },
        {
          kind: "decided",
          iteration: 3,
          at: 1,
          question: "memoise where?",
          choice: "per line",
          why: "fewer invalidations",
          reversible: true,
        },
      ],
    }),
  );
  assert.ok(
    md.indexOf("## Needs you") < md.indexOf("## Decisions made for you"),
    "needs-you must precede decisions",
  );
  assert.ok(
    md.indexOf("## Decisions made for you") < md.indexOf("## Refused actions"),
  );
  assert.ok(md.indexOf("## Refused actions") < md.indexOf("## Iterations"));
  assert.match(md, /regenerate golden files\?/);
});

test("an empty needs-you section still appears, so its absence is a statement", () => {
  // A section that vanishes when empty is indistinguishable from one that was
  // dropped by a bug.
  const md = renderReport(input());
  assert.match(md, /## Needs you \(0\)\nNothing is waiting on you\./);
});

test("irreversible decisions sort above reversible ones", () => {
  const md = renderReport(
    input({
      decisions: [
        { kind: "decided", iteration: 1, at: 1, question: "q1", choice: "reversible one", why: "", reversible: true },
        { kind: "decided", iteration: 2, at: 1, question: "q2", choice: "permanent one", why: "", reversible: false },
      ],
    }),
  );
  // If the reader stops after one line it should be the one they may have to undo.
  assert.ok(md.indexOf("permanent one") < md.indexOf("reversible one"));
  assert.match(md, /permanent one — NOT reversible/);
});

test("a question asked but never answered is shown, not hidden", () => {
  const md = renderReport(
    input({
      decisions: [
        { kind: "asked", iteration: 9, at: 1, questions: ["drop the legacy theme?"] },
      ],
    }),
  );
  assert.match(md, /asked "drop the legacy theme\?" — answer not recorded/);
});

test("an ask the model went on to decide is not reported as unanswered", () => {
  const decisions: Decision[] = [
    { kind: "asked", iteration: 3, at: 1, questions: ["memoise where?"] },
    {
      kind: "decided",
      iteration: 3,
      at: 2,
      question: "where should memoisation live",
      choice: "per line",
      why: "fewer invalidations",
      reversible: true,
    },
  ];
  const md = renderReport(input({ decisions }));
  assert.doesNotMatch(md, /answer not recorded/);
});

test("waits are accounted for — a night can be three commits and eight hours of sleep", () => {
  const wait: WaitRecord = {
    kind: "wait",
    n: 2,
    from: 0,
    until: 2 * 3_600_000,
    reason: "waiting for the anthropic window",
    provider: "anthropic",
  };
  const md = renderReport(
    input({
      night: { ...input().night, waitedMs: 2 * 3_600_000 },
      records: [iteration({ n: 1, commit: "abc1234def" }), wait, iteration({ n: 2, commit: "def5678abc" })],
    }),
  );
  assert.match(md, /waited 2h00m on quota/);
  assert.match(md, /## Waits \(1\)/);
  assert.match(md, /⏸ +waited 2h00m/);
});

test("the iteration list distinguishes committed, failed and notes-only", () => {
  const md = renderReport(
    input({
      records: [
        iteration({ n: 1, commit: "abc1234def", summary: "cached the tree" }),
        iteration({ n: 2, failure: "no_finish" }),
        iteration({ n: 3, summary: "learned the parser is the slow path" }),
      ],
    }),
  );
  assert.match(md, / 1 ✓ abc1234 {2}cached the tree/);
  assert.match(md, / 2 ✗ +no_finish/);
  assert.match(md, / 3 · \(notes\) {2}learned the parser is the slow path/);
});

test("the review block hands over the exact commands, including how to discard it all", () => {
  const md = renderReport(input());
  assert.match(md, /git log --oneline main\.\.night\/reduce-the-tui-render-cost/);
  assert.match(md, /freecode trace sess-1/);
  assert.match(md, /git branch -D night\/reduce-the-tui-render-cost/);
});

test("the review range starts at the recorded branch point, not main", () => {
  // The first live night branched off `autonomous`; `main..branch` listed
  // every commit on that branch as if the night had made them.
  const md = renderReport(
    input({ night: { ...input().night, baseCommit: "0123456789abcdef" } }),
  );
  assert.match(md, /git log --oneline 0123456789ab\.\.night\/reduce-the-tui-render-cost/);
  assert.match(md, /git diff 0123456789ab\.\.\.night\/reduce-the-tui-render-cost --stat/);
  assert.doesNotMatch(md, /main\.\./);
});

test("a run with no --verify says so rather than implying the commits were checked", () => {
  assert.match(renderReport(input()), /NOT verified \(no --verify\)/);
  assert.match(
    renderReport(input({ night: { ...input().night, verifyCommand: "pnpm test" } })),
    /verified with `pnpm test`/,
  );
});

test("an unpriced model reports unknown, never $0", () => {
  // A zero would read as a free night, which is a different claim entirely.
  const md = renderReport(input({ usd: undefined }));
  assert.match(md, /cost unknown \(model not priced\)/);
  assert.doesNotMatch(md, /\$0\.00/);
});

test("uncommitted work is called out with why it was left", () => {
  const md = renderReport(
    input({ night: { ...input().night, uncommitted: ["src/a.ts", "src/b.ts"] } }),
  );
  assert.match(md, /## Uncommitted \(2 paths\)/);
  assert.match(md, /must never destroy work/);
  assert.match(md, /- src\/a\.ts/);
});

test("the same input always renders the same report", () => {
  // The report is regenerated from the logs after a crash, so a regenerated one
  // must equal the one the run would have written.
  const i = input();
  assert.equal(renderReport(i), renderReport(i));
});

test("duration reads as a human would say it", () => {
  assert.equal(duration(0), "0m");
  assert.equal(duration(90_000), "2m");
  assert.equal(duration(3_600_000), "1h00m");
  assert.equal(duration(9 * 3_600_000 + 2 * 60_000), "9h02m");
  assert.equal(duration(-5), "0m");
});
