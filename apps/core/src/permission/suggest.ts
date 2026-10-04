// =============================================================================
// Suggested-rule generation for "always allow" in permission prompts
// Spec: docs/specs/2026-07-18-permission-rules.md §6
// =============================================================================

import * as path from "path";
import { ATTACH_PATTERN, COMMAND_TOOLS, extractTarget } from "./rules.js";

const DISPLAY_NAMES: Record<string, string> = {
  read: "Read",
  ls: "Ls",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  bash: "Bash",
  bashoutput: "BashOutput",
  killbash: "KillBash",
  agent_send: "AgentSend",
  agent_stop: "AgentStop",
  monitor: "Monitor",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  agent: "Agent",
  skill: "Skill",
  output: "Output",
  memory: "Memory",
  finish_iteration: "FinishIteration",
  codemode: "Codemode",
  mcp: "MCP",
};

function displayName(toolName: string): string {
  if (toolName.toLowerCase().startsWith("mcp__")) return DISPLAY_NAMES.mcp;
  return DISPLAY_NAMES[toolName.toLowerCase()] ?? toolName;
}

/**
 * Generate a rule the user can persist to "always allow" calls like this one.
 * bash → first two words + ":*"; paths → the literal path; webfetch → domain.
 */
export function suggestRule(
  toolName: string,
  args: Record<string, unknown>,
  projectRoot: string,
): string {
  const tool = toolName.toLowerCase();
  const name = displayName(toolName);
  const target = extractTarget(tool, args);

  if (COMMAND_TOOLS.has(tool) && target) {
    const prefix = target.trim().split(/\s+/).slice(0, 2).join(" ");
    return `${name}(${prefix}:*)`;
  }
  if (COMMAND_TOOLS.has(tool) && typeof args.bash_id === "string") {
    return `${name}(${ATTACH_PATTERN})`;
  }
  if (tool === "webfetch" && target) {
    try {
      return `${name}(domain:${new URL(target).hostname})`;
    } catch {
      return name;
    }
  }
  if (["read", "write", "edit", "glob", "grep"].includes(tool) && target) {
    const abs = path.resolve(projectRoot, target);
    const rel = path.relative(projectRoot, abs);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return `${name}(./${rel})`;
    return `${name}(/${abs})`; // "//abs/path" absolute-anchor form
  }
  return name; // name-level rule (agent, mcp tools, etc.)
}
