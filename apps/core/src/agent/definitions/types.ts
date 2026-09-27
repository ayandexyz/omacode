// =============================================================================
// Agent definition — a named role the `agent` tool can spawn (`subagent_type`).
// =============================================================================

export type AgentDefinitionScope =
  | "builtin"
  | "claude-code-user"
  | "user"
  | "claude-code-project"
  | "project";

export interface AgentDefinition {
  name: string;
  /** One line: when to use it. Listed to the model in the system prompt. */
  description: string;
  /** The role's instructions; added to the subagent's system prompt. Empty = none. */
  prompt: string;
  /**
   * Allowlist of FreeCode tool names. Intersected with what the subagent's
   * mode allows, so it can narrow the set but never widen it. Undefined = the
   * mode's full set.
   */
  tools?: string[];
  /** `provider/model` to run on; undefined inherits the parent's. */
  model?: string;
  /** explore = read-only; build = may write, inheriting the parent's mode. */
  mode: "explore" | "build";
  scope: AgentDefinitionScope;
  /** File it came from; absent for built-ins. */
  location?: string;
}

/** What a spawned subagent's loop needs from its definition. */
export interface AgentRole {
  name: string;
  prompt: string;
  tools?: string[];
}
