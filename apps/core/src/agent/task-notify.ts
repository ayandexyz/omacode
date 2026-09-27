// =============================================================================
// Task notifications — how a background task tells the model it finished.
//
// Three kinds: a background sub-agent (`agent(run_in_background)`), a
// background shell (`bash(run_in_background)`) exiting, and a `monitor` — which
// also sends `event`s while it runs, one per batch of matching output lines.
//
// Claude Code's shape (ROADMAP "Background shell completion notifications"):
// the finished task becomes a `<task-notification>` user-role message. If the
// session is mid-turn it lands at the next tool-batch boundary (the steer
// path); if the session is idle, core starts a turn with it so the model
// reports back without the user having to ask.
//
// This module owns the message text and the on/off switch. Delivery needs the
// server's turn bookkeeping (activeLoops, the follow-up queue), so server.ts
// installs the sink; with no sink installed (tests, `freecode run`) a
// notification is dropped and `notifyTask` says so.
//
//   ~/.freecode/settings.json  or  <project>/.freecode/settings.json
//   { "tasks": { "notify": false } }
//
// Env: FREECODE_TASK_NOTIFY — "1" on, "0" off, beating the files.
//
// Defaults ON. Off means no turn is ever started without user input, and
// `agent(run_in_background)` then runs in the foreground instead: the
// notification is the only way a background agent's result reaches the model.
// A background shell still runs with it off — `bashoutput` can read it — the
// model just has to ask.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { envFlag } from "./signals/settings.js";

export interface TaskNotification {
  taskId: string;
  kind: "agent" | "shell" | "monitor";
  /** `event`: a monitor matched new output and is still running. */
  status: "completed" | "failed" | "killed" | "event";
  /** One line: what the task was (the agent's task, the shell's command). */
  summary: string;
  /** What the task produced — the text a foreground call would have returned. */
  result: string;
  /**
   * Re-checked at delivery: true once the notification would tell the model
   * nothing new (it drained the shell with bashoutput in the meantime). A
   * stale notification is dropped rather than buying a redundant turn.
   */
  isStale?: () => boolean;
}

type Sink = (
  sessionId: string,
  text: string,
  notice: string,
  isStale?: () => boolean,
) => void;

let sink: Sink | null = null;

/** Installed once by server.ts. Returns the previous sink (tests restore it). */
export function setTaskNotificationSink(next: Sink | null): Sink | null {
  const prev = sink;
  sink = next;
  return prev;
}

export function formatTaskNotification(n: TaskNotification): string {
  return [
    "<task-notification>",
    `<task-id>${n.taskId}</task-id>`,
    `<kind>${n.kind}</kind>`,
    `<status>${n.status}</status>`,
    `<summary>${n.summary}</summary>`,
    "<result>",
    n.result,
    "</result>",
    "</task-notification>",
    n.status === "event"
      ? "A monitor you started matched new output and is still running. Act on it if it matters; otherwise carry on."
      : "A background task you started has finished. Relay what matters to the user — they have not seen this result.",
  ].join("\n");
}

/** The one-liner the frontend shows where the notification arrived. */
export function taskNotice(n: TaskNotification): string {
  const what =
    n.kind === "agent" ? "Background agent" : n.kind === "monitor" ? "Monitor" : "Background command";
  const summary = n.summary.split("\n")[0]!;
  const short = summary.length > 80 ? `${summary.slice(0, 79)}…` : summary;
  if (n.status === "event") {
    const first = n.result.split("\n").find((l) => l.trim()) ?? "";
    return `${what} ${short}: ${first.length > 100 ? `${first.slice(0, 99)}…` : first}`;
  }
  return `${what} ${n.status}: ${short}`;
}

/** Hand a finished task to the session. False when nothing can deliver it. */
export function notifyTask(sessionId: string, n: TaskNotification): boolean {
  if (!sink) return false;
  sink(sessionId, formatTaskNotification(n), taskNotice(n), n.isStale);
  return true;
}

function readScope(filePath: string): boolean | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      tasks?: { notify?: unknown };
    };
    const v = parsed.tasks?.notify;
    return typeof v === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function taskNotificationsEnabled(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const fromEnv = envFlag(env.FREECODE_TASK_NOTIFY);
  if (fromEnv !== undefined) return fromEnv;
  for (const file of [
    path.join(projectRoot, ".freecode", "settings.json"),
    path.join(os.homedir(), ".freecode", "settings.json"),
  ]) {
    const v = readScope(file);
    if (v !== undefined) return v;
  }
  return true;
}
