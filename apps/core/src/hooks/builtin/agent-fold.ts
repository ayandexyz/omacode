// =============================================================================
// agent-fold — mirrors questions, permission requests, and turn ends into the
// agent-fold Omarchy top-bar plugin, and applies what the user picks there.
//
// Entirely inert unless the agent-fold bridge is running: every report first
// reads the bridge's `port.json` (port + token, loopback only) and does
// nothing when it is missing. FREECODE_AGENT_FOLD=0 opts out altogether.
//
// A crashed bridge leaves `port.json` behind and frees its port for any local
// user, so the file alone proves nothing. Before the token or any request
// data is written, the server end of the socket must belong to this uid
// (`/proc/net/tcp`), and a reply only counts if it carries the bridge's HMAC
// over this request's nonce, keyed with `serverKey` from `port.json` (which
// never goes over the wire). Anything unverifiable is treated as no bridge.
//
// The pane keeps its own prompt. Whichever surface answers first wins —
// answerQuestion/answerPermission return false for the loser — and an answer
// given in the pane clears the bar through the `resolved` endpoints.
//
// Only `freecode serve` registers this. Subscribing to permission.asked is
// what makes askPermission wait for an answer instead of denying headlessly,
// so a one-shot `freecode run` must stay unsubscribed.
// =============================================================================

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { request as httpRequest } from "http";
import { connect, type Socket } from "net";
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
  serverKey: string;
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

// Bridges since Hommies 0.2.2 write port.json only under `hommies`;
// AGENT_FOLD_DATA_DIR still works as an override.
function portFile(): string {
  const dataDir =
    process.env.HOMMIES_DATA_DIR ??
    process.env.AGENT_FOLD_DATA_DIR ??
    join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      "hommies",
    );
  return join(dataDir, "port.json");
}

/**
 * Re-read per request: the bridge picks a new port and token on each start.
 * A file without `serverKey` (a bridge older than 0.1.6) cannot be verified,
 * so it counts as no bridge.
 */
async function readConnection(): Promise<Connection | null> {
  try {
    const parsed = JSON.parse(await readFile(portFile(), "utf-8")) as Connection;
    return Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      parsed.port < 65536 &&
      typeof parsed.token === "string" &&
      typeof parsed.serverKey === "string" &&
      parsed.serverKey.length > 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

const NONCE_HEADER = "x-hommies-nonce";
const PROOF_HEADER = "x-hommies-proof";
// Replies are small JSON; anything bigger is not the bridge.
const MAX_REPLY_BYTES = 1024 * 1024;

/** The bridge's HMAC over nonce, status, and body (Hommies `bridge-identity.ts`). */
export function validProof(
  serverKey: string,
  nonce: string,
  status: number,
  body: string,
  proof: unknown,
): boolean {
  if (typeof proof !== "string") return false;
  const expected = Buffer.from(
    createHmac("sha256", serverKey)
      .update(`${nonce}\n${status}\n${body}`)
      .digest("base64url"),
  );
  const actual = Buffer.from(proof);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * The uid that owns the server end of the loopback connection from
 * `localPort` to `port`, from a `/proc/net/tcp` table, or null when the table
 * has no such row. An accepted socket keeps its listener's uid.
 */
export function serverSocketUid(
  table: string,
  port: number,
  localPort: number,
): number | null {
  // 127.0.0.1 as /proc/net/tcp prints it, on little- and big-endian machines.
  const hex = (p: number) => p.toString(16).toUpperCase().padStart(4, "0");
  const loopback = ["0100007F", "7F000001"];
  const server = loopback.map((a) => `${a}:${hex(port)}`);
  const client = loopback.map((a) => `${a}:${hex(localPort)}`);
  for (const line of table.split("\n").slice(1)) {
    const [, local, remote, , , , , uid] = line.trim().split(/\s+/);
    if (local === undefined || remote === undefined || uid === undefined) continue;
    if (server.includes(local) && client.includes(remote) && /^\d+$/.test(uid)) {
      return Number(uid);
    }
  }
  return null;
}

/** Resolves only once the server end of the socket is known to be this user's. */
function connectToOwnBridge(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      try {
        const uid = typeof process.getuid === "function" ? process.getuid() : null;
        const owner =
          socket.localPort === undefined
            ? null
            : serverSocketUid(readFileSync("/proc/net/tcp", "utf8"), port, socket.localPort);
        if (uid === null || owner !== uid) {
          throw new Error("the bridge port is not held by this user");
        }
        resolve(socket);
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
  });
}

async function post(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown | undefined> {
  const connection = await readConnection();
  if (!connection) return undefined;
  try {
    const nonce = randomBytes(24).toString("base64url");
    const payload = JSON.stringify(body);
    const socket = await connectToOwnBridge(connection.port);
    const text = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: connection.port,
          path: `/v1/providers/omacode/${path}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            "x-agent-fold-token": connection.token,
            [NONCE_HEADER]: nonce,
          },
          // The verified socket, not a pooled or fresh one.
          createConnection: () => socket,
        },
        (res) => {
          let reply = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            reply += chunk;
            if (reply.length > MAX_REPLY_BYTES) req.destroy(new Error("reply too large"));
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (!validProof(connection.serverKey, nonce, status, reply, res.headers[PROOF_HEADER])) {
              reject(new Error("bridge reply could not be verified"));
            } else if (status < 200 || status >= 300) {
              reject(new Error(`bridge answered ${status}`));
            } else {
              resolve(reply);
            }
          });
          res.on("error", reject);
        },
      );
      const timer = setTimeout(() => req.destroy(new Error("bridge request timed out")), timeoutMs);
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end(payload);
    });
    return JSON.parse(text) as unknown;
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
