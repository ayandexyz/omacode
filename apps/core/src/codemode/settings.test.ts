import test from "node:test";
import assert from "node:assert/strict";
import { resolveCodemodeMode } from "./settings.js";

test("resolveCodemodeMode accepts the only environment mode", () => {
  assert.equal(resolveCodemodeMode([], { FREECODE_CODEMODE: "only" }), "only");
  assert.equal(resolveCodemodeMode([], { FREECODE_CODEMODE: "on" }), "on");
  assert.equal(resolveCodemodeMode([], { FREECODE_CODEMODE: "off" }), "off");
});

test("resolveCodemodeMode preserves boolean compatibility and precedence", () => {
  assert.equal(resolveCodemodeMode([{ enabled: true }], {}), "on");
  assert.equal(
    resolveCodemodeMode([{ enabled: true, mode: "only" }], {}),
    "only",
  );
  assert.equal(
    resolveCodemodeMode([{ enabled: false, mode: "only" }], {}),
    "off",
  );
  assert.equal(
    resolveCodemodeMode([{ enabled: true }], { FREECODE_CODEMODE: "0" }),
    "off",
  );
});
