// =============================================================================
// Reading a night afterwards: status, report, list.
//
// All of it folds the run directory — manifest + the two jsonl logs — so it
// works on a run this process never started, and on one that died mid-iteration.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.11, §5.4
// =============================================================================

import * as fs from "fs";
import { readDecisions, readIterations, reportPathFor } from "./night-store.js";
import { renderReport, duration } from "./report.js";
import { listRuns, readManifest, updateManifest } from "./run-store.js";
import type { RunManifest } from "./types.js";

/**
 * Whether the process that owns a run is still alive.
 *
 * `kill(pid, 0)` tests existence without signalling. The pid could have been
 * recycled onto an unrelated process, which would read as "still running" —
 * accepted: the alternative is a liveness handshake for a foreground command
 * whose terminal the user can simply look at.
 */
export function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A run whose manifest says `running` but whose pid is gone did not stop, it
 * DIED — terminal closed, OOM, crash. Recorded on read so `status` and `list`
 * agree, and so a later resume knows what it is resuming.
 */
export function reconcileCrashed(manifest: RunManifest): RunManifest {
  if (
    (manifest.status !== "running" && manifest.status !== "pending") ||
    pidAlive(manifest.pid)
  )
    return manifest;
  const crashed: RunManifest = {
    ...manifest,
    status: "crashed",
    endedAt: manifest.endedAt ?? Date.now(),
  };
  updateManifest(manifest.runId, () => crashed);
  return crashed;
}

/** Night runs only, newest first, with dead ones marked crashed. */
export function listNightRuns(): RunManifest[] {
  return listRuns()
    .filter((m) => m.night !== undefined)
    .map(reconcileCrashed);
}

/** The newest night run, or the one whose branch matches. */
export function findNightRun(idOrBranch?: string): RunManifest | undefined {
  const runs = listNightRuns();
  if (!idOrBranch) return runs[0];
  return (
    runs.find((m) => m.runId === idOrBranch) ??
    runs.find((m) => m.night?.branch === idOrBranch)
  );
}

export function statusLine(manifest: RunManifest): string {
  const night = manifest.night;
  if (!night) return `${manifest.runId}  (not a night run)`;
  const elapsed =
    manifest.startedAt !== undefined
      ? duration((manifest.endedAt ?? Date.now()) - manifest.startedAt)
      : "—";
  const parts = [
    manifest.runId.padEnd(10),
    manifest.status.padEnd(9),
    `${night.iterations} it`.padEnd(6),
    `${night.commits.length} commit${night.commits.length === 1 ? "" : "s"}`.padEnd(10),
    elapsed.padEnd(7),
    night.waitedMs > 0 ? `waited ${duration(night.waitedMs)}` : "",
  ];
  return `${parts.join(" ")}  ${night.branch}`;
}

/**
 * Regenerate the report from the logs and write it.
 *
 * The run writes one at exit; this is how a CRASHED run still gets one, and
 * why nothing in `report.ts` reads anything but its input.
 */
export function buildReport(
  manifest: RunManifest,
  extras: { diffstat?: string; subjects?: Record<string, string> } = {},
): string {
  const night = manifest.night;
  if (!night) throw new Error(`run ${manifest.runId} is not a night run`);
  const markdown = renderReport({
    runId: manifest.runId,
    night,
    status: manifest.status,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    provider: manifest.provider,
    model: manifest.model,
    usd: manifest.usage.usd,
    records: readIterations(manifest.runId),
    decisions: readDecisions(manifest.runId),
    ...extras,
  });
  fs.writeFileSync(reportPathFor(manifest.runId), markdown, "utf-8");
  return markdown;
}

/** Ask a running night to stop at the next iteration boundary. */
export function requestStop(manifest: RunManifest): boolean {
  if (manifest.status !== "running" && manifest.status !== "pending") return false;
  return (
    updateManifest(manifest.runId, (m) => ({ ...m, cancelRequested: true })) !==
    null
  );
}

export function readNightManifest(runId: string): RunManifest | undefined {
  const m = readManifest(runId);
  return m ? reconcileCrashed(m) : undefined;
}
