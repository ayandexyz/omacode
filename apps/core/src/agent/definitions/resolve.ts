// =============================================================================
// Resolve an `agent` call's definition and model, before anything is created.
//
// Every refusal here is a model-readable error returned before a session
// exists on disk. Unknown names are refused, not ignored: silently ignoring
// them is how a role name passed as `agentType` used to do nothing at all.
// =============================================================================

import { listProviders } from "../../providers/registry.js";
import { DEFAULT_AGENT_DEFINITION } from "./builtin.js";
import { getAgentDefinitions } from "./index.js";
import type { AgentDefinition, AgentRole } from "./types.js";

export interface SpawnRequest {
  subagent_type?: string;
  /** `provider` or `provider/model`. */
  model?: string;
  /** Deprecated alias: a provider id, or (models guess) a definition name. */
  agentType?: string;
}

export interface ResolvedSpawn {
  definition: AgentDefinition;
  /** Undefined for a definition with neither a prompt nor a tool allowlist. */
  role?: AgentRole;
  /** Explicit provider/model from the call or the definition; else inherit. */
  provider?: string;
  model?: string;
}

function parseModel(spec: string, providers: Set<string>): { provider: string; model?: string } | undefined {
  const slash = spec.indexOf("/");
  const provider = slash === -1 ? spec : spec.slice(0, slash);
  const model = slash === -1 ? undefined : spec.slice(slash + 1) || undefined;
  return providers.has(provider) ? { provider, model } : undefined;
}

export function resolveSpawn(
  req: SpawnRequest,
  projectPath: string,
): ResolvedSpawn | { error: string } {
  const defs = getAgentDefinitions(projectPath);
  const providers = new Set(listProviders().map((p) => p.id));

  // The old `agentType` meant a provider, but models pass role names in it.
  // Honour both readings; anything else keeps its old meaning — ignored.
  let typeName = req.subagent_type?.trim();
  let modelSpec = req.model?.trim();
  const alias = req.agentType?.trim();
  if (alias && !typeName && defs.some((d) => d.name === alias)) typeName = alias;
  else if (alias && !modelSpec && parseModel(alias, providers)) modelSpec = alias;

  const name = typeName || DEFAULT_AGENT_DEFINITION;
  const definition = defs.find((d) => d.name === name);
  if (!definition) {
    return {
      error: `Unknown subagent_type "${name}". Available: ${defs.map((d) => d.name).join(", ")}.`,
    };
  }

  const spec = modelSpec || definition.model;
  let chosen: { provider: string; model?: string } | undefined;
  if (spec) {
    chosen = parseModel(spec, providers);
    if (!chosen) {
      const from = modelSpec ? "model" : `the ${definition.name} definition's model`;
      return { error: `Unknown provider in ${from} "${spec}". Use provider or provider/model, e.g. anthropic/claude-opus-5.` };
    }
  }

  const role =
    definition.prompt || definition.tools
      ? { name: definition.name, prompt: definition.prompt, tools: definition.tools }
      : undefined;
  return { definition, role, provider: chosen?.provider, model: chosen?.model };
}
