// =============================================================================
// The judged set, as Instances the trial loop can run.
// Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.1.
//
// Reads only the APPROVED file, and refuses a record with no reviewer. The
// answer key (`fileDiffs`, `spec`, `sha`) stays behind: an Instance carries
// the prompt, the parent commit and the commands, nothing a trial could use to
// see the real change. `bench:judge` reads the task file itself.
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import type { TaskWindow } from "./contamination.js";
import type { JudgedTask, JudgedTaskFile } from "./task-build.js";
import type { Instance } from "./types.js";

export const TASKS_FILE = path.join(import.meta.dirname, "..", "instances", "freecode-commits.json");
/** The repo the tasks were cut from: this checkout. */
export const REPO_DIR = path.join(import.meta.dirname, "..", "..", "..");
export const INSTANCE_PREFIX = "freecode__";

export function loadJudgedTasks(file = TASKS_FILE): JudgedTask[] {
  if (!fs.existsSync(file)) {
    throw new Error(`no approved tasks at ${file}: run \`pnpm bench:tasks approve\` first`);
  }
  const tasks = (JSON.parse(fs.readFileSync(file, "utf-8")) as JudgedTaskFile).evalCommits;
  const unreviewed = tasks.filter((t) => !t.promptReview?.by);
  if (unreviewed.length) {
    throw new Error(`unreviewed task(s) in ${file}: ${unreviewed.map((t) => t.id).join(", ")}`);
  }
  return tasks;
}

/** The window the approved tasks were cut from, or null for a file that predates it. */
export function loadJudgedWindow(file = TASKS_FILE): TaskWindow | null {
  loadJudgedTasks(file); // the same missing-file and unreviewed refusals, first
  return (JSON.parse(fs.readFileSync(file, "utf-8")) as JudgedTaskFile).window ?? null;
}

export function toInstance(task: JudgedTask, initCommand: string, repoDir = REPO_DIR): Instance {
  return {
    instanceId: `${INSTANCE_PREFIX}${task.id}`,
    repo: "ayandexyz/omacode",
    baseCommit: task.parentSha,
    problemStatement: task.prompt,
    grader: "judged",
    source: repoDir,
    initCommand,
    finalCheckCommands: task.finalCheckCommands,
  };
}

/** All approved tasks, or the ones named (by task id or instance id). */
export function loadJudgedInstances(ids?: string[], file = TASKS_FILE): Instance[] {
  const data = JSON.parse(fs.readFileSync(file, "utf-8")) as JudgedTaskFile;
  const tasks = loadJudgedTasks(file);
  const want = ids?.map((id) => id.replace(INSTANCE_PREFIX, ""));
  if (want) {
    const missing = want.filter((id) => !tasks.some((t) => t.id === id));
    // Same rule as SWE-bench: running 4 of 5 requested tasks publishes a mean
    // over a set nobody chose.
    if (missing.length) throw new Error(`not approved tasks: ${missing.join(", ")}`);
  }
  return tasks
    .filter((t) => !want || want.includes(t.id))
    .map((t) => toInstance(t, data.initCommand));
}
