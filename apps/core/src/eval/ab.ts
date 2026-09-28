// =============================================================================
// Paired A/B — pure logic. Spec `2026-08-29-eval-case-registry.md` §6.
//
// `compare.ts` diffs two FINISHED reports, so everything that drifted between
// the two run dates — a rolled snapshot behind a stable alias, a provider-side
// routing change, a different cache state — is confounded into the delta and
// reported as ours. This runs both sides now, interleaved, so the only
// difference left is the one under test.
//
// NOT a gate. Writes nothing to `eval_runs.jsonl`, has no baseline, and always
// exits 0. Results are noisy model-backed signals reported as paired deltas.
// =============================================================================

import type { TrialResult } from "./types.js";

/** One side of the comparison: what to change before running the trial. */
export interface Variant {
  /** `provider/model`, or bare model. Absent = whatever the config resolves. */
  model?: string;
  /** Env overrides. A key set to `undefined` is UNSET, not set to "". */
  env: Record<string, string | undefined>;
}

export class AbError extends Error {}

/**
 * Env vars a variant may set — and ONLY these.
 *
 * `runAb` calls `initRunner()` once, before either side's environment is
 * applied, because `initProviders()`/`initMcpServers()` are global and
 * stateful. So a variant can only move a setting that is re-read AFTER init.
 * Every name below has been checked to be read per turn or per call:
 *
 *   FREECODE_DISABLE_REDIRECT          `loadRedirectSettings`, every iteration
 *   FREECODE_DISABLE_MEMORY_EXTRACTION `shouldExtract`, every turn
 *   FREECODE_DISABLE_MEMORY_JUDGE      `loadMemorySettings`, every call
 *   FREECODE_DISABLE_MEMORY_CONSOLIDATION `shouldConsolidate`, every call
 *   FREECODE_DISABLE_MEMORY_RECALL     `loadMemorySettings`, every request
 *   FREECODE_BASH_COMPRESS             `maybeCompressOutput`, every tool call
 *   FREECODE_READ_LINE_NUMBERS         read's `execute`, every call
 *   FREECODE_EPHEMERAL_TAIL            `executeTurn`, every iteration
 *   FREECODE_TODO_NUDGE                `shouldNudgeTodo`/`todoNudgeReminder`,
 *                                      every iteration
 *   FREECODE_SYSTEM_FILE               `loadSystemPromptFor`, every turn (the
 *   FREECODE_APPEND_SYSTEM_FILE        compiler rebuilds the system prompt per
 *                                      request; only the shipped .md is cached)
 *   FREECODE_AUTO_POKE                 `loadSignalSettings`, once per AgentLoop
 *   FREECODE_CONFIDENCE_GATE           instance — and the runner builds a
 *   FREECODE_HILLCLIMB_GATE            fresh loop per trial
 *
 * A startup-read var (a provider key, a config path, a fetch timeout baked into
 * the client at `createTimeoutFetch`) would be swapped into `process.env` and
 * then read by nobody. Both sides would run identically and the report would
 * say `unchanged-pass` — a confident verdict on an experiment that never
 * happened, which is the exact failure this command exists to avoid. An
 * allowlist fails loudly instead; extend it only after checking the read site.
 */
export const VARIABLE_ENV_KEYS = [
  "FREECODE_DISABLE_REDIRECT",
  "FREECODE_DISABLE_MEMORY_EXTRACTION",
  "FREECODE_DISABLE_MEMORY_JUDGE",
  "FREECODE_DISABLE_MEMORY_CONSOLIDATION",
  "FREECODE_DISABLE_MEMORY_RECALL",
  "FREECODE_BASH_COMPRESS",
  "FREECODE_READ_LINE_NUMBERS",
  "FREECODE_EPHEMERAL_TAIL",
  "FREECODE_TODO_NUDGE",
  "FREECODE_SYSTEM_FILE",
  "FREECODE_APPEND_SYSTEM_FILE",
  // Read per-call in renderRetrievedMemories (mem-prompt.ts).
  "FREECODE_MEMORY_PROMPT",
  "FREECODE_AUTO_POKE",
  "FREECODE_CONFIDENCE_GATE",
  "FREECODE_HILLCLIMB_GATE",
  // Read per call in compileDynamicContext and loadSystemPrompt.
  "FREECODE_CONTEXT_FRAMING",
  // Read per call in modelPromptOverlay (session/model-prompt.ts).
  "FREECODE_MODEL_OVERLAY",
] as const;

/**
 * `model=p/m,env:FOO=1,env:BAR=` — comma-separated assignments.
 *
 * An empty string is the identity variant, which is how you A/B one axis while
 * leaving the other at whatever the config says. `env:BAR=` UNSETS `BAR`: the
 * difference between "absent" and "empty string" matters to every
 * `isEnvTruthy`-style reader in the codebase, so it has to be expressible.
 */
export function parseVariant(spec: string, label: string): Variant {
  const variant: Variant = { env: {} };
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) {
      throw new AbError(
        `${label}: '${part}' is not an assignment — use model=<p/m> or env:NAME=value`,
      );
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1);
    if (key === "model") {
      if (!value.trim()) throw new AbError(`${label}: 'model=' needs a value`);
      variant.model = value.trim();
    } else if (key.startsWith("env:")) {
      const name = key.slice(4).trim();
      if (!name) throw new AbError(`${label}: 'env:' needs a variable name`);
      if (!(VARIABLE_ENV_KEYS as readonly string[]).includes(name)) {
        throw new AbError(
          `${label}: '${name}' is not known to be re-read after the runner ` +
            `boots, so both sides would run identically and the report would ` +
            `say "unchanged" about an experiment that never happened. ` +
            `Supported: ${VARIABLE_ENV_KEYS.join(", ")}. To add one, check ` +
            `its read site is per-turn and extend VARIABLE_ENV_KEYS.`,
        );
      }
      variant.env[name] = value === "" ? undefined : value;
    } else {
      throw new AbError(
        `${label}: unknown key '${key}' — expected 'model' or 'env:NAME'`,
      );
    }
  }
  return variant;
}

/**
 * Which side runs first on this trial. Alternating cancels ordering and
 * warm-cache bias; with prompt caching in play that bias is not small, and a
 * fixed order silently advantages whichever side runs second.
 */
export function trialOrder(trialIndex: number): ["baseline", "candidate"] | ["candidate", "baseline"] {
  return trialIndex % 2 === 0
    ? ["baseline", "candidate"]
    : ["candidate", "baseline"];
}

/** Credential-shaped values never reach an artifact. */
export function redactValue(key: string, value: string | undefined): string {
  if (value === undefined) return "<unset>";
  return /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)
    ? "[redacted]"
    : value;
}

export function redactVariant(v: Variant): Record<string, string> {
  const out: Record<string, string> = {};
  if (v.model) out.model = v.model;
  for (const [k, val] of Object.entries(v.env)) {
    out[`env:${k}`] = redactValue(k, val);
  }
  return out;
}

export type Delta =
  | "improved"
  | "regressed"
  | "unchanged-pass"
  | "unchanged-fail"
  | "inconclusive";

export interface SideTally {
  /** Trials that passed. */
  passed: number;
  /** Trials that ran at all — a trial that died on infrastructure does not. */
  ran: number;
  infrastructureFailures?: number;
  /** Model calls across all attempts, including infrastructure failures. */
  turns: number;
  /** Redundant tool calls, summed — the tell-tale of a recovery detour. */
  repeatedCalls: number;
  /** input + output tokens across all attempts. */
  tokens: number;
  /**
   * USD summed over PRICED trials only — `undefined` when nothing priced, so
   * "free" and "we cannot say" stay distinguishable (compare.ts semantics).
   * The very numbers a harness experiment exists to move; the first A/B run
   * of `FREECODE_BASH_COMPRESS` reported quality and silently dropped these.
   */
  costUsd?: number;
  /**
   * Trials whose cost is unknown (unpriced model, or memory work still pending
   * when the trial ended). When non-zero, `costUsd` is a lower bound and must
   * not be compared against another side as if it were a total.
   */
  unpricedTrials?: number;
  /**
   * Per-operation cost breakdown for priced trials. Today only
   * `consolidation` is populated (the controlled pre-final pass in
   * `evals/memory-consolidation.jsonl`), so a verdict can report the merge
   * call's cost separately from the trial's model spend.
   *
   * `undefined` (key absent) when no priced trial reported the operation —
   * not `0`, so "we did not measure" stays distinct from "we measured zero".
   */
  costByOperation?: Record<string, number>;
}

/** Legacy reports had only reason strings; new trials carry `infra`. */
export function isInfrastructureFailure(t: Pick<TrialResult, "reason" | "infra">): boolean {
  return t.infra ?? (
    t.reason.startsWith("run failed:") || t.reason.startsWith("model error:") ||
    t.reason === "model call hung" || t.reason === "no rollout events recorded"
  );
}

/** Pure fold of one side's trials. `ran` excludes infrastructure deaths. */
export function tallyOf(
  trials: Pick<
    TrialResult,
    | "passed"
    | "reason"
    | "infra"
    | "turns"
    | "repeatedCalls"
    | "inputTokens"
    | "outputTokens"
    | "costUsd"
    | "costPartial"
    | "costByOperation"
  >[],
): SideTally {
  const tally: SideTally = { passed: 0, ran: 0, turns: 0, repeatedCalls: 0, tokens: 0 };
  for (const t of trials) {
    if (isInfrastructureFailure(t)) {
      tally.infrastructureFailures = (tally.infrastructureFailures ?? 0) + 1;
    } else {
      if (t.passed) tally.passed++;
      tally.ran++;
    }
    // Retain actual spend even for a trial that failed partway through.
    tally.turns += t.turns;
    tally.repeatedCalls += t.repeatedCalls;
    tally.tokens += t.inputTokens + t.outputTokens;
    if (t.costUsd !== undefined) tally.costUsd = (tally.costUsd ?? 0) + t.costUsd;
    if (t.costUsd === undefined || t.costPartial) {
      tally.unpricedTrials = (tally.unpricedTrials ?? 0) + 1;
    }
    if (t.costByOperation) {
      tally.costByOperation = tally.costByOperation ?? {};
      for (const [op, cost] of Object.entries(t.costByOperation)) {
        // Skip `null` (the runner marks a partially-priced operation so the
        // ledger can flag it), and skip `undefined` (key present, no value).
        // Both would pollute the sum with a NaN.
        if (cost === null || cost === undefined) continue;
        tally.costByOperation[op] = (tally.costByOperation[op] ?? 0) + cost;
      }
    }
  }
  return tally;
}

export function comparablePairs(baseline: TrialResult[], candidate: TrialResult[]) {
  const b: TrialResult[] = [], c: TrialResult[] = [];
  for (let i = 0; i < Math.min(baseline.length, candidate.length); i++) {
    if (isInfrastructureFailure(baseline[i]) || isInfrastructureFailure(candidate[i])) continue;
    b.push(baseline[i]);
    c.push(candidate[i]);
  }
  return { pairs: b.length, baseline: tallyOf(b), candidate: tallyOf(c) };
}

/**
 * The paired verdict for one case.
 *
 * `inconclusive` is the honest answer for a low-trial paired run, and refusing
 * to emit it is how an A/B harness launders noise into a decision. Three ways
 * to get it:
 *
 *   1. A side did not complete every trial — an infrastructure failure is not
 *      evidence about the change.
 *   2. `trials < 2`. A single paired trial cannot separate a real effect from
 *      one sample of a stochastic model, whatever the two results were.
 *   3. The majorities differ but the gap is ONE trial. At N=3 that is 2/3 vs
 *      1/3, which is exactly the resolution the trial count cannot support.
 *      Calling it a regression is how a green suite gets reverted for nothing.
 */
export function classify(
  baseline: Pick<SideTally, "passed" | "ran">,
  candidate: Pick<SideTally, "passed" | "ran">,
  trials: number,
): Delta {
  if (baseline.ran < trials || candidate.ran < trials) return "inconclusive";
  if (trials < 2) return "inconclusive";

  const bMajority = baseline.passed * 2 > trials;
  const cMajority = candidate.passed * 2 > trials;
  if (bMajority === cMajority) {
    return bMajority ? "unchanged-pass" : "unchanged-fail";
  }
  if (Math.abs(candidate.passed - baseline.passed) < 2) return "inconclusive";
  return cMajority ? "improved" : "regressed";
}

/** Verdicts that say something happened, in the order a reader cares about. */
export const NOTABLE: Delta[] = ["regressed", "improved", "inconclusive"];
