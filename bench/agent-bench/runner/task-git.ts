// =============================================================================
// Git reads for the task generator. Everything is read from the repo's object
// store by sha, so the owner's working tree and branch are never touched —
// except `withWorktree`, which adds a detached throwaway worktree at the
// parent for the generator to explore, and always removes it.
// =============================================================================

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CommitInfo } from "./commits.js";
import { SCREEN_MAX_FILES, parseNameStatus, type FileDiff, type ScreenFile } from "./task-build.js";

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf-8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });

function show(repo: string, sha: string, file: string): string | undefined {
  try {
    return git(repo, "show", `${sha}:${file}`);
  } catch {
    return undefined;
  }
}

/** Theirs (`generateDiffFromCommit`): whole files before and after, first 30. */
export function screenFiles(repo: string, commit: CommitInfo): ScreenFile[] {
  const out: ScreenFile[] = [];
  for (const { path: file } of commit.files.slice(0, SCREEN_MAX_FILES)) {
    const pre = show(repo, commit.parentSha, file);
    const post = show(repo, commit.sha, file);
    if (pre === undefined && post === undefined) continue;
    out.push({ path: file, preContent: pre ?? "[NEW FILE]", postContent: post ?? "[DELETED]" });
  }
  return out;
}

/** Theirs (`extractFileDiffsFromCommit`), with git's own diff instead of the `diff` package. */
export function fileDiffsFor(repo: string, parentSha: string, sha: string): FileDiff[] {
  return parseNameStatus(git(repo, "diff", "-M", "--name-status", parentSha, sha)).map((f) => ({
    ...f,
    diff: git(
      repo,
      "diff",
      "-M",
      "--no-color",
      "--no-ext-diff",
      parentSha,
      sha,
      "--",
      ...(f.oldPath ? [f.oldPath, f.path] : [f.path]),
    ),
  }));
}

export const fullDiff = (repo: string, parentSha: string, sha: string) =>
  git(repo, "diff", "--no-color", "--no-ext-diff", parentSha, sha);

export const commitMessage = (repo: string, sha: string) =>
  git(repo, "log", "--format=%B", "-n", "1", sha).trim();

export function existsAt(repo: string, sha: string, file: string): boolean {
  try {
    git(repo, "cat-file", "-e", `${sha}:${file}`);
    return true;
  } catch {
    return false;
  }
}

/** Theirs (`filterSupplementalFiles`): keep only paths that exist at the parent. */
export function filterSupplementalFiles(
  repo: string,
  parentSha: string,
  files: string[],
): { valid: string[]; removed: string[] } {
  const valid: string[] = [];
  const removed: string[] = [];
  for (const f of files) (existsAt(repo, parentSha, f) ? valid : removed).push(f);
  return { valid, removed };
}

export async function withWorktree<T>(repo: string, sha: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-gen-"));
  git(repo, "worktree", "add", "--detach", dir, sha);
  try {
    return await fn(dir);
  } finally {
    git(repo, "worktree", "remove", "--force", dir);
  }
}
