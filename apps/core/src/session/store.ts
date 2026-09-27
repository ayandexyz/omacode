// =============================================================================
// SessionStore - JSONL-based file operations for session persistence
// PRIMARY: Provides file-based session storage at ~/.freecode/sessions/
// STORAGE: Sessions stored at {baseDir}/sessions/{projectDir}/{sessionId}/ with meta.json + messages.jsonl
// PROJECT DIR: Project path is formatted using path-formatter (e.g., /home/ayande/Project → home__ayande__Project)
// =============================================================================

import { mkdir, readFile, writeFile, readdir, rm, copyFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { formatSessionDirName } from "../store/path-formatter.js";

// ============================================================================
// Types
// ============================================================================

export interface SessionMeta {
  id: string;
  title: string;
  projectPath: string;
  provider: string;
  model?: string;
  status: "active" | "interrupted" | "archived" | "deleted";
  createdAt: number;
  updatedAt: number;
  lastTurnAt: number;
  turnCount: number;
  parentId?: string;
  aggregatedTokenCount?: number;
  /**
   * Session tree (spec 2026-09-20-pi-parity-plan, Phase 3). Set by
   * `navigate()` when the active leaf is NOT the last line of messages.jsonl;
   * cleared by the next append (which becomes the leaf) or replace. Unset
   * means "the log is linear from the last line", which is every session
   * that never navigated.
   */
  leafId?: string;
  /** Bookmarks for the tree view, keyed by entry id. */
  labels?: Record<string, string>;
}

/**
 * Provider-reported token usage for the request that produced this message.
 *
 * Persisted so cost can be reconstructed after the fact. The daily total in
 * `usage.json` cannot answer the question that actually matters — what share of
 * input was served from the prompt cache — because that is a per-request ratio
 * (spec 2026-08-05-token-efficiency).
 *
 * Present on at most one message per provider response: the loop persists one
 * response as several messages (text, then one per tool call), so summing this
 * across a session gives the true total rather than a multiple of it.
 */
export interface MessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface SerializedMessage {
  id: string;
  role: "user" | "assistant";
  parts: Array<{
    type: "text" | "code" | "tool" | "image";
    content?: string;
    language?: string;
    tool?: { name: string; args: Record<string, unknown> };
    result?: string;
    /** Base64 image data (image parts only). */
    data?: string;
    /** Media type, e.g. image/png (image parts only). */
    mediaType?: string;
    altText?: string;
  }>;
  timestamp: number;
  /**
   * A user-role message the harness wrote, not the user. Sent to the model as
   * a normal turn (a reminder-only turn reads as an empty user message and
   * models answer it instead of acting — jcode's finding); frontends render
   * a one-line notice instead of "You:", and harvest never scopes a turn on it.
   */
  // "steer": the user typed it mid-turn (spec 2026-09-20-pi-parity-plan
  // Phase 1). Persisted as a real user turn for the same reason as the poke;
  // the frontend renders it as a normal user message, badged "steered".
  // "task_notification": a background task finished (agent/task-notify.ts);
  // the frontend renders a one-line notice, not the XML.
  synthetic?: "auto_poke" | "steer" | "branch_summary" | "task_notification";
  interrupted?: boolean;
  usage?: MessageUsage;
  /**
   * Session tree: the entry this one continues from. Written ONLY when it
   * differs from the previous line in the file (i.e. the first append after a
   * `navigate()`), so a session that never branched is byte-identical to a
   * linear log and the previous-line rule fills in the rest.
   */
  parentId?: string;
}

/** One node of the session tree as `getTree()` reports it — never content. */
export interface SessionTreeEntry {
  id: string;
  parentId?: string;
  role: SerializedMessage["role"];
  /** First ~80 chars of the text, for the picker. */
  preview: string;
  timestamp: number;
  synthetic?: SerializedMessage["synthetic"];
  /** Tool names in this entry, for the picker's "no-tools" filter. */
  tools: string[];
  label?: string;
  /** True for every entry on the path from the root to the active leaf. */
  active: boolean;
}

export interface NavigateResult {
  /** The new active path, root → leaf. */
  path: SerializedMessage[];
  /** Entries on the OLD path that the new one does not include, oldest first. */
  abandoned: SerializedMessage[];
}

export interface CreateSessionOptions {
  title: string;
  projectPath: string;
  provider: string;
  model?: string;
}

// Context cache for file requests across turns
export interface ContextCache {
  requestedFiles: string[];
  fileContents: Record<string, string>; // path -> content
  lastUpdated: number;
  turnCount: number;
}

export interface SessionStore {
  createSession(opts: CreateSessionOptions, forcedId?: string): Promise<string>;
  getMeta(sessionId: string, projectPath?: string): Promise<SessionMeta | null>;
  getMetaBySessionId(
    formattedProjDir: string,
    sessionId: string,
  ): Promise<SessionMeta | null>;
  updateMeta(
    sessionId: string,
    updates: Partial<SessionMeta>,
    projectPath?: string,
  ): Promise<void>;
  updateStatus(
    sessionId: string,
    status: SessionMeta["status"],
    projectPath?: string,
  ): Promise<void>;
  deleteSession(
    sessionId: string,
    projectPath?: string,
    purge?: boolean,
  ): Promise<void>;

  appendMessage(
    sessionId: string,
    message: SerializedMessage,
    projectPath?: string,
  ): Promise<void>;
  getMessages(
    sessionId: string,
    projectPath?: string,
  ): Promise<SerializedMessage[]>;
  // Overwrite the whole message log (used by compaction to drop summarized
  // turns so the next turn loads a smaller history).
  replaceMessages(
    sessionId: string,
    messages: SerializedMessage[],
    projectPath?: string,
  ): Promise<void>;
  markInterrupted(
    sessionId: string,
    messageId: string,
    projectPath?: string,
  ): Promise<void>;

  // --- session tree (spec 2026-09-20-pi-parity-plan, Phase 3) ---------------
  /** Every entry in the log, all branches, with the active path marked. */
  getTree(sessionId: string, projectPath?: string): Promise<SessionTreeEntry[]>;
  /**
   * Make `entryId` the active leaf. The next append continues from it; the
   * old leaf's branch stays in the log. Throws if the id is unknown.
   */
  navigate(
    sessionId: string,
    entryId: string,
    projectPath?: string,
  ): Promise<NavigateResult>;
  /** Bookmark an entry (empty label removes it). */
  labelEntry(
    sessionId: string,
    entryId: string,
    label: string,
    projectPath?: string,
  ): Promise<void>;

  getContextCache(
    sessionId: string,
    projectPath?: string,
  ): Promise<ContextCache | null>;
  setContextCache(
    sessionId: string,
    cache: ContextCache,
    projectPath?: string,
  ): Promise<void>;
  clearContextCache(sessionId: string, projectPath?: string): Promise<void>;

  list(filter?: {
    status?: SessionMeta["status"];
    projectPath?: string;
  }): Promise<SessionMeta[]>;
  fork(sessionId: string, newProjectPath?: string): Promise<string>;

  getInterruptedSession(): Promise<{
    sessionId: string;
    messageId: string;
  } | null>;
}

// ============================================================================
// Constants
// ============================================================================

const SESSION_DIR = "sessions";
const META_FILE = "meta.json";
const MESSAGES_FILE = "messages.jsonl";
const CONTEXT_CACHE_FILE = "context-cache.json";
const TODOS_FILE = "todos.json";

// ============================================================================
// Helpers
// ============================================================================

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // already exists
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}

const PREVIEW_CHARS = 80;

function previewOf(m: SerializedMessage): string {
  const text = m.parts
    .map((p) => (p.type === "text" ? (p.content ?? "") : p.type === "tool" ? `[${p.tool?.name}]` : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS - 1) + "…" : text;
}

// ============================================================================
// Factory
// ============================================================================

export async function createSessionStore(
  baseDir: string,
): Promise<SessionStore> {
  await ensureDir(join(baseDir, SESSION_DIR));
  return new SessionStoreImpl(baseDir);
}

// ============================================================================
// Implementation
// ============================================================================

class SessionStoreImpl implements SessionStore {
  constructor(
    private baseDir: string,
    private projectDir?: string,
  ) {}

  private getProjectDir(projectPath: string): string {
    return formatSessionDirName(projectPath);
  }

  private sessionDir(sessionId: string, projectPath?: string): string {
    let projDir = projectPath
      ? this.getProjectDir(projectPath)
      : this.projectDir;
    if (!projDir) {
      const sessionsDir = join(this.baseDir, SESSION_DIR);
      if (existsSync(sessionsDir)) {
        try {
          const entries = readdirSync(sessionsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const candidate = join(sessionsDir, entry.name, sessionId);
              if (existsSync(candidate)) {
                projDir = entry.name;
                break;
              }
            }
          }
        } catch {
          // ignore directory read errors
        }
      }
    }
    if (!projDir) throw new Error("Project path required");
    return join(this.baseDir, SESSION_DIR, projDir, sessionId);
  }

  private sessionDirFromFormatted(
    sessionId: string,
    formattedProjDir: string,
  ): string {
    return join(this.baseDir, SESSION_DIR, formattedProjDir, sessionId);
  }

  private metaPath(sessionId: string, projectPath?: string): string {
    return join(this.sessionDir(sessionId, projectPath), META_FILE);
  }

  private metaPathFromFormatted(
    sessionId: string,
    formattedProjDir: string,
  ): string {
    return join(
      this.sessionDirFromFormatted(sessionId, formattedProjDir),
      META_FILE,
    );
  }

  private messagesPath(sessionId: string, projectPath?: string): string {
    return join(this.sessionDir(sessionId, projectPath), MESSAGES_FILE);
  }

  private messagesPathFromFormatted(
    sessionId: string,
    formattedProjDir: string,
  ): string {
    return join(
      this.sessionDirFromFormatted(sessionId, formattedProjDir),
      MESSAGES_FILE,
    );
  }

  private projectSessionsDir(projectPath: string): string {
    return join(this.baseDir, SESSION_DIR, this.getProjectDir(projectPath));
  }

  async createSession(
    opts: CreateSessionOptions,
    forcedId?: string,
  ): Promise<string> {
    const id = forcedId || randomUUID();
    const now = Date.now();
    const meta: SessionMeta = {
      id,
      title: opts.title,
      projectPath: opts.projectPath,
      provider: opts.provider,
      model: opts.model,
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastTurnAt: now,
      turnCount: 0,
    };
    const projDir = this.getProjectDir(opts.projectPath);
    await ensureDir(join(this.baseDir, SESSION_DIR, projDir));
    await ensureDir(this.sessionDir(id, opts.projectPath));
    await writeJson(this.metaPath(id, opts.projectPath), meta);
    await writeFile(this.messagesPath(id, opts.projectPath), "", "utf-8");
    return id;
  }

  async getMeta(
    sessionId: string,
    projectPath?: string,
  ): Promise<SessionMeta | null> {
    return readJson<SessionMeta>(this.metaPath(sessionId, projectPath));
  }

  async getMetaBySessionId(
    formattedProjDir: string,
    sessionId: string,
  ): Promise<SessionMeta | null> {
    return readJson<SessionMeta>(
      this.metaPathFromFormatted(sessionId, formattedProjDir),
    );
  }

  async updateMeta(
    sessionId: string,
    updates: Partial<SessionMeta>,
    projectPath?: string,
  ): Promise<void> {
    const meta = await this.getMeta(sessionId, projectPath);
    if (!meta) return;
    const updated = { ...meta, ...updates, updatedAt: Date.now() };
    await writeJson(this.metaPath(sessionId, projectPath), updated);
  }

  async updateStatus(
    sessionId: string,
    status: SessionMeta["status"],
    projectPath?: string,
  ): Promise<void> {
    await this.updateMeta(sessionId, { status }, projectPath);
  }

  async deleteSession(
    sessionId: string,
    projectPath?: string,
    purge?: boolean,
  ): Promise<void> {
    if (purge) {
      await rm(this.sessionDir(sessionId, projectPath), {
        recursive: true,
        force: true,
      });
      return;
    }
    await this.updateStatus(sessionId, "deleted", projectPath);
  }

  // The active leaf when it is not the last line: meta.leafId, cached so an
  // append does not read meta.json. `undefined` = not loaded yet, `null` =
  // loaded and unset. Keyed by session id — one process per session.
  private pendingLeaf = new Map<string, string | null>();

  private async loadPendingLeaf(
    sessionId: string,
    projectPath?: string,
  ): Promise<string | null> {
    const cached = this.pendingLeaf.get(sessionId);
    if (cached !== undefined) return cached;
    const meta = await this.getMeta(sessionId, projectPath);
    const leaf = meta?.leafId ?? null;
    this.pendingLeaf.set(sessionId, leaf);
    return leaf;
  }

  private async setPendingLeaf(
    sessionId: string,
    leaf: string | null,
    projectPath?: string,
  ): Promise<void> {
    this.pendingLeaf.set(sessionId, leaf);
    await this.updateMeta(sessionId, { leafId: leaf ?? undefined }, projectPath);
  }

  async appendMessage(
    sessionId: string,
    message: SerializedMessage,
    projectPath?: string,
  ): Promise<void> {
    // Right after a navigate the new entry continues from the chosen leaf,
    // not from the last line — say so on the line itself, then the log is
    // linear again from here and meta.leafId comes off.
    const leaf = await this.loadPendingLeaf(sessionId, projectPath);
    const entry =
      leaf && message.parentId === undefined
        ? { ...message, parentId: leaf }
        : message;
    const line = JSON.stringify(entry) + "\n";
    await writeFile(this.messagesPath(sessionId, projectPath), line, {
      flag: "a",
    });
    if (leaf) await this.setPendingLeaf(sessionId, null, projectPath);
    // `turnCount` is session metadata, not a count of JSONL entries: an agent
    // turn usually appends a user entry, several tool entries, and a final
    // assistant entry. Consolidation's cadence intentionally counts completed
    // user turns, so advance it once here and keep `lastTurnAt` aligned with
    // the same durable event. Without this, every session stayed at zero and
    // the production consolidation gate was permanently unreachable.
    if (entry.role === "user") {
      const meta = await this.getMeta(sessionId, projectPath);
      if (meta) {
        await this.updateMeta(
          sessionId,
          {
            turnCount: meta.turnCount + 1,
            lastTurnAt: entry.timestamp,
          },
          projectPath,
        );
      }
    }
  }

  private async readEntries(
    sessionId: string,
    projectPath?: string,
  ): Promise<SerializedMessage[]> {
    const content = await readFile(
      this.messagesPath(sessionId, projectPath),
      "utf-8",
    ).catch(() => "");
    if (!content.trim()) return [];
    return content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SerializedMessage);
  }

  /**
   * Root → leaf walk. An entry's parent is its `parentId` when set, else the
   * previous line. A parent that is not in the log (compaction dropped it)
   * ends the walk — what remains is still a valid conversation prefix.
   */
  private activePath(
    entries: SerializedMessage[],
    leafId: string | null,
  ): SerializedMessage[] {
    if (entries.length === 0) return [];
    if (!leafId && !entries.some((e) => e.parentId !== undefined)) {
      return entries; // linear log: the common case, no walk
    }
    const index = new Map<string, number>();
    entries.forEach((e, i) => index.set(e.id, i));
    const path: SerializedMessage[] = [];
    let i: number | undefined = leafId ? index.get(leafId) : entries.length - 1;
    const seen = new Set<number>();
    while (i !== undefined && i >= 0 && !seen.has(i)) {
      seen.add(i);
      const cur = entries[i]!;
      path.push(cur);
      i = cur.parentId !== undefined ? index.get(cur.parentId) : i - 1;
    }
    return path.reverse();
  }

  async getMessages(
    sessionId: string,
    projectPath?: string,
  ): Promise<SerializedMessage[]> {
    const entries = await this.readEntries(sessionId, projectPath);
    if (entries.length === 0) return [];
    const leaf = await this.loadPendingLeaf(sessionId, projectPath);
    return this.activePath(entries, leaf);
  }

  async replaceMessages(
    sessionId: string,
    messages: SerializedMessage[],
    projectPath?: string,
  ): Promise<void> {
    const content =
      messages.length === 0
        ? ""
        : messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(
      this.messagesPath(sessionId, projectPath),
      content,
      "utf-8",
    );
    // The written log IS the active path now; other branches are gone with
    // it (compaction trims to the preserved tail — see compact-apply.ts).
    if (await this.loadPendingLeaf(sessionId, projectPath)) {
      await this.setPendingLeaf(sessionId, null, projectPath);
    }
  }

  async getTree(
    sessionId: string,
    projectPath?: string,
  ): Promise<SessionTreeEntry[]> {
    const entries = await this.readEntries(sessionId, projectPath);
    const leaf = await this.loadPendingLeaf(sessionId, projectPath);
    const active = new Set(this.activePath(entries, leaf).map((e) => e.id));
    const labels = (await this.getMeta(sessionId, projectPath))?.labels ?? {};
    return entries.map((e, i) => ({
      id: e.id,
      parentId: e.parentId ?? (i > 0 ? entries[i - 1]!.id : undefined),
      role: e.role,
      preview: previewOf(e),
      timestamp: e.timestamp,
      synthetic: e.synthetic,
      tools: e.parts.flatMap((p) => (p.type === "tool" && p.tool ? [p.tool.name] : [])),
      label: labels[e.id],
      active: active.has(e.id),
    }));
  }

  async navigate(
    sessionId: string,
    entryId: string,
    projectPath?: string,
  ): Promise<NavigateResult> {
    const entries = await this.readEntries(sessionId, projectPath);
    if (!entries.some((e) => e.id === entryId)) {
      throw new Error(`Session entry not found: ${entryId}`);
    }
    const before = await this.loadPendingLeaf(sessionId, projectPath);
    const oldPath = this.activePath(entries, before);
    const path = this.activePath(entries, entryId);
    const keep = new Set(path.map((e) => e.id));
    const abandoned = oldPath.filter((e) => !keep.has(e.id));
    // Navigating to the last line makes the log linear again — no pointer.
    const isLast = entries[entries.length - 1]!.id === entryId;
    await this.setPendingLeaf(sessionId, isLast ? null : entryId, projectPath);
    return { path, abandoned };
  }

  async labelEntry(
    sessionId: string,
    entryId: string,
    label: string,
    projectPath?: string,
  ): Promise<void> {
    const meta = await this.getMeta(sessionId, projectPath);
    const labels = { ...(meta?.labels ?? {}) };
    if (label.trim()) labels[entryId] = label.trim();
    else delete labels[entryId];
    await this.updateMeta(sessionId, { labels }, projectPath);
  }

  async markInterrupted(
    sessionId: string,
    messageId: string,
    projectPath?: string,
  ): Promise<void> {
    // Rewrites the whole log, every branch — the flag is per entry.
    const messages = await this.readEntries(sessionId, projectPath);
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      messages[idx] = { ...messages[idx], interrupted: true };
    }
    const content = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(
      this.messagesPath(sessionId, projectPath),
      content,
      "utf-8",
    );
    await this.updateStatus(sessionId, "interrupted", projectPath);
  }

  async list(filter?: {
    status?: SessionMeta["status"];
    projectPath?: string;
  }): Promise<SessionMeta[]> {
    const sessionsDir = join(this.baseDir, SESSION_DIR);
    let projectDirs: string[];
    try {
      projectDirs = await readdir(sessionsDir);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const projDir of projectDirs) {
      const projPath = join(sessionsDir, projDir);
      let sessionIds: string[];
      try {
        sessionIds = await readdir(projPath);
      } catch {
        continue;
      }
      for (const id of sessionIds) {
        const meta = await this.getMetaBySessionId(projDir, id);
        if (!meta) continue;
        // Exclude deleted sessions unless explicitly requested
        if (!filter?.status && meta.status === "deleted") continue;
        if (filter?.status && meta.status !== filter.status) continue;
        if (filter?.projectPath && meta.projectPath !== filter.projectPath)
          continue;
        metas.push(meta);
      }
    }
    return metas.sort((a, b) => b.lastTurnAt - a.lastTurnAt);
  }

  async fork(sessionId: string, newProjectPath?: string): Promise<string> {
    const meta = await this.getMeta(sessionId);
    if (!meta) throw new Error("Session not found");
    const targetProjectPath = newProjectPath || meta.projectPath;
    const newId = await this.createSession({
      title: meta.title + " (fork)",
      projectPath: targetProjectPath,
      provider: meta.provider,
      model: meta.model,
    });
    await this.updateMeta(
      newId,
      { parentId: sessionId, turnCount: meta.turnCount },
      targetProjectPath,
    );
    const messages = await this.getMessages(sessionId, meta.projectPath);
    for (const msg of messages) {
      await this.appendMessage(newId, msg, targetProjectPath);
    }
    const todosSrc = join(
      this.sessionDir(sessionId, meta.projectPath),
      TODOS_FILE,
    );
    if (existsSync(todosSrc)) {
      await copyFile(
        todosSrc,
        join(this.sessionDir(newId, targetProjectPath), TODOS_FILE),
      );
    }
    return newId;
  }

  async getContextCache(
    sessionId: string,
    projectPath?: string,
  ): Promise<ContextCache | null> {
    const content = await readFile(
      join(this.sessionDir(sessionId, projectPath), CONTEXT_CACHE_FILE),
      "utf-8",
    ).catch(() => "");
    if (!content.trim()) return null;
    try {
      return JSON.parse(content) as ContextCache;
    } catch {
      return null;
    }
  }

  async setContextCache(
    sessionId: string,
    cache: ContextCache,
    projectPath?: string,
  ): Promise<void> {
    await ensureDir(this.sessionDir(sessionId, projectPath));
    await writeJson(
      join(this.sessionDir(sessionId, projectPath), CONTEXT_CACHE_FILE),
      cache,
    );
  }

  async clearContextCache(
    sessionId: string,
    projectPath?: string,
  ): Promise<void> {
    try {
      const { unlink } = await import("fs/promises");
      await unlink(
        join(this.sessionDir(sessionId, projectPath), CONTEXT_CACHE_FILE),
      );
    } catch {
      // doesn't exist, that's fine
    }
  }

  async getInterruptedSession(): Promise<{
    sessionId: string;
    messageId: string;
  } | null> {
    const all = await this.list({ status: "interrupted" });
    if (all.length === 0) return null;
    const session = all[0];
    const messages = await this.getMessages(session.id, session.projectPath);
    const last = messages[messages.length - 1];
    return last ? { sessionId: session.id, messageId: last.id } : null;
  }
}
