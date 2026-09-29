import test from "node:test";
import assert from "node:assert/strict";
import { appFor, basicFilter, parseLog, type CommitInfo } from "./commits.js";

function commit(over: Partial<CommitInfo>): CommitInfo {
  return {
    sha: "a".repeat(40),
    parentSha: "b".repeat(40),
    date: "2026-09-01",
    message: "feat(core): add a thing",
    files: [{ path: "apps/core/src/x.ts", added: 20, deleted: 5 }],
    coAuthoredByClaude: false,
    ...over,
  };
}

test("basicFilter drops BuffBench's message classes", () => {
  for (const message of [
    "chore: bump ai to 5.1",
    "Update dependencies",
    "upgrade node version",
    "regenerate: auto-generated types",
    "ci: cache pnpm store",
    "build: new target",
    "format code with biome",
    "fix lint",
    "run prettier",
    "Merge branch main",
    "Revert \"feat: x\"",
  ]) {
    assert.equal(basicFilter(commit({ message })), false, message);
  }
  assert.equal(basicFilter(commit({ message: "fix: typo in README" })), false);
  assert.equal(basicFilter(commit({ message: "feat: real change" })), true);
});

test("basicFilter drops too-small and too-large commits by stats", () => {
  const tiny = commit({ files: [{ path: "apps/core/src/x.ts", added: 2, deleted: 1 }] });
  assert.equal(basicFilter(tiny), false);
  const none = commit({ files: [] });
  assert.equal(basicFilter(none), false);
  const many = commit({
    files: Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.ts`, added: 1, deleted: 0 })),
  });
  assert.equal(basicFilter(many), false);
  const huge = commit({ files: [{ path: "apps/core/src/x.ts", added: 1500, deleted: 501 }] });
  assert.equal(basicFilter(huge), false);
});

test("basicFilter keeps a single-file commit of 5+ lines (BuffBench's parser dropped all of them)", () => {
  const one = commit({ files: [{ path: "apps/core/src/x.ts", added: 4, deleted: 1 }] });
  assert.equal(basicFilter(one), true);
});

test("appFor picks the app with more non-test changed lines, ignoring tests", () => {
  assert.equal(appFor(commit({})), "core");
  assert.equal(
    appFor(commit({ files: [{ path: "apps/tui/src/a.ts", added: 9, deleted: 0 }] })),
    "tui",
  );
  assert.equal(
    appFor(
      commit({
        files: [
          { path: "apps/core/src/a.ts", added: 3, deleted: 0 },
          { path: "apps/tui/src/b.ts", added: 10, deleted: 2 },
        ],
      }),
    ),
    "tui",
  );
  assert.equal(
    appFor(commit({ files: [{ path: "apps/core/src/a.test.ts", added: 50, deleted: 0 }] })),
    undefined,
  );
  assert.equal(
    appFor(commit({ files: [{ path: "docs/specs/x.md", added: 50, deleted: 0 }] })),
    undefined,
  );
});

test("parseLog reads the record format, numstat, and the Claude co-author trailer", () => {
  const S = "\x1e";
  const U = "\x1f";
  const raw =
    `${S}${"a".repeat(40)}${U}${"b".repeat(40)} ${"c".repeat(40)}${U}2026-09-02${U}feat: x${U}body\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>${U}\n` +
    `12\t3\tapps/core/src/x.ts\n-\t-\tassets/logo.png\n` +
    `${S}${"d".repeat(40)}${U}${"e".repeat(40)}${U}2026-09-01${U}fix: y${U}${U}\n` +
    `1\t0\tapps/tui/src/y.ts\n`;
  const [first, second] = parseLog(raw);
  assert.equal(first.sha, "a".repeat(40));
  assert.equal(first.parentSha, "b".repeat(40), "first parent of a merge");
  assert.equal(first.message, "feat: x");
  assert.equal(first.coAuthoredByClaude, true);
  assert.deepEqual(first.files, [
    { path: "apps/core/src/x.ts", added: 12, deleted: 3 },
    { path: "assets/logo.png", added: 0, deleted: 0 },
  ]);
  assert.equal(second.coAuthoredByClaude, false);
  assert.equal(second.files.length, 1);
});
