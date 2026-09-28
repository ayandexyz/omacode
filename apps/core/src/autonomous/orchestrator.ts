// =============================================================================
// The night's state machine: iterate, commit or reset, stop when told.
//
// Takes every effect as an injected dependency (`runIteration`, `git`, `clock`,
// `store`), so the whole machine — failures, repairs, interrupts, budgets — is
// unit-testable with fakes and a fake clock. Nothing here touches a provider,
// a filesystem or a real clock directly.
//
// Phase 2 adds surviving the night: a spent quota window is waited out and the
// SAME iteration number is retried (a wait is not a failure), `--verify` gates
// every commit, and `--stop-when` gives the run a finish line. Not built:
// report.md, resume, --worktree, --push, detach (Phases 3–5).
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.2, §4.7
// =============================================================================

import { planQuotaWait } from "./quota-wait.js";
import type { QuotaScope } from "../agent/recovery/manager.js";
import type {
  Decision,
  FinishIterationResult,
  IterationFailureReason,
  IterationRecord,
  WaitRecord,
} from "./types.js";

export type NightStopReason =
  | "objective_met"
  | "max_iterations"
  | "deadline"
  | "budget_usd"
  | "consecutive_failures"
  | "permanent_error"
  /** The run spent its whole `--max-wait` allowance waiting on a quota. */
  | "wait_budget"
  | "interrupted"
  | "cancelled";

export interface NightLimits {
  maxIterations?: number;
  /** Epoch ms. The run stops BEFORE starting an iteration that would cross it. */
  until?: number;
  maxUsd?: number;
  maxConsecutiveFailures: number;
  /** Total time the run may spend waiting on quota across the whole night. */
  maxWaitMs: number;
  /**
   * `provider/model` to retry on instead of waiting, the FIRST time a window
   * is spent. Off by default: without it the run never changes models, because
   * a night of commits from a model the user did not choose is a surprise.
   */
  fallbackModel?: string;
  /** Natural-language finish line, handed to the model each iteration. */
  stopWhen?: string;
  /**
   * Iterations already done by an earlier leg of this run (a resume).
   * Numbering continues from here: restarting at 1 would produce a second
   * `night 1:` commit on a branch that already has one, and the report would
   * describe two different steps by the same number.
   */
  startIteration?: number;
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
/** Two five-hour subscription windows, plus slack. */
export const DEFAULT_MAX_WAIT_MS = 12 * 60 * 60 * 1000;

/** What the orchestrator needs from the world. All of it faked in tests. */
export interface OrchestratorDeps {
  runIteration(input: {
    iteration: number;
    notes: string;
    repairPending?: string;
    /** Run this attempt on `--fallback-model` instead of the run's own. */
    useFallback?: boolean;
  }): Promise<{
    sessionId: string;
    finish?: FinishIterationResult;
    failure?: IterationFailureReason;
    /** Present when `failure` is `quota`; decides whether waiting can help. */
    quota?: { scope: QuotaScope; resetAt?: number; provider: string };
    turns: number;
    usd?: number;
  }>;
  git: {
    dirtyPaths(): Promise<string[]>;
    commitAll(
      message: string,
    ): Promise<
      | { ok: true; hash: string; filesChanged: number }
      | { ok: false; error: string }
    >;
    reset(): Promise<void>;
  };
  notes: {
    read(): string;
    append(section: string): void;
  };
  /**
   * The user's `--verify` command, run in the tree before every commit.
   * Absent when they gave none — the run then commits whatever the model says
   * worked, which is exactly as strong as the model's own checking.
   */
  verify?(): Promise<{ ok: boolean; output: string }>;
  /**
   * Sleep until `until` (epoch ms), returning early if the run is asked to
   * stop. Wall-clock, not one long timer: a suspended laptop resumes to a
   * timer that never fired, and setTimeout overflows past 2^31 ms.
   */
  sleepUntil(until: number): Promise<void>;
  record(record: IterationRecord | WaitRecord): void;
  decision(decision: Decision): void;
  now(): number;
  /** True once the user asked to stop; checked between iterations. */
  stopRequested(): boolean;
  /** True after a HARD stop: the tree is left as it is, never reset. */
  hardStopped(): boolean;
  /** One status line per transition. Terminal output in Phase 1. */
  report(line: string): void;
}

export interface NightResult {
  stopReason: NightStopReason;
  iterations: number;
  commits: string[];
  usd: number;
  /** Total time spent waiting on a spent quota. Reported, never hidden. */
  waitedMs: number;
  /** Iterations that ran on `--fallback-model` rather than the run's own. */
  fallbackIterations: number[];
  /** Set when work was left uncommitted — every case is reported (§5.6). */
  uncommitted?: string[];
}

export async function runNight(
  deps: OrchestratorDeps,
  limits: NightLimits,
): Promise<NightResult> {
  const commits: string[] = [];
  const fallbackIterations: number[] = [];
  let iteration = limits.startIteration ?? 0;
  let consecutiveFailures = 0;
  let usd = 0;
  let waitedMs = 0;
  let repairPending: string | undefined;
  let repairAttempts = 0;
  let stopReason: NightStopReason | undefined;
  // A wait retries the SAME iteration number: nothing happened, so numbering it
  // twice would make the report claim work that was never attempted.
  let retrySameIteration = false;
  let probes = 0;
  let useFallback = false;
  let fallbackSpent = false;

  for (;;) {
    if (deps.stopRequested()) {
      stopReason = "cancelled";
      break;
    }
    if (
      limits.maxIterations !== undefined &&
      iteration - (limits.startIteration ?? 0) >= limits.maxIterations
    ) {
      stopReason = "max_iterations";
      break;
    }
    if (limits.until !== undefined && deps.now() >= limits.until) {
      stopReason = "deadline";
      break;
    }
    // Checked BEFORE the iteration, not after: a cap noticed only afterwards
    // has already been exceeded, which is not a cap.
    if (limits.maxUsd !== undefined && usd >= limits.maxUsd) {
      stopReason = "budget_usd";
      break;
    }

    if (!retrySameIteration) iteration += 1;
    retrySameIteration = false;
    const startedAt = deps.now();
    deps.report(
      `iteration ${iteration}: working${useFallback ? " (fallback model)" : ""}`,
    );

    const outcome = await deps.runIteration({
      iteration,
      notes: deps.notes.read(),
      repairPending,
      useFallback,
    });
    if (useFallback) fallbackIterations.push(iteration);
    useFallback = false;
    usd += outcome.usd ?? 0;

    const base = {
      kind: "iteration" as const,
      n: iteration,
      sessionId: outcome.sessionId,
      startedAt,
      endedAt: deps.now(),
      turns: outcome.turns,
      usd: outcome.usd,
    };

    // A hard interrupt leaves the tree alone — a forced stop must never destroy
    // work (gnhf VISION §1, spec §4.8).
    if (deps.hardStopped()) {
      deps.record({ ...base, failure: "interrupted" });
      deps.notes.append(
        `## Iteration ${iteration} — interrupted\nStopped mid-iteration; its changes were left in the tree.`,
      );
      stopReason = "interrupted";
      break;
    }

    // Auth is permanent by definition: a key the provider rejects will not
    // start working while we sleep.
    if (outcome.failure === "auth") {
      await deps.git.reset();
      deps.record({ ...base, failure: "auth" });
      deps.report(`iteration ${iteration}: authentication refused — aborting`);
      stopReason = "permanent_error";
      break;
    }

    // A spent quota is the one failure that is not the model's fault and not
    // worth a rollback slot: reset the tree, wait, and retry the same step.
    if (outcome.failure === "quota") {
      await deps.git.reset();
      const quota = outcome.quota ?? { scope: "unknown" as QuotaScope, provider: "provider" };

      // `--fallback-model`, when given, spends itself on the FIRST window
      // rather than waiting. Opt-in: a night of commits from a model the user
      // did not choose is a surprise, and surprises are what the report exists
      // to prevent.
      if (limits.fallbackModel && !fallbackSpent && quota.scope === "window") {
        fallbackSpent = true;
        useFallback = true;
        retrySameIteration = true;
        deps.record({ ...base, failure: "quota" });
        deps.report(
          `iteration ${iteration}: ${quota.provider} window spent — retrying on ${limits.fallbackModel}`,
        );
        continue;
      }

      const plan = planQuotaWait({
        scope: quota.scope,
        resetAt: quota.resetAt,
        now: deps.now(),
        probes,
        waitedMs,
        maxWaitMs: limits.maxWaitMs,
        until: limits.until,
        provider: quota.provider,
      });

      if (plan.action === "abort") {
        deps.record({ ...base, failure: "quota" });
        deps.report(`iteration ${iteration}: ${plan.reason} — stopping`);
        stopReason = plan.stopReason;
        break;
      }

      const from = deps.now();
      deps.record({
        kind: "wait",
        n: iteration,
        from,
        until: plan.until,
        reason: plan.reason,
        provider: quota.provider,
      });
      deps.report(
        `${plan.reason} — resumes ${new Date(plan.until).toLocaleTimeString()}`,
      );
      await deps.sleepUntil(plan.until);
      waitedMs += Math.max(0, deps.now() - from);
      probes += 1;
      retrySameIteration = true;
      continue;
    }

    // Any other outcome means the provider answered, so the probe streak ends.
    probes = 0;

    const finish = outcome.finish;
    if (!finish || outcome.failure) {
      const reason = outcome.failure ?? "no_finish";
      await resetAndNote(reason);
      if (consecutiveFailures >= limits.maxConsecutiveFailures) {
        stopReason = "consecutive_failures";
        break;
      }
      continue;
    }

    // A "success" that changed nothing and learned nothing is a no-op, and a
    // run that accepts them spins forever producing empty commits. Learnings
    // without changes are allowed: they go into the notes, not a commit.
    const dirty = await deps.git.dirtyPaths();
    if (dirty.length === 0) {
      if (finish.keyLearnings.length === 0) {
        await resetAndNote("no_op", finish);
        if (consecutiveFailures >= limits.maxConsecutiveFailures) {
          stopReason = "consecutive_failures";
          break;
        }
        continue;
      }
      consecutiveFailures = 0;
      deps.record({ ...base, summary: finish.summary });
      deps.notes.append(noteFor(iteration, finish, "no file changes"));
      deps.report(`iteration ${iteration}: learnings only, nothing to commit`);
      if (finish.shouldStop) {
        stopReason = "objective_met";
        break;
      }
      continue;
    }

    // The gate the user chose, run before the commit rather than after: a
    // commit that fails verification is work the morning has to unpick. It is
    // exactly as strong as the command they gave — the report says whether
    // there was one at all.
    if (deps.verify) {
      const verified = await deps.verify();
      if (!verified.ok) {
        await deps.git.reset();
        consecutiveFailures += 1;
        deps.record({ ...base, failure: "verify_failed", summary: finish.summary });
        deps.notes.append(
          `## Iteration ${iteration} — verification failed\n${finish.summary}\n\n` +
            `The verify command rejected it, so the changes were discarded:\n` +
            `${tail(verified.output)}`,
        );
        deps.report(
          `iteration ${iteration}: verify failed — reset, ${consecutiveFailures} in a row`,
        );
        if (consecutiveFailures >= limits.maxConsecutiveFailures) {
          stopReason = "consecutive_failures";
          break;
        }
        continue;
      }
    }

    const commit = await deps.git.commitAll(`night ${iteration}: ${finish.summary}`);
    if (!commit.ok) {
      // The work stays in the tree and the next iteration is told to repair it.
      // Two failed repairs in a row means the blocker is not something the
      // model can clear, so the work is discarded rather than carried forever.
      repairAttempts += 1;
      deps.record({ ...base, failure: "commit_failed", summary: finish.summary });
      deps.notes.append(
        `## Iteration ${iteration} — commit failed\n${finish.summary}\n\nThe commit was rejected:\n${commit.error}`,
      );
      if (repairAttempts >= 2) {
        consecutiveFailures += 1;
        repairPending = undefined;
        repairAttempts = 0;
        await deps.git.reset();
        deps.report(`iteration ${iteration}: commit failed twice — discarded`);
        if (consecutiveFailures >= limits.maxConsecutiveFailures) {
          stopReason = "consecutive_failures";
          break;
        }
      } else {
        repairPending = commit.error;
        deps.report(`iteration ${iteration}: commit failed — repairing next`);
      }
      continue;
    }

    repairPending = undefined;
    repairAttempts = 0;
    consecutiveFailures = 0;
    commits.push(commit.hash);
    deps.record({
      ...base,
      commit: commit.hash,
      summary: finish.summary,
      filesChanged: commit.filesChanged,
    });
    deps.notes.append(noteFor(iteration, finish, `${commit.filesChanged} files`));
    deps.report(
      `iteration ${iteration}: committed ${commit.hash.slice(0, 8)} — ${finish.summary}`,
    );

    if (finish.shouldStop) {
      stopReason = "objective_met";
      break;
    }
  }

  const uncommitted = await deps.git.dirtyPaths().catch(() => []);
  return {
    stopReason: stopReason ?? "max_iterations",
    iterations: iteration,
    commits,
    usd,
    waitedMs,
    fallbackIterations,
    ...(uncommitted.length > 0 ? { uncommitted } : {}),
  };

  async function resetAndNote(
    reason: IterationFailureReason,
    finish?: FinishIterationResult,
  ): Promise<void> {
    await deps.git.reset();
    consecutiveFailures += 1;
    deps.record({
      kind: "iteration",
      n: iteration,
      sessionId: "",
      startedAt: deps.now(),
      endedAt: deps.now(),
      turns: 0,
      failure: reason,
      summary: finish?.summary,
    });
    deps.notes.append(
      [
        `## Iteration ${iteration} — failed (${reason})`,
        finish?.summary ?? "",
        finish && finish.keyLearnings.length > 0
          ? `Learnings:\n${finish.keyLearnings.map((l) => `- ${l}`).join("\n")}`
          : "",
        "Its changes were discarded; the next iteration starts from the last commit.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    deps.report(
      `iteration ${iteration}: failed (${reason}) — reset, ${consecutiveFailures} in a row`,
    );
  }
}

/** The end of a verify failure, where the reason lives. */
function tail(output: string, chars = 2000): string {
  const trimmed = output.trimEnd();
  return trimmed.length <= chars
    ? trimmed
    : `…\n${trimmed.slice(-chars)}`;
}

function noteFor(
  iteration: number,
  finish: FinishIterationResult,
  scope: string,
): string {
  const parts = [`## Iteration ${iteration} — ${finish.summary} (${scope})`];
  if (finish.keyChanges.length > 0) {
    parts.push(`Changes:\n${finish.keyChanges.map((c) => `- ${c}`).join("\n")}`);
  }
  if (finish.keyLearnings.length > 0) {
    parts.push(
      `Learnings:\n${finish.keyLearnings.map((l) => `- ${l}`).join("\n")}`,
    );
  }
  if (finish.needsHuman.length > 0) {
    parts.push(
      `Needs the human:\n${finish.needsHuman.map((n) => `- ${n}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}
