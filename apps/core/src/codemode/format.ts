// =============================================================================
// Codemode result → the text the model reads (spec 2026-10-05-codemode.md §4.5).
// Pure, so the truncation and the failure shape are tested without a VM.
// =============================================================================

import type { CodemodeResult } from "@earendil-works/pi-codemode";

export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

/** Keep the head and tail of `text` within `maxChars`, marking the gap. */
export function capHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - 2 * half;
  return `${text.slice(0, half)}\n[… ${omitted} chars omitted …]\n${text.slice(-half)}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Header line, then the script's output in order, then its return value.
 * Images are not forwarded yet (Phase 1); they are counted so the model knows.
 */
export function formatCodemodeResult(
  result: CodemodeResult,
  wallMs: number,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
): string {
  const parts: string[] = [];
  let images = 0;
  for (const item of result.output) {
    if (item.type === "text") parts.push(item.text);
    else images++;
  }
  if (result.ok && result.value !== undefined)
    parts.push(stringify(result.value));
  if (images > 0) {
    parts.push(
      `[${images} image(s) omitted: codemode does not return images yet]`,
    );
  }

  const seconds = (wallMs / 1000).toFixed(1);
  const calls = result.calls.length;
  const header = `Script ${result.ok ? "completed" : "failed"} in ${seconds}s (${calls} tool call${calls === 1 ? "" : "s"})`;
  const body = capHeadTail(parts.join("\n"), maxOutputTokens * 4);
  const lines = [header];
  if (body) lines.push(body);
  if (!result.ok) {
    const { kind, name, message } = result.error;
    lines.push(`Script error (${kind}): ${name ? `${name}: ` : ""}${message}`);
  }
  return lines.join("\n");
}
