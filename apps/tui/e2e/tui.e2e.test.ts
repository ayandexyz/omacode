// End-to-end smoke tests for the TUI, driven in tmux. Borrowed from freebuff's
// e2e suite (startup, --version, slash commands, knowledge file, live turn).
// Run: pnpm -C apps/tui test:e2e. Needs tmux. The live turn also needs
// FREECODE_E2E_LIVE=1 and MINIMAX_API_KEY, and costs one small model call.
// Kept out of `src/`, so the unit suite and its CI test-count baseline are
// unaffected.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FATAL_MARKERS, REPO_ROOT, TuiSession, tmuxSkipReason } from "./tui-session.js";

const skip = tmuxSkipReason();
const TIMEOUT = 90_000;

function cli(...args: string[]): string {
  // A throwaway HOME: even --version must not create ~/.freecode state.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-e2e-cli-"));
  try {
    return execFileSync(path.join(REPO_ROOT, "node_modules", ".bin", "tsx"), [path.join(REPO_ROOT, "apps", "core", "src", "cli.ts"), ...args], {
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function assertHealthy(screen: string, s: TuiSession): void {
  for (const marker of FATAL_MARKERS) {
    assert.ok(!screen.includes(marker), `fatal marker "${marker}" on screen\n${screen}\n--- stderr ---\n${s.stderr()}`);
  }
}

/** Start, wait for boot, run the body, always clean up. */
async function withTui(
  body: (s: TuiSession) => Promise<void>,
  opts?: Parameters<typeof TuiSession.start>[0],
): Promise<void> {
  const s = TuiSession.start(opts);
  try {
    await s.waitForBoot();
    await body(s);
  } finally {
    s.stop();
  }
}

test("--version prints a semver and exits 0", () => {
  assert.match(cli("--version").trim(), /^\d+\.\d+\.\d+/);
});

test("--help shows usage", () => {
  const out = cli("--help");
  assert.match(out, /--version/);
  assert.match(out, /--help/);
});

test("boots with no model configured: welcome, picker, no fatal output", { skip, timeout: TIMEOUT }, async () => {
  await withTui(async (s) => {
    const screen = await s.waitFor("No model is configured yet");
    assertHealthy(screen, s);
    assert.equal(s.exitCode(), null, "the TUI must still be running");
  });
});

test("/ on an empty prompt opens the command menu", { skip, timeout: TIMEOUT }, async () => {
  await withTui(async (s) => {
    await s.dismissPicker();
    s.type("/");
    const screen = await s.waitFor(/Model[\s\S]*Session[\s\S]*help[\s\S]*exit/);
    assertHealthy(screen, s);
  });
});

test("/help lists the commands", { skip, timeout: TIMEOUT }, async () => {
  await withTui(async (s) => {
    await s.dismissPicker();
    await s.submit("/help");
    const screen = await s.waitFor("/exit** - Exit");
    for (const cmd of ["/model", "/resume", "/compact", "/clear"]) assert.ok(screen.includes(cmd), cmd);
    assertHealthy(screen, s);
  });
});

test("/exit quits with code 0 and nothing on stderr", { skip, timeout: TIMEOUT }, async () => {
  await withTui(async (s) => {
    await s.dismissPicker();
    await s.submit("/exit");
    assert.equal(await s.waitForExit(), 0);
    assert.equal(s.stderr(), "");
  });
});

test("Ctrl+C once warns; twice within the window exits 0", { skip, timeout: TIMEOUT }, async () => {
  await withTui(async (s) => {
    await s.dismissPicker();
    s.keys("C-c");
    await s.waitFor("Press Ctrl+C again to exit");
    assert.equal(s.exitCode(), null, "one Ctrl+C must not exit");
    // Both presses in one tmux call: the double-press window is 800ms.
    s.keys("C-c", "C-c");
    assert.equal(await s.waitForExit(), 0);
    assertHealthy(s.capture(), s);
  });
});

const live = process.env.FREECODE_E2E_LIVE === "1" && process.env.MINIMAX_API_KEY;
test(
  "live turn: the model answers from AGENTS.md through the real TUI",
  { skip: skip || (live ? false : "set FREECODE_E2E_LIVE=1 and MINIMAX_API_KEY"), timeout: 180_000 },
  async () => {
    const keyword = "nebula-orchid-731";
    await withTui(
      async (s) => {
        await s.submit("What is the project keyword? Reply with only the keyword.");
        const screen = await s.waitFor(keyword, 150_000);
        assertHealthy(screen, s);
      },
      {
        files: { "AGENTS.md": `When asked for the project keyword, respond with exactly: ${keyword}\n` },
        config: { providers: { minimax: { model: "MiniMax-M3" } }, current: { provider: "minimax", model: "MiniMax-M3" } },
        env: { MINIMAX_API_KEY: process.env.MINIMAX_API_KEY! },
      },
    );
  },
);
