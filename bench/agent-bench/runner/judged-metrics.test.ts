import test from "node:test";
import assert from "node:assert/strict";
import { panelVerdict, summarize, type JudgedRow } from "./judged-metrics.js";

function row(over: Partial<JudgedRow> & { score: number }): JudgedRow {
  const { score, ...rest } = over;
  return {
    agent: "freecode",
    taskId: "t1",
    trial: 1,
    app: "core",
    coAuthoredByClaude: false,
    judging: {
      overallScore: score,
      completionScore: score,
      codeQualityScore: score,
      scoredBy: "judge-gemini",
      judgeScores: [{ judgeId: "judge-gemini", overallScore: score }],
    },
    usd: 0.1,
    durationMs: 1000,
    errored: false,
    ...rest,
  };
}

test("BuffBench's averages, including the > 1.0 exclusion", () => {
  const s = summarize([
    row({ score: 8, trial: 1 }),
    row({ score: 1, trial: 2 }),
    row({ score: 6, trial: 3, usd: 0.3, durationMs: 4000 }),
  ]);
  const a = s.agents.freecode;
  assert.equal(a.runs, 3);
  assert.equal(a.averageScore, 5);
  assert.equal(a.averageScoreExcludingFailures, 7, "a 1.0 is a huge failure, left out");
  assert.ok(Math.abs((a.averageCost ?? 0) - 0.5 / 3) < 1e-9);
  assert.equal(a.averageDuration, 2000);
});

test("a run any agent errored on is dropped for every agent (per task and trial)", () => {
  const s = summarize([
    row({ agent: "freecode", trial: 1, score: 9 }),
    row({ agent: "claude-code", trial: 1, score: 0, errored: true }),
    row({ agent: "freecode", trial: 2, score: 4 }),
    row({ agent: "claude-code", trial: 2, score: 6 }),
  ]);
  assert.deepEqual(s.excludedRuns, ["t1|1"]);
  assert.equal(s.agents.freecode.averageScore, 4, "freecode's 9 on the errored run is out too");
  assert.equal(s.agents["claude-code"].averageScore, 6);
});

test("cost is null when any run is unmetered or unpriced", () => {
  assert.equal(summarize([row({ score: 5 }), row({ score: 5, trial: 2, usd: null })]).agents.freecode.averageCost, null);
  assert.equal(summarize([row({ score: 5, usd: undefined })]).agents.freecode.averageCost, null);
});

test("per app and per co-author slices never pool", () => {
  const s = summarize([
    row({ score: 8, app: "core", coAuthoredByClaude: true }),
    row({ score: 4, taskId: "t2", app: "tui" }),
  ]);
  assert.deepEqual(s.agents.freecode.byApp, { core: { n: 1, averageScore: 8 }, tui: { n: 1, averageScore: 4 } });
  assert.deepEqual(s.agents.freecode.byCoAuthor.claude, { n: 1, averageScore: 8 });
  assert.deepEqual(s.agents.freecode.byCoAuthor.other, { n: 1, averageScore: 4 });
});

test("spread lists a task whose trials differ by 3+; saturation lists tasks everyone passes", () => {
  const s = summarize([
    row({ taskId: "wobbly", trial: 1, score: 2 }),
    row({ taskId: "wobbly", trial: 2, score: 6 }),
    row({ taskId: "easy", trial: 1, score: 9 }),
    row({ taskId: "easy", trial: 1, agent: "claude-code", score: 8 }),
  ]);
  assert.deepEqual(s.spread, [{ agent: "freecode", taskId: "wobbly", min: 2, max: 6 }]);
  assert.deepEqual(s.saturated, ["easy"]);
});

test("intersection cost: tasks both solved (mean ≥ 7.5), suppressed below 3", () => {
  const rows: JudgedRow[] = [];
  for (const t of ["a", "b", "c", "d"]) {
    rows.push(row({ taskId: t, agent: "freecode", score: 8, usd: 0.1 }));
    rows.push(row({ taskId: t, agent: "claude-code", score: t === "d" ? 3 : 9, usd: 0.3 }));
  }
  const [i] = summarize(rows).intersections;
  assert.equal(i.agent, "claude-code");
  assert.equal(i.versus, "freecode");
  assert.equal(i.n, 3, "d is not solved by claude-code");
  assert.ok(Math.abs((i.agentUsd ?? 0) - 0.3) < 1e-9);
  assert.ok(Math.abs((i.versusUsd ?? 0) - 0.1) < 1e-9);
  const small = summarize(rows.filter((r) => r.taskId !== "a")).intersections[0];
  assert.equal(small.n, 2);
  assert.equal(small.agentUsd, null);
});

test("counts audits, fallbacks and blackouts", () => {
  const base = row({ score: 5 });
  const s = summarize([
    { ...base, judging: { ...base.judging, audited: true } },
    { ...base, trial: 2, judging: { ...base.judging, fallback: true } },
    { ...base, trial: 3, judging: { ...base.judging, judgeFailed: true, overallScore: 0 } },
  ]);
  assert.deepEqual(s.counts, { audited: 1, fallback: 1, degraded: 0, blackout: 1 });
});

test("full panel: a one-judge trial is degraded; more than 10% of them is not a two-judge run", () => {
  const panelRow = (trial: number, failed: boolean) => {
    const base = row({ score: 6, trial });
    return {
      ...base,
      judging: {
        ...base.judging,
        scoredBy: "panel",
        judgeScores: [
          { judgeId: "judge-gemini", overallScore: 6 },
          failed ? { judgeId: "judge-gpt", failed: true as const } : { judgeId: "judge-gpt", overallScore: 6 },
        ],
      },
    };
  };
  const rows = Array.from({ length: 10 }, (_, i) => panelRow(i + 1, i === 0));
  const s = summarize(rows);
  assert.equal(s.counts.degraded, 1);
  assert.deepEqual(panelVerdict(s.counts, rows.length), { ok: true, share: 0.1 });
  const worse = summarize(rows.map((r, i) => (i < 2 ? panelRow(i + 1, true) : r)));
  assert.equal(panelVerdict(worse.counts, rows.length).ok, false);
  assert.equal(panelVerdict(s.counts, 0).ok, false, "no trials is not a two-judge run");
});
