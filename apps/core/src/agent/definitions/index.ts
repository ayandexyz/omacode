// =============================================================================
// Agent definitions — the roster for a project, and how the model sees it.
//
// The roster goes in the system prompt, not the `agent` tool's description:
// tool definitions are process-wide (tools/defs-cache.ts) while definitions are
// per project, and the system prompt is compiled per project already. It is
// byte-stable until a file changes, so the cached prefix holds.
// =============================================================================

import { listTools } from "../../tools/index.js";
import { loadAgentDefinitions } from "./loader.js";
import type { AgentDefinition } from "./types.js";

export type { AgentDefinition, AgentRole, AgentDefinitionScope } from "./types.js";
export { DEFAULT_AGENT_DEFINITION } from "./builtin.js";
export { loadAgentDefinitions, parseAgentFile } from "./loader.js";

function knownTools(): Set<string> {
  return new Set(listTools().map((t) => t.id));
}

export function getAgentDefinitions(projectPath: string): AgentDefinition[] {
  return loadAgentDefinitions({ projectPath, knownTools: knownTools() }).definitions;
}

export function findAgentDefinition(
  projectPath: string,
  name: string,
): AgentDefinition | undefined {
  return getAgentDefinitions(projectPath).find((d) => d.name === name);
}

/** The system-prompt section naming each definition; one line apiece. */
export function renderAgentTypesSection(projectPath: string): string {
  const defs = getAgentDefinitions(projectPath);
  return [
    "# Sub-agent types",
    "Pass one as `subagent_type` to the agent tool; without it you get `general`.",
    ...defs.map((d) => `- ${d.name}${d.mode === "build" ? " (can edit)" : ""}: ${d.description}`),
  ].join("\n");
}
