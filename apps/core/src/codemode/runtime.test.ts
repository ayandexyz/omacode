import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import {
  createCodemodeSandbox,
  resolveCodemodeRuntime,
} from "./runtime.js";

describe("resolveCodemodeRuntime", () => {
  it("uses pi-codemode's defaults outside the compiled binary", () => {
    assert.deepEqual(resolveCodemodeRuntime(false, "/usr/bin/node", import.meta.url), {});
  });

  it("points at the loose wasm and the worker under the embedded root", () => {
    const exe = path.join("/opt", "freecode", "freecode");
    assert.deepEqual(resolveCodemodeRuntime(true, exe, "file:///$bunfs/root/freecode"), {
      wasmPath: path.join("/opt", "freecode", "quickjs.wasm"),
      workerUrl: "/$bunfs/root/core/dist/codemode/worker.js",
    });
  });
});

describe("createCodemodeSandbox", () => {
  it("runs a script that calls a host tool", async () => {
    const sandbox = createCodemodeSandbox({
      timeoutMs: 30_000,
      tools: [{ name: "add", execute: (a) => (a as { x: number; y: number }).x + (a as { x: number; y: number }).y }],
    });
    try {
      const result = await sandbox.execute(`text("hi"); return await tools.add({ x: 2, y: 3 });`);
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.value, 5);
      assert.deepEqual(result.output, [{ type: "text", text: "hi" }]);
    } finally {
      await sandbox.close();
    }
  });
});
