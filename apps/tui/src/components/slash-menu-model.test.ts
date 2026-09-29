import { test } from "node:test";
import assert from "node:assert/strict";
import { SlashMenuModel, type MenuCommand } from "./slash-menu-model.js";

const cmd = (name: string, description = `${name} command`, argHint?: string): MenuCommand => ({
  name,
  description,
  ...(argHint ? { argHint } : {}),
});

const ALL = [
  "model", "web", "effort", "resume", "tree", "rewind", "fork", "compact", "clear",
  "context", "cost", "usage", "graph", "shells", "agents", "mcp", "skills",
  "extensions", "reload", "help", "exit",
].map((n) => cmd(n));

test("root: groups in fixed order, then help and exit as leaves", () => {
  const m = new SlashMenuModel([...ALL, cmd("review-pr")]);
  const rows = m.rows(null);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["model", "session", "inspect", "running", "extend", "prompts", "help", "exit"],
  );
  assert.ok(rows.slice(0, 6).every((r) => r.opens === true), "groups open a submenu");
  assert.equal(rows[6].command?.name, "help", "root leaves carry the command they run");
});

test("a group with none of its commands is hidden, not shown empty", () => {
  const m = new SlashMenuModel(ALL.filter((c) => c.name !== "shells" && c.name !== "agents"));
  assert.ok(!m.rows(null).some((r) => r.id === "running"));
  assert.ok(!m.rows(null).some((r) => r.id === "prompts"), "no ungrouped commands, no Prompts group");
});

test("Prompts collects every command no group names, never help or exit", () => {
  const m = new SlashMenuModel([...ALL, cmd("review-pr"), cmd("deploy")]);
  assert.deepEqual(m.rows("prompts").map((r) => r.id), ["review-pr", "deploy"]);
});

test("a group lists its commands in its own order, skipping ones core did not send", () => {
  const m = new SlashMenuModel([cmd("clear"), cmd("resume"), cmd("compact")]);
  assert.deepEqual(m.rows("session").map((r) => r.id), ["resume", "compact", "clear"]);
});

test("a leaf shows its arg hint and falls back to the default icon", () => {
  const m = new SlashMenuModel([cmd("review-pr", "Review a PR", "<number>"), cmd("model")]);
  const [pr] = m.rows("prompts");
  assert.equal(pr.label, "review-pr <number>");
  assert.equal(pr.description, "Review a PR");
  assert.notEqual(pr.icon, m.rows("model")[0].icon, "unknown commands get the default glyph");
});

test("title: the root is Go, a group its label, an unknown id itself", () => {
  const m = new SlashMenuModel(ALL);
  assert.equal(m.title(null), "Go");
  assert.equal(m.title("session"), "Session");
  assert.equal(m.title("prompts"), "Prompts");
  assert.equal(m.title("nope"), "nope");
});

test("search ranks name-prefix, then name-contains, then a description word, ties by name", () => {
  const m = new SlashMenuModel([
    cmd("recompact", "run it again"),
    cmd("compact", "shrink history"),
    cmd("zeta", "compaction settings"),
    cmd("compare", "diff two things"),
  ]);
  assert.deepEqual(m.search("comp").map((r) => r.id), ["compact", "compare", "recompact", "zeta"]);
  assert.deepEqual(m.search("COMPACT").map((r) => r.id), ["compact", "recompact", "zeta"], "case-insensitive");
});

test("search never returns groups, and an empty or blank query returns nothing", () => {
  const m = new SlashMenuModel(ALL);
  assert.ok(m.search("sess").every((r) => r.command), "the Session group is not a result");
  assert.deepEqual(m.search(""), []);
  assert.deepEqual(m.search("   "), []);
  assert.deepEqual(m.search("zzzz"), []);
});
