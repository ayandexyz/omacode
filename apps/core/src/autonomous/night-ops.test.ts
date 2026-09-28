// =============================================================================
// Reading a night afterwards — crashed-run detection, listing, regeneration.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.11, §5.4
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildReport,
  findNightRun,
  listNightRuns,
  pidAlive,
  reconcileCrashed,
  requestStop,
  statusLine,
} from "./night-ops.js";
import { appendDecision, appendIteration, reportPathFor } from "./night-store.js";
import { readManifest, writeManifest } from "./run-store.js";
import { DEFAULT_RUN_LIMITS, EMPTY_USAGE, type RunManifest } from "./types.js";

function withRunsHome<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "night-ops-"));
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

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "run-1",
    status: "running",
    createdAt: 1_000,
    startedAt: 1_000,
    projectPath: "/repo",
    provider: "anthropic",
    model: "claude-opus-5",
    limits: DEFAULT_RUN_LIMITS,
    usage: EMPTY_USAGE,
    turns: 0,
    verifyCommand: "",
    taskCardCount: 0,
    night: {
      objective: "make it faster",
      branch: "night/make-it-faster",
      iterations: 3,
      commits: ["aaa111"],
      waitedMs: 0,
      fallbackIterations: [],
    },
    ...over,
  };
}

test("a live pid is alive; a freed one is not", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(undefined), false);
  // 2^22 is above Linux's default pid_max, so nothing can hold it.
  assert.equal(pidAlive(4_194_304), false);
});

test("a run whose process is gone is recorded as crashed, not left running", () => {
  withRunsHome(() => {
    // The whole point of §5.4: a terminal closed at 3am leaves a manifest that
    // claims the run is still going, forever.
    writeManifest(manifest({ pid: 4_194_304 }));
    const reconciled = reconcileCrashed(readManifest("run-1")!);
    assert.equal(reconciled.status, "crashed");
    assert.ok(reconciled.endedAt, "a crashed run still gets an end time");
    // Persisted, so `status` and `list` agree and a resume knows what it found.
    assert.equal(readManifest("run-1")!.status, "crashed");
  });
});

test("a run whose process is alive is left alone", () => {
  withRunsHome(() => {
    writeManifest(manifest({ pid: process.pid }));
    assert.equal(reconcileCrashed(readManifest("run-1")!).status, "running");
  });
});

test("a scheduled pending run is live while its worker is alive and crashes if it dies", () => {
  withRunsHome(() => {
    writeManifest(manifest({ status: "pending", pid: process.pid, startedAt: undefined }));
    assert.equal(reconcileCrashed(readManifest("run-1")!).status, "pending");
    writeManifest(manifest({ status: "pending", pid: 4_194_304, startedAt: undefined }));
    assert.equal(reconcileCrashed(readManifest("run-1")!).status, "crashed");
  });
});

test("a finished run is never re-judged by its pid", () => {
  withRunsHome(() => {
    // Its pid is long gone by definition; that is not a crash.
    writeManifest(manifest({ status: "completed", pid: 4_194_304 }));
    assert.equal(reconcileCrashed(readManifest("run-1")!).status, "completed");
  });
});

test("listing shows night runs only, newest first", () => {
  withRunsHome(() => {
    writeManifest(manifest({ runId: "old", createdAt: 1, status: "completed" }));
    writeManifest(manifest({ runId: "new", createdAt: 999, status: "completed" }));
    // An old autonomous-spec run has no `night` block and is not one of these.
    writeManifest({ ...manifest({ runId: "other" }), night: undefined });
    assert.deepEqual(
      listNightRuns().map((m) => m.runId),
      ["new", "old"],
    );
  });
});

test("a run is found by id or by branch — the branch is what survives the night", () => {
  withRunsHome(() => {
    writeManifest(manifest({ runId: "abc", status: "completed" }));
    assert.equal(findNightRun("abc")?.runId, "abc");
    assert.equal(findNightRun("night/make-it-faster")?.runId, "abc");
    assert.equal(findNightRun("nope"), undefined);
    assert.equal(findNightRun()?.runId, "abc", "no argument means the newest");
  });
});

test("the status line carries the numbers without the report", () => {
  const line = statusLine(manifest({ status: "completed" }));
  assert.match(line, /run-1/);
  assert.match(line, /3 it/);
  assert.match(line, /1 commit/);
  assert.match(line, /night\/make-it-faster/);
});

test("stop is only for a running run, and is recorded rather than signalled", () => {
  withRunsHome(() => {
    writeManifest(manifest({ pid: process.pid }));
    assert.equal(requestStop(readManifest("run-1")!), true);
    assert.equal(readManifest("run-1")!.cancelRequested, true);

    writeManifest(manifest({ runId: "scheduled", status: "pending", pid: process.pid }));
    assert.equal(requestStop(readManifest("scheduled")!), true);
    assert.equal(readManifest("scheduled")!.cancelRequested, true);

    writeManifest(manifest({ runId: "done", status: "completed" }));
    assert.equal(requestStop(readManifest("done")!), false);
  });
});

test("a crashed run still gets a report, regenerated from its logs", () => {
  withRunsHome(() => {
    // The reason report.ts is pure: this run never reached its own exit path.
    writeManifest(manifest({ status: "crashed", endedAt: 5_000 }));
    appendIteration("run-1", {
      kind: "iteration",
      n: 1,
      sessionId: "s1",
      startedAt: 1_000,
      endedAt: 2_000,
      turns: 3,
      commit: "aaa111",
      summary: "cached the tree",
    });
    appendDecision("run-1", {
      kind: "needs_human",
      iteration: 1,
      at: 1,
      item: "needs a CI token",
    });

    const markdown = buildReport(readManifest("run-1")!);
    assert.match(markdown, /# Night run run-1 — make it faster/);
    assert.match(markdown, /## Needs you \(1\)/);
    assert.match(markdown, /needs a CI token/);
    assert.match(markdown, /cached the tree/);
    // Written where `freecode night report` will find it.
    assert.equal(fs.readFileSync(reportPathFor("run-1"), "utf-8"), markdown);
  });
});

test("regenerating twice produces the same report", () => {
  withRunsHome(() => {
    writeManifest(manifest({ status: "completed", endedAt: 5_000 }));
    appendIteration("run-1", {
      kind: "iteration",
      n: 1,
      sessionId: "s1",
      startedAt: 1_000,
      endedAt: 2_000,
      turns: 3,
      commit: "aaa111",
    });
    assert.equal(
      buildReport(readManifest("run-1")!),
      buildReport(readManifest("run-1")!),
    );
  });
});

test("a secret in a decision never reaches the report", () => {
  withRunsHome(() => {
    writeManifest(manifest({ status: "completed", endedAt: 5_000 }));
    appendDecision("run-1", {
      kind: "needs_human",
      iteration: 1,
      at: 1,
      item: "set ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuv on the runner",
    });
    const markdown = buildReport(readManifest("run-1")!);
    assert.doesNotMatch(markdown, /sk-ant-abcdefghijklmnopqrstuv/);
    assert.match(markdown, /redacted/);
  });
});
