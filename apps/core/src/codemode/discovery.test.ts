import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeToolDef, discoveryGlobals, searchToolDefs } from "./discovery.js";
import { createCodemodeSandbox } from "./runtime.js";

const defs = [
  { name: "grep", description: "Search file contents with a regular expression.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "read", description: "Read a file from disk.", parameters: { type: "object", properties: { filePath: { type: "string" } } } },
  { name: "mcp__dev-radius__search", description: "Search the Radius issue tracker for tickets.", parameters: { type: "object", properties: { q: { type: "string" } } } },
];

describe("searchToolDefs", () => {
  it("ranks by description and returns script identifiers", () => {
    const hits = searchToolDefs(defs, "issue tracker tickets");
    assert.equal(hits[0].name, "mcp__dev_radius__search");
  });
  it("falls back to a name match for terms BM25 drops", () => {
    assert.deepEqual(searchToolDefs(defs, "re").map((h) => h.name), ["grep", "read"]);
  });
  it("honours the limit", () => {
    assert.equal(searchToolDefs(defs, "search", 1).length, 1);
  });
});

describe("describeToolDef", () => {
  it("renders a declaration by name or identifier", () => {
    assert.match(describeToolDef(defs, "grep")!, /pattern: string/);
    assert.match(describeToolDef(defs, "mcp__dev_radius__search")!, /q\?: string/);
  });
  it("is undefined for an unknown tool", () => {
    assert.equal(describeToolDef(defs, "nope"), undefined);
  });
});

describe("discovery globals in the sandbox", () => {
  it("are callable from a script", async () => {
    const sandbox = createCodemodeSandbox({ timeoutMs: 30_000, globals: discoveryGlobals(defs) });
    try {
      const result = await sandbox.execute(`
        const hits = await searchTools("regular expression", { limit: 1 });
        return { first: hits[0].name, decl: (await describeTool("read")).includes("filePath"), missing: await describeTool("nope") };`);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.ok && result.value, { first: "grep", decl: true });
    } finally {
      await sandbox.close();
    }
  });
});
