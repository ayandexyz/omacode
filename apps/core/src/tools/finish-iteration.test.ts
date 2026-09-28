// =============================================================================
// finish_iteration: the schema contract an unattended iteration ends with.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.4, §7 (unit).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { FinishIterationTool } from "./finish-iteration.js";
import { QuestionTool } from "./question.js";
import type { Decision, UnattendedContext } from "../autonomous/types.js";

function unattended(): UnattendedContext & { records: Decision[] } {
  const records: Decision[] = [];
  return {
    iteration: 3,
    records,
    decideAsk: () => ({ allowed: true }),
    record: (d) => records.push(d),
  } as UnattendedContext & { records: Decision[] };
}

const ctx = (u?: UnattendedContext) => ({ cwd: "/repo", unattended: u }) as never;

test("a well-formed report is stored on the unattended context", async () => {
  const u = unattended();
  const result = await FinishIterationTool.execute(
    {
      success: true,
      summary: "cache the parsed tree",
      key_changes: ["added tree-cache.ts"],
      key_learnings: ["the parse was 80% of render time"],
      decisions: [
        {
          question: "LRU or unbounded?",
          choice: "LRU, 100 entries",
          why: "bounded memory, reversible",
          reversible: true,
        },
      ],
      needs_human: ["needs a CI secret to test the upload path"],
      should_stop: false,
    },
    ctx(u),
  );

  assert.equal(result.success, true);
  assert.equal(u.finish?.summary, "cache the parsed tree");
  assert.equal(u.finish?.decisions.length, 1);
  assert.deepEqual(u.records.map((r) => r.kind), ["decided", "needs_human"]);
});

test("string booleans from providers that quote scalars are coerced", async () => {
  const u = unattended();
  await FinishIterationTool.execute(
    {
      success: "true" as never,
      summary: "s",
      should_stop: "true" as never,
      decisions: [
        { question: "q", choice: "c", why: "w", reversible: "false" },
      ] as never,
    },
    ctx(u),
  );
  assert.equal(u.finish?.success, true);
  assert.equal(u.finish?.shouldStop, true);
  assert.equal(u.finish?.decisions[0]?.reversible, false);
});

test("a decision with no stated reversibility is treated as irreversible", async () => {
  const u = unattended();
  await FinishIterationTool.execute(
    {
      success: true,
      summary: "s",
      decisions: [{ question: "q", choice: "c", why: "w" }] as never,
    },
    ctx(u),
  );
  // The report sorts irreversible first; the expensive mistake is hiding one.
  assert.equal(u.finish?.decisions[0]?.reversible, false);
});

test("a JSON-string array is accepted, and junk entries are dropped", async () => {
  const u = unattended();
  await FinishIterationTool.execute(
    {
      success: true,
      summary: "s",
      key_changes: '["a","b"]' as never,
      decisions: '[{"question":"q","choice":"c"},{"why":"no question"}]' as never,
    },
    ctx(u),
  );
  assert.deepEqual(u.finish?.keyChanges, ["a", "b"]);
  assert.equal(u.finish?.decisions.length, 1);
});

test("the second call is ignored — the first report is the one that counts", async () => {
  const u = unattended();
  await FinishIterationTool.execute({ success: true, summary: "first" }, ctx(u));
  const second = await FinishIterationTool.execute(
    { success: false, summary: "second" },
    ctx(u),
  );
  assert.equal(second.success, true);
  assert.equal(u.finish?.summary, "first");
});

test("validation rejects a missing summary or non-boolean success", () => {
  const validate = FinishIterationTool.validateInput!;
  assert.equal(validate({ success: true, summary: "ok" }).valid, true);
  assert.equal(validate({ success: true, summary: "  " }).valid, false);
  assert.equal(validate({ success: "yes", summary: "ok" }).valid, false);
  assert.equal(validate({ summary: "ok" }).valid, false);
});

test("outside an unattended run it refuses rather than pretending", async () => {
  const result = await FinishIterationTool.execute(
    { success: true, summary: "s" },
    ctx(undefined),
  );
  assert.equal(result.success, false);
});

test("every schema property declares a type", () => {
  // CLAUDE.md tool checklist: a missing `type` produces reject-loops with
  // providers that send numbers and booleans as strings.
  for (const [name, prop] of Object.entries(
    FinishIterationTool.schemas.parameters.properties ?? {},
  )) {
    assert.ok(prop.type, `${name} has no declared type`);
  }
});

test("question answers itself in an unattended run and records the ask", async () => {
  const u = unattended();
  const result = await QuestionTool.execute(
    {
      questions: [
        {
          question: "Rename the flag?",
          options: [
            { label: "yes", description: "clearer" },
            { label: "no", description: "compatible" },
          ],
        },
      ],
    } as never,
    ctx(u),
  );

  assert.equal(result.success, true);
  // It must return instantly without touching the bus — no 30-minute timer, and
  // no answer invented on the user's behalf.
  assert.match(result.result!.output, /Decide this yourself/);
  assert.deepEqual(u.records, [
    {
      kind: "asked",
      iteration: 3,
      at: u.records[0]!.at,
      questions: ["Rename the flag?"],
    },
  ]);
});
