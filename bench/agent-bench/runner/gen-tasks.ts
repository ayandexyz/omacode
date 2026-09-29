#!/usr/bin/env tsx
// =============================================================================
// The judged task set: screen → generate → owner review.
// Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.2 step 4, §4.3.
//
//   pnpm bench:commits --since <date> --out .cache/candidates.json
//   pnpm bench:tasks generate --candidates .cache/candidates.json [--limit N]
//   pnpm bench:tasks list
//   pnpm bench:tasks approve --by <name> (--all | <id|short-sha>...)
//
// Screen and generator both run GPT-5.5 through `codex exec` on the owner's
// Codex subscription (the GPT judge's model and transport). Every screen
// verdict is cached in .cache/screen.json, so a rerun or a raised --limit
// never pays for the same commit twice. Drafts land in
// instances/freecode-commits.draft.json. Only `approve` writes
// instances/freecode-commits.json, the file the runner reads.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runCodex } from "./codex-complete.js";
import type { Candidate } from "./commits.js";
import { mergeWindow, type TaskWindow } from "./contamination.js";
import type { JudgeUsage } from "./core-complete.js";
import { JUDGES } from "./judge.js";
import {
  INIT_COMMAND,
  REPO_URL,
  SCREEN_SCHEMA,
  TASK_SCHEMA,
  approveTasks,
  finalCheckCommands,
  generatorMessage,
  parseTask,
  screenCommitInfo,
  screenVerdict,
  type JudgedTask,
  type JudgedTaskFile,
} from "./task-build.js";
import {
  commitMessage,
  fileDiffsFor,
  filterSupplementalFiles,
  fullDiff,
  screenFiles,
  withWorktree,
} from "./task-git.js";

const ROOT = path.join(import.meta.dirname, "..");
const REPO = path.join(ROOT, "..", "..");
const DRAFT = path.join(ROOT, "instances", "freecode-commits.draft.json");
const APPROVED = path.join(ROOT, "instances", "freecode-commits.json");
const SCREEN_CACHE = path.join(ROOT, ".cache", "screen.json");

/** The GPT judge's model: one model family for screen, generator and judge. */
const MODEL = JUDGES.find((j) => j.provider === "codex")!.model;
const SCREEN_TIMEOUT_MS = 5 * 60 * 1000;
/** The generator explores the checkout, so it gets the judge's 20 minutes. */
const GENERATE_TIMEOUT_MS = 20 * 60 * 1000;
/** Theirs: 8 screens and 5 generators at a time. */
const SCREEN_CONCURRENCY = 8;
const GENERATE_CONCURRENCY = 5;

type ScreenCache = Record<string, { reason: string; shortDescription: string } | null>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function readJson<T>(file: string, fallback: T): T {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as T) : fallback;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function taskFile(file: string): JudgedTaskFile {
  return readJson<JudgedTaskFile>(file, {
    repoUrl: REPO_URL,
    generationDate: new Date().toISOString(),
    initCommand: INIT_COMMAND,
    evalCommits: [],
  });
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function screen(candidates: Candidate[], cache: ScreenCache, usage: JudgeUsage): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "task-screen-"));
  let done = 0;
  try {
    await mapLimit(candidates, SCREEN_CONCURRENCY, async (c) => {
      const tag = `[screen ${++done}/${candidates.length}] ${c.sha.slice(0, 8)}`;
      try {
        const text = await withTimeout(SCREEN_TIMEOUT_MS, (signal) =>
          runCodex({
            model: MODEL,
            cwd: scratch,
            schema: SCREEN_SCHEMA,
            message: screenCommitInfo(c, screenFiles(REPO, c)),
            signal,
            usage,
            usageKey: "screen",
          }),
        );
        cache[c.sha] = screenVerdict(text, c.sha);
        console.log(`${tag} ${cache[c.sha] ? "✓ HARD" : "rejected"}  ${c.message}`);
        writeJson(SCREEN_CACHE, cache);
      } catch (err) {
        // Not cached: a dead call is not a verdict, and the next run retries it.
        console.warn(`${tag} screen failed: ${(err as Error).message}`);
      }
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function generate(
  selected: Candidate[],
  cache: ScreenCache,
  usage: JudgeUsage,
  window: TaskWindow | null,
): Promise<void> {
  let done = 0;
  await mapLimit(selected, GENERATE_CONCURRENCY, async (c) => {
    const tag = `[generate ${++done}/${selected.length}] ${c.sha.slice(0, 8)}`;
    try {
      const fileDiffs = fileDiffsFor(REPO, c.parentSha, c.sha);
      const text = await withWorktree(REPO, c.parentSha, (dir) =>
        withTimeout(GENERATE_TIMEOUT_MS, (signal) =>
          runCodex({
            model: MODEL,
            cwd: dir,
            schema: TASK_SCHEMA,
            message: generatorMessage({
              diff: fullDiff(REPO, c.parentSha, c.sha),
              editedFilePaths: fileDiffs.map((f) => f.path),
              commitMessage: commitMessage(REPO, c.sha),
            }),
            signal,
            usage,
            usageKey: "generate",
          }),
        ),
      );
      const task = parseTask(text);
      if (!task) throw new Error(`not structured output: ${text.slice(0, 120)}`);
      const { valid, removed } = filterSupplementalFiles(REPO, c.parentSha, task.supplementalFiles);
      if (removed.length) console.log(`${tag} dropped ${removed.length} supplemental file(s) absent at the parent`);

      const record: JudgedTask = {
        id: task.id,
        sha: c.sha,
        parentSha: c.parentSha,
        spec: task.spec,
        prompt: task.prompt,
        supplementalFiles: valid,
        fileDiffs,
        app: c.app,
        finalCheckCommands: finalCheckCommands(c.app),
        coAuthoredByClaude: c.coAuthoredByClaude,
        screen: cache[c.sha]!,
        promptReview: null,
      };
      // Re-read and append under one synchronous step: five generators share the file.
      const draft = taskFile(DRAFT);
      draft.window = mergeWindow(draft.window, draft.evalCommits.length, window);
      draft.evalCommits.push(record);
      draft.generationDate = new Date().toISOString();
      writeJson(DRAFT, draft);
      console.log(`${tag} → ${task.id}: ${task.prompt.split("\n")[0].slice(0, 90)}`);
    } catch (err) {
      console.warn(`${tag} generate failed: ${(err as Error).message}`);
    }
  });
}

async function cmdGenerate(): Promise<void> {
  const file = arg("candidates");
  if (!file) throw new Error("--candidates <file> is required (from `pnpm bench:commits --out`)");
  // No fallback: a missing file read as [] reports "0 candidates" and exits 0,
  // which looks like a finished run.
  if (!fs.existsSync(file)) throw new Error(`no candidates file at ${file}`);
  // `bench:commits --out` writes { window, candidates }. A bare array is a
  // file from before the window was recorded: usable, but its tasks can never
  // pass the contamination check (§4.8).
  const raw = readJson<Candidate[] | { window: TaskWindow; candidates: Candidate[] }>(file, []);
  const candidates = Array.isArray(raw) ? raw : raw.candidates;
  const window = Array.isArray(raw) ? null : raw.window;
  if (!window) console.warn(`${file} records no window: its tasks will fail the contamination check`);
  const draftNow = taskFile(DRAFT);
  mergeWindow(draftNow.window, draftNow.evalCommits.length, window); // refuse before spending
  const limit = Number(arg("limit") ?? Infinity);
  const cache = readJson<ScreenCache>(SCREEN_CACHE, {});
  const known = new Set(
    [...taskFile(DRAFT).evalCommits, ...taskFile(APPROVED).evalCommits].map((t) => t.sha),
  );
  const usage: JudgeUsage = {};

  const toScreen = candidates.filter((c) => !(c.sha in cache)).slice(0, limit);
  console.log(
    `${candidates.length} candidates, ${Object.keys(cache).length} already screened, ` +
      `screening ${toScreen.length} with ${MODEL}`,
  );
  await screen(toScreen, cache, usage);

  const selected = candidates.filter((c) => cache[c.sha] && !known.has(c.sha));
  console.log(`\n${selected.length} HARD commit(s) to generate tasks for`);
  await generate(selected, cache, usage, window);

  console.log(`\ntokens (Codex subscription, not priced):`);
  for (const [k, u] of Object.entries(usage)) {
    console.log(`  ${k.padEnd(9)} ${u.calls} call(s)  in ${u.inputTokens.toLocaleString()}  out ${u.outputTokens.toLocaleString()}`);
  }
  console.log(`\nreview: ${path.relative(process.cwd(), DRAFT)}, then pnpm bench:tasks approve --by <you> …`);
}

function cmdList(): void {
  const draft = taskFile(DRAFT).evalCommits;
  const approved = taskFile(APPROVED).evalCommits;
  console.log(`${approved.length} approved, ${draft.length} awaiting review\n`);
  for (const t of draft) {
    console.log(`${t.id}  ${t.sha.slice(0, 7)}  [${t.app}]${t.coAuthoredByClaude ? "  claude-co-authored" : ""}`);
    console.log(`  screen: ${t.screen.shortDescription}`);
    console.log(`  prompt: ${t.prompt.replace(/\n/g, "\n          ")}\n`);
  }
}

function cmdApprove(): void {
  const ids = process.argv.includes("--all")
    ? ("all" as const)
    : process.argv.slice(process.argv.indexOf("approve") + 1).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--by");
  if (ids !== "all" && ids.length === 0) throw new Error("name the tasks to approve, or pass --all");
  const draft = taskFile(DRAFT);
  const approved = taskFile(APPROVED);
  const window = mergeWindow(approved.window, approved.evalCommits.length, draft.window);
  const r = approveTasks(draft.evalCommits, approved.evalCommits, ids, arg("by") ?? "", new Date().toISOString());
  writeJson(APPROVED, { ...approved, window, generationDate: new Date().toISOString(), evalCommits: r.approved });
  writeJson(DRAFT, { ...draft, evalCommits: r.draft });
  console.log(`approved ${r.moved.length}: ${r.moved.join(", ")}`);
}

const commands: Record<string, () => void | Promise<void>> = {
  generate: cmdGenerate,
  list: cmdList,
  approve: cmdApprove,
};
const cmd = commands[process.argv[2] ?? ""];
if (!cmd) {
  console.error("usage: pnpm bench:tasks generate --candidates <file> [--limit N] | list | approve --by <name> (--all | <id>...)");
  process.exit(2);
}
Promise.resolve(cmd()).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
