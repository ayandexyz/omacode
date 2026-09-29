import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checkContamination, mergeWindow, modelKey, readReleases } from "./contamination.js";

const window = { since: "2026-08-01", until: null };
const releases = { "minimax-m3": { released: "2026-07-15", source: "https://example.com" } };

test("modelKey: both adapter dialects name the same model", () => {
  assert.equal(modelKey("minimax/MiniMax-M3"), "minimax-m3");
  assert.equal(modelKey("MiniMax-M3"), "minimax-m3");
});

test("a model released before the window's first day passes, in either dialect", () => {
  const c = checkContamination(window, releases, ["minimax/MiniMax-M3", "MiniMax-M3"]);
  assert.equal(c.ok, true);
  assert.deepEqual(c.releases, { "minimax/MiniMax-M3": "2026-07-15", "MiniMax-M3": "2026-07-15" });
});

test("released on or after the window's first day fails: it may have trained on the tasks", () => {
  for (const released of ["2026-08-01", "2026-08-20", "2026-12-01"]) {
    const c = checkContamination(window, { "minimax-m3": { released, source: null } }, ["MiniMax-M3"]);
    assert.equal(c.ok, false, released);
    assert.match(c.problems[0], /may have trained on the tasks/);
  }
});

test("an unknown release date or a missing window fails: unknown is not clean", () => {
  assert.match(checkContamination(window, {}, ["MiniMax-M3"]).problems[0], /no release date/);
  assert.match(
    checkContamination(window, { "minimax-m3": { released: null, source: null } }, ["MiniMax-M3"]).problems[0],
    /no release date/,
  );
  assert.match(checkContamination(null, releases, ["MiniMax-M3"]).problems[0], /records no window/);
});

test("readReleases skips _notes and tolerates a missing file", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rel-")), "r.json");
  fs.writeFileSync(f, JSON.stringify({ _comment: "fill me", "minimax-m3": { released: "2026-07-15", source: "s" } }));
  assert.deepEqual(Object.keys(readReleases(f)), ["minimax-m3"]);
  assert.deepEqual(readReleases("/nope.json"), {});
});

test("mergeWindow: an empty file takes the window; a different one is refused", () => {
  assert.deepEqual(mergeWindow(null, 0, window), window);
  assert.deepEqual(mergeWindow(window, 3, { ...window }), window);
  assert.throws(() => mergeWindow(window, 3, { since: "2026-09-01", until: null }), /window mismatch/);
  assert.throws(() => mergeWindow(null, 2, window), /window mismatch/, "legacy windowless tasks do not mix");
});
