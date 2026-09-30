// =============================================================================
// Claude Code session import — copy a `~/.claude` transcript into a FreeCode
// session so it can be resumed and continued (jcode's approach, see
// jcode-base/src/import.rs).
//
// - Stable id `cc_<claudeId>`: importing twice returns the existing session,
//   which by then may hold FreeCode-only turns. Never re-import over it.
// - Flattened to text: Claude Code's tool names/args are not FreeCode's, so a
//   replayed tool call could be rejected by the provider or confuse the model.
//   Each tool_use is rendered inline with its paired tool_result instead.
// - Tail-capped: only the last IMPORT_MAX_MESSAGES are kept, behind a note
//   saying how many were omitted.
// - Read-only on `~/.claude`.
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";
import type { SerializedMessage } from "@thisisayande/freecode-shared";
import type { SessionStore } from "../session/store.js";
import {
  decodeProjectSlug,
  extractTitleFromJsonl,
  resolveTranscriptPath,
} from "./scanner.js";

export const IMPORT_MAX_MESSAGES = 160;
/** Per tool call: args and result are cut to this many chars. */
const TOOL_TEXT_MAX = 2000;

export function importedSessionId(claudeId: string): string {
  return `cc_${claudeId}`;
}

interface Entry {
  cwd?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

type Block = Record<string, unknown>;

function cut(s: string): string {
  return s.length <= TOOL_TEXT_MAX
    ? s
    : `${s.slice(0, TOOL_TEXT_MAX)}\n[… ${s.length - TOOL_TEXT_MAX} chars omitted]`;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as Block).text === "string" ? (c as Block).text : ""))
    .join("\n");
}

/** One entry → its text, with tool calls inlined against `results`. */
function entryText(content: unknown, results: Map<string, string>): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const b of content as Block[]) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      out.push(b.text.trim());
    } else if (b.type === "tool_use") {
      const args = cut(JSON.stringify(b.input ?? {}));
      const res = results.get(String(b.id));
      out.push(
        `[Claude Code tool call: ${String(b.name)} ${args}]` +
          (res !== undefined ? `\n[result]\n${cut(res)}` : ""),
      );
    }
    // tool_result is inlined at its tool_use; thinking/images are dropped.
  }
  return out.join("\n\n");
}

/**
 * Parse a Claude Code jsonl into text-only FreeCode messages. Consecutive
 * same-role entries are merged (Claude Code writes one line per block).
 */
export async function convertClaudeTranscript(
  fullPath: string,
  max = IMPORT_MAX_MESSAGES,
): Promise<{ messages: SerializedMessage[]; cwd: string | null }> {
  const entries: Entry[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(fullPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      // Torn last line of a live session — skip.
    }
  }

  const results = new Map<string, string>();
  let cwd: string | null = null;
  for (const e of entries) {
    cwd ??= typeof e.cwd === "string" && e.cwd ? e.cwd : null;
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c as Block[]) {
      if (b?.type === "tool_result") results.set(String(b.tool_use_id), resultText(b.content));
    }
  }

  const all: SerializedMessage[] = [];
  for (const e of entries) {
    const role = e.message?.role;
    if ((role !== "user" && role !== "assistant") || e.isMeta || e.isSidechain) continue;
    const text = entryText(e.message?.content, results);
    if (!text) continue;
    const last = all[all.length - 1];
    if (last?.role === role) {
      last.parts[0]!.content += `\n\n${text}`;
      continue;
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    all.push({
      id: randomUUID(),
      role,
      parts: [{ type: "text", content: text }],
      timestamp: Number.isFinite(ts) ? ts : Date.now(),
    });
  }

  const kept = all.slice(-max);
  const omitted = all.length - kept.length;
  if (omitted > 0) {
    kept.unshift({
      id: randomUUID(),
      role: "user",
      parts: [
        {
          type: "text",
          content: `[Imported from Claude Code: ${omitted} older messages were omitted.]`,
        },
      ],
      timestamp: kept[0]!.timestamp,
    });
  }
  return { messages: kept, cwd };
}

/**
 * Import a Claude Code session into `store`, or return the one already
 * imported. Returns the FreeCode session id.
 */
export async function importClaudeSession(
  store: SessionStore,
  claudeId: string,
  provider: string,
  opts: { claudeConfigDir?: string } = {},
): Promise<string> {
  const id = importedSessionId(claudeId);
  if ((await store.list()).some((m) => m.id === id)) return id;

  const fullPath = await resolveTranscriptPath(claudeId, opts);
  if (!fullPath) throw new Error(`Claude Code session not found: ${claudeId}`);

  const { messages, cwd } = await convertClaudeTranscript(fullPath);
  const projectPath =
    cwd ?? decodeProjectSlug(path.basename(path.dirname(fullPath))) ?? process.cwd();
  const firstPrompt = messages.find((m) => m.role === "user")?.parts[0]?.content;
  const title =
    (await extractTitleFromJsonl(fullPath)) ??
    firstPrompt?.split("\n")[0]!.slice(0, 80) ??
    "Claude Code session";

  await store.createSession({ title, projectPath, provider }, id);
  for (const msg of messages) await store.appendMessage(id, msg, projectPath);
  return id;
}
