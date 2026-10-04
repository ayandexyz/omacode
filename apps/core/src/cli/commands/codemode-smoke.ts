// =============================================================================
// `freecode __codemode-smoke` — hidden. Proves the codemode sandbox (QuickJS
// wasm + worker thread) runs in THIS build, by executing one script that calls
// one host tool. Exists for the compiled binary, where the wasm and worker are
// not where pi-codemode looks by default (spec 2026-10-05-codemode.md §3);
// `scripts/smoke-codemode-binary.mjs` runs it against dist/freecode-bun.
// =============================================================================

import type { CommandModule } from "yargs";
import { createCodemodeSandbox } from "../../codemode/runtime.js";

export const CODEMODE_SMOKE_OK = "FREECODE_CODEMODE_SMOKE_OK";

export const codemodeSmokeCommand: CommandModule = {
  command: "__codemode-smoke",
  describe: false,
  handler: async () => {
    const sandbox = createCodemodeSandbox({
      timeoutMs: 30_000,
      tools: [
        {
          name: "echo",
          execute: (args) => (args as { value: string }).value,
        },
      ],
    });
    try {
      const result = await sandbox.execute(
        `const v = await tools.echo({ value: "${CODEMODE_SMOKE_OK}" }); return v;`,
      );
      if (result.ok && result.value === CODEMODE_SMOKE_OK) {
        console.log(CODEMODE_SMOKE_OK);
        return;
      }
      console.error(
        "codemode smoke failed:",
        result.ok ? `unexpected value ${JSON.stringify(result.value)}` : result.error,
      );
      process.exitCode = 1;
    } finally {
      await sandbox.close();
    }
  },
};
