// =============================================================================
// The night's state machine: iterate, commit or reset, stop when told.
//
// Takes every effect as an injected dependency (`runIteration`, `git`, `clock`,
// `store`), so the whole machine — failures, repairs, interrupts, budgets — is
// unit-testable with fakes and a fake clock. Nothing here touches a provider,
// a filesystem or a real clock directly.
//
// Phase 1: no quota waits (Phase 2), no --verify, no --stop-when, no report.md.
// A quota failure aborts with `permanent_error` for now, which is the honest
// Phase 1 behaviour: waiting is not built, so pretending to wait would hang.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.2
// =============================================================================

import type {
  Decision,
  FinishIterationResult,
  IterationFailureReason,
  IterationRecord,
} from "./types.js";

export type NightStopReason =
  | "objective_met"
  | "max_iterations"
  | "deadline"
  | "budget_usd"
  | "consecutive_failures"
  | "permanent_error"
  | "interrupted"
  | "cancelled";

export interface NightLimits {
  maxIterations?: number;
  /** Epoch ms. The run stops BEFORE starting an iteration that would cross it. */
  until?: number;
  maxUsd?: number;
  maxConsecutiveFailures: number;
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/** What the orchestrator needs from the world. All of it faked in tests. */
export interface OrchestratorDeps {
  runIteration(input: {
    iteration: number;
    notes: string;
    repairPending?: string;
  }): Promise<{
    sessionId: string;
    finish?: FinishIterationResult;
    failure?: IterationFailureReason;
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
  record(record: IterationRecord): void;
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
  /** Set when work was left uncommitted — every case is reported (§5.6). */
  uncommitted?: string[];
}

export async function runNight(
  deps: OrchestratorDeps,
  limits: NightLimits,
): Promise<NightResult> {
  const commits: string[] = [];
  let iteration = 0;
  let consecutiveFailures = 0;
  let usd = 0;
  let repairPending: string | undefined;
  let repairAttempts = 0;
  let stopReason: NightStopReason | undefined;

  for (;;) {
    if (deps.stopRequested()) {
      stopReason = "cancelled";
      break;
    }
    if (limits.maxIterations !== undefined && iteration >= limits.maxIterations) {
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

    iteration += 1;
    const startedAt = deps.now();
    deps.report(`iteration ${iteration}: working`);

    const outcome = await deps.runIteration({
      iteration,
      notes: deps.notes.read(),
      repairPending,
    });
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

    // Permanent: waiting cannot fix an empty account or a bad key, and Phase 1
    // does not wait for a spent window either (Phase 2 adds that).
    if (
      outcome.failure === "auth" ||
      outcome.failure === "quota"
    ) {
      await deps.git.reset();
      deps.record({ ...base, failure: outcome.failure });
      deps.report(`iteration ${iteration}: ${outcome.failure} — aborting`);
      stopReason = "permanent_error";
      break;
    }

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
