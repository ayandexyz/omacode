// =============================================================================
// finish_iteration — how an unattended iteration ends (spec §4.4).
//
// Registered ONLY when the loop runs with an unattended context, so it is
// invisible in an attended session and changes nobody else's tool list. It
// replaces gnhf's "parse the final JSON out of the agent's stdout": a tool call
// is schema-validated, a JSON blob in prose is a guess.
//
// Calling it ends the run after the current tool batch (the loop checks
// `unattended.finish`). A second call is ignored — the first report is the one
// the orchestrator acts on.
// =============================================================================

import type { ToolContext } from "./types.js";
import type { Tool, ToolExecutionResult, JsonSchema } from "./tool.types.js";
import { buildTool } from "./factory.js";
import { coerceBoolean } from "./coerce-args.js";
import type {
  FinishIterationResult,
  IterationDecision,
} from "../autonomous/types.js";

interface FinishParams {
  success: boolean;
  summary: string;
  key_changes?: unknown;
  key_learnings?: unknown;
  decisions?: unknown;
  needs_human?: unknown;
  should_stop?: unknown;
  /** Not in the schema — where MiniMax spills a list's second item. */
  item?: unknown;
}

// A `type` on every property, per the CLAUDE.md tool checklist: a missing one
// yields "must be a number" reject-loops with providers that quote scalars.
const finishSchema: JsonSchema = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      description:
        "true if this iteration made meaningful progress on the objective. false discards its changes — use it honestly, a failed attempt whose learning is recorded is worth more than a fake success.",
    },
    summary: {
      type: "string",
      description:
        "One sentence, imperative mood, describing what this iteration did. Becomes the commit subject.",
    },
    key_changes: {
      type: "array",
      description: "What materially changed, one entry per logical unit.",
      items: { type: "string" },
    },
    key_learnings: {
      type: "array",
      description:
        "What you learned that the run notes do not already say — surprises, dead ends, constraints the next iteration needs.",
      items: { type: "string" },
    },
    decisions: {
      type: "array",
      description:
        "Choices you made on the user's behalf, because nobody was available to ask. Each: question, choice, why, reversible.",
      items: { type: "object" },
    },
    needs_human: {
      type: "array",
      description:
        "Blocking items only the user can resolve (credentials, a product call, anything irreversible). Listed in their morning report.",
      items: { type: "string" },
    },
    should_stop: {
      type: "boolean",
      description:
        "true only when the whole objective is met and further iterations would be busywork.",
    },
  },
  required: ["success", "summary"],
};

function validateFinishInput(
  params: unknown,
): { valid: true } | { valid: false; error: string } {
  if (!params || typeof params !== "object") {
    return { valid: false, error: "parameters must be an object" };
  }
  const p = params as FinishParams;
  if (coerceBoolean(p.success) === undefined) {
    return { valid: false, error: "success must be a boolean" };
  }
  if (typeof p.summary !== "string" || p.summary.trim() === "") {
    return { valid: false, error: "summary must be a non-empty string" };
  }
  return { valid: true };
}

/**
 * MiniMax's XML tool-call format leaks into nested params (first live night,
 * run 74b18cb1): a list item ends in `</item>`, and a field can swallow the
 * next one — `why: "…</why>\n<reversible>true"`. Returns the text with the
 * residue cut off, plus the swallowed field if there was one.
 */
const TAG_RESIDUE = /\s*<\/[A-Za-z_]+>\s*(?:<([A-Za-z_]+)>([\s\S]*))?$/;

function untag(text: string): { text: string; spilled?: [string, string] } {
  const match = TAG_RESIDUE.exec(text);
  if (!match) return { text: text.trim() };
  return {
    text: text.slice(0, match.index).trim(),
    ...(match[1] ? { spilled: [match[1], (match[2] ?? "").trim()] } : {}),
  };
}

/** Tolerant on purpose: a dropped list costs the report, not the iteration. */
function stringList(value: unknown): string[] {
  const raw = typeof value === "string" ? safeParse(value) : value;
  if (!Array.isArray(raw)) return [];
  // `flat`: MiniMax nests a list one level deeper than the schema says.
  return raw
    .flat(Infinity)
    .map((item) =>
      typeof item === "string" ? untag(item).text : JSON.stringify(item),
    )
    .filter((s) => s.trim() !== "");
}

function decisionList(value: unknown, spilledItem?: unknown): IterationDecision[] {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  const raw = Array.isArray(parsed) ? parsed.flat(Infinity) : [];
  // MiniMax puts a list's second item under a top-level `item`; keep it
  // rather than lose a decision the user should see.
  if (spilledItem && typeof spilledItem === "object" && !Array.isArray(spilledItem)) {
    raw.push(spilledItem);
  }
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const d = { ...(item as Record<string, unknown>) };
    for (const key of ["question", "choice", "why"]) {
      if (typeof d[key] !== "string") continue;
      const { text, spilled } = untag(d[key] as string);
      d[key] = text;
      if (spilled && d[spilled[0]] === undefined) d[spilled[0]] = spilled[1];
    }
    const question = String(d.question ?? "").trim();
    const choice = String(d.choice ?? "").trim();
    if (!question || !choice) return [];
    return [
      {
        question,
        choice,
        why: String(d.why ?? "").trim(),
        // Unstated defaults to NOT reversible: the report sorts irreversible
        // decisions first, and the expensive mistake is hiding one there.
        reversible: coerceBoolean(d.reversible) ?? false,
      },
    ];
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function executeFinish(
  params: FinishParams,
  ctx: ToolContext,
): Promise<
  ToolExecutionResult<{
    title: string;
    output: string;
    metadata?: Record<string, unknown>;
  }>
> {
  const unattended = ctx.unattended;
  if (!unattended) {
    return {
      success: false,
      error:
        "finish_iteration is only available inside an unattended run. Nothing to finish.",
    };
  }
  if (unattended.finish) {
    // The run is already ending; a second report would race the first.
    return {
      success: true,
      result: {
        title: "already finished",
        output: "This iteration was already finished. Stop now.",
      },
    };
  }

  const result: FinishIterationResult = {
    success: coerceBoolean(params.success) ?? false,
    summary: params.summary.trim(),
    keyChanges: stringList(params.key_changes),
    keyLearnings: stringList(params.key_learnings),
    decisions: decisionList(params.decisions, params.item),
    needsHuman: stringList(params.needs_human),
    shouldStop: coerceBoolean(params.should_stop) ?? false,
  };
  unattended.finish = result;

  for (const d of result.decisions) {
    unattended.record({
      kind: "decided",
      iteration: unattended.iteration,
      at: Date.now(),
      ...d,
    });
  }
  for (const item of result.needsHuman) {
    unattended.record({
      kind: "needs_human",
      iteration: unattended.iteration,
      at: Date.now(),
      item,
    });
  }

  return {
    success: true,
    result: {
      title: result.success ? "iteration finished" : "iteration finished (no progress)",
      output: `Recorded. The harness takes it from here — stop working now.\n${result.summary}`,
      metadata: { success: result.success, shouldStop: result.shouldStop },
    },
  };
}

export const FinishIterationTool: Tool<FinishParams> = buildTool({
  id: "finish_iteration",
  description: [
    "End this unattended iteration and report what happened. Call it exactly once, as your last action.",
    "",
    "Set success=true only if this iteration made real, verifiable progress. Set success=false if the attempt did not move the objective forward — the harness discards the changes and the next iteration starts clean from your recorded learnings. A false report of success commits work that does not hold up, which is worse than a failure.",
    "",
    "Do not commit, push or switch branches first: the harness commits your work using `summary` as the commit subject.",
  ].join("\n"),
  schemas: { parameters: finishSchema },
  permissions: { operations: [] },
  behavior: {
    isConcurrencySafe: false,
    isDestructive: false,
    userFacingName: "FinishIteration",
  },
  execute: executeFinish,
  validateInput: validateFinishInput,
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: false }),
});
