#!/usr/bin/env node
// =============================================================================
// CI guard against tests that silently stop running. Borrowed from freebuff's
// scripts/ci/test-with-guard.ts.
//
//   node scripts/test-guard.mjs core tui          # run, then compare to baseline
//   node scripts/test-guard.mjs --update core tui # re-record after deleting tests on purpose
//
// Runs each suite's own `test` script (output streams through unchanged) and
// fails when:
//   - the script failed,
//   - it ran no tests at all (a renamed dir or a broken glob prints "0 tests"
//     and exits 0),
//   - fewer tests ran, or fewer *.test.ts files exist, than the baseline in
//     .github/test-baselines.json records.
// Growth never fails; it prints that the baseline is stale. A floor nobody
// raises drifts far below reality and stops guarding, so re-record with
// --update from time to time (from a CI-equivalent run: counts include
// skipped tests, and a suite that skips locally reports differently).
// =============================================================================

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_FILE = path.join(ROOT, ".github", "test-baselines.json");
export const SUITES = { core: "apps/core", tui: "apps/tui" };

/**
 * node:test's summary counts. Node 22 prints TAP (`# tests N`) when stdout is
 * not a terminal, as in CI; newer Node prints `ℹ tests N`. The last summary
 * wins, since a suite prints exactly one at the end.
 */
export function parseSummary(output) {
  const count = (key) => {
    const all = [...output.matchAll(new RegExp(`^\\s*(?:ℹ|#) ${key} (\\d+)\\s*$`, "gm"))];
    return all.length ? Number(all[all.length - 1][1]) : undefined;
  };
  return { tests: count("tests"), fail: count("fail"), cancelled: count("cancelled") };
}

export function countTestFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.test\.tsx?$/.test(e.name)) n++;
    }
  };
  walk(dir);
  return n;
}

/** The verdict for one suite. `problems` empty = pass. */
export function judge(suite, observed, baseline) {
  const problems = [];
  const notes = [];
  if (observed.exitCode !== 0) problems.push(`${suite}: test script exited ${observed.exitCode}`);
  if (!observed.tests) problems.push(`${suite}: ran no tests (summary ${observed.tests === undefined ? "missing" : "says 0"})`);
  if (observed.files === 0) problems.push(`${suite}: no *.test.ts files found`);
  if (!baseline) {
    notes.push(`${suite}: no baseline recorded; run with --update`);
    return { problems, notes };
  }
  if (observed.tests !== undefined && observed.tests < baseline.tests) {
    problems.push(`${suite}: ${observed.tests} tests ran, baseline is ${baseline.tests} (${baseline.tests - observed.tests} missing)`);
  }
  if (observed.files < baseline.files) {
    problems.push(`${suite}: ${observed.files} test files, baseline is ${baseline.files}`);
  }
  if ((observed.tests ?? 0) > baseline.tests || observed.files > baseline.files) {
    notes.push(`${suite}: baseline is stale (${baseline.tests} tests / ${baseline.files} files); raise it with --update`);
  }
  return { problems, notes };
}

function runSuite(dir) {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["-C", dir, "test"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.on("close", (code) => resolve({ output: out, exitCode: code ?? 1 }));
  });
}

async function main() {
  const update = process.argv.includes("--update");
  const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (names.length === 0) throw new Error(`usage: test-guard.mjs [--update] ${Object.keys(SUITES).join(" ")}`);
  const baselines = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8")) : {};

  const problems = [];
  const notes = [];
  for (const name of names) {
    const dir = SUITES[name];
    if (!dir) throw new Error(`unknown suite "${name}"; known: ${Object.keys(SUITES).join(", ")}`);
    const run = await runSuite(dir);
    const summary = parseSummary(run.output);
    const observed = { ...summary, exitCode: run.exitCode, files: countTestFiles(path.join(ROOT, dir, "src")) };
    if (update) {
      if (run.exitCode !== 0 || !observed.tests) {
        throw new Error(`${name}: refusing to record a baseline from a failing or empty run`);
      }
      baselines[name] = { tests: observed.tests, files: observed.files };
      continue;
    }
    const v = judge(name, observed, baselines[name]);
    problems.push(...v.problems);
    notes.push(...v.notes);
    console.log(`\n[test-guard] ${name}: ${observed.tests ?? "?"} tests, ${observed.files} files`);
  }

  if (update) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baselines, null, 2) + "\n");
    console.log(`\n[test-guard] recorded ${path.relative(ROOT, BASELINE_FILE)}`);
    return;
  }
  for (const n of notes) console.log(`[test-guard] note: ${n}`);
  if (problems.length) {
    for (const p of problems) console.error(`[test-guard] FAIL: ${p}`);
    console.error(
      `[test-guard] Deleted tests on purpose? Re-record: node scripts/test-guard.mjs --update ${names.join(" ")}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[test-guard] ${err.message}`);
    process.exit(1);
  });
}
