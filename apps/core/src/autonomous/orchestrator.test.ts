// =============================================================================
// The night's state machine, with every effect faked: no provider, no git, no
// clock. Spec: docs/specs/2026-09-28-overnight-runs.md §7 (unit).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import {
  commitMessage,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_WAIT_MS,
  runNight,
  type NightLimits,
  type OrchestratorDeps,
} from "./orchestrator.js";
import type {
  FinishIterationResult,
  IterationFailureReason,
  IterationRecord,
} from "./types.js";

test("conventional commit preset stays machine-parseable", () => {
  assert.equal(commitMessage(4, "speed up rendering"), "night 4: speed up rendering");
  assert.equal(
    commitMessage(4, "speed up rendering", "conventional"),
    "chore(night): speed up rendering",
  );
});

function finish(
  over: Partial<FinishIterationResult> = {},
): FinishIterationResult {
  return {
    success: true,
    summary: "did a thing",
    keyChanges: ["changed a file"],
    keyLearnings: [],
    decisions: [],
    needsHuman: [],
    shouldStop: false,
    ...over,
  };
}

interface Harness {
  deps: OrchestratorDeps;
  records: IterationRecord[];
  notes: string[];
  lines: string[];
  slept: Array<{ until: number }>;
  resets: number;
  commitCalls: string[];
  clock: { now: number };
  stop: { graceful: boolean; hard: boolean };
}

function harness(opts: {
  /** One entry per iteration; the last is reused if the run goes longer. */
  outcomes: Array<{
    finish?: FinishIterationResult;
    failure?: IterationFailureReason;
    quota?: { scope: "window" | "credits" | "unknown"; resetAt?: number; provider: string };
    usd?: number;
  }>;
  verify?: boolean[];
  dirty?: boolean | boolean[];
  commit?: Array<{ ok: true; hash: string; filesChanged: number } | { ok: false; error: string }>;
}): Harness {
  const records: IterationRecord[] = [];
  const notes: string[] = [];
  const lines: string[] = [];
  const commitCalls: string[] = [];
  const slept: Array<{ until: number }> = [];
  const clock = { now: 1_000 };
  const stop = { graceful: false, hard: false };
  let resets = 0;
  let dirtyCall = 0;
  let commitCall = 0;
  let attempt = 0;
  let verifyCall = 0;

  const h: Harness = {
    records,
    notes,
    lines,
    slept,
    get resets() {
      return resets;
    },
    commitCalls,
    clock,
    stop,
    deps: {
      async runIteration({ iteration }) {
        // Indexed by ATTEMPT, not by iteration number: a wait retries the same
        // number, and the retry must be able to succeed where the first failed.
        const o = opts.outcomes[attempt] ?? opts.outcomes[opts.outcomes.length - 1]!;
        attempt += 1;
        clock.now += 60_000;
        return {
          sessionId: `s-${iteration}`,
          finish: o.finish,
          failure: o.failure,
          quota: o.quota,
          turns: 4,
          usd: o.usd,
        };
      },
      git: {
        async dirtyPaths() {
          const d = opts.dirty ?? true;
          const value = Array.isArray(d) ? (d[dirtyCall++] ?? d[d.length - 1]!) : d;
          return value ? ["src/a.ts"] : [];
        },
        async commitAll(message) {
          commitCalls.push(message);
          const scripted = opts.commit?.[commitCall];
          commitCall += 1;
          return scripted ?? { ok: true, hash: `hash${commitCall}`, filesChanged: 1 };
        },
        async reset() {
          resets += 1;
        },
      },
      notes: {
        read: () => notes.join("\n"),
        append: (s) => notes.push(s),
      },
      ...(opts.verify
        ? {
            verify: async () => {
              const ok = opts.verify![verifyCall++] ?? true;
              return { ok, output: ok ? "all good" : "3 tests failed\nassert: 1 !== 2" };
            },
          }
        : {}),
      sleepUntil: async (until) => {
        slept.push({ until });
        clock.now = until; // the fake clock jumps the whole wait
      },
      record: (r) => records.push(r as IterationRecord),
      decision: () => {},
      now: () => clock.now,
      stopRequested: () => stop.graceful,
      hardStopped: () => stop.hard,
      report: (l) => lines.push(l),
    },
  } as Harness;
  return h;
}

const limits = (over: Partial<NightLimits> = {}): NightLimits => ({
  maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
  maxIterations: 10,
  maxWaitMs: DEFAULT_MAX_WAIT_MS,
  ...over,
});

test("a successful iteration becomes exactly one commit", async () => {
  const h = harness({ outcomes: [{ finish: finish({ shouldStop: true }) }] });
  const result = await runNight(h.deps, limits());

  assert.equal(result.stopReason, "objective_met");
  assert.deepEqual(h.commitCalls, ["night 1: did a thing"]);
  assert.equal(result.commits.length, 1);
  assert.equal(h.resets, 0);
  assert.equal(h.records[0]?.commit, "hash1");
});

test("a reported failure resets the tree and is not committed", async () => {
  const h = harness({
    outcomes: [
      { finish: finish({ success: false, keyLearnings: ["that path is a dead end"] }) },
      { finish: finish({ shouldStop: true }) },
    ],
  });
  // runIteration reports `reported_failure` for a success:false finish, so the
  // orchestrator sees a failure even though the tool call arrived.
  h.deps.runIteration = async ({ iteration }) =>
    iteration === 1
      ? {
          sessionId: "s-1",
          finish: finish({ success: false, keyLearnings: ["dead end"] }),
          failure: "reported_failure",
          turns: 3,
        }
      : { sessionId: "s-2", finish: finish({ shouldStop: true }), turns: 3 };

  const result = await runNight(h.deps, limits());
  assert.equal(h.resets, 1);
  assert.equal(result.commits.length, 1);
  assert.deepEqual(h.commitCalls, ["night 2: did a thing"]);
  assert.match(h.notes.join("\n"), /failed \(reported_failure\)/);
  // The point of an honest failure: the next iteration learns from it.
  assert.match(h.notes.join("\n"), /dead end/);
  // And the record still says which session it was, for `freecode trace`.
  assert.equal(h.records[0]?.sessionId, "s-1");
  assert.equal(h.records[0]?.turns, 3);
});

test("three consecutive failures end the run", async () => {
  const h = harness({ outcomes: [{ failure: "no_finish" }] });
  const result = await runNight(h.deps, limits({ maxIterations: 50 }));

  assert.equal(result.stopReason, "consecutive_failures");
  assert.equal(result.iterations, 3);
  assert.equal(h.resets, 3);
  assert.equal(h.commitCalls.length, 0);
});

test("a success between failures resets the counter", async () => {
  const h = harness({
    outcomes: [
      { failure: "no_finish" },
      { failure: "no_finish" },
      { finish: finish() },
      { failure: "no_finish" },
      { failure: "no_finish" },
      { finish: finish({ shouldStop: true }) },
    ],
  });
  const result = await runNight(h.deps, limits({ maxIterations: 50 }));
  assert.equal(result.stopReason, "objective_met");
  assert.equal(result.commits.length, 2);
});

test("a failed commit keeps the tree and asks the next iteration to repair", async () => {
  const h = harness({
    outcomes: [{ finish: finish() }, { finish: finish({ shouldStop: true }) }],
    commit: [
      { ok: false, error: "pre-commit hook failed: lint" },
      { ok: true, hash: "hash2", filesChanged: 2 },
    ],
  });
  let sawRepair: string | undefined;
  const inner = h.deps.runIteration;
  h.deps.runIteration = async (input) => {
    if (input.iteration === 2) sawRepair = input.repairPending;
    return inner(input);
  };

  const result = await runNight(h.deps, limits());
  // The work was NOT discarded after the failed commit.
  assert.equal(h.resets, 0);
  assert.match(sawRepair ?? "", /pre-commit hook failed/);
  assert.equal(result.commits.length, 1);
});

test("two failed commits in a row discard the work and count as a failure", async () => {
  const h = harness({
    outcomes: [{ finish: finish() }],
    commit: [
      { ok: false, error: "hook failed" },
      { ok: false, error: "hook failed again" },
      { ok: false, error: "hook failed again" },
    ],
  });
  const result = await runNight(h.deps, limits({ maxIterations: 6 }));
  assert.equal(h.resets, 1);
  assert.match(h.lines.join("\n"), /commit failed twice — discarded/);
  assert.equal(result.stopReason, "max_iterations");
});

test("claimed success with no diff and no learnings is a no-op failure", async () => {
  const h = harness({
    outcomes: [{ finish: finish({ keyChanges: [], keyLearnings: [] }) }],
    dirty: false,
  });
  const result = await runNight(h.deps, limits({ maxIterations: 1 }));
  assert.equal(h.commitCalls.length, 0);
  assert.equal(h.resets, 1);
  assert.equal(h.records[0]?.failure, "no_op");
  assert.equal(result.stopReason, "max_iterations");
});

test("learnings with no diff are kept in the notes, not committed", async () => {
  const h = harness({
    outcomes: [
      { finish: finish({ keyLearnings: ["the slow path is the parser"], shouldStop: true }) },
    ],
    dirty: false,
  });
  const result = await runNight(h.deps, limits());
  assert.equal(h.commitCalls.length, 0);
  assert.equal(h.resets, 0);
  assert.equal(result.stopReason, "objective_met");
  assert.match(h.notes.join("\n"), /the slow path is the parser/);
});

test("quota and auth abort instead of spinning (Phase 1 has no waits)", async () => {
  for (const failure of ["quota", "auth"] as const) {
    const h = harness({ outcomes: [{ failure }] });
    const result = await runNight(h.deps, limits({ maxIterations: 9 }));
    assert.equal(result.stopReason, "permanent_error", failure);
    assert.equal(result.iterations, 1, failure);
  }
});

test("a hard stop leaves the tree alone and reports what is uncommitted", async () => {
  const h = harness({ outcomes: [{ finish: finish() }] });
  const inner = h.deps.runIteration;
  h.deps.runIteration = async (input) => {
    h.stop.hard = true;
    return inner(input);
  };
  const result = await runNight(h.deps, limits());
  assert.equal(result.stopReason, "interrupted");
  assert.equal(h.resets, 0, "a forced stop must never destroy work");
  assert.deepEqual(result.uncommitted, ["src/a.ts"]);
});

test("a graceful stop finishes the current iteration first", async () => {
  const h = harness({ outcomes: [{ finish: finish() }] });
  const inner = h.deps.runIteration;
  h.deps.runIteration = async (input) => {
    h.stop.graceful = true; // requested DURING iteration 1
    return inner(input);
  };
  const result = await runNight(h.deps, limits());
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.commits.length, 1, "iteration 1 was still committed");
  assert.equal(result.iterations, 1);
});

test("the deadline stops the run once it is past, and commits what ran", async () => {
  const h = harness({ outcomes: [{ finish: finish() }] });
  const result = await runNight(
    h.deps,
    limits({ maxIterations: 50, until: h.clock.now + 90_000 }),
  );
  // Each fake iteration advances the clock 60s. The deadline is checked between
  // iterations, not predicted: an iteration that starts inside the window may
  // finish outside it, and killing it mid-step would discard real work. So two
  // run, and the third never starts.
  assert.equal(result.stopReason, "deadline");
  assert.equal(result.iterations, 2);
  assert.equal(result.commits.length, 2);
});

test("the usd ceiling is checked before starting the next iteration", async () => {
  const h = harness({ outcomes: [{ finish: finish(), usd: 0.4 }] });
  const result = await runNight(h.deps, limits({ maxIterations: 50, maxUsd: 1 }));
  assert.equal(result.stopReason, "budget_usd");
  // 0.4 × 3 = 1.2 ≥ 1, so it stops before a fourth — never after exceeding it
  // by a whole iteration.
  assert.equal(result.iterations, 3);
  assert.ok(result.usd >= 1);
});

test("max iterations stops the run", async () => {
  const h = harness({ outcomes: [{ finish: finish() }] });
  const result = await runNight(h.deps, limits({ maxIterations: 2 }));
  assert.equal(result.stopReason, "max_iterations");
  assert.equal(result.iterations, 2);
  assert.equal(result.commits.length, 2);
});

test("each iteration sees the notes the previous ones wrote", async () => {
  const seen: string[] = [];
  const h = harness({ outcomes: [{ finish: finish() }] });
  const inner = h.deps.runIteration;
  h.deps.runIteration = async (input) => {
    seen.push(input.notes);
    return inner(input);
  };
  await runNight(h.deps, limits({ maxIterations: 3 }));
  assert.equal(seen[0], "", "the first iteration has no notes");
  assert.match(seen[1] ?? "", /Iteration 1 — did a thing/);
  assert.ok((seen[2]?.length ?? 0) > (seen[1]?.length ?? 0));
});

// ---------------------------------------------------------------------------
// Phase 2 — surviving the night (spec §4.7)
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

test("a spent window is waited out and the SAME iteration is retried", async () => {
  const h = harness({
    outcomes: [
      { failure: "quota", quota: { scope: "window", resetAt: 1_000 + 2 * HOUR, provider: "anthropic" } },
      { finish: finish({ shouldStop: true }) },
    ],
  });
  const result = await runNight(h.deps, limits());

  assert.equal(h.slept.length, 1);
  // Numbering it twice would claim work that was never attempted.
  assert.equal(result.iterations, 1);
  assert.equal(result.commits.length, 1);
  assert.deepEqual(h.commitCalls, ["night 1: did a thing"]);
  assert.ok(result.waitedMs > 0);
  assert.equal(result.stopReason, "objective_met");
});

test("a wait is not a failure — it does not spend a rollback slot", async () => {
  const h = harness({
    outcomes: [
      { failure: "quota", quota: { scope: "window", resetAt: 1_000 + HOUR, provider: "x" } },
      { failure: "quota", quota: { scope: "window", resetAt: 1_000 + 2 * HOUR, provider: "x" } },
      { failure: "quota", quota: { scope: "window", resetAt: 1_000 + 3 * HOUR, provider: "x" } },
      { failure: "quota", quota: { scope: "window", resetAt: 1_000 + 4 * HOUR, provider: "x" } },
      { finish: finish({ shouldStop: true }) },
    ],
  });
  const result = await runNight(h.deps, limits());
  // Four waits in a row, well past maxConsecutiveFailures, and the run lives.
  assert.equal(h.slept.length, 4);
  assert.equal(result.stopReason, "objective_met");
});

test("the tree is reset before waiting, so the retry starts clean", async () => {
  const h = harness({
    outcomes: [
      { failure: "quota", quota: { scope: "window", resetAt: 1_000 + HOUR, provider: "x" } },
      { finish: finish({ shouldStop: true }) },
    ],
  });
  await runNight(h.deps, limits());
  assert.equal(h.resets, 1);
});

test("a wait is recorded with its window, for the morning's accounting", async () => {
  const h = harness({
    outcomes: [
      { failure: "quota", quota: { scope: "window", resetAt: 1_000 + HOUR, provider: "anthropic" } },
      { finish: finish({ shouldStop: true }) },
    ],
  });
  await runNight(h.deps, limits());
  const wait = h.records.find((r) => (r as { kind: string }).kind === "wait") as unknown as {
    n: number;
    provider: string;
    until: number;
  };
  assert.ok(wait, "the wait must appear in the log beside the iterations");
  assert.equal(wait.n, 1);
  assert.equal(wait.provider, "anthropic");
});

test("spent credits abort — no reset is ever coming", async () => {
  const h = harness({
    outcomes: [{ failure: "quota", quota: { scope: "credits", provider: "minimax" } }],
  });
  const result = await runNight(h.deps, limits());
  assert.equal(result.stopReason, "permanent_error");
  assert.equal(h.slept.length, 0, "waiting on an empty account is pure waste");
});

test("a wait that would outlast --max-wait stops the run instead", async () => {
  const h = harness({
    outcomes: [{ failure: "quota", quota: { scope: "window", resetAt: 1_000 + 5 * HOUR, provider: "x" } }],
  });
  const result = await runNight(h.deps, limits({ maxWaitMs: HOUR }));
  assert.equal(result.stopReason, "wait_budget");
  assert.equal(h.slept.length, 0);
});

test("a wait that would cross --until stops the run instead of sleeping past morning", async () => {
  const h = harness({
    outcomes: [{ failure: "quota", quota: { scope: "window", resetAt: 1_000 + 5 * HOUR, provider: "x" } }],
  });
  const result = await runNight(h.deps, limits({ until: 1_000 + 2 * HOUR }));
  assert.equal(result.stopReason, "deadline");
  assert.equal(h.slept.length, 0);
});

test("--fallback-model spends itself on the first window instead of waiting", async () => {
  const h = harness({
    outcomes: [
      { failure: "quota", quota: { scope: "window", resetAt: 1_000 + HOUR, provider: "anthropic" } },
      { finish: finish() },
      { failure: "quota", quota: { scope: "window", resetAt: 1_000 + 2 * HOUR, provider: "anthropic" } },
      { finish: finish({ shouldStop: true }) },
    ],
  });
  const seen: boolean[] = [];
  const inner = h.deps.runIteration;
  h.deps.runIteration = async (input) => {
    seen.push(input.useFallback === true);
    return inner(input);
  };

  const result = await runNight(h.deps, limits({ fallbackModel: "minimax/MiniMax-M3" }));
  // First window: retried on the fallback, no sleep. Second: the fallback is
  // spent, so it waits like any other.
  assert.deepEqual(seen, [false, true, false, false]);
  assert.deepEqual(result.fallbackIterations, [1]);
  assert.equal(h.slept.length, 1);
  assert.equal(result.stopReason, "objective_met");
});

test("without --fallback-model the run never changes models", async () => {
  const h = harness({
    outcomes: [
      { failure: "quota", quota: { scope: "window", resetAt: 1_000 + HOUR, provider: "x" } },
      { finish: finish({ shouldStop: true }) },
    ],
  });
  const result = await runNight(h.deps, limits());
  assert.deepEqual(result.fallbackIterations, []);
  assert.equal(h.slept.length, 1);
});

test("a failing --verify discards the work instead of committing it", async () => {
  const h = harness({
    outcomes: [{ finish: finish() }, { finish: finish({ shouldStop: true }) }],
    verify: [false, true],
  });
  const result = await runNight(h.deps, limits());

  assert.equal(h.commitCalls.length, 1, "only the verified iteration commits");
  assert.deepEqual(h.commitCalls, ["night 2: did a thing"]);
  assert.equal(h.resets, 1);
  assert.equal(h.records[0]?.failure, "verify_failed");
  assert.equal(result.stopReason, "objective_met");
});

test("the verify output reaches the notes, so the next iteration can act on it", async () => {
  const h = harness({
    outcomes: [{ finish: finish() }],
    verify: [false],
  });
  await runNight(h.deps, limits({ maxIterations: 1 }));
  assert.match(h.notes.join("\n"), /assert: 1 !== 2/);
});

test("three verify failures in a row end the run", async () => {
  const h = harness({
    outcomes: [{ finish: finish() }],
    verify: [false, false, false],
  });
  const result = await runNight(h.deps, limits({ maxIterations: 20 }));
  assert.equal(result.stopReason, "consecutive_failures");
  assert.equal(result.iterations, 3);
  assert.equal(h.commitCalls.length, 0);
});

test("verify does not run for a learnings-only iteration — there is nothing to gate", async () => {
  const h = harness({
    outcomes: [{ finish: finish({ keyLearnings: ["a thing"], shouldStop: true }) }],
    dirty: false,
    verify: [false],
  });
  const result = await runNight(h.deps, limits());
  assert.equal(result.stopReason, "objective_met");
  assert.equal(h.resets, 0);
});

test("a resumed run continues the numbering instead of restarting at 1", async () => {
  // Restarting at 1 would put a second `night 1:` commit on a branch that
  // already has one, and the report would describe two steps by one number.
  const h = harness({ outcomes: [{ finish: finish({ shouldStop: true }) }] });
  const result = await runNight(h.deps, limits({ startIteration: 4 }));

  assert.deepEqual(h.commitCalls, ["night 5: did a thing"]);
  assert.equal(result.iterations, 5, "absolute, not this leg's count");
});

test("--max-iterations counts this leg's work, not the whole run's history", async () => {
  // Otherwise a resume of a 10-iteration night with --max-iterations 3 would
  // stop before doing anything at all.
  const h = harness({ outcomes: [{ finish: finish() }] });
  const result = await runNight(
    h.deps,
    limits({ startIteration: 10, maxIterations: 2 }),
  );
  assert.equal(result.iterations, 12);
  assert.equal(result.commits.length, 2);
  assert.equal(result.stopReason, "max_iterations");
});
