// =============================================================================
// agent({ continue }) — run a finished sub-agent's next assignment.
//
// The new generation is a fork of the finished agent's session, so it keeps
// the whole investigation, and it runs exactly as the original was spawned:
// same type, mode and model. Changing any of those mid-history would be a new
// agent wearing an old transcript, so the call cannot. Spec
// 2026-09-27-agent-control-and-definitions.md §4.
// =============================================================================

import type { AgentRegistry, AgentSpawnConfig } from "../agent/registry/registry.js";

/** Fields that would change how the continuation runs; refused with `continue`. */
const FIXED = ["subagent_type", "model", "agentType", "readOnly", "forkContext"] as const;

export function resolveContinuation(
  params: Record<string, unknown>,
  callerSessionId: string | undefined,
  agents: AgentRegistry,
): { sourceId: string; config: AgentSpawnConfig } | { error: string } {
  const sourceId = String(params.continue).trim();
  const given = FIXED.filter((k) => params[k] !== undefined);
  if (given.length) {
    return {
      error: `continue keeps the original agent's type, mode and model; drop ${given.join(", ")}, or start a new agent to change them.`,
    };
  }
  const agent = agents.get(sourceId);
  if (!agent || agent.parentId !== callerSessionId) {
    // Models reach for the type name ("explorer"); ids are opaque (a forked
    // or continued agent's is a bare UUID), so always say where to find one.
    return {
      error: `No agent ${sourceId} started by this session. continue takes the agent's id from the "Agent id:" line of its result, not its type.`,
    };
  }
  if (agent.status === "running") {
    return { error: `${sourceId} is still running. Use agent_send to add to its task.` };
  }
  if (agents.stoppedByParent(sourceId)) {
    return { error: `You stopped ${sourceId} with agent_stop. Start a new agent instead.` };
  }
  const config = agents.spawnConfigOf(sourceId);
  if (!config) {
    return { error: `${sourceId} cannot be continued: it did not finish starting.` };
  }
  return { sourceId, config };
}
