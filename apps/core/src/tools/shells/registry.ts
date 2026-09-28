// =============================================================================
// ShellRegistry - per-session registry of background shells.
//
// `bash(run_in_background: true)` starts a process here and returns an id
// immediately, so a dev server or a long build stops holding the turn. The
// model drains new output with `bashoutput` and stops the process with
// `killbash`; the TUI's shells panel reads the same registry over IPC.
//
// Output is held in a character-capped ring buffer, not on disk: a dev server
// left running for an hour must not grow without bound. When the cap is hit the
// OLDEST output is dropped and `droppedChars` reports it — a reader is told what
// it missed rather than silently handed a gap.
// =============================================================================

import type { ShellReadResult, ShellStatus, ShellSummary } from "./types.js";
import { spawnShell, type ShellSandbox, type SpawnedShell } from "./spawn.js";

/** Per-shell ring-buffer cap. A dev server can log for hours; keep the tail. */
export const SHELL_BUFFER_CHARS = 256_000;
/** Trim in blocks so a chatty process doesn't re-slice the buffer per chunk. */
const TRIM_BLOCK = SHELL_BUFFER_CHARS >> 2;
/** Ceiling on concurrent shells per session — a runaway loop can't fork-bomb. */
export const MAX_SHELLS_PER_SESSION = 16;
/** SIGTERM → SIGKILL escalation, for a process that ignores the polite one. */
export const KILL_ESCALATION_MS = 2000;
/**
 * How long after `exit` to wait for `close`. `close` can never fire while a
 * grandchild holds the pipe open, so settle shortly after `exit` regardless —
 * the same race the foreground path guards against.
 */
const CLOSE_GRACE_MS = 250;

export interface ShellStartOptions {
  command: string;
  cwd: string;
  /**
   * Session that started the shell. Registries are keyed by ROOT session, so
   * a subagent's shells sit in its root's registry; this is what lets the
   * subagent's teardown take only its own shells with it.
   */
  owner?: string;
  /** Notified on every chunk so the loop can relay it to the TUI live. */
  onData?: (id: string, chunk: string) => void;
  /** Notified once the process settles, for the same reason. */
  onExit?: (id: string, status: ShellStatus, exitCode: number | null) => void;
  sandbox?: ShellSandbox;
}

/** A later subscriber to a running shell — `monitor({ bash_id })`. */
export interface ShellWatcher {
  onData: (chunk: string) => void;
  onExit: (status: ShellStatus, exitCode: number | null) => void;
}

interface Shell {
  id: string;
  command: string;
  cwd: string;
  owner?: string;
  status: ShellStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  buf: string;
  /** Characters dropped off the front of `buf`; also the buffer's base offset. */
  droppedChars: number;
  /** Absolute offset the model's `bashoutput` has consumed up to. */
  modelCursor: number;
  /**
   * The model already knows how this shell ended: a `bashoutput` returned it
   * settled, or the model stopped it with `killbash`. A completion
   * notification would then only buy a redundant turn.
   */
  modelKnowsEnd?: boolean;
  kill: (signal: NodeJS.Signals) => void;
  /** Kept on the record so killAll() can fire it too, not just the exit handler. */
  notifyExit?: (id: string, status: ShellStatus, code: number | null) => void;
  watchers: Set<ShellWatcher>;
  /** Set by kill(): SIGKILL escalation pending; also marks the exit as ours. */
  killTimer?: NodeJS.Timeout;
  closeGrace?: NodeJS.Timeout;
}

export class ShellRegistry {
  private shells = new Map<string, Shell>();
  private seq = 0;

  /**
   * Spawn a background shell. Throws only when the session is already at
   * MAX_SHELLS_PER_SESSION — a spawn failure surfaces as a `failed` shell so
   * the model reads the error out of `bashoutput` like any other output.
   */
  start(options: ShellStartOptions): ShellSummary {
    this.assertRoom();
    return this.attach(
      options,
      spawnShell(options.command, options.cwd, options.sandbox),
      "",
    );
  }

  /**
   * Take over a process that is already running — a foreground `bash` that
   * outlived its timeout (tools/bash.ts). `output` is what it printed so far;
   * the caller must have detached its own listeners first, so every later
   * chunk lands here once. Throws like `start` when the session is full.
   */
  adopt(options: ShellStartOptions, spawned: SpawnedShell, output: string): ShellSummary {
    this.assertRoom();
    return this.attach(options, spawned, output);
  }

  private assertRoom(): void {
    if (this.runningCount() >= MAX_SHELLS_PER_SESSION) {
      throw new Error(
        `Too many background shells (${MAX_SHELLS_PER_SESSION}). Kill one with killbash before starting another.`,
      );
    }
  }

  private attach(
    options: ShellStartOptions,
    { child, killTree }: SpawnedShell,
    initialOutput: string,
  ): ShellSummary {
    const id = `bash_${++this.seq}`;

    const shell: Shell = {
      id,
      command: options.command,
      cwd: options.cwd,
      owner: options.owner,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      buf: "",
      droppedChars: 0,
      modelCursor: 0,
      kill: killTree,
      notifyExit: options.onExit,
      watchers: new Set(),
    };
    this.shells.set(id, shell);

    const append = (chunk: string): void => {
      shell.buf += chunk;
      if (shell.buf.length > SHELL_BUFFER_CHARS) {
        const drop = shell.buf.length - SHELL_BUFFER_CHARS + TRIM_BLOCK;
        shell.buf = shell.buf.slice(drop);
        shell.droppedChars += drop;
      }
      options.onData?.(id, chunk);
      for (const w of shell.watchers) w.onData(chunk);
    };

    if (initialOutput) append(initialOutput);
    child.stdout?.on("data", (d: Buffer) => append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => append(d.toString()));

    const settle = (status: ShellStatus, code: number | null): void => {
      if (shell.status !== "running") return;
      this.clearTimers(shell);
      shell.status = status;
      shell.exitCode = code;
      shell.endedAt = Date.now();
      this.endWatchers(shell);
      options.onExit?.(id, status, code);
    };

    child.on("error", (err) => {
      append(`\n<shell_error>\n${err.message}\n</shell_error>\n`);
      settle("failed", null);
    });
    // Settle on `close`, not `exit`: `exit` can fire with stdio still
    // undrained, so a `completed` shell would be missing its last lines. The
    // grace timer covers a grandchild holding the pipe open past `exit`.
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (signal || shell.killTimer) settle("killed", code);
      else settle(code === 0 ? "completed" : "failed", code);
    };
    child.on("exit", (code, signal) => {
      shell.closeGrace = setTimeout(() => finish(code, signal), CLOSE_GRACE_MS);
    });
    child.on("close", finish);

    return this.summarize(shell);
  }

  /**
   * Drain everything the model has not seen yet and advance its cursor. This is
   * the `bashoutput` contract: each call returns only new output.
   */
  readForModel(id: string): ShellReadResult {
    const shell = this.shells.get(id);
    if (!shell) return missing();
    const result = this.readFrom(id, shell.modelCursor);
    shell.modelCursor = result.nextCursor;
    if (result.status !== "running") shell.modelKnowsEnd = true;
    return result;
  }

  /**
   * Positional read that leaves the model's cursor alone — the TUI panel polls
   * through this so opening the panel never eats output the model still owes.
   */
  readFrom(id: string, cursor: number): ShellReadResult {
    const shell = this.shells.get(id);
    if (!shell) return missing();
    const end = shell.droppedChars + shell.buf.length;
    const from = Math.max(cursor, shell.droppedChars);
    return {
      found: true,
      text: shell.buf.slice(from - shell.droppedChars),
      status: shell.status,
      exitCode: shell.exitCode,
      droppedChars: Math.max(0, shell.droppedChars - cursor),
      nextCursor: end,
    };
  }

  /**
   * Whether a completion notification for this shell would tell the model
   * nothing new: it read the end itself, killed it itself, or the record is
   * gone (dismissed, or its session ended). Checked at delivery, not at exit —
   * the model can drain the shell in the moments between.
   */
  modelKnowsEnd(id: string): boolean {
    const shell = this.shells.get(id);
    return shell ? shell.modelKnowsEnd === true : true;
  }

  /**
   * Subscribe to a RUNNING shell's later output and its end. The buffered
   * output so far is returned rather than replayed, so the caller decides what
   * to do with it. Undefined for an unknown or settled shell. The returned
   * `stop` detaches without touching the process.
   */
  watch(
    id: string,
    watcher: ShellWatcher,
  ): { buffered: string; stop: () => void } | undefined {
    const shell = this.shells.get(id);
    if (!shell || shell.status !== "running") return undefined;
    shell.watchers.add(watcher);
    return { buffered: shell.buf, stop: () => shell.watchers.delete(watcher) };
  }

  /** The last `maxChars` of buffered output, without touching any cursor. */
  tail(id: string, maxChars: number): string {
    const buf = this.shells.get(id)?.buf ?? "";
    return buf.length > maxChars ? buf.slice(-maxChars) : buf;
  }

  list(): ShellSummary[] {
    return [...this.shells.values()].map((s) => this.summarize(s));
  }

  get(id: string): ShellSummary | undefined {
    const shell = this.shells.get(id);
    return shell ? this.summarize(shell) : undefined;
  }

  /**
   * Forget a settled shell, discarding its buffered output.
   *
   * Refuses while the process is still running: dropping the record would
   * leak the process — nothing else holds a handle to kill it. Kill first,
   * then remove. Returns false for an unknown id or a running one.
   */
  remove(id: string): boolean {
    const shell = this.shells.get(id);
    if (!shell || shell.status === "running") return false;
    this.shells.delete(id);
    return true;
  }

  /**
   * SIGTERM the process group, escalating to SIGKILL after KILL_ESCALATION_MS
   * if it has not exited. The record stays `running` until the process really
   * exits (so killAll/remove still see it and the real exit code is recorded);
   * the exit handler then settles it as `killed`. Returns false for an unknown
   * id, one already settled, or one a kill is already pending on.
   */
  kill(id: string, byModel = false): boolean {
    const shell = this.shells.get(id);
    if (!shell || shell.status !== "running" || shell.killTimer) return false;
    if (byModel) shell.modelKnowsEnd = true;
    shell.kill("SIGTERM");
    shell.killTimer = setTimeout(() => {
      shell.kill("SIGKILL");
      this.forceSettle(shell);
    }, KILL_ESCALATION_MS);
    shell.killTimer.unref();
    return true;
  }

  /** Session teardown: nothing may outlive the session that started it. */
  killAll(): void {
    for (const shell of this.shells.values()) {
      if (shell.status === "running") {
        shell.kill("SIGKILL");
        this.forceSettle(shell);
      }
    }
    this.shells.clear();
  }

  /**
   * Subagent teardown: kill and forget only the shells `owner` started. The
   * registry is the root's, so killAll() here would take the parent's dev
   * server down with the subagent.
   */
  disposeOwned(owner: string): void {
    for (const shell of [...this.shells.values()]) {
      if (shell.owner !== owner) continue;
      if (shell.status === "running") {
        shell.kill("SIGKILL");
        this.forceSettle(shell);
      }
      this.shells.delete(shell.id);
    }
  }

  /**
   * Settle without waiting for the exit handler. That short-circuits the
   * handler's own settle(), so the exit notification has to be fired here or
   * the frontend's shell counter would stay stale.
   */
  private forceSettle(shell: Shell): void {
    if (shell.status !== "running") return;
    this.clearTimers(shell);
    shell.status = "killed";
    shell.endedAt = Date.now();
    this.endWatchers(shell);
    shell.notifyExit?.(shell.id, "killed", null);
  }

  /** Watchers hear the end first, so their last lines precede the exit notice. */
  private endWatchers(shell: Shell): void {
    for (const w of shell.watchers) w.onExit(shell.status, shell.exitCode);
    shell.watchers.clear();
  }

  private clearTimers(shell: Shell): void {
    if (shell.killTimer) clearTimeout(shell.killTimer);
    if (shell.closeGrace) clearTimeout(shell.closeGrace);
  }

  private runningCount(): number {
    let n = 0;
    for (const s of this.shells.values()) if (s.status === "running") n++;
    return n;
  }

  private summarize(shell: Shell): ShellSummary {
    return {
      id: shell.id,
      command: shell.command,
      cwd: shell.cwd,
      status: shell.status,
      exitCode: shell.exitCode,
      startedAt: shell.startedAt,
      endedAt: shell.endedAt,
      bufferedChars: shell.buf.length,
      truncated: shell.droppedChars > 0,
    };
  }
}

function missing(): ShellReadResult {
  return {
    found: false,
    text: "",
    status: "failed",
    exitCode: null,
    droppedChars: 0,
    nextCursor: 0,
  };
}
