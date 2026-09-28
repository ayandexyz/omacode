import { test } from "node:test";
import assert from "node:assert/strict";
import { modelFamily, modelPromptOverlay } from "./model-prompt.js";

test("modelFamily routes by model id, then provider", () => {
  const cases: Array<[string, string | undefined, string]> = [
    ["minimax", "MiniMax-M3", "minimax"],
    ["openrouter", "minimax/minimax-m3", "minimax"],
    ["moonshotai", "some-model", "kimi"],
    ["openrouter", "moonshotai/kimi-k2", "kimi"],
    ["google", "gemini-2.5-pro", "gemini"],
    ["openai", "gpt-5", "gpt"],
    ["openai", "o3", "gpt"],
    ["openrouter", "openai/o4-mini", "gpt"],
    ["openai", "gpt-5-codex", "gpt"],
    ["anthropic", "claude-sonnet-4-5", "default"],
    ["deepseek", "deepseek-chat", "default"],
    // An "o3" inside another word is not the o-series.
    ["mistral", "pro3-large", "default"],
    ["anthropic", undefined, "default"],
  ];
  for (const [provider, model, want] of cases) {
    assert.equal(modelFamily(provider, model), want, `${provider}/${model}`);
  }
});

test("modelPromptOverlay is empty for the default family", () => {
  assert.equal(modelPromptOverlay("anthropic", "claude-sonnet-4-5"), "");
});

test("FREECODE_MODEL_OVERLAY=0 drops every overlay", () => {
  const on = modelPromptOverlay("google", "gemini-3.6-flash", {});
  assert.match(on, /# Gemini execution guidance/);
  assert.equal(
    modelPromptOverlay("google", "gemini-3.6-flash", {
      FREECODE_MODEL_OVERLAY: "0",
    }),
    "",
  );
});
