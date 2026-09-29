// =============================================================================
// Audit mode: Gemini scores every trial, GPT re-judges a sample.
// Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.6 ("Audit mode").
//
// The owner's choice (2026-09-29) over the full panel, because a GPT call on
// these tasks is ~118K input tokens on the Codex subscription. The score is
// always the primary's, never a mean, so an audited trial and an unaudited
// one are scored the same way; the auditor's score exists only to measure
// agreement. Which trials are audited comes from a hash of
// (task, agent, trial), so re-judging a run audits the same sample.
// =============================================================================

import { createHash } from "crypto";
import {
  JUDGES,
  JUDGE_TIMEOUT_MS,
  aggregatePanel,
  runOne,
  type Complete,
  type JudgeScore,
  type Judging,
  type PanelJudging,
} from "./judge.js";
import { JUDGE_SYSTEM, renderJudgePrompt, type JudgeInput } from "./judge-prompt.js";

export const AUDIT_RATE = 0.2;
/**
 * A run in audit mode is reported as "scored by Gemini" only while the two
 * judges agree to within this many points (mean |Gemini − GPT| over audited
 * trials, 0–10 scale). Past it, the report says the audit failed and a
 * published number needs the full panel.
 */
export const MAX_AUDIT_GAP = 1.5;
/** Below this many two-sided audits, agreement is unmeasured, not passed. */
export const MIN_AUDITS = 5;
/**
 * The primary is retried before the auditor takes over. Every fallback puts a
 * second judge's scale into a run the report calls Gemini-scored, and the
 * first live smoke (2026-09-29) fell back on BOTH trials over a transient
 * "model is experiencing high demand".
 */
export const PRIMARY_RETRY_DELAYS_MS = [20_000, 60_000];

export interface AuditedJudging extends PanelJudging {
  /** The judge whose verdict is the score, or "none" when both failed. */
  scoredBy: string;
  audited?: true;
  /** The primary failed and the auditor's verdict is the score. */
  fallback?: true;
}

export function isAudited(key: string, rate = AUDIT_RATE): boolean {
  const n = createHash("sha256").update(key).digest().readUInt32BE(0);
  return n / 2 ** 32 < rate;
}

export async function judgeAudited(
  input: JudgeInput,
  complete: Complete,
  opts: {
    /** `${taskId}|${agent}|${trial}` — decides the sample. */
    auditKey: string;
    rate?: number;
    timeoutMs?: number;
    label?: string;
    warn?: (msg: string) => void;
    retryDelaysMs?: number[];
  },
): Promise<AuditedJudging> {
  const [primary, auditor] = JUDGES;
  const warn = opts.warn ?? console.warn;
  const label = opts.label ?? "task";
  const prompt = renderJudgePrompt(input);
  const run = (j: typeof primary) =>
    runOne(j, complete, JUDGE_SYSTEM, prompt, opts.timeoutMs ?? JUDGE_TIMEOUT_MS, warn);
  const audited = isAudited(opts.auditKey, opts.rate);
  const runPrimary = async () => {
    let verdict = await run(primary);
    for (const delay of opts.retryDelaysMs ?? PRIMARY_RETRY_DELAYS_MS) {
      if (verdict) break;
      warn(`${primary.id} retrying for ${label} in ${delay / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      verdict = await run(primary);
    }
    return verdict;
  };

  const [p, first] = await Promise.all([runPrimary(), audited ? run(auditor) : Promise.resolve(null)]);
  let a = first;
  if (!p) {
    warn(`⚠️  ${primary.id} failed for ${label}: scoring by ${auditor.id} (fallback)`);
    if (!audited) a = await run(auditor);
  }
  const fallback = !p && a !== null;

  const scorer: { id: string; verdict: Judging | null } = p
    ? { id: primary.id, verdict: p }
    : { id: auditor.id, verdict: a };
  const base = aggregatePanel([scorer.id], [scorer.verdict], label, () => {});
  if (!scorer.verdict) warn(`All judges failed to provide results for ${label}`);

  // The auditor is on the record whenever it was called: sampled, or as fallback.
  const calledAuditor = audited || !p;
  const score = (judgeId: string, v: Judging | null): JudgeScore =>
    v
      ? {
          judgeId,
          overallScore: v.overallScore,
          completionScore: v.completionScore,
          codeQualityScore: v.codeQualityScore,
        }
      : { judgeId, failed: true };
  const judgeScores = [score(primary.id, p), ...(calledAuditor ? [score(auditor.id, a)] : [])];

  return {
    ...base,
    judgeScores,
    scoredBy: scorer.verdict ? scorer.id : "none",
    ...(audited ? { audited: true as const } : {}),
    ...(fallback ? { fallback: true as const } : {}),
  };
}

export interface AuditAgreement {
  /** Audited trials where both judges answered. */
  n: number;
  meanAbsGap: number;
  meanPrimary: number;
  meanAuditor: number;
  /** n ≥ MIN_AUDITS and meanAbsGap ≤ MAX_AUDIT_GAP. */
  passes: boolean;
}

export function auditAgreement(
  rows: { audited?: true; judgeScores: JudgeScore[] }[],
): AuditAgreement {
  const [primary, auditor] = JUDGES;
  const pairs: [number, number][] = [];
  for (const r of rows) {
    if (!r.audited) continue;
    const p = r.judgeScores.find((s) => s.judgeId === primary.id)?.overallScore;
    const a = r.judgeScores.find((s) => s.judgeId === auditor.id)?.overallScore;
    if (p !== undefined && a !== undefined) pairs.push([p, a]);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const meanAbsGap = mean(pairs.map(([p, a]) => Math.abs(p - a)));
  return {
    n: pairs.length,
    meanAbsGap,
    meanPrimary: mean(pairs.map(([p]) => p)),
    meanAuditor: mean(pairs.map(([, a]) => a)),
    passes: pairs.length >= MIN_AUDITS && meanAbsGap <= MAX_AUDIT_GAP,
  };
}
