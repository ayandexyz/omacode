import test from "node:test";
import assert from "node:assert/strict";
import { AUDIT_RATE, MIN_AUDITS, auditAgreement, isAudited, judgeAudited } from "./judge-audit.js";
import { JUDGES, type Judging } from "./judge.js";
import type { JudgeInput } from "./judge-prompt.js";

const [GEMINI, GPT] = JUDGES;

function verdict(overall: number): string {
  const v: Judging = {
    analysis: `a${overall}`,
    strengths: [],
    weaknesses: [],
    completionScore: overall,
    codeQualityScore: overall,
    overallScore: overall,
  };
  return JSON.stringify(v);
}

const input: JudgeInput = {
  prompt: "p",
  contextFiles: {},
  groundTruth: [{ path: "a", diff: "+x" }],
  agentDiff: "+x",
};

test("the primary is Gemini and the auditor is GPT", () => {
  assert.equal(GEMINI.provider, "gemini");
  assert.equal(GPT.provider, "codex");
});

test("isAudited is deterministic per key and samples about AUDIT_RATE", () => {
  assert.equal(isAudited("task|freecode|1"), isAudited("task|freecode|1"));
  let hits = 0;
  for (let i = 0; i < 5000; i++) if (isAudited(`t${i}|a|${i % 3}`)) hits++;
  const rate = hits / 5000;
  assert.ok(Math.abs(rate - AUDIT_RATE) < 0.03, `sampled ${rate}`);
  assert.equal(isAudited("x", 0), false);
  assert.equal(isAudited("x", 1), true);
});

test("unaudited: only Gemini is called, and it scores", async () => {
  const called: string[] = [];
  const r = await judgeAudited(
    input,
    async (j) => {
      called.push(j.id);
      return verdict(7);
    },
    { auditKey: "k", rate: 0, warn: () => {} },
  );
  assert.deepEqual(called, [GEMINI.id]);
  assert.equal(r.overallScore, 7);
  assert.equal(r.scoredBy, GEMINI.id);
  assert.equal(r.audited, undefined);
});

test("audited: both are called, the score stays Gemini's, GPT's is kept for agreement", async () => {
  const r = await judgeAudited(
    input,
    async (j) => verdict(j.id === GEMINI.id ? 6 : 9),
    { auditKey: "k", rate: 1, warn: () => {} },
  );
  assert.equal(r.overallScore, 6, "never the mean: audited and unaudited trials score alike");
  assert.equal(r.scoredBy, GEMINI.id);
  assert.equal(r.audited, true);
  assert.deepEqual(
    r.judgeScores.map((s) => [s.judgeId, s.overallScore]),
    [
      [GEMINI.id, 6],
      [GPT.id, 9],
    ],
  );
});

test("Gemini dead: GPT scores the trial as a flagged fallback, not a blackout", async () => {
  const warnings: string[] = [];
  const r = await judgeAudited(
    input,
    async (j) => {
      if (j.id === GEMINI.id) throw new Error("quota");
      return verdict(8);
    },
    { auditKey: "k", rate: 0, label: "t1", warn: (m) => warnings.push(m), retryDelaysMs: [0, 0] },
  );
  assert.equal(r.overallScore, 8);
  assert.equal(r.scoredBy, GPT.id);
  assert.equal(r.fallback, true);
  assert.equal(r.judgeFailed, undefined);
  assert.ok(warnings.some((w) => /fallback/.test(w)));
});

test("both dead: BuffBench's zeros and judgeFailed", async () => {
  const r = await judgeAudited(input, async () => "garbage", {
    auditKey: "k",
    rate: 1,
    warn: () => {},
    retryDelaysMs: [0, 0],
  });
  assert.equal(r.overallScore, 0);
  assert.equal(r.judgeFailed, true);
  assert.equal(r.scoredBy, "none");
  assert.deepEqual(r.judgeScores.map((s) => s.failed), [true, true]);
});

test("auditAgreement: n, mean absolute gap and per-judge means over audited trials only", () => {
  const row = (g: number | undefined, p: number | undefined, audited = true) => ({
    audited: audited ? (true as const) : undefined,
    judgeScores: [
      g === undefined ? { judgeId: GEMINI.id, failed: true as const } : { judgeId: GEMINI.id, overallScore: g },
      p === undefined ? { judgeId: GPT.id, failed: true as const } : { judgeId: GPT.id, overallScore: p },
    ],
  });
  const a = auditAgreement([row(6, 8), row(9, 8), row(5, undefined), row(2, 9, false)]);
  assert.equal(a.n, 2, "a one-sided audit and an unaudited trial are not agreement evidence");
  assert.equal(a.meanAbsGap, 1.5);
  assert.equal(a.meanPrimary, 7.5);
  assert.equal(a.meanAuditor, 8);
  assert.equal(a.passes, false, "2 audits is below MIN_AUDITS: unmeasured, not passed");
  const close = Array.from({ length: MIN_AUDITS }, () => row(7, 8));
  assert.equal(auditAgreement(close).passes, true);
  const far = Array.from({ length: MIN_AUDITS }, () => row(3, 8));
  assert.equal(auditAgreement(far).passes, false);
  assert.equal(auditAgreement([]).passes, false, "no evidence is not agreement");
});

test("Gemini dead and the fallback dead too: both on the record as failed", async () => {
  const r = await judgeAudited(input, async () => "garbage", {
    auditKey: "k",
    rate: 0,
    warn: () => {},
    retryDelaysMs: [0, 0],
  });
  assert.equal(r.judgeFailed, true);
  assert.equal(r.fallback, undefined);
  assert.deepEqual(r.judgeScores.map((s) => [s.judgeId, s.failed]), [
    [GEMINI.id, true],
    [GPT.id, true],
  ]);
});

test("a transient primary failure is retried before the auditor takes over", async () => {
  const calls: string[] = [];
  const r = await judgeAudited(
    input,
    async (j) => {
      calls.push(j.id);
      if (j.id === GEMINI.id && calls.filter((c) => c === GEMINI.id).length < 3) {
        throw new Error("high demand");
      }
      return verdict(7);
    },
    { auditKey: "k", rate: 0, warn: () => {}, retryDelaysMs: [0, 0] },
  );
  assert.deepEqual(calls, [GEMINI.id, GEMINI.id, GEMINI.id], "third try succeeds, GPT never called");
  assert.equal(r.scoredBy, GEMINI.id);
  assert.equal(r.fallback, undefined);
});
