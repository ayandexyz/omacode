import test from "node:test";
import assert from "node:assert/strict";
import {
  JUDGES,
  aggregatePanel,
  assertNoCollision,
  judgePanel,
  parseJudging,
  type Judging,
} from "./judge.js";
import { JUDGE_SYSTEM, renderJudgePrompt, type JudgeInput } from "./judge-prompt.js";

function verdict(overall: number, over: Partial<Judging> = {}): Judging {
  return {
    analysis: `analysis ${overall}`,
    strengths: [`s${overall}`],
    weaknesses: [`w${overall}`],
    completionScore: overall,
    codeQualityScore: overall,
    overallScore: overall,
    ...over,
  };
}

const input: JudgeInput = {
  prompt: "Add a retry limit",
  contextFiles: { "src/a.ts": "export const a = 1;\n" },
  groundTruth: [{ path: "src/a.ts", diff: "+export const MAX = 3;" }],
  agentDiff: "+export const MAX = 3;",
};

test("parseJudging accepts the schema, fenced or bare, and rejects anything else", () => {
  const ok = JSON.stringify(verdict(7));
  assert.equal(parseJudging(ok)?.overallScore, 7);
  assert.equal(parseJudging("```json\n" + ok + "\n```")?.overallScore, 7);
  assert.equal(parseJudging("not json"), null);
  assert.equal(parseJudging(JSON.stringify({ ...verdict(7), overallScore: 11 })), null);
  assert.equal(parseJudging(JSON.stringify({ ...verdict(7), overallScore: "7" })), null);
  assert.equal(
    parseJudging(JSON.stringify(verdict(0.88, { completionScore: 0.9, codeQualityScore: 0.85 }))),
    null,
    "a 0–1 scale reply is a dead judge, not 0.88/10",
  );
  assert.equal(parseJudging(JSON.stringify(verdict(1, { completionScore: 0, codeQualityScore: 1 })))?.overallScore, 1);
  assert.equal(parseJudging(JSON.stringify(verdict(0.5, { completionScore: 3 })))?.overallScore, 0.5);
  const { strengths: _, ...missing } = verdict(7);
  assert.equal(parseJudging(JSON.stringify(missing)), null);
});

test("two judges: scores are the mean, analysis is the median judge's (the higher of two)", () => {
  const r = aggregatePanel(["g", "s"], [verdict(4), verdict(8, { completionScore: 6 })], "t", () => {});
  assert.equal(r.overallScore, 6);
  assert.equal(r.completionScore, 5);
  assert.equal(r.analysis, "analysis 8", "floor(2/2) = index 1 of the ascending sort");
  assert.deepEqual(r.strengths, ["s8"]);
  assert.deepEqual(r.judgeScores, [
    { judgeId: "g", overallScore: 4, completionScore: 4, codeQualityScore: 4 },
    { judgeId: "s", overallScore: 8, completionScore: 6, codeQualityScore: 8 },
  ]);
  assert.equal(r.judgeFailed, undefined);
});

test("one judge dead: scored from the survivor, and it says so", () => {
  const warnings: string[] = [];
  const r = aggregatePanel(["g", "s"], [null, verdict(7)], "task-1", (m) => warnings.push(m));
  assert.equal(r.overallScore, 7);
  assert.deepEqual(r.judgeScores[0], { judgeId: "g", failed: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Judge panel degraded for task-1: g failed\. Scoring from 1\/2 judges\./);
});

test("both judges dead: BuffBench's zeros, plus judgeFailed so the 0 is not read as a bad patch", () => {
  const r = aggregatePanel(["g", "s"], [null, null], "t", () => {});
  assert.equal(r.overallScore, 0);
  assert.equal(r.completionScore, 0);
  assert.equal(r.codeQualityScore, 0);
  assert.equal(r.analysis, "Error running judge agent - all judges failed");
  assert.deepEqual(r.weaknesses, ["All judges failed to provide structured output"]);
  assert.equal(r.judgeFailed, true);
});

test("judgePanel sends the verbatim system prompt and treats a throw or garbage as a dead judge", async () => {
  const seen: string[] = [];
  const r = await judgePanel(
    input,
    async (judge, system, prompt) => {
      assert.equal(system, JUDGE_SYSTEM);
      assert.equal(prompt, renderJudgePrompt(input));
      seen.push(judge.id);
      if (judge.id === JUDGES[0].id) throw new Error("503");
      return "sure! " + JSON.stringify(verdict(9)) + " hope that helps";
    },
    { warn: () => {} },
  );
  assert.deepEqual(seen.sort(), JUDGES.map((j) => j.id).sort());
  assert.equal(r.overallScore, 9);
  assert.equal(r.judgeScores.filter((s) => s.failed).length, 1);
});

test("judgePanel times a hung judge out instead of waiting on it", async () => {
  const r = await judgePanel(
    input,
    (judge) =>
      judge.id === JUDGES[0].id
        ? new Promise<string>(() => {})
        : Promise.resolve(JSON.stringify(verdict(5))),
    { timeoutMs: 20, warn: () => {} },
  );
  assert.equal(r.overallScore, 5);
  assert.equal(r.judgeScores[0].failed, true);
});

test("the panel is two judges from two families, and never the model under test", () => {
  assert.equal(JUDGES.length, 2);
  assert.equal(new Set(JUDGES.map((j) => j.provider)).size, 2);
  assert.doesNotThrow(() => assertNoCollision(JUDGES, "minimax/MiniMax-M3"));
  assert.throws(
    () => assertNoCollision([{ id: "j", provider: "minimax", model: "MiniMax-M3" }], "minimax/MiniMax-M3"),
    /model under test/,
  );
  assert.throws(
    () => assertNoCollision([{ id: "j", provider: "minimax", model: "MiniMax-M2" }], "minimax/MiniMax-M3"),
    /model under test/,
    "same provider family is a collision too: spec §4.6 excludes MiniMax, not one id",
  );
  assert.throws(
    () => assertNoCollision([{ id: "j", provider: "minimax", model: "MiniMax-M2" }], "MiniMax-M3"),
    /model under test/,
    "a bare model id (the claude-code adapter's dialect) is still recognised",
  );
  assert.doesNotThrow(() => assertNoCollision(JUDGES, "MiniMax-M3"));
  assert.throws(() => assertNoCollision(JUDGES, "gpt-5.5"), /model under test/);
  assert.throws(() => assertNoCollision(JUDGES, "google/gemini-3.5-pro"), /model under test/);
  assert.throws(
    () => assertNoCollision(JUDGES, "openai/gpt-5.5"),
    /model under test/,
    "the codex judge runs OpenAI's model, so an OpenAI agent model collides with it",
  );
});

test("renderJudgePrompt keeps BuffBench's sections and fallbacks", () => {
  const p = renderJudgePrompt({ ...input, contextFiles: {}, agentDiff: "", error: "boom" });
  assert.match(p, /## User Prompt \(What the agent was asked to do\)\nAdd a retry limit/);
  assert.match(p, /## Context Files \(from parent commit\)\n\(No context files\)/);
  assert.match(p, /## Ground Truth Changes \(One valid implementation\)/);
  assert.match(p, /```diff\n\(No changes made\)\n```/);
  assert.match(p, /## Error Encountered\nboom/);
  assert.doesNotMatch(p, /Final Check Command Outputs/);
});
