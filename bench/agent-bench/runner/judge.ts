// =============================================================================
// The two-judge panel. BuffBench's arithmetic (freebuff evals/buffbench/
// judge.ts, Apache-2.0), with our judges.
// Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.6.
//
// Scores are the mean of the judges that answered. Analysis, strengths and
// weaknesses come from the median judge (ascending by overall, index
// floor(n/2), which is the higher of two). A dead judge is warned about,
// never silently dropped: that silence is how BuffBench's panel quietly
// became one model. All dead scores 0, exactly as theirs, plus `judgeFailed`
// so a blackout is not read as a bad patch.
// =============================================================================

import { JUDGE_SYSTEM, renderJudgePrompt, type JudgeInput } from "./judge-prompt.js";

export interface Judging {
  analysis: string;
  strengths: string[];
  weaknesses: string[];
  completionScore: number;
  codeQualityScore: number;
  overallScore: number;
}

export interface JudgeScore {
  judgeId: string;
  overallScore?: number;
  completionScore?: number;
  codeQualityScore?: number;
  failed?: true;
}

export interface PanelJudging extends Judging {
  judgeScores: JudgeScore[];
  judgeFailed?: true;
}

export interface JudgeSpec {
  id: string;
  /**
   * A freecode provider id (served by core's providers), or "codex" (served by
   * `codex exec`, see core-complete.ts judgeComplete).
   */
  provider: string;
  model: string;
}

/**
 * Pinned 2026-09-29. Gemini: 3.5-flash, the strongest this key can call —
 * gemini-3.1-pro-preview is out of quota, 2.5-pro and 3-pro-preview are
 * retired for new users (probed 2026-09-29). A retired id surfaces as a dead judge, not an error, so
 * both ids are written into every judged report. Sonnet goes through the
 * GPT goes through `codex exec` on the owner's Codex subscription
 * (codex-complete.ts): the Claude-subscription Sonnet judge was refused by
 * Anthropic ("OAuth authentication is currently not allowed for this
 * organization"), probed 2026-09-29.
 */
export const JUDGES: JudgeSpec[] = [
  { id: "judge-gemini", provider: "gemini", model: "gemini-3.5-flash" },
  { id: "judge-gpt", provider: "codex", model: "gpt-5.5" },
];

/** Theirs: 20 minutes per judge. */
export const JUDGE_TIMEOUT_MS = 20 * 60 * 1000;

export type Complete = (
  judge: JudgeSpec,
  system: string,
  prompt: string,
  signal: AbortSignal,
) => Promise<string>;

/**
 * The model family behind a `provider/model` string or a bare model id.
 * Agent adapters use their own dialect: freecode says `minimax/MiniMax-M3`,
 * the claude-code adapter says `MiniMax-M3`. Matching on the provider prefix
 * alone let a bare id through as a "provider" that matches nothing.
 */
export function familyOf(model: string): string {
  const m = model.toLowerCase();
  if (/minimax/.test(m)) return "minimax";
  if (/^codex\/|openai|(^|\/)(gpt|o\d)/.test(m)) return "openai";
  if (/gemini|google/.test(m)) return "google";
  if (/claude|anthropic/.test(m)) return "anthropic";
  return m.split("/")[0];
}

/**
 * Refuse a judge from the model under test's family. Spec §4.6 excludes the
 * family, not one id: a MiniMax judge prefers MiniMax-shaped output whichever
 * MiniMax it is.
 */
export function assertNoCollision(judges: JudgeSpec[], modelUnderTest: string): void {
  const family = familyOf(modelUnderTest);
  for (const j of judges) {
    if (familyOf(`${j.provider}/${j.model}`) === family) {
      throw new Error(
        `${j.id} (${j.provider}/${j.model}) is from the same model family as the model under test ` +
          `(${modelUnderTest}); a judge may not grade its own family (spec §4.6)`,
      );
    }
  }
}

const isScore = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10;
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

/** The reply's JSON object, or null when it does not match the schema. */
export function parseJudging(text: string): Judging | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (
    typeof o.analysis !== "string" ||
    !isStrings(o.strengths) ||
    !isStrings(o.weaknesses) ||
    !isScore(o.completionScore) ||
    !isScore(o.codeQualityScore) ||
    !isScore(o.overallScore)
  ) {
    return null;
  }
  // A judge that answered on a 0–1 scale passes the bounds check and would
  // be scored as ~0.9/10. Seen 2026-09-29 (gpt-5.5, 0.88 on a correct patch).
  // All three at or below 1 with one of them fractional is that, never a real
  // 0–10 verdict. BuffBench's genuine failures are whole 0s and 1s.
  const scores = [o.completionScore, o.codeQualityScore, o.overallScore];
  if (scores.every((v) => v <= 1) && scores.some((v) => v > 0 && v < 1)) {
    return null;
  }
  return {
    analysis: o.analysis,
    strengths: o.strengths,
    weaknesses: o.weaknesses,
    completionScore: o.completionScore,
    codeQualityScore: o.codeQualityScore,
    overallScore: o.overallScore,
  };
}

export function aggregatePanel(
  judgeIds: string[],
  results: (Judging | null)[],
  label: string,
  warn: (msg: string) => void = console.warn,
): PanelJudging {
  const judgeScores: JudgeScore[] = judgeIds.map((judgeId, i) => {
    const r = results[i];
    return r
      ? {
          judgeId,
          overallScore: r.overallScore,
          completionScore: r.completionScore,
          codeQualityScore: r.codeQualityScore,
        }
      : { judgeId, failed: true };
  });
  const valid = results.filter((r): r is Judging => r !== null);

  if (valid.length === 0) {
    warn(`All judges failed to provide results for ${label}`);
    return {
      analysis: "Error running judge agent - all judges failed",
      strengths: [],
      weaknesses: ["All judges failed to provide structured output"],
      completionScore: 0,
      codeQualityScore: 0,
      overallScore: 0,
      judgeScores,
      judgeFailed: true,
    };
  }
  const failed = judgeIds.filter((_, i) => !results[i]);
  if (failed.length > 0) {
    warn(
      `⚠️  Judge panel degraded for ${label}: ${failed.join(", ")} failed. ` +
        `Scoring from ${valid.length}/${judgeIds.length} judges.`,
    );
  }

  const median = [...valid].sort((a, b) => a.overallScore - b.overallScore)[
    Math.floor(valid.length / 2)
  ];
  const mean = (key: "completionScore" | "codeQualityScore" | "overallScore") =>
    valid.reduce((n, r) => n + r[key], 0) / valid.length;
  return {
    analysis: median.analysis,
    strengths: median.strengths,
    weaknesses: median.weaknesses,
    completionScore: mean("completionScore"),
    codeQualityScore: mean("codeQualityScore"),
    overallScore: mean("overallScore"),
    judgeScores,
  };
}

export async function runOne(
  judge: JudgeSpec,
  complete: Complete,
  system: string,
  prompt: string,
  timeoutMs: number,
  warn: (msg: string) => void,
): Promise<Judging | null> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    // Raced as well as aborted: the signal asks, the race guarantees.
    const text = await Promise.race([
      complete(judge, system, prompt, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`judge timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    const parsed = parseJudging(text);
    if (!parsed) warn(`Judge ${judge.id} - not structured output: ${text.slice(0, 200)}`);
    return parsed;
  } catch (err) {
    // Theirs: `Judge ${id} failed:` — a reason, not just a count.
    warn(`Judge ${judge.id} failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function judgePanel(
  input: JudgeInput,
  complete: Complete,
  opts: {
    judges?: JudgeSpec[];
    timeoutMs?: number;
    label?: string;
    warn?: (msg: string) => void;
  } = {},
): Promise<PanelJudging> {
  const judges = opts.judges ?? JUDGES;
  const prompt = renderJudgePrompt(input);
  const results = await Promise.all(
    judges.map((j) =>
      runOne(
        j,
        complete,
        JUDGE_SYSTEM,
        prompt,
        opts.timeoutMs ?? JUDGE_TIMEOUT_MS,
        opts.warn ?? console.warn,
      ),
    ),
  );
  return aggregatePanel(
    judges.map((j) => j.id),
    results,
    opts.label ?? "task",
    opts.warn,
  );
}
