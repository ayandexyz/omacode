// =============================================================================
// agent_send / agent_stop — the spawner's controls over a running subagent.
//
// Before these, only the user could stop a subagent (`k` in /agents); the model
// that started a background agent could neither correct it nor cancel it. The
// shape is killbash's: an id from the spawn result, a model-readable answer
// for every miss, never a throw.
//
// Only the direct parent may use them. A subagent's own session is a different
// id, so it cannot reach its parent or a sibling.
// =============================================================================

import type { ToolContext } from "./types.js";
import type { Tool, ToolExecutionResult, JsonSchema } from "./tool.types.js";
import { buildTool } from "./factory.js";
import { getAgentRegistry } from "../agent/registry/index.js";
import type { AgentSummary } from "../agent/registry/types.js";

/** Activity handed back by agent_stop, like a timed-out bash's partial output. */
const STOP_TAIL_CHARS = 2_000;

type ControlResult = ToolExecutionResult<{
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
}>;

interface SendParams {
  agent_id: string;
  message: string;
}

interface StopParams {
  agent_id: string;
}

const agentIdProp = {
  type: "string",
  description: "The id the agent tool returned, e.g. subagent-1727…",
} as const;

function answer(id: string, output: string, metadata: Record<string, unknown>): ControlResult {
  return { success: true, result: { title: id, output, metadata: { agentId: id, ...metadata } } };
}

/** The agent, if the caller is the one that started it; else why not. */
function ownAgent(id: string, ctx: ToolContext): AgentSummary | string {
  const agent = getAgentRegistry().get(id);
  if (!agent || agent.parentId !== ctx.sessionId) {
    return `No agent ${id} started by this session.`;
  }
  if (agent.status !== "running") {
    return `${id} has already ended (${agent.status}); its result is in its task notification.`;
  }
  return agent;
}

function validate(
  params: unknown,
  fields: string[],
): { valid: true } | { valid: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  for (const f of fields) {
    if (typeof p[f] !== "string" || !(p[f] as string).trim()) {
      return { valid: false, error: `${f} is required and must be a non-empty string` };
    }
  }
  return { valid: true };
}

async function executeSend(params: SendParams, ctx: ToolContext): Promise<ControlResult> {
  const agent = ownAgent(params.agent_id, ctx);
  if (typeof agent === "string") return answer(params.agent_id, agent, { sent: false });
  getAgentRegistry().send(agent.id, params.message);
  return answer(
    agent.id,
    `Sent to ${agent.id}. It reads it after its current step and carries on with it in mind. Its result still arrives as a <task-notification>; do not poll.`,
    { sent: true },
  );
}

async function executeStop(params: StopParams, ctx: ToolContext): Promise<ControlResult> {
  const agent = ownAgent(params.agent_id, ctx);
  if (typeof agent === "string") return answer(params.agent_id, agent, { stopped: false });
  const registry = getAgentRegistry();
  const tail = registry.tail(agent.id, STOP_TAIL_CHARS).trim();
  const stopped = registry.stop(agent.id, true);
  return answer(
    agent.id,
    [
      `Stopped ${agent.id} (${agent.task}). No task notification will follow.`,
      tail ? `\nIts last activity:\n${tail}` : "\nIt had not done anything yet.",
    ].join("\n"),
    { stopped },
  );
}

const sendSchema: JsonSchema = {
  type: "object",
  properties: {
    agent_id: agentIdProp,
    message: {
      type: "string",
      description: "What to tell it: a correction, a narrower scope, extra context.",
    },
  },
  required: ["agent_id", "message"],
};

const stopSchema: JsonSchema = {
  type: "object",
  properties: { agent_id: agentIdProp },
  required: ["agent_id"],
};

export const AgentSendTool: Tool<SendParams> = buildTool({
  id: "agent_send",
  description:
    "Send a message to a running sub-agent you started (usually a background one): change its task, narrow its scope, or give it context it lacked. It reads the message after its current step. Only for an agent that is still running; to cancel one, use agent_stop.",
  schemas: { parameters: sendSchema },
  permissions: { operations: ["agent.spawn"], requiresApproval: false },
  behavior: {
    isConcurrencySafe: false,
    isDestructive: false,
    interruptBehavior: "await",
    userFacingName: "AgentSend",
  },
  execute: executeSend,
  validateInput: (p) => validate(p, ["agent_id", "message"]),
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: false }),
});

export const AgentStopTool: Tool<StopParams> = buildTool({
  id: "agent_stop",
  description:
    "Stop a running sub-agent you started. Returns its last activity; no task notification follows. Use it when its work is no longer wanted — to change what it is doing, agent_send is cheaper.",
  schemas: { parameters: stopSchema },
  permissions: { operations: ["agent.spawn"], requiresApproval: false },
  behavior: {
    isConcurrencySafe: false,
    isDestructive: false,
    interruptBehavior: "await",
    userFacingName: "AgentStop",
  },
  execute: executeStop,
  validateInput: (p) => validate(p, ["agent_id"]),
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: false }),
});
