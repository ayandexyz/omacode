// =============================================================================
// `freecode night status|report|list|stop` — printing, nothing else.
//
// Every decision is in `autonomous/night-ops.ts`; this only formats and exits.
// Deliberately free of the backend: reading a finished run must not boot
// providers, MCP servers or the Effect runtime.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.11
// =============================================================================

import * as path from "path";

export const nightOps = {
  async status(id?: string): Promise<void> {
    const { findNightRun, statusLine } = await import(
      "../../autonomous/night-ops.js"
    );
    const { notesPath } = await import("../../autonomous/night-store.js");
    const run = findNightRun(id);
    if (!run?.night) return notFound(id);

    console.log(statusLine(run));
    console.log(`  objective: ${run.night.objective}`);
    if (run.status === "pending" && run.night.scheduledFor) {
      console.log(`  starts:    ${new Date(run.night.scheduledFor).toLocaleString()}`);
    }
    if (run.night.logPath) console.log(`  log:       ${run.night.logPath}`);
    if (run.night.stopReason) console.log(`  stopped:   ${run.night.stopReason}`);
    if (run.status === "crashed") {
      // The one status nobody chose: its process is gone and it never wrote an
      // ending. Say what to do about it rather than just naming it.
      console.log(
        `  the process (pid ${run.pid}) is gone — the run died rather than stopping.\n` +
          `  resume it:  git checkout ${run.night.branch} && freecode night`,
      );
    }
    if (run.night.uncommitted?.length) {
      console.log(`  uncommitted: ${run.night.uncommitted.length} paths in the tree`);
    }
    console.log(`  details:   ${path.dirname(notesPath(run.runId))}`);
  },

  async report(id?: string): Promise<void> {
    const { findNightRun, regenerateReport } = await import(
      "../../autonomous/night-ops.js"
    );
    const run = findNightRun(id);
    if (!run?.night) return notFound(id);
    // Regenerated from the logs every time, so a crashed run gets one too.
    process.stdout.write(await regenerateReport(run));
  },

  async list(): Promise<void> {
    const { listNightRuns, statusLine } = await import(
      "../../autonomous/night-ops.js"
    );
    const runs = listNightRuns();
    if (runs.length === 0) {
      console.log("No night runs yet. Start one: freecode night \"<objective>\" --until 07:00");
      return;
    }
    for (const run of runs) console.log(statusLine(run));
  },

  async stop(id?: string): Promise<void> {
    const { findNightRun, requestStop } = await import(
      "../../autonomous/night-ops.js"
    );
    const run = findNightRun(id);
    if (!run?.night) return notFound(id);
    if (!requestStop(run)) {
      console.log(`${run.runId} is not running (${run.status}) — nothing to stop.`);
      return;
    }
    // Checked at the next iteration boundary, never signalled: a process killed
    // mid-write is how manifests corrupt.
    console.log(
      run.status === "pending"
        ? `Asked ${run.runId} not to start. Its scheduled worker will exit.`
        : `Asked ${run.runId} to stop. It finishes the current iteration first, ` +
            `so its work is committed rather than discarded.`,
    );
  },
};

function notFound(id?: string): void {
  console.error(
    id ? `No night run matching "${id}".` : "No night runs yet.",
  );
  process.exitCode = 1;
}
