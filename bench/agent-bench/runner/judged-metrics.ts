// =============================================================================
// The judged set's numbers. Spec §5.
//
// BuffBench's four (averageScore, averageScoreExcludingFailures > 1.0,
// averageCost, averageDuration) after their exclusion rule: a run where ANY
// agent errored is dropped for EVERY agent, so nobody is scored on a different
// set. They run one trial, so "run" was a commit. With 3 trials it is a
// (task, trial) pair: one crashed trial must not discard the other two.
// Everything else here is ours, required by the parent spec or §5.
// =============================================================================

import type { App } from "./commits.js";
import { auditAgreement, type AuditAgreement } from "./judge-audit.js";
import type { TrialJudging } from "./types.js";

/** Theirs (`analyze-task-scores.ts`): above this, a task is not hard. Also our "solved" (§5). */
export const SOLVED = 7.5;
/** Trials of one task by one agent this far apart are listed (§5). */
export const SPREAD = 3;
/** Parent spec §7.2: below this, an intersection mean is an anecdote. */
export const MIN_INTERSECTION = 3;
/**
 * Spec §6.6: a full-panel run with more than this share of trials not scored
 * by both judges (one dead, or both) is not a two-judge run.
 */
export const MAX_ONE_JUDGE_SHARE = 0.1;

export interface JudgedRow {
  agent: string;
  taskId: string;
  trial: number;
  app: App;
  coAuthoredByClaude: boolean;
  judging: TrialJudging;
  /** undefined without the meter, null when unpriced. */
  usd?: number | null;
  durationMs: number;
  /** Harness error or timeout: BuffBench's `evalRun.error`. */
  errored: boolean;
}

interface Slice {
  n: number;
  averageScore: number;
}

export interface AgentSummary {
  runs: number;
  averageScore: number;
  averageScoreExcludingFailures: number;
  /** null when any run is unmetered or unpriced: an average over some runs is not the average. */
  averageCost: number | null;
  averageDuration: number;
  byApp: Partial<Record<App, Slice>>;
  byCoAuthor: { claude?: Slice; other?: Slice };
}

export interface Intersection {
  agent: string;
  versus: string;
  n: number;
  /** Mean USD over I, or null when |I| < 3 or any cost is unknown. */
  agentUsd: number | null;
  versusUsd: number | null;
}

export interface JudgedSummary {
  excludedRuns: string[];
  agents: Record<string, AgentSummary>;
  spread: { agent: string; taskId: string; min: number; max: number }[];
  saturated: string[];
  intersections: Intersection[];
  audit: AuditAgreement;
  /** `degraded`: full-panel trials scored by one judge (the other failed). */
  counts: { audited: number; fallback: number; degraded: number; blackout: number };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const slice = (rows: JudgedRow[]): Slice | undefined =>
  rows.length ? { n: rows.length, averageScore: mean(rows.map((r) => r.judging.overallScore)) } : undefined;

function costOf(rows: JudgedRow[]): number | null {
  if (rows.some((r) => typeof r.usd !== "number")) return null;
  return mean(rows.map((r) => r.usd as number));
}

export function summarize(rows: JudgedRow[], versus = "freecode"): JudgedSummary {
  const runKey = (r: JudgedRow) => `${r.taskId}|${r.trial}`;
  const excluded = new Set(rows.filter((r) => r.errored).map(runKey));
  const valid = rows.filter((r) => !excluded.has(runKey(r)));
  const agentIds = [...new Set(rows.map((r) => r.agent))];

  const agents: Record<string, AgentSummary> = {};
  for (const agent of agentIds) {
    const mine = valid.filter((r) => r.agent === agent);
    const scores = mine.map((r) => r.judging.overallScore);
    const byApp: Partial<Record<App, Slice>> = {};
    for (const app of ["core", "tui"] as const) {
      const s = slice(mine.filter((r) => r.app === app));
      if (s) byApp[app] = s;
    }
    agents[agent] = {
      runs: mine.length,
      averageScore: mean(scores),
      averageScoreExcludingFailures: mean(scores.filter((s) => s > 1.0)),
      averageCost: mine.length ? costOf(mine) : null,
      averageDuration: mean(mine.map((r) => r.durationMs)),
      byApp,
      byCoAuthor: {
        claude: slice(mine.filter((r) => r.coAuthoredByClaude)),
        other: slice(mine.filter((r) => !r.coAuthoredByClaude)),
      },
    };
  }

  const groups = new Map<string, JudgedRow[]>();
  for (const r of valid) {
    const k = `${r.agent}|${r.taskId}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const spread: JudgedSummary["spread"] = [];
  for (const g of groups.values()) {
    const s = g.map((r) => r.judging.overallScore);
    const min = Math.min(...s);
    const max = Math.max(...s);
    if (max - min >= SPREAD) spread.push({ agent: g[0].agent, taskId: g[0].taskId, min, max });
  }

  const taskIds = [...new Set(valid.map((r) => r.taskId))];
  const saturated = taskIds.filter((t) =>
    valid.filter((r) => r.taskId === t).every((r) => r.judging.overallScore > SOLVED),
  );

  const solvedTasks = (agent: string) =>
    new Set(
      taskIds.filter((t) => {
        const g = groups.get(`${agent}|${t}`);
        return g && mean(g.map((r) => r.judging.overallScore)) >= SOLVED;
      }),
    );
  const taskCost = (agent: string, tasks: string[]) => {
    const costs = tasks.map((t) => costOf(groups.get(`${agent}|${t}`) ?? []));
    return costs.some((c) => c === null) ? null : mean(costs as number[]);
  };
  const intersections: Intersection[] = [];
  if (agentIds.includes(versus)) {
    const base = solvedTasks(versus);
    for (const agent of agentIds.filter((a) => a !== versus)) {
      const both = [...solvedTasks(agent)].filter((t) => base.has(t));
      const shown = both.length >= MIN_INTERSECTION;
      intersections.push({
        agent,
        versus,
        n: both.length,
        agentUsd: shown ? taskCost(agent, both) : null,
        versusUsd: shown ? taskCost(versus, both) : null,
      });
    }
  }

  return {
    excludedRuns: [...excluded].sort(),
    agents,
    spread,
    saturated,
    intersections,
    audit: auditAgreement(rows.map((r) => r.judging)),
    counts: {
      audited: rows.filter((r) => r.judging.audited).length,
      fallback: rows.filter((r) => r.judging.fallback).length,
      degraded: rows.filter(
        (r) => r.judging.scoredBy === "panel" && !r.judging.judgeFailed && r.judging.judgeScores.some((s) => s.failed),
      ).length,
      blackout: rows.filter((r) => r.judging.judgeFailed).length,
    },
  };
}

/**
 * Spec §6.6, full-panel mode: two-judge only while at most 10% of trials were
 * scored by fewer than two judges. `ok` is false on no trials at all.
 */
export function panelVerdict(counts: JudgedSummary["counts"], trials: number): { ok: boolean; share: number } {
  const share = trials ? (counts.degraded + counts.blackout) / trials : 1;
  return { ok: trials > 0 && share <= MAX_ONE_JUDGE_SHARE, share };
}
