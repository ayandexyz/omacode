// =============================================================================
// The permission envelope: what an unattended run refuses without asking.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.6, §7 (unit).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ENVELOPE_DENY_RULES,
  decideUnattendedAsk,
  insideTree,
} from "./envelope.js";
import { evaluatePermission } from "../permission/evaluate.js";
import { parseRuleSet } from "../permission/rules.js";

// The envelope's rules go into the DENY tier, so they are evaluated by the one
// existing evaluator — these tests check them there, not against a second
// matcher that could drift from it.
function evaluate(toolName: string, args: Record<string, unknown>) {
  return evaluatePermission({
    toolName,
    args,
    mode: "build",
    rules: parseRuleSet({
      deny: ENVELOPE_DENY_RULES,
      // A user's own allow rule must not widen the envelope.
      allow: ["Bash(git:*)", "Bash(gh:*)", "Bash(sudo:*)"],
      ask: [],
    }),
    projectRoot: "/repo",
  });
}

test("the orchestrator's git verbs are refused even with a user allow rule", () => {
  for (const command of [
    "git push origin main",
    "git commit -m wip",
    "git reset --hard HEAD~1",
    "git checkout main",
    "git switch main",
    "git rebase -i HEAD~3",
    "git merge feature",
    "git branch -D night/old",
    "git worktree add ../wt",
    "git tag v9",
    "git config user.email x@y.z",
  ]) {
    const result = evaluate("bash", { command });
    assert.equal(result.decision, "deny", command);
  }
});

test("outward-facing and system commands are refused", () => {
  for (const command of [
    "gh pr create",
    "npm publish",
    "pnpm publish --access public",
    "cargo publish",
    "docker push registry/img",
    "sudo rm /etc/hosts",
    "npm install -g typescript",
    "pnpm add -g tsx",
  ]) {
    assert.equal(evaluate("bash", { command }).decision, "deny", command);
  }
});

test("ordinary work is not refused by the deny list", () => {
  for (const command of [
    "pnpm test",
    "git status",
    "git diff",
    "git log --oneline -5",
    "node build.mjs",
  ]) {
    assert.notEqual(evaluate("bash", { command }).decision, "deny", command);
  }
});

test("a write inside the tree is allowed, outside is refused", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "night-tree-"));
  try {
    assert.equal(
      decideUnattendedAsk({
        tree,
        toolName: "write",
        args: { filePath: path.join(tree, "src/new.ts") },
      }).allowed,
      true,
    );
    const outside = decideUnattendedAsk({
      tree,
      toolName: "write",
      args: { filePath: path.join(os.homedir(), ".bashrc") },
    });
    assert.equal(outside.allowed, false);
    assert.match(outside.reason ?? "", /do not retry/);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("`..` cannot climb out of the tree", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "night-tree-"));
  try {
    assert.equal(
      decideUnattendedAsk({
        tree,
        toolName: "edit",
        args: { filePath: "../../etc/passwd" },
      }).allowed,
      false,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("a symlink out of the tree does not count as inside it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "night-"));
  const tree = path.join(root, "tree");
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(tree);
  fs.mkdirSync(elsewhere);
  try {
    fs.symlinkSync(elsewhere, path.join(tree, "link"));
  } catch {
    return; // no symlink permission (Windows CI) — nothing to assert
  }
  try {
    assert.equal(insideTree(tree, path.join(tree, "src")), true);
    assert.equal(
      insideTree(tree, path.join(tree, "link", "escaped.ts")),
      false,
      "a symlink pointing out of the tree is out of the tree",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writes under .git/ are refused; reads are not", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "night-tree-"));
  try {
    assert.equal(
      decideUnattendedAsk({
        tree,
        toolName: "write",
        args: { filePath: path.join(tree, ".git", "HEAD") },
      }).allowed,
      false,
    );
    assert.equal(
      decideUnattendedAsk({
        tree,
        toolName: "read",
        args: { filePath: path.join(tree, ".git", "HEAD") },
      }).allowed,
      true,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("a bash command is not judged as a path", () => {
  // Its "target" is the command text; treating that as a path would refuse
  // every build command in the repo.
  assert.equal(
    decideUnattendedAsk({
      tree: "/repo",
      toolName: "bash",
      args: { command: "pnpm test" },
    }).allowed,
    true,
  );
});

test("every envelope rule parses", () => {
  const parsed = parseRuleSet({ deny: ENVELOPE_DENY_RULES });
  assert.equal(parsed.deny.length, ENVELOPE_DENY_RULES.length);
});
