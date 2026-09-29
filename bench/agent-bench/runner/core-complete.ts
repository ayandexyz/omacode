// =============================================================================
// Judge transport: core's providers, not a copy of them.
// Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.6 ("Transport").
//
// agent-bench otherwise shares no code with core (proxy/price.ts copies its
// rate table on purpose), because that rule protects a published NUMBER. A
// judge's transport is not a number, and core already owns provider auth,
// catalogue and fetch timeouts. Imported lazily, so the tests never load core.
// The GPT judge is the exception: it runs through `codex exec` on the owner's
// Codex subscription (codex-complete.ts), which core cannot reach.
// =============================================================================

import { codexComplete } from "./codex-complete.js";
import type { Complete } from "./judge.js";

/** Judge tokens per judge id. The Codex-subscription judge has no USD price (§6.6). */
export type JudgeUsage = Record<string, { inputTokens: number; outputTokens: number; calls: number }>;

/** Enough for BuffBench's analysis + lists + three scores. */
const JUDGE_MAX_TOKENS = 4096;

export function coreComplete(usage: JudgeUsage): Complete {
  return async (judge, system, prompt, signal) => {
    const { getProvider, initProviders } = await import(
      "../../../apps/core/src/providers/index.js"
    );
    await initProviders();
    const provider = getProvider(judge.provider as never);
    if (!provider) throw new Error(`no such provider: ${judge.provider}`);
    const result = await provider.execute({
      prompt,
      system,
      model: judge.model,
      maxTokens: JUDGE_MAX_TOKENS,
      abortSignal: signal,
    });
    const u = (usage[judge.id] ??= { inputTokens: 0, outputTokens: 0, calls: 0 });
    u.inputTokens += result.usage?.inputTokens ?? 0;
    u.outputTokens += result.usage?.outputTokens ?? 0;
    u.calls += 1;
    return result.content ?? "";
  };
}

/** The panel's transport: `codex` judges through `codex exec`, the rest through core. */
export function judgeComplete(usage: JudgeUsage): Complete {
  const core = coreComplete(usage);
  const codex = codexComplete(usage);
  return (judge, ...rest) => (judge.provider === "codex" ? codex : core)(judge, ...rest);
}
