import test from "node:test";
import assert from "node:assert/strict";
import { COMMIT_SCREENING_PROMPT, GENERATOR_INSTRUCTIONS, GENERATOR_SYSTEM } from "./buffbench-prompts.js";
import type { CommitInfo } from "./commits.js";
import {
  SCREEN_MAX_CHARS,
  SCREEN_MAX_FILES,
  approveTasks,
  finalCheckCommands,
  generatorMessage,
  parseNameStatus,
  parseTask,
  screenCommitInfo,
  screenVerdict,
  type JudgedTask,
} from "./task-build.js";

const commit: CommitInfo = {
  sha: "abcdef0123456789abcdef0123456789abcdef01",
  parentSha: "1".repeat(40),
  date: "2026-09-01",
  message: "feat(core): steer queue",
  files: [
    { path: "a.ts", added: 3, deleted: 1 },
    { path: "b.ts", added: 2, deleted: 0 },
  ],
  coAuthoredByClaude: false,
};

test("screenCommitInfo is BuffBench's layout, prompt first", () => {
  const s = screenCommitInfo(commit, [
    { path: "a.ts", preContent: "x\ny", postContent: "x\nz" },
    { path: "b.ts", preContent: "[NEW FILE]", postContent: "new" },
    { path: "c.ts", preContent: "gone", postContent: "[DELETED]" },
    { path: "d.ts", preContent: "p", postContent: "p\n" },
  ]);
  assert.ok(s.startsWith(COMMIT_SCREENING_PROMPT + "\n\nCommit to evaluate:\n\nabcdef01: feat(core): steer queue\n"));
  assert.match(s, /Stats: 2 files changed, \+5 -1\n/);
  assert.match(s, /--- a\.ts ---\nLine 2:\n- y\n\+ z\n/);
  assert.match(s, /--- b\.ts ---\nNew file:\nnew\n/);
  assert.match(s, /--- c\.ts ---\nFile deleted\n/);
  assert.match(s, /--- d\.ts ---\nFile length changed from 1 to 2 lines\n/);
});

test("screenCommitInfo keeps their 30-file limit and adds our size cap", () => {
  const many = Array.from({ length: SCREEN_MAX_FILES + 5 }, (_, i) => ({
    path: `f${i}.ts`,
    preContent: "[NEW FILE]",
    postContent: "x",
  }));
  const s = screenCommitInfo(commit, many);
  assert.match(s, /--- f29\.ts ---/);
  assert.doesNotMatch(s, /--- f30\.ts ---/);
  const huge = screenCommitInfo(commit, [
    { path: "big.ts", preContent: "[NEW FILE]", postContent: "y".repeat(SCREEN_MAX_CHARS * 2) },
  ]);
  assert.match(huge, /\[truncated at 150000 characters\]\n$/);
  assert.ok(huge.length < COMMIT_SCREENING_PROMPT.length + SCREEN_MAX_CHARS + 200);
});

test("screenVerdict: selected only when the returned sha prefixes the commit's", () => {
  const sel = (sha: string) =>
    JSON.stringify({ selectedCommits: [{ sha, reason: "hard", shortDescription: "d" }] });
  assert.deepEqual(screenVerdict(sel("abcdef01"), commit.sha), { reason: "hard", shortDescription: "d" });
  assert.equal(screenVerdict(sel("ffff"), commit.sha), null);
  assert.equal(screenVerdict(sel(""), commit.sha), null);
  assert.equal(screenVerdict(JSON.stringify({ selectedCommits: [] }), commit.sha), null);
  assert.equal(screenVerdict("nope", commit.sha), null);
});

test("parseTask requires the generator's five fields", () => {
  const ok = { id: "add-x", reasoning: "r", spec: "s", prompt: "p", supplementalFiles: ["a.ts"] };
  assert.deepEqual(parseTask(JSON.stringify(ok)), ok);
  assert.equal(parseTask(JSON.stringify({ ...ok, prompt: "  " })), null);
  assert.equal(parseTask(JSON.stringify({ ...ok, supplementalFiles: [1] })), null);
  assert.equal(parseTask("{"), null);
});

test("generatorMessage lays out system, run prompt, params, instructions in their order", () => {
  const m = generatorMessage({ diff: "DIFF", editedFilePaths: ["a.ts"], commitMessage: "MSG" });
  const at = (s: string) => m.indexOf(s);
  assert.ok(at(GENERATOR_SYSTEM) === 0);
  assert.ok(at("Generate a task specification") > at(GENERATOR_SYSTEM));
  assert.ok(at('"diff": "DIFF"') > at("Generate a task specification"));
  assert.ok(at(GENERATOR_INSTRUCTIONS) > at('"commitMessage": "MSG"'));
  assert.doesNotMatch(GENERATOR_SYSTEM, /PLACEHOLDER/);
  assert.doesNotMatch(GENERATOR_INSTRUCTIONS, /file-picker/);
});

test("parseNameStatus maps git's letters to BuffBench's statuses", () => {
  assert.deepEqual(parseNameStatus("M\ta.ts\nA\tb.ts\nD\tc.ts\nR087\told.ts\tnew.ts\n"), [
    { path: "a.ts", status: "modified" },
    { path: "b.ts", status: "added" },
    { path: "c.ts", status: "deleted" },
    { path: "new.ts", status: "renamed", oldPath: "old.ts" },
  ]);
});

function task(id: string, sha: string): JudgedTask {
  return {
    id,
    sha,
    parentSha: "p",
    spec: "s",
    prompt: "p",
    supplementalFiles: [],
    fileDiffs: [],
    app: "core",
    finalCheckCommands: [],
    coAuthoredByClaude: false,
    screen: { reason: "r", shortDescription: "d" },
    promptReview: null,
  };
}

test("approveTasks moves by id or short sha, stamps the reviewer, and refuses gaps", () => {
  const draft = [task("add-x", "aaaaaaa111"), task("fix-y", "bbbbbbb222")];
  const r = approveTasks(draft, [], ["bbbbbbb"], "owner", "2026-09-29");
  assert.deepEqual(r.moved, ["fix-y"]);
  assert.deepEqual(r.draft.map((t) => t.id), ["add-x"]);
  assert.deepEqual(r.approved[0].promptReview, { by: "owner", at: "2026-09-29" });
  assert.throws(() => approveTasks(draft, [], ["nope"], "owner", "t"), /not in the draft: nope/);
  assert.throws(() => approveTasks(draft, [], "all", " ", "t"), /--by is required/);
  assert.throws(
    () => approveTasks(draft, [task("add-x", "ccccccc333")], ["add-x"], "owner", "t"),
    /already approved/,
  );
  assert.equal(approveTasks(draft, [], "all", "owner", "t").approved.length, 2);
});

test("finalCheckCommands target the app by directory (the package names are not core/tui)", () => {
  assert.deepEqual(finalCheckCommands("tui"), [
    "pnpm -C apps/tui exec tsc --noEmit",
    "pnpm -C apps/tui test",
  ]);
});
