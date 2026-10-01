// =============================================================================
// Autonomous run types — RunManifest, RunLimits, RunStatus, TaskCard, GateResult
// Spec: docs/specs/2026-09-28-overnight-runs.md
//
// PHASE 0: types + budget + storage only. Nothing here starts an agent, spawns
// a process, or runs a gate command. A run is deliberately not a new kind of
// thing in the event-sourcing model — it is a session whose turns happen to be
// system-continued rather than human-continued, which is what makes replay work
// on it for free.
// =============================================================================

/**
 * Four independent ceilings; whichever is hit first stops the run.
 *
 * Stricter than Prime Agent's `DEFAULT_AUTONOMOUS_LIMITS` on purpose (spec §9):
 * their OAuth-first default means a runaway loop mostly wastes time. Ours wastes
 * money, so `maxUsd` exists at all and the other three start lower.
 */
export interface RunLimits {
  maxTurns: number;
  /** Input + output + cache *writes*. Cache reads are excluded — see §4.3. */
  maxTokens: number;
  timeoutMs: number;
  /** No OAuth free tier here, so cost is a first-class ceiling, not a nicety. */
  maxUsd?: number;
  /**
   * Trajectory redirections allowed for the whole run
   * (`agent/redirect/policy.ts`). Sourced from the budget rather than the
   * redirect settings when a run owns the loop: an unattended run's recovery
   * attempts are part of its spend, not a separate allowance.
   * Spec `2026-08-26-trajectory-redirection.md` Phase 3.
   */
  maxRedirects: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxTurns: 20,
  maxTokens: 150_000,
  timeoutMs: 60 * 60 * 1000,
  maxRedirects: 2,
};

/**
 * Why a run stopped. `budget_*` are the four ceilings; the rest are lifecycle.
 * A run that ends without one of these has not ended — it has gone missing, and
 * `crashed` is what that is called once the PID is found dead.
 */
export type RunStopReason =
  | "budget_turns"
  | "budget_tokens"
  | "budget_time"
  | "budget_usd"
  | "gate_passed"
  | "cancelled"
  | "crashed"
  | "error";

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "stopped"
  | "cancelled"
  | "crashed";

/** Usage as the budget counts it. Mirrors the provider-reported shape. */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  /**
   * Counted for reporting, NEVER against `maxTokens`. Counting cache reads
   * cumulatively would let a long verifier loop exhaust the budget on repeated
   * *context* rather than new work — the exact reasoning Prime Agent documents,
   * and doubly relevant here after a release spent on cache hit rate.
   */
  cacheReadTokens: number;
  usd?: number;
}

export const EMPTY_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

/** One unit of work, jcode-shaped (§3.2). Written by the run's own agent. */
export interface TaskCard {
  id: string;
  title: string;
  before: string;
  after: string;
  validation: string;
  outcome: "done" | "partial" | "failed";
  createdAt: number;
}

export interface GateResult {
  command: string;
  passed: boolean;
  attempt: number;
  output: string;
  /**
   * Worktree hash at the moment the gate ran. Equal to the previous failure's
   * hash means the model changed nothing, so re-running an expensive suite
   * would burn budget to learn what is already known (§3.1).
   */
  worktreeHash: string;
  ranAt: number;
}

export interface RunManifest {
  runId: string;
  status: RunStatus;
  /** Set once the run reaches a terminal state; absent while it lives. */
  stopReason?: RunStopReason;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;

  projectPath: string;
  /** The dedicated `git worktree` this run operates in — never the user's checkout. */
  worktreePath?: string;
  provider: string;
  model?: string;

  limits: RunLimits;
  usage: RunUsage;
  turns: number;

  /**
   * Fixed at start and re-read from the manifest on every check, never sourced
   * from anything the model can write to — which is what structurally stops a
   * run from disabling its own gate.
   */
  verifyCommand: string;
  lastGateFailure?: GateResult;

  /** PID of the detached child, once §4.4a exists. Absent in Phase 0. */
  pid?: number;
  /**
   * Checked at turn boundaries rather than signalled: a process killed
   * mid-write is how manifests corrupt.
   */
  cancelRequested?: boolean;

  taskCardCount: number;

  /** Present on a `freecode night` run, absent on an old autonomous one. */
  night?: NightManifestFields;
}

// =============================================================================
// Overnight runs (`freecode night`) — spec 2026-09-28-overnight-runs.md.
// A run is a sequence of ITERATIONS: each one a fresh session doing one small
// verifiable step, ending in a `finish_iteration` call. The orchestrator, not
// the model, commits, resets, and decides when the night is over.
// =============================================================================

/**
 * The night-run fields on a `RunManifest`. Kept in one optional block rather
 * than spread across the manifest: Phase 0's shape belongs to the older
 * autonomous design, and a night run should not have to pretend to be one.
 *
 * Updated after every iteration, so `freecode night status` from another
 * terminal reads real progress rather than whatever was true at startup.
 */
export interface NightManifestFields {
  objective: string;
  branch: string;
  /**
   * The commit the branch started from. The report's review range and
   * diffstat are measured from it, never from `main`: a night may branch off
   * anything, and a resumed leg must still report the whole night.
   */
  baseCommit?: string;
  stopWhen?: string;
  verifyCommand?: string;
  /** Iterations attempted so far (a retried wait does not increment it). */
  iterations: number;
  /** Commit hashes on the run's branch, oldest first. */
  commits: string[];
  waitedMs: number;
  fallbackIterations: number[];
  fallbackModel?: string;
  stopReason?: string;
  /** Left in the tree when the run ended. Absent means nothing was. */
  uncommitted?: string[];
  /** Phase 5 lifecycle metadata. A pending scheduled run has not started yet. */
  detached?: boolean;
  scheduledFor?: number;
  logPath?: string;
  /** Whether unattended shell commands are confined to the run tree. */
  sandbox?: boolean;
  commitStyle?: "night" | "conventional";
}

/** What the model reports through `finish_iteration` (§4.4). */
export interface FinishIterationResult {
  /** Meaningful progress was made. `false` ⇒ the orchestrator discards the tree. */
  success: boolean;
  /** One sentence; becomes the commit subject. */
  summary: string;
  keyChanges: string[];
  keyLearnings: string[];
  decisions: IterationDecision[];
  needsHuman: string[];
  /** The objective is fully met — end the run, don't just end the iteration. */
  shouldStop?: boolean;
}

export interface IterationDecision {
  question: string;
  choice: string;
  why: string;
  reversible: boolean;
}

/**
 * Why an iteration did not produce a commit. `no_finish` is the one to watch:
 * it means the model stopped without calling the finish tool (§6 failure mode 1).
 */
export type IterationFailureReason =
  | "reported_failure"
  | "no_finish"
  | "no_op"
  | "turn_cap"
  | "stuck"
  | "timeout"
  | "commit_failed"
  | "verify_failed"
  | "provider"
  | "quota"
  | "auth"
  | "interrupted";

export interface IterationRecord {
  kind: "iteration";
  n: number;
  sessionId: string;
  startedAt: number;
  endedAt: number;
  /** Committed ⇒ the step is on the branch. */
  commit?: string;
  failure?: IterationFailureReason;
  summary?: string;
  filesChanged?: number;
  usd?: number;
  turns: number;
}

/**
 * One wait on a spent quota, written to `iterations.jsonl` beside the
 * iterations so the morning can account for a night that produced three
 * commits and eight hours of sleep.
 */
export interface WaitRecord {
  kind: "wait";
  /** The iteration that will be retried once the wait ends. */
  n: number;
  from: number;
  until: number;
  reason: string;
  provider: string;
}

/** A denial or a self-answered question, for the morning report (§4.5, §4.6). */
export type Decision =
  | { kind: "asked"; iteration: number; at: number; questions: string[] }
  | {
      kind: "decided";
      iteration: number;
      at: number;
      question: string;
      choice: string;
      why: string;
      reversible: boolean;
    }
  | {
      kind: "denied";
      iteration: number;
      at: number;
      tool: string;
      target?: string;
      rule: string;
    }
  | { kind: "needs_human"; iteration: number; at: number; item: string };

/**
 * The seam between the agent loop and an unattended run. The loop knows only
 * this interface: it consults `decideAsk` instead of prompting a human, hands
 * it to tools through `ToolContext`, and ends the run once `finish` is set.
 * Nothing here is visible in an attended session.
 */
export interface UnattendedContext {
  /** 1-based iteration number, for every record written. */
  iteration: number;
  /** Set by `finish_iteration`. The loop ends the run after that batch. */
  finish?: FinishIterationResult;
  /** Answer a permission `ask` without a human (§4.6). */
  decideAsk(
    toolName: string,
    args: Record<string, unknown>,
  ): { allowed: boolean; reason?: string };
  /** Record a self-answered question or a refusal for the report. */
  record(decision: Decision): void;
  /** Passed to the bash tool; absent keeps attended shells unchanged. */
  sandbox?: { projectPath: string };
}
