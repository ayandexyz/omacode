// =============================================================================
// Codex CLI session discovery + import — the Codex twin of claude-sessions/.
//
// Reads `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (default `~/.codex`).
// Line 1 is `session_meta` (id, cwd); after it:
//   - response_item/message (user) → the prompt, minus the blocks Codex
//     injects (AGENTS.md, <environment_context>, <turn_aborted>, image tags)
//   - response_item/message (assistant) → reply text
//   - response_item/{function,custom_tool}_call(+_output) → inlined as text,
//     like the Claude importer (Codex tool names are not FreeCode's)
// Reasoning, developer messages and telemetry are dropped. Read-only on
// `~/.codex`. Import id is `codex_<id>`, never re-imported over.
// =============================================================================

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import type {
  CodexSessionMeta,
  SerializedMessage,
} from "@thisisayande/freecode-shared";
import type { SessionStore } from "../session/store.js";
import {
  IMPORT_MAX_MESSAGES,
  capMessages,
  cut,
  firstPromptTitle,
  pushText,
  saveImported,
} from "../claude-sessions/import.js";

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

export function importedCodexSessionId(codexId: string): string {
  return `codex_${codexId}`;
}

type Obj = Record<string, unknown>;

async function* jsonLines(file: string): AsyncGenerator<Obj> {
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let row: Obj;
      try {
        row = JSON.parse(line) as Obj;
      } catch {
        continue; // Torn last line of a live session.
      }
      yield row;
    }
  } finally {
    // A caller that `break`s early must not leak the file handle.
    rl.close();
    input.destroy();
  }
}

async function collectJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collectJsonl(p)));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** `session_index.jsonl` → id → thread_name (Codex's own titles). */
async function readThreadNames(home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const file = path.join(home, "session_index.jsonl");
  if (!fs.existsSync(file)) return names;
  for await (const row of jsonLines(file)) {
    if (typeof row.id === "string" && typeof row.thread_name === "string") {
      names.set(row.id, row.thread_name);
    }
  }
  return names;
}

function metaOf(
  first: Obj | undefined,
): { id: string; cwd: string; ts: number } | null {
  if (!first || first.type !== "session_meta") return null;
  const p = (first.payload ?? {}) as Obj;
  if (typeof p.id !== "string" || !p.id) return null;
  const ts = Date.parse(String(p.timestamp ?? first.timestamp ?? ""));
  return { id: p.id, cwd: typeof p.cwd === "string" ? p.cwd : "", ts };
}

function outputText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as Obj).content === "string") {
    return (v as Obj).content as string;
  }
  return v === undefined ? "" : JSON.stringify(v);
}

/** Blocks Codex adds to user messages itself; seen across real rollouts. */
const INJECTED =
  /^(# AGENTS\.md instructions|<(environment_context|turn_aborted|user_instructions|image\b|\/image>))/;

/** Text of a response_item message; user messages lose injected blocks. */
function messageText(p: Obj): string {
  if (!Array.isArray(p.content)) return "";
  return (p.content as Obj[])
    .map((c) => (typeof c?.text === "string" ? c.text.trim() : ""))
    .filter((t) => t && !(p.role === "user" && INJECTED.test(t)))
    .join("\n\n");
}

/**
 * Newest-first list for the picker. Each listed file is streamed once for
 * its turn count — ponytail: fine at ~20MB of rollouts, cache by mtime if
 * large Codex histories make /resume slow.
 */
export async function listCodexSessions(
  opts: { codexHome?: string; limit?: number } = {},
): Promise<CodexSessionMeta[]> {
  const home = opts.codexHome ?? getCodexHome();
  const files = await collectJsonl(path.join(home, "sessions"));
  const stamped = await Promise.all(
    files.map(async (f) => ({ f, mtime: (await fsp.stat(f)).mtimeMs })),
  );
  stamped.sort((a, b) => b.mtime - a.mtime);
  const names = await readThreadNames(home);

  const rows: CodexSessionMeta[] = [];
  for (const { f, mtime } of stamped.slice(0, opts.limit ?? 200)) {
    let meta: ReturnType<typeof metaOf> = null;
    let turns = 0;
    let firstPrompt = "";
    let first = true;
    for await (const row of jsonLines(f)) {
      if (first) {
        meta = metaOf(row);
        first = false;
        if (!meta) break;
        continue;
      }
      const p = row.payload as Obj | undefined;
      if (row.type !== "response_item" || p?.role !== "user") continue;
      const text = messageText(p);
      if (!text) continue;
      turns++;
      firstPrompt ||= text;
    }
    if (!meta) continue;
    rows.push({
      id: meta.id,
      title: names.get(meta.id) ?? firstPrompt.split("\n")[0]!.slice(0, 200),
      projectPath: meta.cwd,
      provider: "codex",
      createdAt: Number.isFinite(meta.ts) ? meta.ts : mtime,
      updatedAt: mtime,
      lastTurnAt: mtime,
      turnCount: turns,
      fullPath: f,
    });
  }
  return rows;
}

async function findCodexFile(
  codexId: string,
  home: string,
): Promise<string | null> {
  // Rollout filenames end in the session id; fall back to reading headers.
  const files = await collectJsonl(path.join(home, "sessions"));
  const byName = files.find((f) => f.endsWith(`${codexId}.jsonl`));
  if (byName) return byName;
  for (const f of files) {
    for await (const row of jsonLines(f)) {
      if (metaOf(row)?.id === codexId) return f;
      break;
    }
  }
  return null;
}

/** Codex rollout → text-only FreeCode messages (preview and import). */
export async function convertCodexTranscript(
  fullPath: string,
  max = IMPORT_MAX_MESSAGES,
): Promise<{ messages: SerializedMessage[]; cwd: string | null }> {
  const rows: Obj[] = [];
  for await (const row of jsonLines(fullPath)) rows.push(row);

  const results = new Map<string, string>();
  for (const r of rows) {
    const p = r.payload as Obj | undefined;
    if (
      r.type === "response_item" &&
      String(p?.type).endsWith("_call_output")
    ) {
      results.set(String(p!.call_id), outputText(p!.output));
    }
  }

  const all: SerializedMessage[] = [];
  for (const r of rows) {
    const p = r.payload as Obj | undefined;
    if (!p) continue;
    const ts = typeof r.timestamp === "string" ? r.timestamp : undefined;
    if (r.type !== "response_item") continue;
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      pushText(all, p.role, messageText(p), ts);
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const args = cut(String(p.arguments ?? p.input ?? ""));
      const res = results.get(String(p.call_id));
      pushText(
        all,
        "assistant",
        `[Codex tool call: ${String(p.name)} ${args}]` +
          (res !== undefined ? `\n[result]\n${cut(res)}` : ""),
        ts,
      );
    }
  }
  const cwd = metaOf(rows[0])?.cwd || null;
  return { messages: capMessages(all, max, "Codex"), cwd };
}

export async function readCodexTranscript(
  codexId: string,
  opts: { codexHome?: string } = {},
): Promise<SerializedMessage[]> {
  const file = await findCodexFile(codexId, opts.codexHome ?? getCodexHome());
  return file ? (await convertCodexTranscript(file)).messages : [];
}

/** Import a Codex session into `store` (or return the existing import). */
export async function importCodexSession(
  store: SessionStore,
  codexId: string,
  provider: string,
  opts: { codexHome?: string } = {},
): Promise<string> {
  const id = importedCodexSessionId(codexId);
  if ((await store.list()).some((m) => m.id === id)) return id;

  const home = opts.codexHome ?? getCodexHome();
  const file = await findCodexFile(codexId, home);
  if (!file) throw new Error(`Codex session not found: ${codexId}`);

  const { messages, cwd } = await convertCodexTranscript(file);
  const title =
    (await readThreadNames(home)).get(codexId) ??
    firstPromptTitle(messages) ??
    "Codex session";
  await saveImported(
    store,
    id,
    { title, projectPath: cwd ?? process.cwd(), provider },
    messages,
  );
  return id;
}
