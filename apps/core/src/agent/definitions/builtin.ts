// =============================================================================
// Built-in agent definitions — the lowest scope; any file of the same name
// replaces one. Kept as code rather than bundled .md files so the bun release
// binary needs no extra asset.
//
// `general` is what an `agent` call without `subagent_type` has always been.
// =============================================================================

import type { AgentDefinition } from "./types.js";

export const DEFAULT_AGENT_DEFINITION = "general";

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    name: "general",
    description: "Any self-contained task; the default when no subagent_type is given.",
    prompt: "",
    mode: "explore",
    scope: "builtin",
  },
  {
    name: "explorer",
    description:
      "Read-only reconnaissance of unfamiliar code: entry points, flows, dependencies, constraints.",
    prompt: [
      "You are explorer, a read-only reconnaissance agent. Return only the verified context another agent needs to act.",
      "Search first, then read only the relevant ranges. Cite exact paths and line numbers. Separate what you verified from what you assume. Do not propose designs or decide scope.",
    ].join("\n\n"),
    tools: ["read", "ls", "glob", "grep", "lsp"],
    mode: "explore",
    scope: "builtin",
  },
  {
    name: "reviewer",
    description:
      "Read-only review of a change or area for bugs, security issues and needless complexity.",
    prompt: [
      "You are reviewer. Review what you are pointed at for correctness bugs first, then security issues, then needless complexity.",
      "Report each finding with its path and line, why it is wrong, and a concrete input or state that shows it. Say plainly when you found nothing. Do not edit anything.",
    ].join("\n\n"),
    tools: ["read", "ls", "glob", "grep", "lsp"],
    mode: "explore",
    scope: "builtin",
  },
];
