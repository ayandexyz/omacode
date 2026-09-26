// =============================================================================
// Agent Tool - Spawn a sub-agent with UI rendering
// =============================================================================

import * as path from "path";
import * as os from "os";
import type { ToolContext } from "./types.js";
import type { Tool, ToolExecutionResult, JsonSchema } from "./tool.types.js";
import { buildTool } from "./factory.js";
import { AgentLoop } from "../agent/loop.js";
import { BusEvents } from "../bus/index.js";
import type { AgentMode, HookContext } from "../agent/types.js";
import type { HookRuntime } from "../hooks/runtime.js";
import { createSessionStore, type SessionStore } from "../session/store.js";
import { coerceBoolean } from "./coerce-args.js";
import { createRecorder } from "../rollout/recorder.js";
import { listProviders } from "../providers/registry.js";
import { getAgentRegistry } from "../agent/registry/index.js";
import { disposeSubagentShells } from "./shells/index.js";
import { notifyTask, taskNotificationsEnabled } from "../agent/task-notify.js";

interface AgentParams {
  task: string;
  prompt: string;
  agentType?: string;
  forkContext?: boolean;
  readOnly?: boolean;
  run_in_background?: boolean;
}

type AgentResult = ToolExecutionResult<{
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
}>;

// =============================================================================
// Agent Schema
// =============================================================================

const agentSchema: JsonSchema = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description: "Brief description of the task for the sub-agent",
    },
    prompt: {
      type: "string",
      description: "The actual prompt/instruction for the sub-agent",
    },
    agentType: {
      type: "string",
      description: "Optional: AI provider to use (e.g., 'chatgpt', 'claude')",
    },
    forkContext: {
      type: "boolean",
      description:
        "If true, the sub-agent starts with the full parent conversation forked into its own session, instead of only the task prompt. Use when the sub-agent needs this conversation's context (e.g. continuing complex work) rather than a fresh, isolated investigation.",
    },
    readOnly: {
      type: "boolean",
      description:
        "Defaults to true: the sub-agent runs read-only and physically cannot see write/edit/bash, so it cannot change anything. Set false ONLY when the task is to modify code — the sub-agent then inherits this session's permission mode.",
    },
    run_in_background: {
      type: "boolean",
      description:
        "If true, return immediately and keep working (or end your turn) while the sub-agent runs. Its result arrives later as a <task-notification> message — do not poll or wait for it.",
    },
  },
  required: ["task", "prompt"],
};

// =============================================================================
// Input validation
// =============================================================================

function validateAgentInput(
  params: unknown,
): { valid: true } | { valid: false; error: string } {
  if (!params || typeof params !== "object") {
    return { valid: false, error: "Expected object parameters" };
  }
  const p = params as Record<string, unknown>;
  if (typeof p.task !== "string" || p.task.length === 0) {
    return { valid: false, error: "task is required" };
  }
  if (typeof p.prompt !== "string" || p.prompt.length === 0) {
    return { valid: false, error: "prompt is required" };
  }
  if (
    p.forkContext !== undefined &&
    coerceBoolean(p.forkContext) === undefined
  ) {
    return { valid: false, error: "forkContext must be a boolean" };
  }
  if (p.readOnly !== undefined && coerceBoolean(p.readOnly) === undefined) {
    return { valid: false, error: "readOnly must be a boolean" };
  }
  if (
    p.run_in_background !== undefined &&
    coerceBoolean(p.run_in_background) === undefined
  ) {
    return { valid: false, error: "run_in_background must be a boolean" };
  }
  return { valid: true };
}

// =============================================================================
// Execute subagent
// =============================================================================

async function executeSubagent(
  params: AgentParams,
  ctx: ToolContext,
  hooks: HookRuntime,
): Promise<AgentResult> {
  let subagentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const parentSessionId = ctx.sessionId || "unknown";
  const parentRecorder = ctx.sessionId
    ? createRecorder(ctx.sessionId)
    : undefined;
  let sessionStore: SessionStore | undefined;

  // Cheap cap check BEFORE a session exists on disk: `register()` below is
  // what refuses the spawn for real, but it needs the id, and fork() is what
  // mints the id — so without this a refused spawn left a session behind.
  const agents = getAgentRegistry();
  try {
    agents.assertCanRegister(parentSessionId);
  } catch (error) {
    return { success: false, error: String((error as Error).message ?? error) };
  }

  const baseDir = path.join(os.homedir(), ".freecode");
  sessionStore = await createSessionStore(baseDir);
  const forking = coerceBoolean(params.forkContext) && !!ctx.sessionId;
  if (forking) {
    subagentId = await sessionStore.fork(ctx.sessionId!);
  }

  // `agentType` is documented as an optional provider override, not a real
  // "agent type" — but the registry only knows anthropic/openai/gemini/
  // minimax/deepseek/zai, so an unset or bogus value used to default to the
  // unregistered "chatgpt" and throw on the subagent's first turn (known gap
  // #6). Fall back to the parent session's own provider/model instead.
  const registeredIds = new Set(listProviders().map((p) => p.id));
  let provider =
    params.agentType && registeredIds.has(params.agentType)
      ? params.agentType
      : undefined;
  let model: string | undefined;
  if (!provider && ctx.sessionId) {
    const parentMeta = await sessionStore.getMeta(
      ctx.sessionId,
      ctx.projectPath ?? ctx.cwd,
    );
    provider = parentMeta?.provider;
    model = parentMeta?.model;
  }
  const projectPath = ctx.projectPath ?? ctx.cwd;
  // Anything that gives up after this point must not leave the session behind.
  const discardSession = () =>
    sessionStore!.deleteSession(subagentId, projectPath, true).catch(() => {});
  if (!provider) {
    if (forking) await discardSession();
    return {
      success: false,
      error: `agent: no valid provider (agentType "${params.agentType ?? ""}" is not registered, and the parent session has none)`,
    };
  }

  // The store is handed to the subagent's loop, and `appendMessage` is a bare
  // append with no mkdir — so without a session on disk the loop threw ENOENT
  // writing its FIRST user message and died at ~8ms with 0 turns, reported to
  // the model only as "Status: FAILED". `fork()` creates the directory itself,
  // which is why forkContext: true was the only mode that ever worked.
  if (!forking) {
    await sessionStore.createSession(
      {
        title: params.task,
        projectPath: ctx.projectPath ?? ctx.cwd,
        provider,
        model,
      },
      subagentId,
    );
  }

  const hookCtx: HookContext = {
    sessionId: subagentId,
    turnCount: 0,
    toolName: "agent",
  };

  // Background needs a parent session to notify, and notifications switched
  // on: the notification is the only way a background result reaches the
  // model. With them off it runs in the foreground and says so.
  const wantsBackground = coerceBoolean(params.run_in_background) === true;
  const background =
    wantsBackground && !!ctx.sessionId && taskNotificationsEnabled(projectPath);

  // Register BEFORE anything is constructed: the depth and concurrency caps
  // have to be able to refuse the spawn, and the registry is what knows how
  // deep in the tree this parent already is. A refusal is a tool error the
  // model reads and acts on, not an exception.
  const rootId = agents.rootOf(parentSessionId);
  try {
    agents.register({
      id: subagentId,
      parentId: parentSessionId,
      task: params.task,
      prompt: params.prompt,
      background,
      agentType: params.agentType || "agent",
      // Stamped with the ROOT session id: the frontend subscribes to the root
      // and would never see an event addressed to the subagent's own id.
      onActivity: (id, chunk) =>
        BusEvents.stream(rootId, { type: "agent_output", agentId: id, chunk }),
      onExit: (id, status) => {
        if (status === "running") return;
        BusEvents.stream(rootId, { type: "agent_exit", agentId: id, status });
      },
    });
  } catch (error) {
    await discardSession();
    return { success: false, error: String((error as Error).message ?? error) };
  }
  // `k` in the /agents panel settles the record to "killed" before the loop
  // exists (stop() fires the interrupt on attach), so the loop's own result
  // cannot be trusted to say so — the record is the source of truth.
  const killed = () => agents.get(subagentId)?.status === "killed";

  // Read-only unless the spawner opts out. `explore` is not advisory: mutating
  // tools are filtered out of the tool list entirely (tools/defs-cache.ts), so
  // an analysis subagent cannot delete anything even if it decides to try.
  //
  // When it IS allowed to write it inherits the parent's mode rather than
  // hardcoding `build` — under a `danger` parent that used to mean the
  // subagent prompted for permissions the user had already switched off, and
  // the prompt surfaced mid-turn with nothing saying which agent asked.
  const readOnly = coerceBoolean(params.readOnly) ?? true;
  const subagentMode: AgentMode = readOnly
    ? "explore"
    : (ctx.agentMode ?? "build");

  let settleStatus: "completed" | "failed" = "failed";

  BusEvents.stream(rootId, {
    type: "agent_start",
    agentId: subagentId,
    parentId: parentSessionId,
    task: params.task,
    agentType: params.agentType || "agent",
    depth: agents.depthOf(subagentId),
  });

  const runToCompletion = async (): Promise<AgentResult> => {
    try {
      const startResult = await hooks.runSubagentStart(params.task, hookCtx);

      if (startResult.additionalContext) {
        console.log(`[AgentTool] SubagentStart hook added context`);
      }
      // Stopped from the panel while the hook ran: nothing to run.
      if (killed()) throw new Error("interrupted");

      BusEvents.subagentStarted(
        subagentId,
        params.agentType || "agent",
        parentSessionId,
        params.task,
      );
      parentRecorder?.recordSubagentStart(subagentId, params.task);

      const subAgentLoop = new AgentLoop(subagentId, {
        maxIterations: 50,
        hooks,
        sessionStore,
        // Delegated machine work, nothing durable to learn from it — same
        // reasoning as agent/subagent.ts.
        memoryExtraction: false,
        redirect: false,
        autoPoke: false,
        cacheWarming: false,
        // A subagent's edits belong to the parent turn, which is already
        // checkpointed; snapshotting again would add a tree per delegation.
        checkpoints: false,
      });
      // Late-bound because the loop cannot exist until the spawn has been
      // allowed; this is what makes `k` in the /agents panel able to stop it.
      agents.attachInterrupt(subagentId, () => subAgentLoop.interrupt());

      const result = await subAgentLoop.run({
        prompt: params.prompt,
        sessionId: subagentId,
        provider,
        model,
        projectPath,
        agentMode: subagentMode,
      });

      // The loop reports its own interrupt as a clean completion (that is the
      // right answer for a user's Ctrl+C at the top level); a killed subagent
      // is a failure to the parent that delegated to it.
      const interrupted = killed();
      const success = result.success && !interrupted;
      const message = interrupted ? "interrupted" : result.message;

      BusEvents.subagentCompleted(
        subagentId,
        params.agentType || "agent",
        parentSessionId,
        success,
        message,
      );
      parentRecorder?.recordSubagentStop(subagentId, message ?? "");
      settleStatus = success ? "completed" : "failed";

      await hooks.runSubagentStop(params.task, hookCtx);

      // A failure has to carry its reason. Without this the model is handed a
      // bare "Status: FAILED" and can only guess — which is exactly what it did
      // when the missing-session ENOENT above was still live.
      if (!success) {
        console.error(
          `[agent] Subagent ${subagentId} returned failure: ${message ?? "(no message)"}`,
        );
      }
      const output = [
        `Subagent: ${params.task}`,
        `Status: ${success ? "SUCCESS" : "FAILED"}`,
        `Turns: ${result.turnCount}`,
        `Iterations: ${result.iterationCount}`,
        !success && message ? `Reason: ${message}` : "",
        result.content ? `\nOutput:\n${result.content}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        success: true,
        result: {
          title: `Agent: ${params.task}`,
          output,
          metadata: {
            subagentId,
            success,
            turns: result.turnCount,
          },
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[agent] Subagent ${subagentId} failed: ${errorMsg}`);
      settleStatus = "failed";

      BusEvents.subagentCompleted(
        subagentId,
        params.agentType || "agent",
        parentSessionId,
        false,
        errorMsg,
      );
      parentRecorder?.recordSubagentStop(subagentId, errorMsg);

      await hooks.runSubagentStop(
        JSON.stringify({ success: false, error: errorMsg }),
        hookCtx,
      );

      return {
        success: false,
        error: errorMsg,
      };
    } finally {
      // Idempotent, and a no-op when the panel already stopped this agent —
      // `stop()` settles the record itself so the row flips without waiting for
      // the loop to unwind.
      agents.settle(subagentId, settleStatus);
      // A subagent runs under a synthetic session id that `endSession` never
      // sees, so a background shell it started would otherwise outlive it. Its
      // shells live in the root's registry, so take only its own.
      disposeSubagentShells(subagentId);
    }
  };

  if (!background) {
    const result = await runToCompletion();
    if (wantsBackground && result.success) {
      result.result.output +=
        "\n\n(Ran in the foreground: task notifications are off — tasks.notify / FREECODE_TASK_NOTIFY.)";
    }
    return result;
  }

  // The parent's turn does not wait. Whatever happens — success, failure, a
  // stop from /agents — the parent is told, or it would wait on a result
  // that never comes. A session that ended first is dropped by the sink.
  void runToCompletion().then((result) => {
    const status = killed()
      ? "killed"
      : result.success && result.result.metadata?.success
        ? "completed"
        : "failed";
    notifyTask(parentSessionId, {
      taskId: subagentId,
      kind: "agent",
      status,
      summary: params.task,
      result: result.success ? result.result.output : result.error,
    });
  });

  return {
    success: true,
    result: {
      title: `Agent: ${params.task}`,
      output: [
        `Started in the background as ${subagentId}.`,
        "",
        "Its result will arrive as a <task-notification> message when it finishes. Do not poll or wait for it: carry on with other work, or end your turn if there is none.",
      ].join("\n"),
      metadata: { subagentId, background: true },
    },
  };
}

// =============================================================================
// Execute function
// =============================================================================

async function executeAgent(
  params: AgentParams,
  ctx: ToolContext,
): Promise<AgentResult> {
  const hooks = (ctx as any).hooks as HookRuntime | undefined;

  if (!hooks) {
    const { createHookRuntime } = await import("../hooks/runtime.js");
    const defaultHooks = createHookRuntime();
    return executeSubagent(params, ctx, defaultHooks);
  }

  return executeSubagent(params, ctx, hooks);
}

// =============================================================================
// AgentTool - Built with buildTool() factory
// =============================================================================

export const AgentTool: Tool<AgentParams> = buildTool({
  id: "agent",
  description: `Run a task in a sub-agent with its own context window; only its final summary returns here.

Use it when the work would burn context you have no further use for ("find everywhere X is wired up", "why is this test flaky"). Don't use it for work you can do directly — a known read, a single grep, an understood edit is faster inline.

- Put everything it needs in \`prompt\`: it starts cold unless forkContext: true (forks this session into it). Say exactly what you want back.
- It is READ-ONLY by default and cannot write, edit, or run bash. Pass readOnly: false only when the task is to change code; it then runs with this session's permissions.
- It cannot spawn sub-agents of its own. If your task needs delegating twice, do the outer half yourself.
- Its result is not shown to the user — relay what matters yourself.
- run_in_background: true returns at once and delivers the result later as a <task-notification>. Use it for long work you don't need before your next step, or to run several agents in parallel.`,
  schemas: {
    parameters: agentSchema,
  },
  permissions: {
    operations: ["agent.spawn"],
    requiresApproval: true,
  },
  behavior: {
    isConcurrencySafe: false,
    // A subagent runs arbitrary tools of its own and can mutate the
    // filesystem, so this must read the same as write/edit: triggers the
    // verify gate, counts toward stagnation, and is not safely retryable.
    isDestructive: true,
    interruptBehavior: "await",
    userFacingName: "Agent",
  },
  execute: executeAgent,
  validateInput: validateAgentInput,
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: false }),
});
