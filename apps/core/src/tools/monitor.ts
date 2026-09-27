// =============================================================================
// Monitor Tool — watch a long-running command and hear about it as it happens.
//
// `bash(run_in_background)` reports once, at exit. A monitor reports DURING
// the run: every output line (or every line matching `pattern`) reaches the
// model as a `<task-notification>` event, so an agent watching a three-hour
// eval can act on the first FAIL instead of reading the wreckage at the end.
// Claude Code's `Monitor` is the model for this.
//
// It is a background shell underneath — same registry, same /shells row, same
// `killbash` — plus a line splitter and three guard rails, because every event
// on an idle session is a paid turn:
//   - lines are batched for FLUSH_MS, so a burst is one event, not fifty;
//   - after MAX_EVENTS events the monitor stops itself and says why;
//   - `timeout_ms` (default 5 min, max 60) bounds how long it can run.
// =============================================================================

import * as path from "path";
import type { ToolContext } from "./types.js";
import type { Tool, ToolExecutionResult, JsonSchema } from "./tool.types.js";
import { buildTool } from "./factory.js";
import { trackShell } from "./bash.js";
import { getShellRegistry } from "./shells/index.js";
import {
  notifyTask,
  taskNotificationsEnabled,
} from "../agent/task-notify.js";

interface MonitorParams {
  command: string;
  description: string;
  pattern?: string;
  timeout_ms?: number;
  workdir?: string;
}

type MonitorResult = ToolExecutionResult<{
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
}>;

export const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;
export const MAX_MONITOR_TIMEOUT_MS = 3_600_000;
/** Lines arriving within this window become one event. */
export const FLUSH_MS = 1_000;
/** Events before the monitor stops itself — a filter that is too loose. */
export const MAX_EVENTS = 20;
/** Lines carried per event; the rest are counted, and bashoutput has them. */
const MAX_LINES_PER_EVENT = 20;
const MAX_LINE_CHARS = 300;

const monitorSchema: JsonSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "Shell command to run and watch, e.g. `pnpm eval coding` or `tail -f build.log`.",
    },
    description: {
      type: "string",
      description:
        "Short name for what is being watched; shown in every event (e.g. 'coding eval failures').",
    },
    pattern: {
      type: "string",
      description:
        "Optional regex: only matching lines become events (e.g. 'FAIL|Error|Traceback|done'). Include failure signatures, not just success — silence looks like 'still fine'. Without it, every line is an event.",
    },
    timeout_ms: {
      type: "number",
      description: `Stop watching after this long (default ${DEFAULT_MONITOR_TIMEOUT_MS}, max ${MAX_MONITOR_TIMEOUT_MS}).`,
    },
    workdir: { type: "string", description: "Working directory." },
  },
  required: ["command", "description"],
};

function validateMonitorInput(
  params: unknown,
): { valid: true } | { valid: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.command !== "string" || !p.command.trim()) {
    return { valid: false, error: "command is required" };
  }
  if (typeof p.description !== "string" || !p.description.trim()) {
    return { valid: false, error: "description is required" };
  }
  if (p.timeout_ms !== undefined && !Number.isFinite(Number(p.timeout_ms))) {
    return { valid: false, error: "timeout_ms must be a number" };
  }
  return { valid: true };
}

/** A regex when it compiles, else a literal substring match. */
export function lineMatcher(pattern: string | undefined): (line: string) => boolean {
  if (!pattern) return () => true;
  try {
    const re = new RegExp(pattern);
    return (line) => re.test(line);
  } catch {
    return (line) => line.includes(pattern);
  }
}

async function executeMonitor(
  params: MonitorParams,
  ctx: ToolContext,
): Promise<MonitorResult> {
  const sessionId = ctx.sessionId;
  if (!sessionId) {
    return { success: false, error: "monitor needs a session." };
  }
  const cwd = params.workdir
    ? path.resolve(ctx.cwd, params.workdir)
    : ctx.cwd;
  if (!taskNotificationsEnabled(ctx.projectPath ?? cwd)) {
    return {
      success: false,
      error:
        "monitor reports through task notifications, which are off (tasks.notify / FREECODE_TASK_NOTIFY). Use bash with run_in_background: true and read it with bashoutput instead.",
    };
  }
  const asked = Number(params.timeout_ms ?? DEFAULT_MONITOR_TIMEOUT_MS);
  const timeoutMs = Math.min(
    asked > 0 ? asked : DEFAULT_MONITOR_TIMEOUT_MS,
    MAX_MONITOR_TIMEOUT_MS,
  );
  const matches = lineMatcher(params.pattern);
  const registry = getShellRegistry(sessionId);

  let partial = "";
  let pending: string[] = [];
  let dropped = 0;
  let events = 0;
  let flushTimer: NodeJS.Timeout | undefined;
  let stopReason: string | undefined;
  let shellId = "";

  const take = (line: string): void => {
    if (!matches(line)) return;
    if (pending.length >= MAX_LINES_PER_EVENT) {
      dropped++;
      return;
    }
    pending.push(
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line,
    );
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  };

  function flush(): void {
    flushTimer = undefined;
    if (pending.length === 0 || stopReason) return;
    const lines = pending;
    const more = dropped;
    pending = [];
    dropped = 0;
    events++;
    notifyTask(sessionId!, {
      taskId: shellId,
      kind: "monitor",
      status: "event",
      summary: params.description,
      result: more > 0 ? `${lines.join("\n")}\n… ${more} more matching lines` : lines.join("\n"),
      // Stopped by the model with killbash since: it no longer wants these.
      isStale: () => registry.modelKnowsEnd(shellId),
    });
    if (events >= MAX_EVENTS) {
      stopReason = `stopped after ${MAX_EVENTS} events — the filter is too loose; narrow \`pattern\` and start a new monitor`;
      registry.kill(shellId);
    }
  }

  let tracked;
  try {
    tracked = trackShell(
      { command: params.command },
      ctx,
      cwd,
      sessionId,
      (reg, options) => reg.start(options),
      {
        onData: (_id, chunk) => {
          const lines = (partial + chunk).split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) take(line.replace(/\r$/, ""));
        },
        onExit: (id, status, exitCode) => {
          clearTimeout(timeout);
          if (partial) take(partial);
          partial = "";
          if (flushTimer) clearTimeout(flushTimer);
          flush();
          if (registry.modelKnowsEnd(id)) return;
          notifyTask(sessionId, {
            taskId: id,
            kind: "monitor",
            status,
            summary: params.description,
            result: [
              `Monitor ended${stopReason ? `: ${stopReason}` : ""}.`,
              `Exit code: ${exitCode ?? "none (stopped by a signal)"}`,
              `${events} event(s) were sent. bashoutput(bash_id: "${id}") has the full output.`,
            ].join("\n"),
            isStale: () => registry.modelKnowsEnd(id),
          });
        },
        notifyOnExit: false,
        kind: "monitor",
      },
    );
  } catch (error) {
    return { success: false, error: String((error as Error).message ?? error) };
  }
  shellId = tracked.shell.id;
  const timeout = setTimeout(() => {
    stopReason = `timed out after ${Math.round(timeoutMs / 1000)}s`;
    registry.kill(shellId);
  }, timeoutMs);
  timeout.unref();

  return {
    success: true,
    result: {
      title: params.description.slice(0, 50),
      output: [
        `Monitoring as ${shellId}: ${params.description}.`,
        "",
        params.pattern
          ? `Each batch of lines matching /${params.pattern}/ reaches you as a <task-notification> event while it runs; one more arrives when it ends.`
          : "Each batch of output lines reaches you as a <task-notification> event while it runs; one more arrives when it ends.",
        `It stops by itself after ${Math.round(timeoutMs / 1000)}s or ${MAX_EVENTS} events. Do not poll: carry on, or end your turn.`,
        `Stop it early with killbash(bash_id: "${shellId}").`,
      ].join("\n"),
      metadata: {
        background: true,
        monitor: true,
        shellId,
        command: params.command,
        pattern: params.pattern,
        timeoutMs,
      },
    },
  };
}

export const MonitorTool: Tool<MonitorParams> = buildTool({
  id: "monitor",
  description: `Run a command in the background and get notified about its output WHILE it runs — each line, or each line matching \`pattern\`, arrives as a <task-notification> event (batched per second). One final notification arrives when it ends.

Use it to watch something long and act on it as it happens: a multi-hour test or eval run ("tell me the first failure"), a deploy, a log file (\`tail -f app.log\`).
- Prefer \`bash\` with run_in_background when you only need the result at the end — that reports once, at exit.
- Give \`pattern\` so only lines worth acting on become events, and include failure signatures (\`FAIL|Error|Traceback\`), not just the success line.
- It stops itself after \`timeout_ms\` (default 5 min, max 60) or ${MAX_EVENTS} events. Stop it with killbash.`,
  schemas: { parameters: monitorSchema },
  permissions: {
    operations: ["shell"],
    requiresApproval: true,
  },
  behavior: {
    isConcurrencySafe: false,
    // Runs an arbitrary command, same as bash.
    isDestructive: true,
    interruptBehavior: "await",
    userFacingName: "Monitor",
  },
  execute: executeMonitor,
  validateInput: validateMonitorInput,
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: false }),
});
