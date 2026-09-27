// =============================================================================
// Bash Tool - Shell command execution with UI rendering
//
// Two modes:
//   foreground (default) — awaits the command, streaming a live tail to the
//     frontend as it runs so a long build isn't a silent spinner.
//   background (`run_in_background: true`) — registers the process in the
//     session's ShellRegistry and returns an id immediately, so a dev server or
//     a long test run stops holding the turn. Drain it with `bashoutput`, stop
//     it with `killbash`.
// =============================================================================

import * as path from "path";
import type { ToolContext } from "./types.js";
import type { Tool, ToolExecutionResult, JsonSchema } from "./tool.types.js";
import { buildTool } from "./factory.js";
import { BASH_DESCRIPTION } from "./bash-prompt.js";
import { classifyCommand } from "./output-compress.js";
import { spawnShell } from "./shells/spawn.js";
import { getShellRegistry, shellSessionOf } from "./shells/index.js";
import type { ShellRegistry, ShellStartOptions } from "./shells/registry.js";
import type { ShellSummary } from "./shells/types.js";
import { BusEvents } from "../bus/index.js";
import {
  notifyTask,
  taskNotificationsEnabled,
} from "../agent/task-notify.js";
import { recordEnd, recordStart } from "../agent/background-ledger.js";

interface BashParams {
  command: string;
  timeout?: number;
  workdir?: string;
  run_in_background?: boolean;
}

const DEFAULT_TIMEOUT = 60_000;
/**
 * Ceiling on a foreground command (Claude Code's number). Anything longer must
 * run in the background: a foreground call holds the whole turn, and one that
 * prints nothing also trips the TUI's idle deadline (just above this).
 */
export const MAX_TIMEOUT = 600_000;
/** Output tail a completion notification carries; bashoutput has the rest. */
const NOTIFY_TAIL_CHARS = 4_000;
/** Output shown when a command is moved to the background or killed. */
const MOVED_OUTPUT_CHARS = 8_000;

function tailChars(text: string, max: number): string {
  return text.length > max
    ? `… (${text.length - max} earlier chars not shown)\n${text.slice(-max)}`
    : text;
}

/**
 * How often a running foreground command flushes its tail to the frontend.
 * Coalesced rather than per-chunk: a verbose build emits thousands of writes a
 * second and each one would be an IPC frame plus a TUI re-render.
 */
const LIVE_TAIL_INTERVAL_MS = 200;
/** Lines of tail the frontend shows; matches the loop's post-hoc emit. */
const LIVE_TAIL_LINES = 5;
const MAX_LINE_LEN = 200;

type BashResult = ToolExecutionResult<{
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
}>;

// =============================================================================
// Bash Schema
// =============================================================================

const bashSchema: JsonSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "The shell command to execute" },
    timeout: {
      type: "number",
      description:
        "Timeout in milliseconds (default 60000, max 600000). Unset or at the max: a command still running then moves to the background. Set below the max: it is killed then.",
    },
    workdir: {
      type: "string",
      description: "Working directory for the command",
    },
    run_in_background: {
      type: "boolean",
      description:
        "Run the command in the background and return a shell id immediately instead of waiting. Use for dev servers, watchers, and anything longer than the timeout; read its output with bashoutput and stop it with killbash.",
    },
  },
  required: ["command"],
};

// =============================================================================
// Input validation
// =============================================================================

function validateBashInput(
  params: unknown,
): { valid: true } | { valid: false; error: string } {
  if (!params || typeof params !== "object") {
    return { valid: false, error: "Expected object parameters" };
  }
  const p = params as Record<string, unknown>;
  if (typeof p.command !== "string" || p.command.length === 0) {
    return { valid: false, error: "command is required and must be a string" };
  }
  if (p.timeout !== undefined && typeof p.timeout !== "number") {
    return { valid: false, error: "timeout must be a number" };
  }
  return { valid: true };
}

// =============================================================================
// Execute function
// =============================================================================

async function executeBash(
  params: BashParams,
  ctx: ToolContext,
): Promise<BashResult> {
  // Executed via the BashTool definition below; exported separately only for
  // regression tests in `bash.test.ts` so they can call it without building a
  // full ToolContext for the harness.
  return _executeBash(params, ctx);
}

function resolveCwd(params: BashParams, ctx: ToolContext): string {
  if (!params.workdir) return ctx.cwd;
  return path.isAbsolute(params.workdir)
    ? params.workdir
    : path.resolve(ctx.cwd, params.workdir);
}

export async function _executeBash(
  params: BashParams,
  ctx: ToolContext,
  /** Test seam: the default timeout, so the move-to-background path runs in ms. */
  defaultTimeout = DEFAULT_TIMEOUT,
): Promise<BashResult> {
  const cwd = resolveCwd(params, ctx);
  // Providers send booleans as strings (see the coercion note in the tool
  // registration checklist), so accept both spellings of true.
  const background =
    params.run_in_background === true ||
    (params.run_in_background as unknown) === "true";

  return background
    ? startBackground(params, ctx, cwd)
    : runForeground(params, ctx, cwd, defaultTimeout);
}

// =============================================================================
// Background mode
// =============================================================================

/**
 * Register a shell in the session's registry with the relays every background
 * shell needs — live output and exit to the /shells panel, and the completion
 * notification. `launch` does the registry call: `start` spawns a new process,
 * `adopt` takes over a foreground one that outlived its timeout. Throws when
 * the session is at its shell cap.
 */
export function trackShell(
  params: BashParams,
  ctx: ToolContext,
  cwd: string,
  sessionId: string,
  launch: (registry: ShellRegistry, options: ShellStartOptions) => ShellSummary,
  /**
   * For a caller with its own reporting (`monitor`): extra per-chunk and exit
   * hooks, and `notifyOnExit: false` to replace the standard exit notification.
   */
  hooks: {
    onData?: (id: string, chunk: string) => void;
    onExit?: (
      id: string,
      status: Exclude<ShellSummary["status"], "running">,
      exitCode: number | null,
    ) => void;
    notifyOnExit?: boolean;
    /** How the background ledger labels it. */
    kind?: "shell" | "monitor";
  } = {},
): { shell: ShellSummary; notify: boolean } {
  // Stamped with the ROOT session id, like agent_* events: the frontend
  // subscribes to the root and filters everything else out, so a subagent's
  // shells would otherwise never reach /shells.
  const rootId = shellSessionOf(sessionId);
  const registry = getShellRegistry(sessionId);
  // Read once, at start: the start message has to say whether an exit will be
  // reported, and the answer must not change under the model mid-run.
  const notify = taskNotificationsEnabled(ctx.projectPath ?? cwd);
  // Set once the start is recorded; the exit handler can run before that
  // only for a shell that died instantly, which then never needs a record.
  let ledgered = false;
  const shell = launch(registry, {
    command: params.command,
    cwd,
    owner: sessionId,
    onData: (id, chunk) => {
      BusEvents.stream(rootId, {
        type: "shell_output",
        shellId: id,
        chunk,
      });
      hooks.onData?.(id, chunk);
    },
    onExit: (id, status, exitCode) => {
      if (status === "running") return;
      BusEvents.stream(rootId, {
        type: "shell_exit",
        shellId: id,
        status,
        exitCode,
      });
      if (ledgered) recordEnd(sessionId, id);
      hooks.onExit?.(id, status, exitCode);
      if (hooks.notifyOnExit === false) return;
      // To the session that started it (a subagent's shell tells the
      // subagent, and is dropped if that subagent is gone). Skipped when
      // the model already knows — see ShellRegistry.modelKnowsEnd.
      if (!notify || registry.modelKnowsEnd(id)) return;
      notifyTask(sessionId, {
        taskId: id,
        kind: "shell",
        status,
        summary: params.command,
        result: shellResult(id, exitCode, registry.tail(id, NOTIFY_TAIL_CHARS)),
        isStale: () => registry.modelKnowsEnd(id),
      });
    },
  });

  BusEvents.stream(rootId, {
    type: "shell_start",
    shellId: shell.id,
    command: shell.command,
    cwd: shell.cwd,
  });
  // Root sessions only: a subagent's shells die with the subagent anyway.
  if (rootId === sessionId && shell.status === "running") {
    ledgered = true;
    recordStart(sessionId, {
      id: shell.id,
      kind: hooks.kind ?? "shell",
      summary: params.command,
    });
  }
  return { shell, notify };
}

/** What the model is told to do with a shell that is now in the background. */
function backgroundGuidance(id: string, notify: boolean): string[] {
  return [
    notify
      ? "You will get a <task-notification> with its exit code and output tail when it exits. You do not know its result until then: do not state or guess it, and do not poll or sleep waiting. Keep working, or end your turn."
      : "Completion notifications are off: check on it with bashoutput when you need the result.",
    `bashoutput(bash_id: "${id}") returns only output that is new since your last call.`,
    `Stop it with killbash(bash_id: "${id}").`,
  ];
}

function startBackground(
  params: BashParams,
  ctx: ToolContext,
  cwd: string,
): BashResult {
  const sessionId = ctx.sessionId;
  if (!sessionId) {
    return {
      success: false,
      error:
        "run_in_background requires a session; re-run the command in the foreground.",
    };
  }

  let tracked;
  try {
    tracked = trackShell(params, ctx, cwd, sessionId, (registry, options) =>
      registry.start(options),
    );
  } catch (error) {
    return { success: false, error: String((error as Error).message ?? error) };
  }
  const { shell, notify } = tracked;

  return {
    success: true,
    result: {
      title: params.command.split("\n")[0].slice(0, 50),
      output: [
        `Started in the background as ${shell.id}.`,
        "",
        ...backgroundGuidance(shell.id, notify),
      ].join("\n"),
      metadata: {
        background: true,
        shellId: shell.id,
        command: params.command,
        cwd,
        outputKind: classifyCommand(params.command),
      },
    },
  };
}

/** The <result> of a shell's completion notification. */
function shellResult(id: string, exitCode: number | null, tail: string): string {
  return [
    `Exit code: ${exitCode ?? "none (killed by a signal)"}`,
    tail.trim()
      ? `Last output:\n${tail.trimEnd()}`
      : "(no output)",
    `bashoutput(bash_id: "${id}") returns everything you have not read yet.`,
  ].join("\n");
}

// =============================================================================
// Foreground mode
// =============================================================================

function runForeground(
  params: BashParams,
  ctx: ToolContext,
  cwd: string,
  defaultTimeout: number,
): Promise<BashResult> {
  return new Promise((resolve) => {
    // Providers send numbers as strings (tool registration checklist).
    const asked = Number(params.timeout ?? defaultTimeout);
    const timeout = Math.min(
      Number.isFinite(asked) && asked > 0 ? asked : defaultTimeout,
      MAX_TIMEOUT,
    );
    const spawned = spawnShell(params.command, cwd);
    const { child, killTree } = spawned;
    // At the timeout a command is moved to the background instead of killed —
    // unless the model bounded it on purpose with a short explicit `timeout`.
    // No `timeout`, or one at the cap, means "however long it takes", and a
    // kill would throw that work away (a multi-hour eval dies at 60s).
    const mayMove =
      Boolean(ctx.sessionId) &&
      (params.timeout === undefined || asked >= MAX_TIMEOUT);

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    /** The move to the background was refused (shell cap); it was killed. */
    let moveFailed = false;

    // Live tail: the frontend shows the last few lines while the command runs,
    // so a three-minute build reports progress instead of looking hung. Only
    // the tail is sent — the full output still goes back at completion.
    const canStream = Boolean(ctx.sessionId && ctx.toolCallId);
    let tailDirty = false;
    const flushTail = (): void => {
      if (!tailDirty || !ctx.sessionId || !ctx.toolCallId) return;
      tailDirty = false;
      const lines = (stdout + stderr)
        .split("\n")
        .filter((l) => l.trim())
        .slice(-LIVE_TAIL_LINES)
        .map((l) =>
          l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + "..." : l,
        );
      if (lines.length === 0) return;
      BusEvents.stream(ctx.sessionId, {
        type: "tool_output",
        toolCallId: ctx.toolCallId,
        content: lines.join("\n"),
      });
    };
    const tailTimer = canStream
      ? setInterval(flushTail, LIVE_TAIL_INTERVAL_MS)
      : undefined;

    const killTimer = setTimeout(() => {
      killTree("SIGKILL");
    }, timeout + 3000);

    const timer = setTimeout(() => {
      if (settled) return;
      // Already exited: let the exit/close path report it normally.
      const alive = child.exitCode === null && child.signalCode === null;
      if (alive && mayMove) {
        if (moveToBackground()) return;
        moveFailed = true;
      }
      killed = true;
      killTree("SIGTERM");
    }, timeout);

    let exitGrace: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (exitGrace) clearTimeout(exitGrace);
      if (tailTimer) clearInterval(tailTimer);
    };

    const onStdout = (data: Buffer): void => {
      stdout += data.toString();
      tailDirty = true;
    };
    const onStderr = (data: Buffer): void => {
      stderr += data.toString();
      tailDirty = true;
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);

    // `close` fires only once every stdio pipe is closed — and a surviving
    // grandchild still holds the write end, so it may never fire at all. The
    // tool promise would then never settle and the UI spins forever. Settle
    // shortly after `exit` with whatever was captured; in the normal case
    // `close` wins the race and this timer is cleared.
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      exitGrace = setTimeout(() => finish(code, signal), 250);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(code, signal);
    child.on("exit", onExit);
    child.on("close", onClose);

    /**
     * Hand the live process to the session's shell registry and end this
     * tool call with its id. Returns false when the registry is full, and the
     * caller falls back to the kill. Adopt first, detach after: both are
     * synchronous, so no chunk can land between them or twice.
     */
    function moveToBackground(): boolean {
      const initial =
        stdout + (stderr ? `${stdout ? "\n" : ""}<stderr>\n${stderr}\n</stderr>\n` : "");
      let tracked;
      try {
        tracked = trackShell(params, ctx, cwd, ctx.sessionId!, (registry, options) =>
          registry.adopt(options, spawned, initial),
        );
      } catch {
        return false;
      }
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      settled = true;
      cleanup();
      flushTail();

      const { shell, notify } = tracked;
      const secs = Math.round(timeout / 1000);
      resolve({
        success: true,
        result: {
          title: params.command.split("\n")[0].slice(0, 50),
          output: [
            initial.trim() ? `Output so far:\n${tailChars(initial, MOVED_OUTPUT_CHARS)}\n` : "",
            "<bash_metadata>",
            `Still running after ${secs}s, so it was moved to the background as ${shell.id} instead of being killed. Do not run it again.`,
            ...backgroundGuidance(shell.id, notify),
            "</bash_metadata>",
          ]
            .filter(Boolean)
            .join("\n"),
          metadata: {
            background: true,
            movedToBackground: true,
            shellId: shell.id,
            command: params.command,
            cwd,
            outputKind: classifyCommand(params.command),
          },
        },
      });
      return true;
    }

    function finish(code: number | null, _signal: NodeJS.Signals | null) {
      if (settled) return;
      settled = true;
      cleanup();

      let output = "";
      if (stdout) output += stdout;
      if (stderr)
        output += (output ? "\n" : "") + "<stderr>\n" + stderr + "\n</stderr>";

      if (!output) {
        output = "(no output)";
      }

      // Returned untruncated: the orchestrator stores the full text in the
      // OutputStore before any lossy cap, so the `output` tool can page the
      // whole thing. Capping here would leave the store holding an
      // already-cut copy (spec 2026-09-04-harness-cost-efficiency.md D1).
      const result = {
        title: params.command.split("\n")[0].slice(0, 50),
        output,
        metadata: {
          exitCode: code,
          command: params.command,
          cwd,
          // Classified here — the tool knows what was run — but acted on at
          // the orchestrator's cap site (spec 2026-09-04 D2).
          outputKind: classifyCommand(params.command),
        },
      };

      if (killed) {
        // Surface the timeout as a failure so the loop sees it as such and
        // doesn't conclude "the command ran successfully, just slowly." The
        // partial output and the advice go IN the error: they used to be
        // appended to a result that was then discarded, so the model saw only
        // "timed out" and never the suggestion to background it.
        resolve({
          success: false,
          error: [
            moveFailed
              ? `Command was still running after ${timeout}ms and could not be moved to the background (too many background shells — killbash one), so it was killed.`
              : `Command timed out after ${timeout}ms (the timeout you set) and was killed.`,
            "",
            output === "(no output)"
              ? "(no output before the kill)"
              : `Output before the kill:\n${tailChars(output, MOVED_OUTPUT_CHARS)}`,
            "",
            "If it is long-running by design, re-run it with run_in_background: true, or without a timeout so it moves to the background by itself.",
          ].join("\n"),
          code: `TIMEOUT_${timeout}`,
        });
        return;
      }

      resolve({ success: true, result });
    }

    function onError(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        success: false,
        error: `Error executing command: ${err.message}`,
      });
    }
    child.on("error", onError);
  });
}

// =============================================================================
// BashTool - Built with buildTool() factory
// =============================================================================

export const BashTool: Tool<BashParams> = buildTool({
  id: "bash",
  description: BASH_DESCRIPTION,
  schemas: {
    parameters: bashSchema,
  },
  permissions: {
    operations: ["shell"],
    requiresApproval: true,
  },
  behavior: {
    isConcurrencySafe: false,
    // A shell command can mutate the filesystem (sed -i, git apply, a
    // codemod), so this must read the same as write/edit: triggers the
    // verify gate, counts toward stagnation, and is not safely retryable.
    isDestructive: true,
    interruptBehavior: "await",
    userFacingName: "Bash",
  },
  execute: executeBash,
  validateInput: validateBashInput,
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: false }),
});
