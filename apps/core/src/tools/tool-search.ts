// =============================================================================
// ToolSearch Tool — find and load deferred MCP tools.
// Spec: docs/specs/2026-10-10-deferred-tool-loading.md §4.2 path B
//
// Ranks MCP tools with the memory store's BM25 over name, description and
// schema text. Loading is not a side effect here: the result lists what it
// loaded, and the loop reads that back out of history (`loadedFromHistory`),
// so the next request declares those tools.
//
// The description never lists the deferred tools, so it stays byte-stable as
// MCP servers connect — the tool list sits in front of the cached prefix.
// =============================================================================

import type { ToolContext } from "./types.js";
import type { Tool, ToolExecutionResult, JsonSchema } from "./tool.types.js";
import { buildTool } from "./factory.js";
import { Bm25Index } from "../memory/bm25.js";
import {
  DEFAULT_TOOL_SEARCH_LIMIT,
  TOOL_SEARCH_TOOL,
  formatSearchResult,
} from "./deferral.js";

interface ToolSearchParams {
  query: string;
  limit?: number;
}

const toolSearchSchema: JsonSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "What the tool should do, in plain words, or part of its name (e.g. 'figma design context', 'github issues').",
    },
    limit: {
      type: "number",
      description: `Maximum number of tools to load. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.`,
    },
  },
  required: ["query"],
};

/** Schema descriptions and property names, recursively. */
function schemaText(schema: unknown, parts: string[]): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const s = schema as Record<string, unknown>;
  if (typeof s.description === "string") parts.push(s.description);
  if (s.properties && typeof s.properties === "object") {
    for (const [name, prop] of Object.entries(s.properties)) {
      parts.push(name);
      schemaText(prop, parts);
    }
  }
  schemaText(s.items, parts);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = s[key];
    if (Array.isArray(variants)) for (const v of variants) schemaText(v, parts);
  }
}

/** Rank MCP tools for a query. Exported for tests. */
export function searchMcpTools(
  query: string,
  limit: number,
  candidates: readonly Tool[],
): { name: string; description: string }[] {
  const entries = candidates.map((t) => {
    const parts: string[] = [];
    schemaText(t.schemas.parameters, parts);
    return {
      name: t.id,
      // `mcp__server__tool` → "server tool", so the server name is searchable.
      description: `${t.id.replace(/^mcp__/, "").replace(/__/g, " ")} ${t.description}`,
      content: parts.join(" "),
    };
  });
  const index = new Bm25Index(entries, (e) => e.name);
  const byName = new Map(candidates.map((t) => [t.id, t]));
  return index.search(query, limit).map((hit) => ({
    name: hit.id,
    description: byName.get(hit.id)?.description ?? "",
  }));
}

function validateToolSearchInput(
  params: unknown,
): { valid: true } | { valid: false; error: string } {
  if (!params || typeof params !== "object") {
    return { valid: false, error: "Expected object parameters" };
  }
  const p = params as Record<string, unknown>;
  if (typeof p.query !== "string" || p.query.trim().length === 0) {
    return { valid: false, error: "query is required and must not be empty" };
  }
  return { valid: true };
}

async function executeToolSearch(
  params: ToolSearchParams,
  _ctx: ToolContext,
): Promise<
  ToolExecutionResult<{
    title: string;
    output: string;
    metadata?: Record<string, unknown>;
  }>
> {
  // Providers like MiniMax send numbers as strings.
  const raw = Number(params.limit ?? DEFAULT_TOOL_SEARCH_LIMIT);
  const limit =
    Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_TOOL_SEARCH_LIMIT;
  // Lazy: index.ts registers this tool, so a static import is a cycle.
  const { getMcpTools } = await import("./index.js");
  const matches = searchMcpTools(
    params.query,
    limit,
    Object.values(getMcpTools()),
  );
  return {
    success: true,
    result: {
      title: params.query.slice(0, 50),
      output: formatSearchResult(matches),
      metadata: { loaded: matches.map((m) => m.name) },
    },
  };
}

export const ToolSearchTool: Tool<ToolSearchParams> = buildTool({
  id: TOOL_SEARCH_TOOL,
  description:
    "Search for tools that are not loaded yet and load the matches. Tools from MCP servers are not provided upfront: when a task needs one, call this with a short description of what the tool should do. Matching tools become callable from your next call.",
  schemas: {
    parameters: toolSearchSchema,
  },
  permissions: {
    operations: [],
    requiresApproval: false,
  },
  behavior: {
    isConcurrencySafe: true,
    isDestructive: false,
    interruptBehavior: "await",
    userFacingName: "ToolSearch",
  },
  execute: executeToolSearch,
  validateInput: validateToolSearchInput,
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
});
