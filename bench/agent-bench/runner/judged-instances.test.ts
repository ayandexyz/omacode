import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadJudgedInstances, loadJudgedTasks, toInstance } from "./judged-instances.js";
import { runFinalChecks, runSetup, tail } from "./judged-trial.js";
import { taskPrompt } from "./prompt.js";
import type { JudgedTask } from "./task-build.js";

function task(id: string, reviewed = true): JudgedTask {
  return {
    id,
    sha: "f".repeat(40),
    parentSha: "e".repeat(40),
    spec: "SECRET SPEC",
    prompt: "Add a thing.",
    supplementalFiles: ["x.ts"],
    fileDiffs: [{ path: "a.ts", status: "modified", diff: "+SECRET DIFF" }],
    app: "core",
    finalCheckCommands: ["pnpm -C apps/core test"],
    coAuthoredByClaude: false,
    screen: { reason: "r", shortDescription: "d" },
    promptReview: reviewed ? { by: "owner", at: "2026-09-29" } : null,
  };
}

function file(tasks: JudgedTask[]): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "judged-")), "tasks.json");
  fs.writeFileSync(
    f,
    JSON.stringify({ repoUrl: "u", generationDate: "d", initCommand: "pnpm install", evalCommits: tasks }),
  );
  return f;
}

test("an Instance carries the prompt and commands, never the answer key", () => {
  const inst = toInstance(task("add-x"), "pnpm install", "/repo");
  const json = JSON.stringify(inst);
  assert.doesNotMatch(json, /SECRET/);
  assert.doesNotMatch(json, /f{40}/, "the fix commit's sha would let an agent check it out");
  assert.equal(inst.baseCommit, "e".repeat(40));
  assert.equal(inst.instanceId, "freecode__add-x");
  assert.equal(inst.grader, "judged");
  assert.equal(inst.source, "/repo");
});

test("unreviewed tasks and missing files are refused", () => {
  assert.throws(() => loadJudgedTasks(file([task("a"), task("b", false)])), /unreviewed task\(s\).*: b/);
  assert.throws(() => loadJudgedTasks("/nope.json"), /bench:tasks approve/);
});

test("loadJudgedInstances selects by task id or instance id and refuses unknown ids", () => {
  const f = file([task("a"), task("b")]);
  assert.equal(loadJudgedInstances(undefined, f).length, 2);
  assert.deepEqual(loadJudgedInstances(["b", "freecode__a"], f).map((i) => i.instanceId).sort(), [
    "freecode__a",
    "freecode__b",
  ]);
  assert.throws(() => loadJudgedInstances(["zzz"], f), /not approved tasks: zzz/);
});

test("the judged prompt wraps the task and differs from the SWE-bench one", () => {
  const p = taskPrompt(toInstance(task("a"), "x"));
  assert.match(p, /checkout of the freecode repository/);
  assert.match(p, /<task>\nAdd a thing\.\n<\/task>/);
  assert.doesNotMatch(p, /issue/);
});

test("setup throws on failure; final checks record exit codes and keep the tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checks-"));
  assert.throws(() => runSetup("echo broken >&2; exit 3", dir), /setup .* failed \(3\): broken/);
  const [ok, bad] = runFinalChecks(["echo fine", "echo nope >&2; exit 2"], dir);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim(), "fine");
  assert.equal(bad.exitCode, 2);
  assert.match(bad.stderr, /nope/);
  assert.match(tail("x".repeat(50), 10), /^\[… 40 earlier characters dropped\]\nx{10}$/);
});
