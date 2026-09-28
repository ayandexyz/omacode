// =============================================================================
// Permission envelope — how an unattended run answers a permission `ask`
// without a human. Replaces both `--yes` (blanket allow) and the bus prompt
// (which hangs for 30 minutes and then reads as a denial).
//
// HONEST LIMIT: this is a guard rail, not a sandbox. Prefix rules match
// commands, not effects — `bash` can still `cd` elsewhere or pipe curl into a
// shell. What actually bounds the damage is the orchestrator: every failed
// iteration is `git reset --hard`, the run lives on its own branch, and nothing
// is pushed. The deny list covers the irreversible and outward-facing commands
// a model reaches for in practice, and nothing more.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.6
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { COMMAND_TOOLS, extractTarget } from "../permission/rules.js";

/**
 * Denied for every night run, seeded into the session's DENY tier so a user's
 * own allow rule cannot widen them (deny beats allow — permission/evaluate.ts).
 */
export const ENVELOPE_DENY_RULES: string[] = [
  // The orchestrator owns git. A model that commits or switches branches
  // breaks the one-commit-per-step guarantee the morning review depends on.
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git reset:*)",
  "Bash(git checkout:*)",
  "Bash(git switch:*)",
  "Bash(git rebase:*)",
  "Bash(git merge:*)",
  "Bash(git branch:*)",
  "Bash(git worktree:*)",
  "Bash(git tag:*)",
  "Bash(git config:*)",
  // Nothing leaves the machine. `--push` does not relax this: pushing is the
  // orchestrator's act, after a commit, never the model's.
  "Bash(gh:*)",
  "Bash(npm publish:*)",
  "Bash(pnpm publish:*)",
  "Bash(yarn publish:*)",
  "Bash(cargo publish:*)",
  "Bash(docker push:*)",
  // No system changes.
  "Bash(sudo:*)",
  "Bash(npm i -g:*)",
  "Bash(npm install -g:*)",
  "Bash(pnpm add -g:*)",
  "Bash(rm -rf /:*)",
  "Bash(rm -rf ~:*)",
];

/** Returned to the model verbatim. A refusal is final — it must not retry. */
export const REFUSAL_TEXT =
  "Refused for this unattended run and final — do not retry it. " +
  "Work around it, or add it to finish_iteration.needs_human and move on.";

export interface EnvelopeDecision {
  allowed: boolean;
  /** Which envelope rule refused, for the report. Absent when allowed. */
  rule?: string;
  reason?: string;
}

/**
 * Whether a resolved path stays inside the run's working tree.
 *
 * Resolves symlinks where they exist: a symlink inside the tree pointing out of
 * it is the obvious way past a string comparison. A path that does not exist
 * yet (a file about to be created) is judged by its nearest existing parent.
 */
export function insideTree(tree: string, target: string): boolean {
  const realTree = realpathOrSelf(path.resolve(tree));
  const resolved = realpathOrSelf(path.resolve(tree, target));
  const rel = path.relative(realTree, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathOrSelf(p: string): string {
  // Walk up to the nearest existing ancestor: `realpathSync` throws on a path
  // that does not exist yet, which is every file a write is about to create.
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p; // hit the root; nothing resolvable
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The envelope's answer for an `ask` the mode raised. Deny rules are NOT
 * checked here — they are seeded into the rule set, so the evaluator has
 * already refused them before an ask can happen. This decides the rest:
 * a path mutation must stay inside the tree; everything else is allowed.
 */
export function decideUnattendedAsk(opts: {
  tree: string;
  toolName: string;
  args: Record<string, unknown>;
}): EnvelopeDecision {
  const { tree, toolName, args } = opts;
  const tool = toolName.toLowerCase();

  // A command's "target" is the command text, not a path — judging it as one
  // would refuse every `pnpm test`. Commands are bounded by the deny list, plus
  // the chained-command check below.
  if (COMMAND_TOOLS.has(tool)) {
    const evaded = deniedSegment(args.command);
    if (evaded) {
      return {
        allowed: false,
        rule: evaded,
        reason: `\`${evaded}\` is refused for this run, however it is spelled. ${REFUSAL_TEXT}`,
      };
    }
  }

  if (!COMMAND_TOOLS.has(tool)) {
    const target = extractTarget(tool, args);
    if (target && MUTATORS.has(tool) && touchesGitDir(target)) {
      return {
        allowed: false,
        rule: "writes under .git/ are refused",
        reason: `The orchestrator owns this repository's git state. ${REFUSAL_TEXT}`,
      };
    }
    if (target && looksLikePath(tool) && !insideTree(tree, target)) {
      return {
        allowed: false,
        rule: "outside the run's working tree",
        reason: `${target} is outside ${tree}. ${REFUSAL_TEXT}`,
      };
    }
  }

  return { allowed: true };
}

// Only tools whose target IS a filesystem path. `webfetch`'s target is a URL
// and `agent`'s is a sub-agent type; neither is judged by tree containment.
const PATH_TOOLS = new Set(["write", "edit", "read", "ls", "glob", "grep"]);
const looksLikePath = (tool: string): boolean => PATH_TOOLS.has(tool);
const MUTATORS = new Set(["write", "edit"]);

/**
 * The verbs the deny rules above forbid, as bare prefixes. Derived from the
 * rules so the two cannot drift.
 */
const DENIED_PREFIXES = ENVELOPE_DENY_RULES.map((rule) =>
  rule.replace(/^Bash\(/, "").replace(/:\*\)$/, "").trim(),
);

/** `&&`, `||`, `;`, `|`, newline, and command substitution. */
const SEGMENT_SPLIT = /\|\||&&|;|\||\n|`|\$\(|\)/;

/** `FOO=bar` — a leading environment assignment, not the command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strip what a prefix rule cannot see past, so the verb lands at the front:
 * leading environment assignments and an `env` wrapper
 * (`GIT_AUTHOR_NAME=x env git commit` → `git commit`), then the directory of a
 * program path (`/usr/bin/git commit` → `git commit`).
 *
 * Only leading tokens are touched — a path or an `=` in an ARGUMENT is data,
 * and rewriting it would change which commands match.
 */
function normalizeSegment(segment: string): string {
  let rest = segment.trim();
  for (;;) {
    const space = rest.search(/\s/);
    if (space === -1) break;
    const head = rest.slice(0, space);
    if (!ENV_ASSIGNMENT.test(head) && head !== "env") break;
    rest = rest.slice(space + 1).trimStart();
  }
  const space = rest.search(/\s/);
  const head = space === -1 ? rest : rest.slice(0, space);
  if (!head.includes("/")) return rest;
  const bare = head.slice(head.lastIndexOf("/") + 1);
  return space === -1 ? bare : bare + rest.slice(space);
}

/**
 * The denied verb inside a command, however it is spelled.
 *
 * Both spellings here were found by `evals/night.jsonl` on its first two runs,
 * with MiniMax-M3 working around a refused `git commit`:
 *
 * 1. **Chained.** `git init && git config … && git add -A && git commit -am '…'`
 *    — `docs/DECISIONS.md` records that a bash prefix rule deliberately refuses
 *    to match a compound command, so `Bash(npm:*)` can never approve
 *    `npm test && rm -rf /`. That is the right failure direction for an ALLOW
 *    rule and the wrong one for a DENY rule, which then matches nothing and
 *    lets the whole chain through.
 * 2. **Path-qualified.** `/usr/bin/git commit -m '…'` — a prefix rule compares
 *    from the first character, so the same verb behind its absolute path is a
 *    different string.
 * 3. **Env-prefixed.** `GIT_AUTHOR_NAME="freecode" GIT_AUTHOR_EMAIL="…" git
 *    commit -m '…'` — same story, with assignments in front of the verb.
 *
 * Fixed here rather than in `rules.ts`: the recorded decision is about allow
 * semantics and is load-bearing there. This is the envelope's own problem,
 * because it is the only caller whose rules are exclusively denials.
 *
 * Still not a sandbox (see the header). `eval "$(echo git push)"`, a shell
 * alias, or a script that wraps the verb all defeat it. It closes the routes a
 * model actually takes when told no, not the ones an adversary would.
 */
function deniedSegment(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  for (const raw of command.split(SEGMENT_SPLIT)) {
    const segment = normalizeSegment(raw);
    for (const prefix of DENIED_PREFIXES) {
      if (segment === prefix) return prefix;
      if (
        segment.startsWith(prefix) &&
        /\s/.test(segment[prefix.length] ?? " ")
      ) {
        return prefix;
      }
    }
  }
  return undefined;
}

// Reading `.git/` is fine (a model may want the log); writing into it is how a
// model would rewrite the history the orchestrator owns.
function touchesGitDir(target: string): boolean {
  return path
    .normalize(target)
    .split(path.sep)
    .includes(".git");
}
