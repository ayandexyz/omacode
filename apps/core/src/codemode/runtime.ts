// =============================================================================
// Codemode runtime — where the QuickJS wasm and the sandbox worker live
// (spec 2026-10-05-codemode.md §3).
//
// From the repo (tsx or node dist/) both are pi-codemode's defaults: the wasm
// from the installed quickjs-wasi package, the worker next to pi-codemode.
// The compiled binary has neither on disk, so build-bun.mjs:
//   - ships `quickjs.wasm` as a loose file beside the executable (like
//     `web-ui/` and the onnx libs — `bun build --compile` bundles JS, not
//     assets), and
//   - embeds `codemode/worker.js` as an extra entrypoint. Bun roots embedded
//     files at the entrypoints' common ancestor — `apps/` (entry.ts is in
//     apps/tui) — under its virtual fs, `/$bunfs/root` (`B:\~BUN\root` on
//     Windows). A relative specifier does NOT resolve there (measured with
//     node:worker_threads, Bun 1.3.14); an absolute one does. The bundled code
//     itself lives at that root, so the root is the dirname of its own
//     `import.meta.url`, which keeps this platform-neutral.
// =============================================================================

import * as path from "path";
import { fileURLToPath } from "url";
import {
  CodemodeSandbox,
  loadQuickJSWasm,
  type CodemodeSandboxOptions,
} from "@earendil-works/pi-codemode";

/** The worker inside the compiled binary, relative to the embedded root (`apps/`). */
export const BUNDLED_WORKER_PATH = "core/dist/codemode/worker.js";
export const BUNDLED_WASM_FILE = "quickjs.wasm";

export interface CodemodeRuntime {
  wasmPath?: string;
  workerUrl?: string;
}

/** Pure, for tests: undefined fields fall back to pi-codemode's defaults. */
export function resolveCodemodeRuntime(
  bundled: boolean,
  execPath: string,
  moduleUrl: string,
): CodemodeRuntime {
  if (!bundled) return {};
  return {
    wasmPath: path.join(path.dirname(execPath), BUNDLED_WASM_FILE),
    workerUrl: path.join(path.dirname(fileURLToPath(moduleUrl)), BUNDLED_WORKER_PATH),
  };
}

/** A sandbox wired for whichever runtime this process is. */
export function createCodemodeSandbox(
  options: Omit<CodemodeSandboxOptions, "wasm" | "workerUrl">,
): CodemodeSandbox {
  const runtime = resolveCodemodeRuntime(
    process.env.FREECODE_BUNDLED === "1",
    process.execPath,
    import.meta.url,
  );
  return new CodemodeSandbox({
    ...options,
    wasm: loadQuickJSWasm(runtime.wasmPath),
    ...(runtime.workerUrl ? { workerUrl: runtime.workerUrl } : {}),
  });
}
