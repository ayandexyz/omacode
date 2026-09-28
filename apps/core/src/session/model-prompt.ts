// =============================================================================
// Model-family prompt overlays
//
// The canonical system prompt owns FreeCode's policy. Overlays may restate that
// policy in a shape a model family follows more reliably, but must not grant or
// remove capabilities. Keep them small and back every addition with an eval.
//
// Families mirror OpenCode's routing (session/system.ts there), which ships a
// whole prompt per family. FreeCode keeps one base and adds only the family's
// known gaps, so a policy fix lands for every model at once. Anthropic and
// unrecognised models get no overlay: the base prompt is written for them.
//
// FREECODE_MODEL_OVERLAY=0 drops every overlay, read per call so `eval ab`
// can pair base-only against base+overlay in one run.
// =============================================================================

export type ModelFamily = "gpt" | "gemini" | "kimi" | "minimax" | "default";

const OVERLAYS: Record<ModelFamily, string> = {
  // Unmeasured: no OpenAI key when the overlays were A/B'd (2026-09-28).
  gpt: "",

  gemini: `# Gemini execution guidance

- Pass absolute paths to file tools. Resolve a relative path the user gives against the project root first.
- Before using a library or framework, confirm the project already depends on it (imports, package manifest).
- Never describe your changes or talk to the user through code comments.
- No preamble ("Okay, I will now...") and no postamble summarising the edit unless asked.`,

  // Unmeasured: no Kimi key when the overlays were A/B'd (2026-09-28).
  kimi: "",

  minimax: `# MiniMax execution guidance

- Follow an explicit user request to call an available tool unless that call is unsafe or unavailable.
- When the user requests a one-off tool interaction or demonstration, perform it once, acknowledge the result, and stop.
- A user's answer to a question refines work they already requested. It does not create a new implementation task when the original request was only a question, demonstration, or tool test.
- Do not turn a one-off question into a discovery interview. Ask follow-up questions only when they are necessary for work the user already authorized.`,

  default: "",
};

/**
 * Which overlay family a provider/model pair belongs to.
 *
 * Matched on the model id first, then the provider, because gateways
 * (openrouter, together, …) serve every family under their own provider id.
 */
export function modelFamily(provider: string, model?: string): ModelFamily {
  const id = (model ?? "").toLowerCase();
  const p = provider.toLowerCase();
  if (id.includes("minimax") || p.includes("minimax")) return "minimax";
  if (id.includes("kimi") || p.startsWith("moonshotai")) return "kimi";
  if (id.includes("gemini")) return "gemini";
  // gpt-*, codex, and the o-series (o1, o3, o4-mini), incl. `openai/o3`.
  if (/(^|[/:])(gpt|codex|o[134])([-.]|$)/.test(id) || id.includes("codex")) {
    return "gpt";
  }
  return "default";
}

/** The behavioral-shaping overlay for a model family ("" when none). */
export function modelPromptOverlay(
  provider: string,
  model?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.FREECODE_MODEL_OVERLAY === "0") return "";
  return OVERLAYS[modelFamily(provider, model)];
}
