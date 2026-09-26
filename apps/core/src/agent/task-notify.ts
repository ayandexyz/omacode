// =============================================================================
// Task notifications — how a background task tells the model it finished.
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
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { envFlag } from "./signals/settings.js";

export interface TaskNotification {
  taskId: string;
  kind: "agent";
  status: "completed" | "failed" | "killed";
  /** One line: what the task was. */
  summary: string;
  /** What the task produced — the text a foreground call would have returned. */
  result: string;
}

type Sink = (sessionId: string, text: string, notice: string) => void;

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
    "A background task you started has finished. Relay what matters to the user — they have not seen this result.",
  ].join("\n");
}

/** The one-liner the frontend shows where the notification arrived. */
export function taskNotice(n: TaskNotification): string {
  const what = n.kind === "agent" ? "Background agent" : "Background task";
  return `${what} ${n.status}: ${n.summary}`;
}

/** Hand a finished task to the session. False when nothing can deliver it. */
export function notifyTask(sessionId: string, n: TaskNotification): boolean {
  if (!sink) return false;
  sink(sessionId, formatTaskNotification(n), taskNotice(n));
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
