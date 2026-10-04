// =============================================================================
// Codemode discovery globals — searchTools() and describeTool() (spec
// 2026-10-05-codemode.md §5). The codemode description inlines no tool
// declarations (§3.1), so these are how a script finds a tool it was not
// told about (MCP) and learns its argument shape without growing the prompt.
// =============================================================================

import {
  renderToolSample,
  toCodemodeIdentifier,
  type CodemodeTool as SandboxTool,
} from "@earendil-works/pi-codemode";
import { Bm25Index } from "../memory/bm25.js";
import type { MemoryEntry } from "../memory/mem-types.js";
import type { ProviderToolDef } from "../tools/defs-cache.js";

export const DEFAULT_SEARCH_LIMIT = 8;

export interface ToolHit {
  name: string;
  description: string;
}

function firstLine(text: string): string {
  return text.split("\n")[0].slice(0, 200);
}

/**
 * BM25 over name + description, reusing the memory store's scorer: a tool is
 * shaped like a memory entry (a name, a description) and the corpus is the
 * same size — a few dozen to a few hundred short documents.
 */
export function searchToolDefs(
  defs: readonly ProviderToolDef[],
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): ToolHit[] {
  const index = new Bm25Index(
    defs.map((d) => ({ name: d.name, description: d.description, content: "" }) as MemoryEntry),
    (e) => e.name,
  );
  const byName = new Map(defs.map((d) => [d.name, d]));
  const ranked = index.search(query, limit).map((h) => byName.get(h.id)!);
  // BM25 drops short and stop-word terms; a bare "lsp" or "ls" would find
  // nothing. A name containing the query is the obvious fallback.
  const hits =
    ranked.length > 0
      ? ranked
      : defs.filter((d) => d.name.toLowerCase().includes(query.toLowerCase().trim())).slice(0, limit);
  return hits.map((d) => ({
    name: toCodemodeIdentifier(d.name),
    description: firstLine(d.description),
  }));
}

/** `undefined` for an unknown tool. Accepts the raw name or the identifier. */
export function describeToolDef(
  defs: readonly ProviderToolDef[],
  name: string,
): string | undefined {
  const def = defs.find((d) => d.name === name || toCodemodeIdentifier(d.name) === name);
  if (!def) return undefined;
  return renderToolSample({
    name: def.name,
    description: def.description,
    inputSchema: def.parameters,
  });
}

/** The sandbox globals, over the same tool list the script's `tools` has. */
export function discoveryGlobals(defs: readonly ProviderToolDef[]): SandboxTool[] {
  return [
    {
      name: "searchTools",
      description: "Rank callable tools by relevance to a query.",
      spread: true,
      signature: "(query: string, options?: { limit?: number }): Promise<Array<{ name: string; description: string }>>",
      execute: (args) => {
        const [query, options] = args as [unknown, { limit?: unknown } | undefined];
        const limit =
          typeof options?.limit === "number" && options.limit > 0
            ? Math.floor(options.limit)
            : DEFAULT_SEARCH_LIMIT;
        return searchToolDefs(defs, String(query ?? ""), limit);
      },
    },
    {
      name: "describeTool",
      description: "A tool's description and TypeScript declaration, or undefined.",
      spread: true,
      signature: "(name: string): Promise<string | undefined>",
      execute: (args) => describeToolDef(defs, String((args as unknown[])[0] ?? "")),
    },
  ];
}
