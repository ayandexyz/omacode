import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "freecode-ledger-"));
process.env.FREECODE_BACKGROUND_DIR = dir;
const {
  recordStart,
  recordEnd,
  takeOrphans,
  clearLedger,
  markSessionEnding,
  reviveLedger,
  lostTasksNotification,
} = await import("./background-ledger.js");

test.after(() => rmSync(dir, { recursive: true, force: true }));

const deadProcessEntry = (id: string) => ({
  id,
  kind: "shell",
  summary: `pnpm eval ${id}`,
  startedAt: 1_700_000_000_000,
  pid: process.pid + 100_000, // not this process: a core that has exited
});

test("a settled task leaves nothing behind", () => {
  recordStart("s1", { id: "bash_1", kind: "shell", summary: "sleep 1" });
  recordEnd("s1", "bash_1");
  assert.equal(existsSync(join(dir, "s1.json")), false);
  assert.deepEqual(takeOrphans("s1"), []);
});

test("this process's running tasks are live, never orphans", () => {
  recordStart("s2", { id: "bash_1", kind: "shell", summary: "dev server" });
  assert.deepEqual(takeOrphans("s2"), [], "a same-core resume must not flag it");
  recordEnd("s2", "bash_1");
});

test("entries left by another process are orphans, reported exactly once", () => {
  writeFileSync(join(dir, "s3.json"), JSON.stringify([deadProcessEntry("bash_4"), deadProcessEntry("bash_5")]));
  recordStart("s3", { id: "bash_1", kind: "monitor", summary: "tail -f log" });
  const orphans = takeOrphans("s3");
  assert.deepEqual(orphans.map((o) => o.id), ["bash_4", "bash_5"]);
  assert.deepEqual(takeOrphans("s3"), [], "each loss is reported once");
  recordEnd("s3", "bash_1");
  assert.equal(existsSync(join(dir, "s3.json")), false, "the live entry was kept until it ended");
});

test("a new process's bash_1 does not erase the old process's bash_1", () => {
  writeFileSync(join(dir, "s4.json"), JSON.stringify([deadProcessEntry("bash_1")]));
  recordStart("s4", { id: "bash_1", kind: "shell", summary: "new run" });
  recordEnd("s4", "bash_1");
  assert.deepEqual(takeOrphans("s4").map((o) => o.summary), ["pnpm eval bash_1"]);
});

test("a deleted session clears its ledger: nothing will resume it", () => {
  writeFileSync(join(dir, "s5.json"), JSON.stringify([deadProcessEntry("bash_2")]));
  clearLedger("s5");
  assert.deepEqual(takeOrphans("s5"), []);
});

test("the notification names each lost task and says no result will come", () => {
  const text = lostTasksNotification([deadProcessEntry("bash_7") as never]);
  assert.match(text, /<status>lost<\/status>/);
  assert.match(text, /shell bash_7: pnpm eval bash_7/);
  assert.match(text, /no further notification will arrive/);
});

test("a session ending with a task running marks it stopped; the kill that follows does not erase it", () => {
  recordStart("s6", { id: "bash_1", kind: "shell", summary: "pnpm eval coding" });
  markSessionEnding("s6", "switch");
  recordEnd("s6", "bash_1"); // the disposer's kill fires the normal exit path
  reviveLedger("s6"); // resumed in the SAME process
  const orphans = takeOrphans("s6");
  assert.deepEqual(orphans.map((o) => [o.id, o.stopped]), [["bash_1", "switch"]]);
  assert.deepEqual(takeOrphans("s6"), []);
});

test("after a resume, tasks record and finish normally again", () => {
  markSessionEnding("s7", "switch");
  reviveLedger("s7");
  recordStart("s7", { id: "bash_2", kind: "shell", summary: "x" });
  recordEnd("s7", "bash_2");
  assert.deepEqual(takeOrphans("s7"), []);
});
