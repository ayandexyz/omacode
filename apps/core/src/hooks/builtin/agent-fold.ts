// =============================================================================
// agent-fold — mirrors questions, permission requests, and turn ends into the
// agent-fold Omarchy top-bar plugin, and applies what the user picks there.
//
// Entirely inert unless the agent-fold bridge is running: every report first
// reads the bridge's `port.json` (port + token, loopback only) and does
// nothing when it is missing. FREECODE_AGENT_FOLD=0 opts out altogether.
//
// The pane keeps its own prompt. Whichever surface answers first wins —
// answerQuestion/answerPermission return false for the loser — and an answer
// given in the pane clears the bar through the `resolved` endpoints.
//
// Only `freecode serve` registers this. Subscribing to permission.asked is
// what makes askPermission wait for an answer instead of denying headlessly,
// so a one-shot `freecode run` must stay unsubscribed.
// =============================================================================

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import {
  bus,
  answerPermission,
  answerQuestion,
  type PermissionAskedEvent,
  type QuestionAskedEvent,
} from "../../bus/index.js";

export interface AgentFoldSession {
  /** The session's project directory; the bar groups by its basename. */
  cwd?: string;
  title?: string;
}

/** What the integration needs to know about a session, supplied by the server. */
export interface AgentFoldSessions {
  describe(sessionId: string): Promise<AgentFoldSession | null>;
  /** Text of the session's final assistant message, or null when there is none. */
  lastAssistantText(sessionId: string): Promise<string | null>;
}

export interface AgentFoldIntegration {
  /** A turn began, so the session is no longer waiting on the user. */
  turnStarted(sessionId: string): void;
}

interface Connection {
  port: number;
  token: string;
}

// The bridge holds a request for five minutes; wait a little longer so its
// own timeout, not ours, decides.
const REQUEST_WAIT_MS = 5 * 60 * 1000 + 5_000;
// Turn reports are advisory and must never hold up the session.
const EVENT_TIMEOUT_MS = 2000;
// Keep a tool's arguments out of the payload beyond what the bar displays.
const MAX_DETAIL_CHARS = 320;

const inert: AgentFoldIntegration = { turnStarted: () => undefined };

// =============================================================================
// Pure mappers — the HTTP contract with the bridge, testable without a socket
// =============================================================================

export function permissionToPayload(
  e: PermissionAskedEvent,
  session: AgentFoldSession | null,
): Record<string, unknown> {
  const args = e.args ?? {};
  const filePath = [args.file_path, args.filePath, args.path].find(
    (value): value is string => typeof value === "string",
  );
  const detail: Record<string, string> = {};
  if (typeof args.command === "string") detail.command = cap(args.command);
  if (filePath !== undefined) detail.file_path = cap(filePath);
  if (e.description) detail.description = cap(e.description);
  return {
    ...sessionFields(e.sessionId ?? "", session),
    hook_event_name: "PermissionRequest",
    request_id: e.requestId,
    tool_name: e.toolName,
    tool_input: detail,
  };
}

export function questionToPayload(
  e: QuestionAskedEvent,
  session: AgentFoldSession | null,
): Record<string, unknown> {
  return {
    ...sessionFields(e.sessionId ?? "", session),
    request_id: e.requestId,
    questions: e.questions.map((q) => ({
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      options: q.options.map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      })),
      multiple: q.multiple === true,
    })),
  };
}

/**
 * Read the bridge's permission verdict. Null — the bridge timed out, the user
 * picked "Ask in CLI", the pane answered first — leaves the pane prompt to the
 * human; it must never be confused with a deny.
 */
export function replyToDecision(reply: unknown): "allow" | "deny" | null {
  if (!isRecord(reply) || !isRecord(reply.hookSpecificOutput)) return null;
  const decision = reply.hookSpecificOutput.decision;
  if (!isRecord(decision)) return null;
  return decision.behavior === "allow" || decision.behavior === "deny"
    ? decision.behavior
    : null;
}

/**
 * The bridge answers with one label array per question; FreeCode's question
 * tool takes one string per question, so multi-select picks are joined.
 */
export function replyToAnswers(
  reply: unknown,
  questionCount: number,
): string[] | null {
  if (!isRecord(reply) || !Array.isArray(reply.answers)) return null;
  if (reply.answers.length !== questionCount) return null;
  const answers: string[] = [];
  for (const labels of reply.answers) {
    if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) {
      return null;
    }
    answers.push(labels.join(", "));
  }
  return answers;
}

function sessionFields(
  sessionId: string,
  session: AgentFoldSession | null,
): Record<string, string> {
  return {
    session_id: sessionId,
    ...(session?.cwd ? { cwd: session.cwd } : {}),
    ...(session?.title ? { session_title: session.title } : {}),
  };
}

function cap(value: string): string {
  return value.length > MAX_DETAIL_CHARS
    ? `${value.slice(0, MAX_DETAIL_CHARS - 3)}...`
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// =============================================================================
// Transport
// =============================================================================

function portFile(): string {
  const dataDir =
    process.env.AGENT_FOLD_DATA_DIR ??
    join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      "agent-fold",
    );
  return join(dataDir, "port.json");
}

/** Re-read per request: the bridge picks a new port and token on each start. */
async function readConnection(): Promise<Connection | null> {
  try {
    const parsed = JSON.parse(await readFile(portFile(), "utf-8")) as Connection;
    return Number.isInteger(parsed.port) && typeof parsed.token === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function post(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown | undefined> {
  const connection = await readConnection();
  if (!connection) return undefined;
  try {
    const res = await fetch(
      `http://127.0.0.1:${connection.port}/v1/providers/omacode/${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-fold-token": connection.token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return undefined;
    return await res.json().catch(() => undefined);
  } catch {
    // Swallowed on purpose: the bar is optional and must not fail a turn.
    return undefined;
  }
}

// =============================================================================
// Registration
// =============================================================================

export function registerAgentFold(
  sessions: AgentFoldSessions,
): AgentFoldIntegration {
  if (process.env.FREECODE_AGENT_FOLD === "0") return inert;

  const describe = (id: string | undefined) =>
    id ? sessions.describe(id).catch(() => null) : Promise.resolve(null);

  // Requests the bar may still be showing, so a pane answer can clear them.
  // The bus's answered/rejected events carry no session id.
  const shown = new Map<string, string>();

  const resolved = (kind: "permission" | "question", requestId: string) => {
    const sessionId = shown.get(requestId);
    if (sessionId === undefined) return;
    shown.delete(requestId);
    void post(
      `${kind}/resolved`,
      { session_id: sessionId, request_id: requestId },
      EVENT_TIMEOUT_MS,
    );
  };

  bus.subscribe("permission.asked", (e) => {
    if (!e.sessionId) return;
    const sessionId = e.sessionId;
    void (async () => {
      shown.set(e.requestId, sessionId);
      const decision = replyToDecision(
        await post(
          "permission",
          permissionToPayload(e, await describe(sessionId)),
          REQUEST_WAIT_MS,
        ),
      );
      shown.delete(e.requestId);
      if (decision === "allow") {
        // allow-once only: widening the grant is a choice made in the pane,
        // where the rule it would persist is visible.
        answerPermission(e.requestId, { decision: "allow-once" });
      } else if (decision === "deny") {
        answerPermission(e.requestId, { decision: "deny" });
      }
    })();
  });
  bus.subscribe("permission.answered", (e) => resolved("permission", e.requestId));
  bus.subscribe("permission.rejected", (e) => resolved("permission", e.requestId));

  bus.subscribe("question.asked", (e) => {
    if (!e.sessionId) return;
    const sessionId = e.sessionId;
    void (async () => {
      shown.set(e.requestId, sessionId);
      const answers = replyToAnswers(
        await post(
          "question",
          questionToPayload(e, await describe(sessionId)),
          REQUEST_WAIT_MS,
        ),
        e.questions.length,
      );
      shown.delete(e.requestId);
      if (answers) answerQuestion(e.requestId, answers);
    })();
  });
  bus.subscribe("question.answered", (e) => resolved("question", e.requestId));
  bus.subscribe("question.rejected", (e) => resolved("question", e.requestId));

  // A failed turn still ends in `done`; its last assistant text belongs to an
  // earlier turn, so it must not be reported as this one finishing.
  const failed = new Set<string>();
  bus.subscribe("session.error", (e) => failed.add(e.sessionId));

  // `done` ends every served turn: "Done" on a normal finish, "Interrupted"
  // for Ctrl+C, or the reason the loop stopped.
  bus.subscribe("stream", (e) => {
    if (e.event.type !== "done") return;
    const sessionId = e.sessionId;
    const outcome = e.event.content;
    if (failed.delete(sessionId)) return;
    void (async () => {
      // An interrupted turn is neither a question nor a finished report.
      if (outcome === "Interrupted") {
        await post(
          "resume",
          { hook_event_name: "UserPromptSubmit", session_id: sessionId },
          EVENT_TIMEOUT_MS,
        );
        return;
      }
      const message =
        (await sessions.lastAssistantText(sessionId).catch(() => null)) ??
        (outcome && outcome !== "Done" ? outcome : null);
      if (message === null) return;
      await post(
        "stop",
        {
          ...sessionFields(sessionId, await describe(sessionId)),
          hook_event_name: "Stop",
          last_assistant_message: message,
        },
        EVENT_TIMEOUT_MS,
      );
    })();
  });

  return {
    turnStarted: (sessionId) => {
      failed.delete(sessionId);
      void post(
        "resume",
        { hook_event_name: "UserPromptSubmit", session_id: sessionId },
        EVENT_TIMEOUT_MS,
      );
    },
  };
}
