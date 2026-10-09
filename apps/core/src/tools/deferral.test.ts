// =============================================================================
// Deferred tool loading — spec docs/specs/2026-10-10-deferred-tool-loading.md
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDeferral,
  formatSearchResult,
  loadedFromHistory,
  parseLoadedNames,
  resolveDeferralSettings,
  selectDeferred,
  supportsNativeDeferral,
  TOOL_SEARCH_TOOL,
} from "./deferral.js";
import { searchMcpTools } from "./tool-search.js";
import { getToolDefs, toolSearchDef } from "./defs-cache.js";
import { buildTool } from "./factory.js";
import type { ProviderToolDef } from "./defs-cache.js";
import type { Message } from "../agent/types.js";

const def = (name: string, padding = 0): ProviderToolDef => ({
  name,
  description: `${name} ${"x".repeat(padding)}`,
  parameters: { type: "object", properties: {} },
});

const BUILTINS = [def("read"), def("bash")];
const MCP = [def("mcp__figma__get_code", 4000), def("mcp__figma__get_image", 4000)];
const ON = { enabled: true, minTokens: 1000 };

test("settings: off by default, env beats files", () => {
  assert.equal(resolveDeferralSettings([], {}).enabled, false);
  assert.equal(resolveDeferralSettings([{ enabled: true }], {}).enabled, true);
  assert.equal(
    resolveDeferralSettings([{ enabled: true }], { FREECODE_DEFER_TOOLS: "0" })
      .enabled,
    false,
  );
  assert.equal(resolveDeferralSettings([{ minTokens: 10 }], {}).minTokens, 10);
});

test("selectDeferred: only MCP tools, only when on and over the threshold", () => {
  const offered = [...BUILTINS, ...MCP];
  assert.deepEqual(
    [...selectDeferred(offered, ON)].sort(),
    ["mcp__figma__get_code", "mcp__figma__get_image"],
  );
  assert.equal(selectDeferred(offered, { ...ON, enabled: false }).size, 0);
  assert.equal(selectDeferred(offered, { ...ON, minTokens: 1_000_000 }).size, 0);
  assert.equal(selectDeferred(BUILTINS, ON).size, 0);
});

test("format/parse round-trip", () => {
  const text = formatSearchResult([
    { name: "mcp__figma__get_code", description: "Get code\nmore" },
    { name: "mcp__a-b__c", description: "" },
  ]);
  assert.deepEqual(parseLoadedNames(text), ["mcp__figma__get_code", "mcp__a-b__c"]);
  assert.deepEqual(parseLoadedNames(formatSearchResult([])), []);
  assert.deepEqual(parseLoadedNames("- mcp__x__y: not a search result"), []);
});

const toolMsg = (tool: string, result?: string): Message => ({
  id: tool,
  role: "assistant",
  timestamp: 0,
  parts: [
    {
      type: "tool",
      tool: { id: `c-${tool}`, tool, args: {}, execution: "sequential" } as any,
      result,
    },
  ],
});

test("loadedFromHistory: search results only, deferred only", () => {
  const deferred = new Set(["mcp__figma__get_code", "mcp__figma__get_image"]);
  const history = [
    toolMsg(
      TOOL_SEARCH_TOOL,
      formatSearchResult([
        { name: "mcp__figma__get_code", description: "" },
        { name: "mcp__gone__tool", description: "" },
      ]),
    ),
    // A refused premature call is in history too; it loads nothing.
    toolMsg("mcp__figma__get_image", "Tool mcp__figma__get_image is not loaded."),
    toolMsg("read", "Loaded 1 tool. x:\n- mcp__figma__get_image: y"),
  ];
  assert.deepEqual([...loadedFromHistory(history, deferred)], ["mcp__figma__get_code"]);
});

test("applyDeferral: hides unloaded deferred tools, appends tool_search", () => {
  const offered = [...BUILTINS, ...MCP];
  const search = def(TOOL_SEARCH_TOOL);
  const deferred = selectDeferred(offered, ON);
  const out = applyDeferral(offered, deferred, new Set(["mcp__figma__get_code"]), search);
  assert.deepEqual(
    out.map((d) => d.name),
    ["read", "bash", "mcp__figma__get_code", TOOL_SEARCH_TOOL],
  );
  // Nothing deferred: the list passes through untouched, no tool_search.
  assert.deepEqual(
    applyDeferral(offered, new Set(), new Set(), search).map((d) => d.name),
    offered.map((d) => d.name),
  );
});

test("tool_search is not in the shared list, but is available to the loop", () => {
  assert.ok(!getToolDefs().some((d) => d.name === TOOL_SEARCH_TOOL));
  assert.ok(!getToolDefs("explore").some((d) => d.name === TOOL_SEARCH_TOOL));
  assert.equal(toolSearchDef()?.name, TOOL_SEARCH_TOOL);
});

const mcpTool = (id: string, description: string, properties: Record<string, unknown> = {}) =>
  buildTool({
    id,
    description,
    schemas: { parameters: { type: "object", properties } as any },
    execute: async () => ({ success: true, result: { title: "", output: "" } }),
  });

test("searchMcpTools ranks by description, server name and schema text", () => {
  const candidates = [
    mcpTool("mcp__figma__get_design_context", "Generate UI code for a Figma node"),
    mcpTool("mcp__github__list_issues", "List issues in a repository", {
      state: { type: "string", description: "open or closed" },
    }),
    mcpTool("mcp__agentmemory__recall", "Recall stored memories"),
  ];
  assert.equal(searchMcpTools("figma design", 8, candidates)[0]?.name, "mcp__figma__get_design_context");
  assert.equal(searchMcpTools("github issues", 8, candidates)[0]?.name, "mcp__github__list_issues");
  assert.equal(searchMcpTools("closed", 8, candidates)[0]?.name, "mcp__github__list_issues");
  assert.equal(searchMcpTools("figma", 1, candidates).length, 1);
  assert.deepEqual(searchMcpTools("kubernetes", 8, candidates), []);
});

test("supportsNativeDeferral: Anthropic Sonnet/Opus 4.5+ and the 5 family only", () => {
  const yes = ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-6", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-5"];
  const no = ["claude-sonnet-4-20250514", "claude-opus-4-1", "claude-haiku-4-5-20251001", "claude-3-7-sonnet", "gpt-5"];
  for (const m of yes) assert.ok(supportsNativeDeferral("anthropic", m), m);
  for (const m of no) assert.ok(!supportsNativeDeferral("anthropic", m), m);
  assert.ok(!supportsNativeDeferral("minimax", "claude-sonnet-4-5"));
  assert.ok(!supportsNativeDeferral("anthropic", undefined));
});

test("settings: native defaults on, env beats files", () => {
  assert.equal(resolveDeferralSettings([], {}).native, true);
  assert.equal(resolveDeferralSettings([{ native: false }], {}).native, false);
  assert.equal(
    resolveDeferralSettings([{ native: false }], { FREECODE_DEFER_TOOLS_NATIVE: "1" }).native,
    true,
  );
});

test("applyDeferral native: every deferred tool sent last with deferLoading, same list loaded or not", () => {
  const offered = [def("bash"), MCP[0], def("read"), MCP[1]];
  const search = def(TOOL_SEARCH_TOOL);
  const deferred = selectDeferred(offered, ON);
  const before = applyDeferral(offered, deferred, new Set(), search, true);
  const after = applyDeferral(offered, deferred, new Set(["mcp__figma__get_code"]), search, true);
  assert.deepEqual(before, after, "loading never changes the native list");
  assert.deepEqual(
    before.map((d) => [d.name, d.deferLoading ?? false]),
    [
      ["bash", false],
      ["read", false],
      [TOOL_SEARCH_TOOL, false],
      ["mcp__figma__get_code", true],
      ["mcp__figma__get_image", true],
    ],
  );
});
