// =============================================================================
// The orchestrator's git, against a real repository in a tmpdir: the commit /
// reset contract the whole run leans on. Spec §7 (integration, no provider).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createGitOps } from "./git.js";
import { runNight, DEFAULT_MAX_CONSECUTIVE_FAILURES } from "./orchestrator.js";
import type { FinishIterationResult } from "./types.js";

function fixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "night-repo-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-b", "main");
  git("config", "user.email", "night@example.com");
  git("config", "user.name", "Night");
  // Signing off: a GPG prompt in a test would hang exactly as it would at 3am.
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  return dir;
}

const finish = (over: Partial<FinishIterationResult> = {}): FinishIterationResult => ({
  success: true,
  summary: "touched a.txt",
  keyChanges: ["a.txt"],
  keyLearnings: [],
  decisions: [],
  needsHuman: [],
  ...over,
});

test("a successful iteration lands one commit; a failed one leaves no trace", async () => {
  const repo = fixtureRepo();
  const git = createGitOps(repo);
  try {
    const notes: string[] = [];
    const result = await runNight(
      {
        async runIteration({ iteration }) {
          // Iteration 1 edits and succeeds; iteration 2 edits and fails.
          fs.writeFileSync(path.join(repo, "a.txt"), `changed ${iteration}\n`);
          fs.writeFileSync(path.join(repo, `new-${iteration}.txt`), "x\n");
          return iteration === 1
            ? { sessionId: "s1", finish: finish(), turns: 2 }
            : { sessionId: "s2", failure: "reported_failure", turns: 2 };
        },
        git,
        notes: { read: () => notes.join("\n"), append: (s) => notes.push(s) },
        record: () => {},
        decision: () => {},
        now: () => Date.now(),
        stopRequested: () => false,
        hardStopped: () => false,
        report: () => {},
      },
      { maxIterations: 2, maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES },
    );

    assert.equal(result.commits.length, 1);
    const log = execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" });
    assert.match(log, /night 1: touched a\.txt/);
    assert.equal(log.split("\n").filter(Boolean).length, 2, "initial + one night commit");

    // The failed iteration's work is gone — tracked edit AND untracked file.
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf-8"), "changed 1\n");
    assert.equal(fs.existsSync(path.join(repo, "new-2.txt")), false);
    assert.deepEqual(await git.dirtyPaths(), []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a failing pre-commit hook keeps the work in the tree", async () => {
  const repo = fixtureRepo();
  const git = createGitOps(repo);
  const hooks = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho nope >&2\nexit 1\n", {
    mode: 0o755,
  });
  try {
    fs.writeFileSync(path.join(repo, "a.txt"), "edited\n");
    const outcome = await git.commitAll("night 1: edit");
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.error : "", /nope/);
    // The point of the repair path: the work is still there to be rescued.
    assert.deepEqual(await git.dirtyPaths(), ["a.txt"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("dirtyPaths sees untracked files, so preflight refuses on them", async () => {
  const repo = fixtureRepo();
  const git = createGitOps(repo);
  try {
    fs.writeFileSync(path.join(repo, "scratch.md"), "notes\n");
    assert.deepEqual(await git.dirtyPaths(), ["scratch.md"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a non-repo is detected rather than half-run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "night-plain-"));
  try {
    assert.equal(await createGitOps(dir).isRepo(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the run's branch is created and committed onto", async () => {
  const repo = fixtureRepo();
  const git = createGitOps(repo);
  try {
    assert.equal(await git.branchExists("night/x"), false);
    await git.createOrSwitchBranch("night/x");
    assert.equal(await git.currentBranch(), "night/x");
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    const commit = await git.commitAll("night 1: two");
    assert.equal(commit.ok, true);
    // main is untouched — the whole safety story depends on this.
    const mainLog = execFileSync("git", ["log", "--oneline", "main"], {
      cwd: repo,
      encoding: "utf-8",
    });
    assert.equal(mainLog.split("\n").filter(Boolean).length, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
