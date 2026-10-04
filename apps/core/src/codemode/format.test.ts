import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capHeadTail, formatCodemodeResult } from "./format.js";

describe("capHeadTail", () => {
  it("leaves short text alone", () => {
    assert.equal(capHeadTail("abc", 10), "abc");
  });
  it("keeps both ends of long text", () => {
    const out = capHeadTail("a".repeat(50) + "b".repeat(50), 20);
    assert.ok(out.startsWith("a".repeat(10)));
    assert.ok(out.endsWith("b".repeat(10)));
    assert.match(out, /80 chars omitted/);
  });
});

describe("formatCodemodeResult", () => {
  it("prints output then the return value", () => {
    const text = formatCodemodeResult(
      {
        ok: true,
        value: { n: 2 },
        output: [{ type: "text", text: "hello" }],
        calls: [{ name: "read", status: "ok", durationMs: 1 }],
        storeWrites: { set: {}, delete: [] },
      },
      1234,
    );
    assert.equal(text, 'Script completed in 1.2s (1 tool call)\nhello\n{\n  "n": 2\n}');
  });

  it("keeps partial output and names the error on failure", () => {
    const text = formatCodemodeResult(
      {
        ok: false,
        error: { kind: "script", name: "Error", message: "boom" },
        output: [{ type: "text", text: "before" }],
        calls: [],
      },
      0,
    );
    assert.equal(text, "Script failed in 0.0s (0 tool calls)\nbefore\nScript error (script): Error: boom");
  });

  it("counts images it cannot forward", () => {
    const text = formatCodemodeResult(
      {
        ok: true,
        value: undefined,
        output: [{ type: "image", data: "x", mimeType: "image/png" }],
        calls: [],
        storeWrites: { set: {}, delete: [] },
      },
      0,
    );
    assert.match(text, /1 image\(s\) omitted/);
  });
});
