// =============================================================================
// Background ledger — which background tasks a session has running, on disk.
//
// Background sub-agents, shells and monitors live in core's memory and die
// with it: a crash, the TUI's supervisor restarting core, or `freecode` being
// quit. Before this, their results simply never arrived and nothing said why —
// the model went on waiting for a notification that could not come.
//
// Every start is recorded here with the recording process's pid, and removed
// only when the task FINISHES ON ITS OWN while its session is live. When the
// session ends instead — switched away, stopped, or the process exiting — the
// tasks it kills are marked `stopped` rather than erased (killing them fires
// the normal exit path, which would otherwise erase the evidence). On
// `session.resume`, a stopped entry, or one left by a DIFFERENT process, is
// reported as lost. The pid is what keeps a same-core resume from flagging
// tasks that are still running.
//
// Only root sessions record: a subagent's own shells die with the subagent,
// and the subagent itself is recorded under its parent.
//
//   ~/.freecode/background/<sessionId>.json   (FREECODE_BACKGROUND_DIR overrides)
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface LedgerEntry {
  id: string;
  kind: "agent" | "shell" | "monitor";
  /** The task description or command, for the "lost" message. */
  summary: string;
  startedAt: number;
  /** Process that ran it — the one whose exit would have killed it. */
  pid: number;
  /** Set when its session ended with it still running (the end reason). */
  stopped?: string;
}

/** Sessions ending right now: their kills must not erase entries. */
const ending = new Set<string>();
/** The process is going down: every kill from here on is a loss. */
let exiting = false;

function ledgerDir(): string {
  return (
    process.env.FREECODE_BACKGROUND_DIR ??
    path.join(os.homedir(), ".freecode", "background")
  );
}

function fileFor(sessionId: string): string {
  // Session ids are uuids; keep anything else from escaping the directory.
  return path.join(ledgerDir(), `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}

function read(sessionId: string): LedgerEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(sessionId), "utf-8"));
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

function write(sessionId: string, entries: LedgerEntry[]): void {
  try {
    if (entries.length === 0) {
      fs.rmSync(fileFor(sessionId), { force: true });
      return;
    }
    fs.mkdirSync(ledgerDir(), { recursive: true });
    const file = fileFor(sessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries));
    fs.renameSync(tmp, file);
  } catch {
    // Best effort: losing the ledger costs the "lost" message, never a task.
  }
}

export function recordStart(
  sessionId: string,
  entry: Omit<LedgerEntry, "pid" | "startedAt">,
): void {
  const entries = read(sessionId).filter(
    (e) => !(e.id === entry.id && e.pid === process.pid),
  );
  entries.push({ ...entry, startedAt: Date.now(), pid: process.pid });
  write(sessionId, entries);
}

export function recordEnd(sessionId: string, id: string): void {
  // A kill caused by the session or the process going away is not a task
  // finishing — the entry stays, marked, to be reported on resume.
  if (exiting || ending.has(sessionId)) return;
  const entries = read(sessionId);
  const kept = entries.filter((e) => !(e.id === id && e.pid === process.pid));
  if (kept.length !== entries.length) write(sessionId, kept);
}

/**
 * Entries a previous core process left behind — tasks that died with it.
 * Removes them from the ledger, so each loss is reported once. This process's
 * own entries are live and stay.
 */
export function takeOrphans(sessionId: string): LedgerEntry[] {
  const entries = read(sessionId);
  const lost = (e: LedgerEntry) => e.pid !== process.pid || e.stopped !== undefined;
  const orphans = entries.filter(lost);
  if (orphans.length > 0) {
    write(
      sessionId,
      entries.filter((e) => !lost(e)),
    );
  }
  return orphans;
}

/**
 * The session is ending (called first thing in endSession): mark this
 * process's still-running entries stopped, and keep the kills that follow from
 * erasing them.
 */
export function markSessionEnding(sessionId: string, reason: string): void {
  ending.add(sessionId);
  const entries = read(sessionId);
  if (entries.some((e) => e.pid === process.pid && e.stopped === undefined)) {
    write(
      sessionId,
      entries.map((e) =>
        e.pid === process.pid && e.stopped === undefined ? { ...e, stopped: reason } : e,
      ),
    );
  }
}

/** The session is live again (resume): record and erase normally. */
export function reviveLedger(sessionId: string): void {
  ending.delete(sessionId);
}

/** Process teardown on a path that skips endSession (the sync exit backstop). */
export function markProcessExiting(): void {
  exiting = true;
}

/** The session was deleted: nothing will ever resume it. */
export function clearLedger(sessionId: string): void {
  write(sessionId, []);
}

/** The notification text for tasks lost in a restart. */
export function lostTasksNotification(orphans: LedgerEntry[]): string {
  const lines = orphans.map(
    (e) =>
      `- ${e.kind} ${e.id}: ${e.summary.split("\n")[0]!.slice(0, 200)} (started ${new Date(e.startedAt).toISOString()})`,
  );
  return [
    "<task-notification>",
    "<status>lost</status>",
    "<summary>Background tasks were stopped before they finished</summary>",
    "<result>",
    "These were stopped when this session was last closed or FreeCode exited, while they were still running. Their results are lost and no further notification will arrive for them:",
    ...lines,
    "</result>",
    "</task-notification>",
    "Tell the user which tasks were lost. Re-run one only if the user's current request needs it or they ask you to.",
  ].join("\n");
}
