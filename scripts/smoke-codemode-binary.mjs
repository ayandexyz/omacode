#!/usr/bin/env node
// =============================================================================
// smoke-codemode-binary.mjs — run a compiled freecode binary's hidden
// `__codemode-smoke` command from a directory OUTSIDE the repo, so a wasm or
// worker that only resolves from the monorepo fails here and not on a user's
// machine (spec 2026-10-05-codemode.md §3).
// Usage: node scripts/smoke-codemode-binary.mjs [binary]
//        (default apps/tui/dist/freecode-bun)
// =============================================================================

import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const MARKER = "FREECODE_CODEMODE_SMOKE_OK";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = resolve(process.argv[2] ?? resolve(repoRoot, "apps/tui/dist/freecode-bun"));

const run = spawnSync(binary, ["__codemode-smoke"], {
  cwd: tmpdir(),
  encoding: "utf-8",
  timeout: 60_000,
});
if (run.status === 0 && run.stdout.includes(MARKER)) {
  console.log(`[codemode-smoke] ok: ${binary}`);
} else {
  console.error(`[codemode-smoke] FAILED: ${binary} (exit ${run.status})`);
  console.error(run.stdout, run.stderr, run.error ?? "");
  process.exit(1);
}
