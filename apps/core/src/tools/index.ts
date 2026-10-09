import { ReadTool } from "./read.js";
import { WriteTool } from "./write.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { EditTool } from "./edit.js";
import { BashTool } from "./bash.js";
import { BashOutputTool } from "./bashoutput.js";
import { KillBashTool } from "./killbash.js";
import { AgentSendTool, AgentStopTool } from "./agent-control.js";
import { MonitorTool } from "./monitor.js";
import { SkillTool } from "./skill.js";
import { AgentTool } from "./agent.js";
import { QuestionTool } from "./question.js";
import { WebFetchTool } from "./webfetch.js";
import { WebSearchTool } from "./websearch.js";
import { TodoWriteTool } from "./todo.js";
import { LspTool } from "./lsp.js";
import { LsTool } from "./ls.js";
import { OutputTool } from "./output.js";
import { MemoryTool } from "./memory.js";
import { FinishIterationTool } from "./finish-iteration.js";
import { ToolSearchTool } from "./tool-search.js";
import {
  createToolOrchestrator,
  type ToolOrchestrator,
} from "./orchestrator.js";
import type {
  ToolContext,
  ToolResult,
  JsonSchema,
  FileCache,
  FileCacheEntry,
  PermissionProfile,
} from "./types.js";
import type {
  Tool,
  ToolBehavior,
  ToolPermissions,
  ToolExecutionResult,
  ValidationResult,
  PermissionCheckResult,
} from "./tool.types.js";
import {
  buildTool,
  defaultBehavior,
  executeTool,
} from "./factory.js";

export type {
  ToolContext,
  ToolResult,
  JsonSchema,
  FileCache,
  FileCacheEntry,
  PermissionProfile,
};
export type {
  Tool,
  ToolBehavior,
  ToolPermissions,
  ToolExecutionResult,
  ValidationResult,
  PermissionCheckResult,
};
export type { ToolOrchestrator };

const mcpTools: Record<string, Tool> = {};

export const tools = {
  read: ReadTool,
  write: WriteTool,
  glob: GlobTool,
  grep: GrepTool,
  edit: EditTool,
  bash: BashTool,
  bashoutput: BashOutputTool,
  killbash: KillBashTool,
  agent_send: AgentSendTool,
  agent_stop: AgentStopTool,
  monitor: MonitorTool,
  skill: SkillTool,
  agent: AgentTool,
  question: QuestionTool,
  webfetch: WebFetchTool,
  websearch: WebSearchTool,
  todowrite: TodoWriteTool,
  lsp: LspTool,
  ls: LsTool,
  output: OutputTool,
  memory: MemoryTool,
  // Unattended runs only. Deliberately absent from the provider-facing tool
  // list unless the loop has an unattended context — see defs-cache.ts.
  finish_iteration: FinishIterationTool,
  // Offered only while MCP tools are deferred — see tools/deferral.ts.
  tool_search: ToolSearchTool,
} as const;

export type ToolId = keyof typeof tools;

export function registerMcpTool(tool: Tool): void {
  mcpTools[tool.id] = tool;
}

export function unregisterMcpTools(prefix: string): void {
  for (const key of Object.keys(mcpTools)) {
    if (key.startsWith(prefix)) {
      delete mcpTools[key];
    }
  }
}

export function getMcpTools(): Record<string, Tool> {
  return { ...mcpTools };
}

// Extension tools (spec 2026-09-20-pi-parity-plan, Phase 5): the same
// dynamic slot as MCP tools, keyed by the id the model sees. Built-ins win a
// name collision — an extension cannot shadow `bash`.
const extensionTools: Record<string, Tool> = {};

export function registerExtensionTool(tool: Tool): void {
  if (tools[tool.id as ToolId]) {
    throw new Error(`Extension tool "${tool.id}" collides with a built-in tool`);
  }
  extensionTools[tool.id] = tool;
}

export function unregisterExtensionTool(id: string): void {
  delete extensionTools[id];
}

export function getTool(id: string): Tool | undefined {
  if (tools[id as ToolId]) return tools[id as ToolId] as Tool;
  return mcpTools[id] ?? extensionTools[id];
}

export function listTools(): {
  id: string;
  description: string;
  parameters: JsonSchema;
}[] {
  const builtIn = Object.values(tools).map((t) => ({
    id: t.id,
    description: t.description,
    parameters: t.schemas.parameters,
  }));

  const mcp = Object.values(mcpTools).map((t) => ({
    id: t.id,
    description: t.description,
    parameters: t.schemas.parameters,
  }));

  const extension = Object.values(extensionTools).map((t) => ({
    id: t.id,
    description: t.description,
    parameters: t.schemas.parameters,
  }));

  return [...builtIn, ...mcp, ...extension];
}

export { createToolOrchestrator };
export { buildTool, defaultBehavior, executeTool };
