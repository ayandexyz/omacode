// =============================================================================
// Pure pieces of the task generator: what the screen and the generator are
// shown, what they must answer, and the owner's approval step.
// Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.1–4.3.
// =============================================================================

import {
  COMMIT_SCREENING_PROMPT,
  GENERATOR_INSTRUCTIONS,
  GENERATOR_SYSTEM,
} from "./buffbench-prompts.js";
import type { App, CommitInfo } from "./commits.js";
import type { TaskWindow } from "./contamination.js";

export interface FileDiff {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  oldPath?: string;
  diff: string;
}

/** BuffBench's `EvalCommitV2`, plus the fields spec §4.1 marks `+`. */
export interface JudgedTask {
  id: string;
  sha: string;
  parentSha: string;
  spec: string;
  prompt: string;
  supplementalFiles: string[];
  fileDiffs: FileDiff[];
  app: App;
  finalCheckCommands: string[];
  coAuthoredByClaude: boolean;
  /** Why the screen kept it — shown to the owner at review. */
  screen: { reason: string; shortDescription: string };
  /** null until the owner approves (§4.3 step 3). */
  promptReview: { by: string; at: string } | null;
}

/** BuffBench's `EvalDataV2`, plus the window its tasks were cut from (§4.8). */
export interface JudgedTaskFile {
  repoUrl: string;
  generationDate: string;
  initCommand: string;
  window?: TaskWindow | null;
  evalCommits: JudgedTask[];
}

export const REPO_URL = "https://github.com/ayandexyz/omacode";
// --prefer-offline, not --offline: a parent commit may pin a version the local
// store no longer holds, and --offline turns that into a failed trial.
export const INIT_COMMAND = "pnpm install --frozen-lockfile --prefer-offline";

/**
 * By directory, not `--filter <name>`: the packages are named
 * `@thisisayande/freecode-core` and `@thisisayande/freecode`, so a filter on
 * "core" matches nothing and exits 0. A green check from a no-op is exactly
 * the evidence a judge must not be shown.
 */
export function finalCheckCommands(app: App): string[] {
  return [`pnpm -C apps/${app} exec tsc --noEmit`, `pnpm -C apps/${app} test`];
}

// --- screen ------------------------------------------------------------------

/** Theirs: `MAX_FILES_PER_COMMIT`. */
export const SCREEN_MAX_FILES = 30;
/**
 * Ours. Their per-line comparison shifts after the first inserted line and so
 * prints most of a changed file, with no size cap. On a 2000-line commit that
 * can exceed a context window, which is a dead screen call, not a verdict.
 */
export const SCREEN_MAX_CHARS = 150_000;

export interface ScreenFile {
  path: string;
  /** "[NEW FILE]" when absent at the parent, as theirs. */
  preContent: string;
  /** "[DELETED]" when absent at the commit, as theirs. */
  postContent: string;
}

/**
 * The commit as BuffBench's screen sees it, including their positional
 * "Line N: - / +" comparison. That comparison is not a real diff, but it is
 * what their screen model saw, so it is kept.
 */
export function screenCommitInfo(commit: CommitInfo, files: ScreenFile[]): string {
  const added = commit.files.reduce((n, f) => n + f.added, 0);
  const deleted = commit.files.reduce((n, f) => n + f.deleted, 0);
  let info =
    `${commit.sha.substring(0, 8)}: ${commit.message}\n` +
    `Date: ${commit.date}\n` +
    `Stats: ${commit.files.length} files changed, +${added} -${deleted}\n`;
  if (files.length > 0) {
    info += `\nFile Changes:\n`;
    for (const diff of files.slice(0, SCREEN_MAX_FILES)) {
      info += `\n--- ${diff.path} ---\n`;
      if (diff.preContent === "[NEW FILE]") {
        info += `New file:\n${diff.postContent}\n`;
      } else if (diff.postContent === "[DELETED]") {
        info += `File deleted\n`;
      } else {
        const pre = diff.preContent.split("\n");
        const post = diff.postContent.split("\n");
        let hasChanges = false;
        for (let i = 0; i < pre.length; i++) {
          if (pre[i] !== post[i]) {
            info += `Line ${i + 1}:\n- ${pre[i]}\n+ ${post[i]}\n`;
            hasChanges = true;
          }
        }
        if (!hasChanges && pre.length !== post.length) {
          info += `File length changed from ${pre.length} to ${post.length} lines\n`;
        }
      }
    }
  }
  if (info.length > SCREEN_MAX_CHARS) {
    info = `${info.slice(0, SCREEN_MAX_CHARS)}\n[truncated at ${SCREEN_MAX_CHARS} characters]\n`;
  }
  return `${COMMIT_SCREENING_PROMPT}\n\nCommit to evaluate:\n\n${info}`;
}

/** Theirs: `CommitSelectionSchema`. */
export const SCREEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["selectedCommits"],
  properties: {
    selectedCommits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sha", "reason", "shortDescription"],
        properties: {
          sha: { type: "string" },
          reason: { type: "string" },
          shortDescription: { type: "string" },
        },
      },
    },
  },
};

/** Theirs: selected only when the first entry's sha prefixes the commit's. */
export function screenVerdict(
  text: string,
  sha: string,
): { reason: string; shortDescription: string } | null {
  try {
    const selected = JSON.parse(text)?.selectedCommits?.[0];
    if (!selected || typeof selected.sha !== "string" || !selected.sha) return null;
    if (!sha.startsWith(selected.sha)) return null;
    return { reason: String(selected.reason), shortDescription: String(selected.shortDescription) };
  } catch {
    return null;
  }
}

// --- generator ---------------------------------------------------------------

export const TASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "reasoning", "spec", "prompt", "supplementalFiles"],
  properties: {
    id: {
      type: "string",
      description:
        'Short 2-3 word hyphenated task identifier (e.g., "fix-auth-bug", "add-user-profile", "refactor-login-flow")',
    },
    reasoning: { type: "string", description: "Your thoughts about the task, spec, and prompt" },
    spec: {
      type: "string",
      description:
        "Clear specification describing WHAT needs to be implemented (observable behavior/structure, not HOW)",
    },
    prompt: { type: "string", description: "High-level user prompt describing what needs to be done" },
    supplementalFiles: {
      type: "array",
      items: { type: "string" },
      description: "List of supplemental file paths",
    },
  },
};

export interface GeneratedTask {
  id: string;
  reasoning: string;
  spec: string;
  prompt: string;
  supplementalFiles: string[];
}

export function parseTask(text: string): GeneratedTask | null {
  try {
    const o = JSON.parse(text);
    const strings = ["id", "reasoning", "spec", "prompt"] as const;
    if (!strings.every((k) => typeof o[k] === "string" && o[k].trim())) return null;
    if (!Array.isArray(o.supplementalFiles) || !o.supplementalFiles.every((f: unknown) => typeof f === "string")) {
      return null;
    }
    return o as GeneratedTask;
  } catch {
    return null;
  }
}

/**
 * Their generator got a system prompt, the run prompt, the params
 * `{ diff, editedFilePaths, commitMessage }` and the instructions prompt, in
 * that order. `codex exec` takes one message, so they are laid out in order.
 */
export function generatorMessage(params: {
  diff: string;
  editedFilePaths: string[];
  commitMessage: string;
}): string {
  return [
    GENERATOR_SYSTEM,
    "Generate a task specification and user prompt based on the git diff and codebase exploration",
    `Params:\n${JSON.stringify(params, null, 2)}`,
    GENERATOR_INSTRUCTIONS,
  ].join("\n\n---\n\n");
}

/** `git diff --name-status` → BuffBench's FileDiff status (without the diff). */
export function parseNameStatus(out: string): Omit<FileDiff, "diff">[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...parts] = line.split("\t");
      const filePath = parts[parts.length - 1];
      if (status === "A") return { path: filePath, status: "added" as const };
      if (status === "D") return { path: filePath, status: "deleted" as const };
      if (status.startsWith("R")) return { path: filePath, status: "renamed" as const, oldPath: parts[0] };
      return { path: filePath, status: "modified" as const };
    });
}

// --- review ------------------------------------------------------------------

/**
 * Spec §4.3 step 3: move reviewed drafts into the task file, stamped. The
 * owner edits `prompt` in the draft first if it needs it; the stamp records
 * who approved the text that will actually run.
 */
export function approveTasks(
  draft: JudgedTask[],
  approved: JudgedTask[],
  ids: string[] | "all",
  by: string,
  at: string,
): { draft: JudgedTask[]; approved: JudgedTask[]; moved: string[] } {
  if (!by.trim()) throw new Error("--by is required: a review nobody signs is not a review");
  const pick = (t: JudgedTask) => ids === "all" || ids.includes(t.id) || ids.includes(t.sha.slice(0, 7));
  const moving = draft.filter(pick);
  if (ids !== "all") {
    const found = new Set(moving.flatMap((t) => [t.id, t.sha.slice(0, 7)]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`not in the draft: ${missing.join(", ")}`);
  }
  const taken = new Set(approved.map((t) => t.id));
  for (const t of moving) {
    if (taken.has(t.id)) throw new Error(`task id "${t.id}" is already approved; rename one in the draft`);
    taken.add(t.id);
  }
  return {
    draft: draft.filter((t) => !pick(t)),
    approved: [...approved, ...moving.map((t) => ({ ...t, promptReview: { by, at } }))],
    moved: moving.map((t) => t.id),
  };
}
