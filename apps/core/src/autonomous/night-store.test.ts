// =============================================================================
// The night's sidecar files, and the --until parser.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseUntil } from "../cli/commands/night.js";
import { trimNotes, buildIterationPrompt } from "./prompt.js";
import { branchSlug } from "./git.js";

function withRunsHome<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "night-runs-"));
  const previous = process.env.FREECODE_RUNS_HOME;
  process.env.FREECODE_RUNS_HOME = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.FREECODE_RUNS_HOME;
    else process.env.FREECODE_RUNS_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("notes, decisions and iterations round-trip", async () => {
  const store = await import("./night-store.js");
  withRunsHome(() => {
    store.appendNotes("r1", "## Iteration 1\nDid a thing");
    store.appendNotes("r1", "## Iteration 2\nDid another");
    assert.match(store.readNotes("r1"), /Iteration 1[\s\S]*Iteration 2/);

    store.appendDecision("r1", {
      kind: "denied",
      iteration: 1,
      at: 1,
      tool: "bash",
      rule: "Bash(git push:*)",
    });
    assert.equal(store.readDecisions("r1").length, 1);

    store.appendIteration("r1", {
      kind: "iteration",
      n: 1,
      sessionId: "s",
      startedAt: 1,
      endedAt: 2,
      turns: 3,
      commit: "abc",
    });
    assert.equal(store.readIterations("r1")[0]?.commit, "abc");
  });
});

test("a credential in a note is redacted, not written", async () => {
  const store = await import("./night-store.js");
  withRunsHome(() => {
    store.appendNotes(
      "r2",
      "The deploy script needs ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop\nand a retry",
    );
    const notes = store.readNotes("r2");
    assert.ok(!notes.includes("sk-ant-abcdefghijklmnop"));
    assert.match(notes, /redacted/);
    // Only the offending line goes; the rest of the note survives.
    assert.match(notes, /and a retry/);
  });
});

test("a truncated last line does not lose the rest of the log", async () => {
  const store = await import("./night-store.js");
  withRunsHome(() => {
    store.appendDecision("r3", {
      kind: "needs_human",
      iteration: 1,
      at: 1,
      item: "needs a token",
    });
    fs.appendFileSync(store.decisionsPath("r3"), '{"kind":"nee');
    assert.equal(store.readDecisions("r3").length, 1);
  });
});

test("trimNotes keeps the start and the end of an oversized file", () => {
  const notes = `START${"x".repeat(50_000)}END`;
  const trimmed = trimNotes(notes, 1_000);
  assert.ok(trimmed.startsWith("START"));
  assert.ok(trimmed.endsWith("END"));
  assert.ok(trimmed.length < 1_400);
  assert.match(trimmed, /characters of earlier notes omitted/);
});

test("the iteration prompt carries the contract, the notes and the objective", () => {
  const prompt = buildIterationPrompt({
    objective: "make the parser faster",
    iteration: 4,
    notes: "## Iteration 3\nThe slow path is tokenize()",
    repairPending: "pre-commit hook failed",
  });
  assert.match(prompt, /iteration 4 of an overnight run/);
  assert.match(prompt, /finish_iteration exactly once/);
  assert.match(prompt, /Repair first/);
  assert.match(prompt, /tokenize\(\)/);
  assert.match(prompt, /make the parser faster/);
  // The objective is last: it is what the model should be holding when it starts.
  assert.ok(prompt.lastIndexOf("## Objective") > prompt.indexOf("## Run notes"));
});

test("no repair section when nothing is pending", () => {
  const prompt = buildIterationPrompt({
    objective: "o",
    iteration: 1,
    notes: "",
  });
  assert.ok(!prompt.includes("Repair first"));
  assert.match(prompt, /none yet/);
});

test("branchSlug is a safe, bounded branch name", () => {
  assert.equal(branchSlug("Reduce the TUI's render cost"), "reduce-the-tui-s-render-cost");
  assert.equal(branchSlug("!!!"), "run");
  assert.ok(branchSlug("x".repeat(200)).length <= 48);
});

test("--until accepts a clock time and a duration", () => {
  const now = Date.parse("2026-09-28T23:00:00.000Z");
  assert.equal(parseUntil("2h", now), now + 7_200_000);
  assert.equal(parseUntil("90m", now), now + 5_400_000);
  // A time that has already passed today means tomorrow, or "--until 07:00"
  // typed after midnight would be an expired deadline.
  const at = parseUntil("07:00", now)!;
  assert.ok(at > now);
  assert.ok(at - now <= 24 * 3_600_000);
  assert.equal(parseUntil("tomorrow", now), undefined);
});
