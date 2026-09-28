// =============================================================================
// When a spent quota is worth waiting out, and for how long.
//
// PURE: no clock of its own (`now` is passed in), no sleeping, no IO. The
// orchestrator owns the waiting; this owns the policy, so every branch — a
// reset in the past, a weekly limit beyond the deadline, a probe that keeps
// failing — is a table test rather than a night nobody watched.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.7, §5.2
// =============================================================================

import type { QuotaScope } from "../agent/recovery/manager.js";

/**
 * Added to a provider's stated reset before retrying. A reset time is the
 * moment the allowance returns, and hitting it to the second earns another
 * 429 on clock skew alone.
 */
export const RESET_GRACE_MS = 60_000;

/**
 * One wait never exceeds a day, whatever the provider claims. A weekly limit
 * reports a reset days out; sleeping on it would hand back a laptop that did
 * nothing all week. `--max-wait` and `--until` usually abort first.
 */
export const MAX_SINGLE_WAIT_MS = 24 * 60 * 60 * 1000;

/** Probe backoff when the provider gave no usable reset: 1, 2, 4 … 30 min. */
export const FIRST_PROBE_MS = 60_000;
export const MAX_PROBE_MS = 30 * 60 * 1000;

/**
 * A scope we cannot identify might not be a window at all, so it is probed a
 * few times and then treated as permanent rather than waited on forever.
 */
export const MAX_UNKNOWN_PROBES = 3;

export type WaitPlan =
  | { action: "wait"; until: number; reason: string }
  | {
      action: "abort";
      stopReason: "permanent_error" | "wait_budget" | "deadline";
      reason: string;
    };

export interface WaitInput {
  scope: QuotaScope;
  /** Epoch ms the provider said the allowance returns, if it said. */
  resetAt?: number;
  now: number;
  /** Consecutive probes already spent on this iteration, 0 on the first. */
  probes: number;
  /** Everything this run has already spent waiting. */
  waitedMs: number;
  maxWaitMs: number;
  /** The run's wall-clock deadline (`--until`), if it has one. */
  until?: number;
  provider: string;
}

export function planQuotaWait(input: WaitInput): WaitPlan {
  const { scope, now, probes, waitedMs, maxWaitMs, until, provider } = input;

  // Money, not time. No reset will ever come, so waiting only wastes the night.
  if (scope === "credits") {
    return {
      action: "abort",
      stopReason: "permanent_error",
      reason: `${provider} reports the account is out of credit — waiting cannot fix that`,
    };
  }

  if (scope === "unknown" && probes >= MAX_UNKNOWN_PROBES) {
    return {
      action: "abort",
      stopReason: "permanent_error",
      reason: `${provider} refused ${probes} probes without naming a reset — treating it as permanent`,
    };
  }

  // A reset in the past is a stale header (or a skewed clock), not a wait.
  const stated =
    input.resetAt !== undefined && input.resetAt > now
      ? input.resetAt + RESET_GRACE_MS
      : undefined;
  const target = stated ?? now + probeDelay(probes);
  const capped = Math.min(target, now + MAX_SINGLE_WAIT_MS);
  const waitMs = capped - now;

  // Both budgets are checked against what the wait WOULD cost, before it
  // starts. Discovering the overrun afterwards is not a budget.
  if (waitedMs + waitMs > maxWaitMs) {
    return {
      action: "abort",
      stopReason: "wait_budget",
      reason: `waiting for ${provider} would exceed the run's total wait budget`,
    };
  }
  if (until !== undefined && capped >= until) {
    return {
      action: "abort",
      stopReason: "deadline",
      reason: `${provider} does not reset before the run's deadline — stopping instead of sleeping past it`,
    };
  }

  return {
    action: "wait",
    until: capped,
    reason: stated
      ? `waiting for the ${provider} window`
      : `${provider} named no reset — probing again`,
  };
}

/** 1, 2, 4, 8, 16, 30, 30 … minutes. */
export function probeDelay(probes: number): number {
  return Math.min(FIRST_PROBE_MS * 2 ** probes, MAX_PROBE_MS);
}
