// =============================================================================
// The two workspace steps a judged trial adds: dependency setup before the
// agent, final checks after it. Spec §4.4 steps 1 and 4. On the host by
// default; inside the agent's image on an --isolate run (§4.7), so the native
// modules are built for the Node that will load them.
// =============================================================================

import { spawnSync } from "child_process";
import {
  checkArgv,
  removeContainer,
  setupArgv,
  type ToolContainer,
} from "../isolate/docker.js";
import type { FinalCheckOutput } from "./judge-prompt.js";

/** Set on an --isolate run: setup and checks then run in the agent's image (§4.7). */
export interface InContainer {
  tool: ToolContainer;
  /** Host dir for the containers' pnpm store (setup only). */
  storeDir: string;
}

/** Theirs: 60 minutes per agent run. */
export const JUDGED_TIMEOUT_MS = 60 * 60 * 1000;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Ours. A full core test run prints thousands of lines, and every byte goes
 * into a ~118K-token judge prompt. The tail is kept because that is where
 * test runners and tsc put the verdict.
 */
export const CHECK_OUTPUT_CHARS = 20_000;

export function tail(text: string, max = CHECK_OUTPUT_CHARS): string {
  return text.length <= max ? text : `[… ${text.length - max} earlier characters dropped]\n${text.slice(-max)}`;
}

function exec(argv: string[], cwd: string, timeoutMs: number, container?: string) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 256 << 20,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Killing the docker client does not stop its container.
  if (container && r.error) removeContainer(container);
  return r;
}

function run(kind: "setup" | "check", command: string, cwd: string, timeoutMs: number, c?: InContainer) {
  if (!c) return exec(["sh", "-c", command], cwd, timeoutMs);
  const argv = kind === "setup" ? setupArgv(c.tool, c.storeDir, command) : checkArgv(c.tool, command);
  return exec(argv, cwd, timeoutMs, c.tool.name);
}

/** Throws with the output tail: a trial whose tree cannot be set up is a harness error. */
export function runSetup(command: string, cwd: string, container?: InContainer): void {
  const r = run("setup", command, cwd, SETUP_TIMEOUT_MS, container);
  if (r.status !== 0) {
    throw new Error(`setup "${command}" failed (${r.status ?? r.signal}): ${tail(r.stderr || r.stdout, 300)}`);
  }
}

export function runFinalChecks(commands: string[], cwd: string, container?: InContainer): FinalCheckOutput[] {
  return commands.map((command, i) => {
    const r = run(
      "check",
      command,
      cwd,
      CHECK_TIMEOUT_MS,
      container && { ...container, tool: { ...container.tool, name: `${container.tool.name}-${i}` } },
    );
    return {
      command,
      // A timeout or signal has no exit status; -1 keeps it a failure the judge sees.
      exitCode: r.status ?? -1,
      stdout: tail(r.stdout ?? ""),
      stderr: tail((r.stderr ?? "") + (r.error ? `\n${r.error.message}` : "")),
    };
  });
}
