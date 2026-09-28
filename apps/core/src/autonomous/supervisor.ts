// =============================================================================
// Detached/scheduled night-run supervisor.
//
// The worker is the same CLI invocation with one environment marker. That keeps
// provider, MCP and hook bootstrapping wholly inside the child, as required by
// the process boundary. stdout/stderr go to the run directory for post-mortem.
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { branchSlug } from "./git.js";
import { runDir, updateManifest, writeManifest } from "./run-store.js";
import { DEFAULT_RUN_LIMITS, EMPTY_USAGE } from "./types.js";

export const NIGHT_WORKER_ENV = "FREECODE_NIGHT_WORKER";
export const NIGHT_RUN_ID_ENV = "FREECODE_NIGHT_RUN_ID";
export const NIGHT_SCHEDULED_FOR_ENV = "FREECODE_NIGHT_SCHEDULED_FOR";

export interface DetachedNightInput {
  objective: string;
  projectPath: string;
  scheduledFor?: number;
  provider?: string;
  model?: string;
  maxIterations?: number;
  maxUsd?: number;
  verify?: string;
  stopWhen?: string;
  sandbox: boolean;
  commitStyle: "night" | "conventional";
}

export interface DetachedInvocation {
  command: string;
  args: string[];
}

export function launchDetachedNight(
  input: DetachedNightInput,
  invocation: DetachedInvocation = currentInvocation(),
): {
  runId: string;
  pid: number;
  logPath: string;
} {
  const runId = randomUUID().slice(0, 8);
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "worker.log");
  const fd = fs.openSync(logPath, "a");
  const branch = `night/${branchSlug(input.objective)}`;
  // Write before spawning: a fast child must never have its live manifest
  // overwritten by the parent's provisional one.
  writeManifest({
    runId,
    status: "pending",
    createdAt: Date.now(),
    projectPath: input.projectPath,
    provider: input.provider ?? "pending",
    model: input.model,
    limits: {
      ...DEFAULT_RUN_LIMITS,
      ...(input.maxIterations !== undefined ? { maxTurns: input.maxIterations } : {}),
      ...(input.maxUsd !== undefined ? { maxUsd: input.maxUsd } : {}),
    },
    usage: EMPTY_USAGE,
    turns: 0,
    verifyCommand: input.verify ?? "",
    taskCardCount: 0,
    night: {
      objective: input.objective,
      branch,
      stopWhen: input.stopWhen,
      verifyCommand: input.verify,
      iterations: 0,
      commits: [],
      waitedMs: 0,
      fallbackIterations: [],
      detached: true,
      scheduledFor: input.scheduledFor,
      logPath,
      sandbox: input.sandbox,
      commitStyle: input.commitStyle,
    },
  });
  const child = spawn(invocation.command, invocation.args, {
    cwd: input.projectPath,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      [NIGHT_WORKER_ENV]: "1",
      [NIGHT_RUN_ID_ENV]: runId,
      ...(input.scheduledFor !== undefined
        ? { [NIGHT_SCHEDULED_FOR_ENV]: String(input.scheduledFor) }
        : {}),
    },
  });
  fs.closeSync(fd);
  if (!child.pid) throw new Error("detached night worker did not receive a pid");
  child.unref();
  updateManifest(runId, (manifest) => ({ ...manifest, pid: child.pid }));
  return { runId, pid: child.pid, logPath };
}

export function currentInvocation(): DetachedInvocation {
  const first = process.argv[1];
  if (first && /\.(?:[cm]?js|tsx?)$/.test(first)) {
    return {
      command: process.execPath,
      args: [...process.execArgv, first, ...process.argv.slice(2)],
    };
  }
  // A single-file executable (Bun/Node SEA): execPath is the CLI itself.
  return { command: process.execPath, args: process.argv.slice(1) };
}
