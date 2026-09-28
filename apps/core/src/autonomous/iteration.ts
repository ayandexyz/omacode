// =============================================================================
// One iteration: a fresh session, one small verifiable step, one report.
//
// Fresh session per iteration is the load-bearing choice (gnhf's, §3.1): a bad
// step costs one rollback instead of poisoning a three-hour context, and every
// iteration starts from `notes.md` rather than from whatever the last one
// happened to leave in the window.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.2
// =============================================================================

import { createAgentLoopEffect } from "../agent/loop.js";
import { getAppRuntime } from "../effect/runtime.js";
import { getSessionManager } from "../session/index.js";
import { classifyLoopFailure } from "../agent/recovery/manager.js";
import { disposeShellRegistry } from "../tools/shells/index.js";
import { disposeAgentsForRoot } from "../agent/registry/index.js";
import { priceUsd } from "../providers/pricing.js";
import { logger } from "../utils/logger.js";
import { decideUnattendedAsk, REFUSAL_TEXT } from "./envelope.js";
import { buildIterationPrompt, FINISH_POKE } from "./prompt.js";
import type {
  Decision,
  FinishIterationResult,
  IterationFailureReason,
  UnattendedContext,
} from "./types.js";

/** Per-iteration guard rails (§4.2). A step needing 60 turns is not "smallest". */
export const MAX_TURNS_PER_ITERATION = 60;
export const ITERATION_TIMEOUT_MS = 30 * 60 * 1000;

export interface IterationInput {
  objective: string;
  iteration: number;
  notes: string;
  repairPending?: string;
  projectPath: string;
  provider: string;
  model?: string;
  /** Extra deny/allow rules from the CLI, on top of the envelope's own. */
  denyRules: string[];
  allowRules: string[];
  /** Appended to decisions.jsonl by the caller. */
  onDecision(decision: Decision): void;
  /** Stops the iteration early: a hard interrupt, or the run's deadline. */
  signal?: AbortSignal;
}

export interface IterationOutcome {
  sessionId: string;
  finish?: FinishIterationResult;
  failure?: IterationFailureReason;
  /** Set when the failure was a quota rejection worth waiting out (Phase 2). */
  quota?: { scope: "window" | "credits" | "unknown"; resetAt?: number };
  turns: number;
  usd?: number;
}

/**
 * Runs the model until it calls `finish_iteration`, and once more if it stops
 * without doing so. Never throws: an iteration's failure is data the
 * orchestrator acts on, not an exception that ends the night.
 */
export async function runIteration(
  input: IterationInput,
): Promise<IterationOutcome> {
  const manager = await getSessionManager();
  const sessionId = await manager.start(input.projectPath, input.provider);

  const unattended: UnattendedContext = {
    iteration: input.iteration,
    decideAsk(toolName, args) {
      const verdict = decideUnattendedAsk({
        tree: input.projectPath,
        toolName,
        args,
      });
      if (!verdict.allowed) {
        input.onDecision({
          kind: "denied",
          iteration: input.iteration,
          at: Date.now(),
          tool: toolName,
          target: typeof args.filePath === "string" ? args.filePath : undefined,
          rule: verdict.rule ?? "envelope",
        });
        return { allowed: false, reason: verdict.reason ?? REFUSAL_TEXT };
      }
      return { allowed: true };
    },
    record: input.onDecision,
  };

  // Belt and braces with the run's own deadline: a single iteration that hangs
  // must not consume the night.
  const timer = new AbortController();
  const deadline = setTimeout(() => timer.abort(), ITERATION_TIMEOUT_MS);
  deadline.unref?.();
  const abort = anySignal([input.signal, timer.signal]);

  let turns = 0;
  let usd: number | undefined;
  let failure: IterationFailureReason | undefined;
  let quota: IterationOutcome["quota"];

  try {
    const loop = await getAppRuntime().runPromise(
      createAgentLoopEffect(sessionId, {
        maxIterations: MAX_TURNS_PER_ITERATION,
        unattended,
        sessionGrants: input.allowRules,
        sessionDenies: input.denyRules,
      }),
    );

    // The loop owns its own AbortController, so an external stop reaches it
    // through interrupt() rather than a signal it never reads.
    abort.addEventListener("abort", () => loop.interrupt(), { once: true });

    let result = await getAppRuntime().runPromise(
      loop.runEffect({
        prompt: buildIterationPrompt(input),
        sessionId,
        provider: input.provider,
        model: input.model,
        projectPath: input.projectPath,
        agentMode: "build",
      }),
    );
    turns = result.turnCount;
    usd = costOf(result, input.provider, input.model);

    // One re-poke, as auto-poke does for open todos: a model that produced the
    // work but forgot the bookkeeping should not lose the work over it.
    if (!unattended.finish && !result.failure && !abort.aborted) {
      const again = await getAppRuntime().runPromise(
        loop.runEffect({
          prompt: FINISH_POKE,
          sessionId,
          provider: input.provider,
          model: input.model,
          projectPath: input.projectPath,
          agentMode: "build",
        }),
      );
      turns += again.turnCount;
      const extra = costOf(again, input.provider, input.model);
      if (extra !== undefined) usd = (usd ?? 0) + extra;
      result = again;
    }

    if (!unattended.finish) {
      failure = failureFromLoop(result.failure) ?? "no_finish";
      if (result.failure?.kind === "quota") {
        quota = {
          scope: result.failure.scope,
          resetAt: result.failure.resetAt,
        };
      }
    } else if (!unattended.finish.success) {
      failure = "reported_failure";
    }
  } catch (error) {
    // runEffect rejected outright (a provider error the recovery chain could
    // not absorb). Classified, not swallowed: the orchestrator needs to know
    // whether to wait, abort, or try the next step.
    const classified = classifyLoopFailure(error);
    failure = failureFromLoop(classified) ?? "provider";
    if (classified.kind === "quota") {
      quota = { scope: classified.scope, resetAt: classified.resetAt };
    }
    logger.warn(
      `[night] iteration ${input.iteration} threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(deadline);
    // The prompt asks the model to stop its background work; this enforces it.
    // A dev server left running would hold the port for every later iteration.
    disposeShellRegistry(sessionId);
    disposeAgentsForRoot(sessionId);
  }

  return { sessionId, finish: unattended.finish, failure, quota, turns, usd };
}

function failureFromLoop(
  failure: { kind: string } | undefined,
): IterationFailureReason | undefined {
  switch (failure?.kind) {
    case "quota":
      return "quota";
    case "auth":
      return "auth";
    case "interrupted":
      return "interrupted";
    case "turn_cap":
      return "turn_cap";
    case "timeout":
      return "timeout";
    case "stuck":
      return "stuck";
    case "provider":
      return "provider";
    default:
      return undefined;
  }
}

function costOf(
  result: { usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } },
  provider: string,
  model: string | undefined,
): number | undefined {
  if (!result.usage || !model) return undefined;
  return priceUsd(provider, model, {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadInputTokens,
    cacheWriteTokens: result.usage.cacheCreationInputTokens,
  });
}

/** `AbortSignal.any` without requiring the newer Node built-in everywhere. */
function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  const controller = new AbortController();
  for (const s of present) {
    if (s.aborted) {
      controller.abort();
      return controller.signal;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}
