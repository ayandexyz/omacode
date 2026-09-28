// =============================================================================
// Git for a night run — the orchestrator's own commits, on the run's branch.
//
// The MODEL never runs git: the envelope denies it (§4.6), so these are the
// only writes to the repository during a run. Commits are unsigned
// (`-c commit.gpgsign=false`): a GPG or SSH signing prompt would hang the night
// waiting for a passphrase nobody will type.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.2, §5.1
// =============================================================================

import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
}

export interface GitOps {
  isRepo(): Promise<boolean>;
  /** Paths with any change, staged or not, including untracked. */
  dirtyPaths(): Promise<string[]>;
  currentBranch(): Promise<string | undefined>;
  createOrSwitchBranch(name: string): Promise<void>;
  branchExists(name: string): Promise<boolean>;
  /** The commit hash, or a failure the orchestrator turns into a repair note. */
  commitAll(
    message: string,
  ): Promise<{ ok: true; hash: string; filesChanged: number } | { ok: false; error: string }>;
  /** Discard everything since the last commit, tracked and untracked. */
  reset(): Promise<void>;
  headHash(): Promise<string | undefined>;
  /** Push the run's branch. Never forced, never to another branch. */
  push(branch: string): Promise<{ ok: boolean; error?: string }>;
  /** `--stat` against the branch point, for the morning report. */
  diffstatAgainst(base: string): Promise<string>;
  /** Commit subjects on the run's branch, keyed by full hash. */
  subjectsSince(base: string): Promise<Record<string, string>>;
  /** Create a worktree for the branch and return its path. */
  addWorktree(dir: string, branch: string): Promise<void>;
}

export function createGitOps(cwd: string): GitOps {
  return {
    async isRepo() {
      try {
        const { stdout } = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
        return stdout.trim() === "true";
      } catch {
        return false;
      }
    },

    async dirtyPaths() {
      const { stdout } = await git(cwd, ["status", "--porcelain"]);
      return stdout
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
    },

    async currentBranch() {
      try {
        const { stdout } = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
        return stdout.trim() || undefined;
      } catch {
        return undefined; // detached HEAD — refused at preflight
      }
    },

    async branchExists(name) {
      try {
        await git(cwd, ["rev-parse", "--verify", `refs/heads/${name}`]);
        return true;
      } catch {
        return false;
      }
    },

    async createOrSwitchBranch(name) {
      if (await this.branchExists(name)) {
        await git(cwd, ["checkout", name]);
      } else {
        await git(cwd, ["checkout", "-b", name]);
      }
    },

    async commitAll(message) {
      try {
        await git(cwd, ["add", "-A"]);
        // --no-verify is NOT passed: a pre-commit hook failing is information,
        // and the orchestrator's repair path exists for exactly that (§5.1).
        await git(cwd, [
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          message,
        ]);
        const hash = (await this.headHash()) ?? "";
        const { stdout } = await git(cwd, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          hash,
        ]);
        return {
          ok: true,
          hash,
          filesChanged: stdout.split("\n").filter(Boolean).length,
        };
      } catch (error) {
        // Keep the tree. The work is still there and the next iteration is
        // told to repair whatever blocked the commit.
        const err = error as { stdout?: string; stderr?: string; message?: string };
        const detail = (err.stderr || err.stdout || err.message || "").trim();
        return { ok: false, error: detail.slice(0, 2000) };
      }
    },

    async reset() {
      await git(cwd, ["reset", "--hard"]);
      // Untracked files are not touched by reset --hard, and a half-finished
      // step usually left some. -d, not -dx: an ignored node_modules or build
      // cache is not this iteration's work.
      await git(cwd, ["clean", "-fd"]);
    },

    async headHash() {
      try {
        const { stdout } = await git(cwd, ["rev-parse", "HEAD"]);
        return stdout.trim();
      } catch {
        return undefined; // no commits yet
      }
    },

    async push(branch) {
      try {
        // Explicit refspec, no --force, no upstream tracking games: the only
        // branch this run may ever touch is its own.
        await git(cwd, ["push", "origin", `${branch}:${branch}`]);
        return { ok: true };
      } catch (error) {
        const err = error as { stderr?: string; message?: string };
        return { ok: false, error: (err.stderr || err.message || "").trim() };
      }
    },

    async diffstatAgainst(base) {
      try {
        // Three dots: what the branch added, not what `base` moved on to.
        const { stdout } = await git(cwd, ["diff", "--stat", `${base}...HEAD`]);
        return stdout;
      } catch {
        return "";
      }
    },

    async subjectsSince(base) {
      try {
        const { stdout } = await git(cwd, [
          "log",
          "--format=%H%x00%s",
          `${base}..HEAD`,
        ]);
        const out: Record<string, string> = {};
        for (const line of stdout.split("\n")) {
          const [hash, subject] = line.split("\0");
          if (hash && subject) out[hash] = subject;
        }
        return out;
      } catch {
        return {};
      }
    },

    async addWorktree(dir, branch) {
      await git(cwd, ["worktree", "add", "-b", branch, dir]);
    },
  };
}

/** `night/<slug>` from the objective — lowercase, hyphenated, bounded. */
export function branchSlug(objective: string): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "run";
}
