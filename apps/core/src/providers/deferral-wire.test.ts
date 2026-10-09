// =============================================================================
// The native deferral path on the wire (spec 2026-10-10 §4.2 path A): what the
// real @ai-sdk/anthropic serializes from FreeCode's tool list and history.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { buildToolsParam, convertToCoreMessages } from "./utils.js";
import { formatSearchResult, TOOL_SEARCH_TOOL } from "../tools/deferral.js";
import type { Message } from "../agent/types.js";
import type { ToolDef } from "./types.js";

const schema = { type: "object", properties: {} };
const tools: ToolDef[] = [
  { name: "read", description: "read", parameters: schema },
  { name: TOOL_SEARCH_TOOL, description: "search", parameters: schema },
  { name: "mcp__figma__get_code", description: "code", parameters: schema, deferLoading: true },
  { name: "mcp__figma__get_image", description: "image", parameters: schema, deferLoading: true },
];

const history: Message[] = [
  { id: "u", role: "user", timestamp: 0, parts: [{ type: "text", content: "get the code" }] },
  {
    id: "a",
    role: "assistant",
    timestamp: 0,
    parts: [
      {
        type: "tool",
        tool: { id: "toolu_1", tool: TOOL_SEARCH_TOOL, args: { query: "figma code" }, execution: "sequential" } as any,
        result: formatSearchResult([
          { name: "mcp__figma__get_code", description: "code" },
          // Not declared deferred on this request: must not be referenced.
          { name: "mcp__gone__tool", description: "gone" },
        ]),
      },
    ],
  },
];

async function captureBody(): Promise<any> {
  let body: any;
  const anthropic = createAnthropic({
    apiKey: "test",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      throw new Error("captured");
    },
  });
  const deferred = new Set(tools.filter((t) => t.deferLoading).map((t) => t.name));
  await generateText({
    model: anthropic("claude-sonnet-4-5"),
    tools: buildToolsParam(tools) as any,
    messages: convertToCoreMessages(history, deferred),
    maxRetries: 0,
  }).catch(() => {});
  return body;
}

test("deferred tools carry defer_loading; the cache anchor sits on the last loaded-in-prompt tool", async () => {
  const body = await captureBody();
  const byName = Object.fromEntries(body.tools.map((t: any) => [t.name, t]));
  assert.equal(byName["mcp__figma__get_code"].defer_loading, true);
  assert.equal(byName["mcp__figma__get_image"].defer_loading, true);
  assert.equal(byName["read"].defer_loading, undefined);
  assert.ok(byName[TOOL_SEARCH_TOOL].cache_control, "anchor on the last non-deferred tool");
  assert.equal(byName["mcp__figma__get_image"].cache_control, undefined);
});

test("a tool_search result carries tool_reference blocks for declared deferred tools only", async () => {
  const body = await captureBody();
  const result = body.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .find((c: any) => c.type === "tool_result" && c.tool_use_id === "toolu_1");
  assert.ok(result, "tool_result present");
  // References only — the API 400s on a result that mixes them with text.
  assert.deepEqual(result.content, [{ type: "tool_reference", tool_name: "mcp__figma__get_code" }]);
});
