// =============================================================================
// Wait policy — spec 2026-09-28-overnight-runs.md §4.7's table, one test per row.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SINGLE_WAIT_MS,
  MAX_UNKNOWN_PROBES,
  RESET_GRACE_MS,
  planQuotaWait,
  probeDelay,
  type WaitInput,
} from "./quota-wait.js";

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

const input = (over: Partial<WaitInput> = {}): WaitInput => ({
  scope: "window",
  now: NOW,
  probes: 0,
  waitedMs: 0,
  maxWaitMs: 12 * HOUR,
  provider: "anthropic",
  ...over,
});

test("a stated reset in the future is waited out, plus grace", () => {
  const plan = planQuotaWait(input({ resetAt: NOW + 2 * HOUR }));
  assert.equal(plan.action, "wait");
  assert.equal(plan.action === "wait" && plan.until, NOW + 2 * HOUR + RESET_GRACE_MS);
});

test("grace exists because hitting the reset to the second earns another 429", () => {
  const plan = planQuotaWait(input({ resetAt: NOW + 60_000 }));
  assert.ok(plan.action === "wait" && plan.until > NOW + 60_000);
});

test("a reset in the past is a stale header, not a wait until then", () => {
  // Would otherwise compute a negative wait and retry instantly, forever.
  const plan = planQuotaWait(input({ resetAt: NOW - HOUR }));
  assert.equal(plan.action, "wait");
  assert.equal(plan.action === "wait" && plan.until, NOW + probeDelay(0));
});

test("no reset at all falls back to an escalating probe", () => {
  const delays = [0, 1, 2, 3, 4, 5, 6].map((probes) => {
    const plan = planQuotaWait(input({ probes, maxWaitMs: 99 * HOUR }));
    return plan.action === "wait" ? (plan.until - NOW) / 60_000 : -1;
  });
  assert.deepEqual(delays, [1, 2, 4, 8, 16, 30, 30]);
});

test("one wait is capped at 24h however far out the provider says", () => {
  // A weekly limit reports days; sleeping on it hands back a laptop that did
  // nothing all week.
  const plan = planQuotaWait(
    input({ resetAt: NOW + 7 * 24 * HOUR, maxWaitMs: 99 * 24 * HOUR }),
  );
  assert.equal(plan.action === "wait" && plan.until, NOW + MAX_SINGLE_WAIT_MS);
});

test("credits abort immediately — no reset is ever coming", () => {
  const plan = planQuotaWait(input({ scope: "credits", resetAt: NOW + HOUR }));
  assert.equal(plan.action, "abort");
  assert.equal(plan.action === "abort" && plan.stopReason, "permanent_error");
  assert.match(plan.reason, /out of credit/);
});

test("an unknown scope is probed a few times, then treated as permanent", () => {
  for (let probes = 0; probes < MAX_UNKNOWN_PROBES; probes++) {
    assert.equal(planQuotaWait(input({ scope: "unknown", probes })).action, "wait");
  }
  const plan = planQuotaWait(input({ scope: "unknown", probes: MAX_UNKNOWN_PROBES }));
  assert.equal(plan.action, "abort");
  assert.equal(plan.action === "abort" && plan.stopReason, "permanent_error");
});

test("a known window is probed indefinitely — it is only a matter of when", () => {
  const plan = planQuotaWait(input({ scope: "window", probes: 20 }));
  assert.equal(plan.action, "wait");
});

test("the wait budget is checked against what the wait would cost", () => {
  // 11h already waited, a 2h wait proposed, 12h budget: refused BEFORE sleeping,
  // not discovered after.
  const plan = planQuotaWait(
    input({ resetAt: NOW + 2 * HOUR, waitedMs: 11 * HOUR, maxWaitMs: 12 * HOUR }),
  );
  assert.equal(plan.action, "abort");
  assert.equal(plan.action === "abort" && plan.stopReason, "wait_budget");
});

test("a wait that fits the budget is allowed", () => {
  const plan = planQuotaWait(
    input({ resetAt: NOW + HOUR, waitedMs: 10 * HOUR, maxWaitMs: 12 * HOUR }),
  );
  assert.equal(plan.action, "wait");
});

test("never sleep past the run's own deadline", () => {
  const plan = planQuotaWait(
    input({ resetAt: NOW + 3 * HOUR, until: NOW + 2 * HOUR }),
  );
  assert.equal(plan.action, "abort");
  assert.equal(plan.action === "abort" && plan.stopReason, "deadline");
});

test("a wait ending before the deadline is fine", () => {
  const plan = planQuotaWait(
    input({ resetAt: NOW + HOUR, until: NOW + 6 * HOUR }),
  );
  assert.equal(plan.action, "wait");
});

test("the budget is checked before the deadline when both would fire", () => {
  // Order is fixed so the reported reason sends the reader to the right knob.
  const plan = planQuotaWait(
    input({
      resetAt: NOW + 3 * HOUR,
      until: NOW + 2 * HOUR,
      waitedMs: 12 * HOUR,
      maxWaitMs: 12 * HOUR,
    }),
  );
  assert.equal(plan.action === "abort" && plan.stopReason, "wait_budget");
});
