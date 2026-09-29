#!/usr/bin/env tsx
// =============================================================================
// Score a finished judged run. Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md
// §4.4 step 5, §4.5, §4.6, §5.
//
//   pnpm bench:judge bench/agent-bench/results/<run> [--panel] [--rejudge] [--concurrency N] [--tasks <file>]
//
// Audit mode by default (Gemini scores, GPT audits 20% and falls back);
// `--panel` runs BuffBench's full two-judge panel on every trial instead.
// Resumable: a trial that already has `judging` is skipped unless --rejudge,
// and report.json is rewritten after every verdict. Writes judging.json per
// trial (the full analysis) and judged-report.json per run (§5's numbers).
// =============================================================================

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { judgeComplete, type JudgeUsage } from "./core-complete.js";
import { auditAgreement, judgeAudited, MAX_AUDIT_GAP, MIN_AUDITS } from "./judge-audit.js";
import { JUDGES, assertNoCollision, judgePanel } from "./judge.js";
import type { FinalCheckOutput, JudgeInput } from "./judge-prompt.js";
import { INSTANCE_PREFIX, REPO_DIR, loadJudgedTasks } from "./judged-instances.js";
import { MAX_ONE_JUDGE_SHARE, panelVerdict, summarize, type JudgedRow } from "./judged-metrics.js";
import type { JudgedTask } from "./task-build.js";
import type { Report, TrialJudging, TrialRecord } from "./types.js";

const ROOT = path.join(import.meta.dirname, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const errored = (t: TrialRecord) => t.timedOut || t.reason.startsWith("harness error");

function contextFiles(task: JudgedTask): Record<string, string> {
  // Theirs: supplemental files plus every changed path that existed at the parent.
  const paths = new Set([
    ...task.supplementalFiles,
    ...task.fileDiffs.filter((f) => f.status !== "added").map((f) => f.oldPath ?? f.path),
  ]);
  const out: Record<string, string> = {};
  for (const p of paths) {
    try {
      out[p] = execFileSync("git", ["show", `${task.parentSha}:${p}`], {
        cwd: REPO_DIR,
        encoding: "utf-8",
        maxBuffer: 64 << 20,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      out[p] = "";
    }
  }
  return out;
}

function judgeInput(task: JudgedTask, trial: TrialRecord): JudgeInput {
  const dir = path.join(ROOT, trial.artifactDir);
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf-8") : "");
  const checks = read("final-checks.json");
  return {
    // The judge sees the task as the user typed it, not our wrapper template.
    prompt: task.prompt,
    contextFiles: contextFiles(task),
    groundTruth: task.fileDiffs.map((f) => ({ path: f.path, diff: f.diff })),
    agentDiff: read("patch.diff"),
    error: errored(trial) ? trial.reason : undefined,
    finalCheckOutputs: checks ? (JSON.parse(checks) as FinalCheckOutput[]) : undefined,
  };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main(): Promise<void> {
  const runDir = process.argv[2];
  if (!runDir || runDir.startsWith("--")) throw new Error("usage: pnpm bench:judge <results/run> [--panel] [--rejudge]");
  const reportFile = path.join(runDir, "report.json");
  const report = JSON.parse(fs.readFileSync(reportFile, "utf-8")) as Report;
  if (report.set !== "freecode-commits") {
    throw new Error(`${reportFile} is a ${report.set ?? "swe-bench-lite"} run: grade it with pnpm bench:grade`);
  }
  const panel = process.argv.includes("--panel");
  const rejudge = process.argv.includes("--rejudge");
  // --tasks: an alternative approved task file (a smoke test, or a frozen copy
  // of the set a published run used).
  const tasks = new Map(loadJudgedTasks(arg("tasks")).map((t) => [`${INSTANCE_PREFIX}${t.id}`, t]));
  // Before any spend: a judge from the agents' own family is refused (§4.6).
  for (const model of new Set(report.trials.map((t) => t.model))) assertNoCollision(JUDGES, model);

  const usage: JudgeUsage = {};
  const complete = judgeComplete(usage);
  const todo = report.trials.filter((t) => rejudge || !t.judging);
  console.log(
    `${report.trials.length} trials, judging ${todo.length} — ${panel ? "full panel" : "audit mode"}: ` +
      JUDGES.map((j) => `${j.provider}/${j.model}`).join(" + "),
  );

  let done = 0;
  await mapLimit(todo, Number(arg("concurrency") ?? 4), async (trial) => {
    const task = tasks.get(trial.instanceId);
    const label = `${trial.instanceId} t${trial.trial} ${trial.agent}`;
    if (!task) {
      console.warn(`${label}: not in the approved task file, skipped`);
      return;
    }
    const input = judgeInput(task, trial);
    const verdict = panel
      ? { ...(await judgePanel(input, complete, { label })), scoredBy: "panel" }
      : await judgeAudited(input, complete, { auditKey: `${task.id}|${trial.agent}|${trial.trial}`, label });
    fs.writeFileSync(path.join(ROOT, trial.artifactDir, "judging.json"), JSON.stringify(verdict, null, 2));
    const summary: TrialJudging = {
      overallScore: verdict.overallScore,
      completionScore: verdict.completionScore,
      codeQualityScore: verdict.codeQualityScore,
      scoredBy: verdict.scoredBy,
      ...("audited" in verdict && verdict.audited ? { audited: true as const } : {}),
      ...("fallback" in verdict && verdict.fallback ? { fallback: true as const } : {}),
      ...(verdict.judgeFailed ? { judgeFailed: true as const } : {}),
      judgeScores: verdict.judgeScores.map((s) => ({
        judgeId: s.judgeId,
        ...(s.failed ? { failed: true as const } : { overallScore: s.overallScore }),
      })),
    };
    trial.judging = summary;
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`[${++done}/${todo.length}] ${label}  ${summary.overallScore.toFixed(1)}  by ${summary.scoredBy}${summary.audited ? " (audited)" : ""}`);
  });

  const rows: JudgedRow[] = report.trials
    .filter((t) => t.judging && tasks.has(t.instanceId))
    .map((t) => {
      const task = tasks.get(t.instanceId)!;
      return {
        agent: t.agent,
        taskId: task.id,
        trial: t.trial,
        app: task.app,
        coAuthoredByClaude: task.coAuthoredByClaude,
        judging: t.judging!,
        usd: t.usd,
        durationMs: t.durationMs,
        errored: errored(t),
      };
    });
  const summary = summarize(rows);
  const agreement = auditAgreement(rows.map((r) => r.judging));
  const pv = panelVerdict(summary.counts, rows.length);
  const verdictLine = panel
    ? pv.ok
      ? `full panel: ${(pv.share * 100).toFixed(0)}% of trials scored by fewer than two judges (≤ ${MAX_ONE_JUDGE_SHARE * 100}%)`
      : `full panel DEGRADED: ${(pv.share * 100).toFixed(0)}% of trials scored by fewer than two judges (> ${MAX_ONE_JUDGE_SHARE * 100}%): not a two-judge run`
    : agreement.n < MIN_AUDITS
      ? `audit UNMEASURED (${agreement.n} two-sided audits, need ${MIN_AUDITS}): a published number needs --panel`
      : agreement.passes
        ? `scored by Gemini, audited by GPT: n=${agreement.n}, mean gap ${agreement.meanAbsGap.toFixed(2)} ≤ ${MAX_AUDIT_GAP}`
        : `audit FAILED: mean gap ${agreement.meanAbsGap.toFixed(2)} > ${MAX_AUDIT_GAP} over n=${agreement.n}; a published number needs --panel`;
  const judgingVerified = panel ? pv.ok : agreement.passes;
  const contaminationChecked = report.contamination?.checked === true;
  const publishable = report.isolation === "container" && judgingVerified && contaminationChecked;

  fs.writeFileSync(
    path.join(runDir, "judged-report.json"),
    JSON.stringify(
      {
        mode: panel ? "panel" : "audit",
        judges: JUDGES,
        isolation: report.isolation,
        contamination: report.contamination ?? null,
        publishable,
        verdict: verdictLine,
        judgeTokens: usage,
        summary,
      },
      null,
      2,
    ),
  );

  console.log(`\n${verdictLine}`);
  if (!publishable) {
    console.log(
      `NOT publishable: ${report.isolation !== "container" ? "run was not isolated (--isolate); " : ""}` +
        `${judgingVerified ? "" : "judging not verified; "}` +
        `${contaminationChecked ? "" : "contamination check not passed (spec §4.8)"}`,
    );
  }
  console.log(`\n${"agent".padEnd(12)} runs   avg  avg>1   $/run   min/run   core   tui  claude-co  other`);
  const f = (n?: number) => (n === undefined ? "  -  " : n.toFixed(2).padStart(5));
  for (const [agent, a] of Object.entries(summary.agents)) {
    console.log(
      `${agent.padEnd(12)} ${String(a.runs).padStart(4)} ${f(a.averageScore)} ${f(a.averageScoreExcludingFailures)}  ` +
        `${a.averageCost === null ? "   n/a" : a.averageCost.toFixed(3).padStart(6)}  ${(a.averageDuration / 60000).toFixed(1).padStart(7)}  ` +
        `${f(a.byApp.core?.averageScore)} ${f(a.byApp.tui?.averageScore)}  ${f(a.byCoAuthor.claude?.averageScore)}     ${f(a.byCoAuthor.other?.averageScore)}`,
    );
  }
  for (const i of summary.intersections) {
    console.log(
      `\ncost on tasks both solved (≥7.5), ${i.agent} vs ${i.versus}: |I|=${i.n}` +
        (i.agentUsd === null ? " — suppressed (|I| < 3 or cost unknown)" : `  $${i.agentUsd.toFixed(3)} vs $${i.versusUsd!.toFixed(3)}`),
    );
  }
  if (summary.excludedRuns.length) console.log(`excluded (an agent errored): ${summary.excludedRuns.join(", ")}`);
  if (summary.spread.length) console.log(`trials ≥3 apart: ${summary.spread.map((s) => `${s.agent}/${s.taskId} ${s.min}–${s.max}`).join(", ")}`);
  if (summary.saturated.length) console.log(`saturated (everyone > 7.5): ${summary.saturated.join(", ")}`);
  console.log(
    `judging: ${summary.counts.audited} audited, ${summary.counts.fallback} fallback, ` +
      `${summary.counts.degraded} degraded, ${summary.counts.blackout} blackout`,
  );
  console.log(`judge tokens: ${Object.entries(usage).map(([k, u]) => `${k} ${u.calls} calls in ${u.inputTokens.toLocaleString()}`).join(", ") || "none this pass"}`);
  console.log(`\n${path.join(runDir, "judged-report.json")}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
