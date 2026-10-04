// =============================================================================
// Worker entry for the codemode sandbox (spec 2026-10-05-codemode.md §3).
// pi-codemode runs QuickJS in a worker thread and, by default, finds its own
// worker file next to itself on disk. Inside `bun build --compile` that file
// does not exist, so build-bun.mjs embeds THIS file as a second entrypoint and
// runtime.ts points the sandbox at it.
// =============================================================================

import "@earendil-works/pi-codemode/worker";
