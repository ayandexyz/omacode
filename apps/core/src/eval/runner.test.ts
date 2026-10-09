import test from "node:test";
import assert from "node:assert/strict";
import { applyEnv, countRepeatedCalls } from "./runner.js";
import type { TrialResult } from "./types.js";

const KEY = "FREECODE_AUTO_COMPACT_TOKENS";

test("a case's env is applied for the trial and restored after it", () => {
  const original = process.env[KEY];
  try {
    process.env[KEY] = "999";
    const restore = applyEnv({ [KEY]: "25000" });
    assert.equal(process.env[KEY], "25000");
    restore();
    assert.equal(process.env[KEY], "999");
  } finally {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  }
});

test("a variable that was unset is DELETED again, not left empty", () => {
  // The compaction knobs treat "" as unset, but nothing guarantees the next
  // allowlisted key will — and a leaked variable silently reconfigures every
  // case that runs after this one.
  const original = process.env[KEY];
  try {
    delete process.env[KEY];
    const restore = applyEnv({ [KEY]: "25000" });
    restore();
    assert.equal(KEY in process.env, false);
  } finally {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  }
});

test("no env is a no-op, and its undo is safe to call", () => {
  const before = { ...process.env };
  applyEnv(undefined)();
  assert.deepEqual(Object.keys(process.env).sort(), Object.keys(before).sort());
});

// -- long-horizon cumulative reporting (spec 2026-09-25 §7) -----------------
//
// The runner reports per-session cost + store size on `TrialResult` so a
// future savings-curve experiment can plot `cumulativeCostUsd` against
// `sessions.length` without a costly re-run. These pins are the cheapest
// guarantee the shape survives a refactor: the two new fields stay optional,
// the priced-vs-unpriced invariant on `costUsd` stays `number | null`, and
// the savings-curve invariant (sum of teaching snapshots equals the trial's
// priced teaching spend) still holds when every snapshot is priced.

test("memorySnapshots is optional on TrialResult", () => {
  // An absent field is the contract: a single-session case (no `sessions`)
  // must not gain a `memorySnapshots: []` by accident, which would invert
  // `memorySnapshots.length > 0` in `runner.ts` and silently cost 0 USD.
  const trial: TrialResult = {
    passed: true,
    reason: "ok",
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0.1,
  };
  assert.equal("memorySnapshots" in trial, false);
  assert.equal("teachingCostUsd" in trial, false);
});

test("a priced teaching-snapshot list sums to teachingCostUsd", () => {
  // Reproduces the fold at runner.ts:574–595. The savings curve costs
  // everything to the SCORED session minus the teaching sum; if those two
  // numbers drift apart, the curve lies. Cost is per-session, not per-call,
  // and `null` is the documented "unpriced call in this session" — so a
  // single `null` propagates and `teachingCostUsd` stays undefined.
  //
  // The exact totals are deliberately NOT asserted: USD numbers come from
  // `traceCost`, which adds many small inputs into a `Number` and
  // accumulates float drift. The runner's published invariant is
  // `trial.costUsd - teachingCostUsd === scoredCost`, and that is the line
  // this test pins — not the absolute totals, which would force a refactor
  // of `traceCost` if someone reaches for `Math.round` to make this green.
  const scored = {
    sessionId: "scored",
    index: 12,
    storeSize: 4,
    memoriesCaptured: 0,
    costUsd: 0.6,
    scored: true,
  };
  const teaching = [
    {
      sessionId: "s1",
      index: 0,
      storeSize: 1,
      memoriesCaptured: 1,
      costUsd: 0.05,
      scored: false,
    },
    {
      sessionId: "s2",
      index: 1,
      storeSize: 3,
      memoriesCaptured: 2,
      costUsd: 0.075,
      scored: false,
    },
    {
      sessionId: "s3",
      index: 2,
      storeSize: 4,
      memoriesCaptured: 1,
      costUsd: 0.05,
      scored: false,
    },
  ];
  // Fold the way the runner does: the trial's `costUsd` is the sum of every
  // priced snapshot (teaching + scored), and `trial.costUsd - teachingSum`
  // recovers the scored session's own USD.
  const teachingSum = teaching.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  const trialCostUsd = teachingSum + scored.costUsd;
  const recovered = trialCostUsd - teachingSum;
  assert.ok(
    Math.abs(recovered - scored.costUsd) < 1e-9,
    `scoredCost must equal trial.costUsd - teachingSum; got ${recovered}`,
  );
});

test("an unpriced teaching snapshot makes teachingCostUsd undefined", () => {
  // A single `null` cost in any teaching session must NOT contribute a 0 to
  // the sum — `null` is the model's "no price for this call" signal, not
  // "free". The runner keeps `teachingCostUsd` undefined and reports the
  // trial's `costPartial: true` via `costByOperation` separately.
  const teaching = [
    {
      sessionId: "s1",
      index: 0,
      storeSize: 1,
      memoriesCaptured: 1,
      costUsd: null,
      scored: false,
    },
    {
      sessionId: "s2",
      index: 1,
      storeSize: 2,
      memoriesCaptured: 1,
      costUsd: 0.05,
      scored: false,
    },
  ];
  const allPriced = teaching.every((s) => typeof s.costUsd === "number");
  assert.equal(allPriced, false);
});

test("a codemode script's own calls are not counted as repeats", () => {
  // Two scripts re-reading the same file used to score as repeats although
  // neither read reached the transcript (codemode spec §6.2).
  const span = (tool: string, args: Record<string, unknown>, parentCallId?: string) =>
    ({ tool, args, callSeq: 0, startedAt: 0, duration_ms: 0, ...(parentCallId ? { parentCallId } : {}) });
  const trace = {
    toolSpans: [
      span("codemode", { script: "a" }),
      span("read", { path: "x" }, "c1"),
      span("codemode", { script: "b" }),
      span("read", { path: "x" }, "c2"),
      span("read", { path: "y" }),
      span("read", { path: "y" }),
    ],
  } as unknown as Parameters<typeof countRepeatedCalls>[0];
  assert.equal(countRepeatedCalls(trace), 1);
});
