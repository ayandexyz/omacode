// =============================================================================
// Keep the machine awake for the run's lifetime.
//
// A laptop that suspends at 00:30 ends the night silently: the process is
// frozen mid-request, and the morning report says the run is still "running"
// with a pid that has not moved. One child process, killed in every exit path.
//
// Deliberately simpler than gnhf's self re-exec under the inhibitor (which
// leaks its worktree on cleanup): a child we spawn is a child we can kill.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.9
// =============================================================================

import { spawn, type ChildProcess } from "child_process";
import { logger } from "../utils/logger.js";

export interface Inhibitor {
  /** What is holding the machine awake, for the preflight line. */
  readonly kind: "systemd-inhibit" | "caffeinate" | "none";
  release(): void;
}

const NONE: Inhibitor = { kind: "none", release: () => {} };

/**
 * Best-effort by design: a missing binary warns once and the run continues.
 * Refusing to start a night because the machine might sleep would be worse
 * than a night that might get cut short.
 */
export function inhibitSleep(enabled = true): Inhibitor {
  if (!enabled) return NONE;

  if (process.platform === "linux") {
    return spawnInhibitor("systemd-inhibit", [
      "--what=idle:sleep",
      "--who=freecode",
      "--why=overnight run",
      "--mode=block",
      "sleep",
      "infinity",
    ]);
  }
  if (process.platform === "darwin") {
    // -i: idle sleep only. -w <pid>: dies with us, so a killed run does not
    // leave the machine permanently awake.
    return spawnInhibitor("caffeinate", ["-i", "-w", String(process.pid)]);
  }

  logger.warn(
    `[night] sleep inhibition is not implemented on ${process.platform}; the machine may suspend mid-run`,
  );
  return NONE;
}

function spawnInhibitor(command: string, args: string[]): Inhibitor {
  let child: ChildProcess;
  try {
    child = spawn(command, args, { stdio: "ignore", detached: false });
  } catch {
    return warnMissing(command);
  }
  // ENOENT arrives asynchronously as an 'error' event, not as a throw.
  child.on("error", () => warnMissing(command));
  // The inhibitor must never be what keeps node alive at the end of the run.
  child.unref?.();

  return {
    kind: command as Inhibitor["kind"],
    release: () => {
      if (!child.killed) child.kill();
    },
  };
}

function warnMissing(command: string): Inhibitor {
  logger.warn(
    `[night] ${command} not available; the machine may suspend mid-run (use --no-inhibit to silence this)`,
  );
  return NONE;
}
