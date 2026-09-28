// =============================================================================
// The iteration prompt. Adapted from gnhf's `iteration-prompt.ts`, with its
// output section replaced by the `finish_iteration` tool.
//
// This is the USER message of a fresh session, never system content: the cached
// system prefix stays byte-identical across iterations, and the notes — which
// grow every iteration — cannot invalidate it (the ephemeral-tail invariant,
// caching-architecture.md §1.1).
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.3
// =============================================================================

/**
 * How much of notes.md reaches the prompt. The full file stays on disk; when it
 * outgrows this, the FIRST section (what the run set out to do) and the most
 * RECENT ones are kept — the middle is what a fresh iteration needs least.
 */
export const NOTES_BUDGET_CHARS = 24_000;

export function trimNotes(
  notes: string,
  budget = NOTES_BUDGET_CHARS,
): string {
  if (notes.length <= budget) return notes;
  const head = Math.floor(budget * 0.25);
  const tail = budget - head;
  return `${notes.slice(0, head)}\n\n[… ${
    notes.length - budget
  } characters of earlier notes omitted; the full file is in the run directory …]\n\n${notes.slice(
    -tail,
  )}`;
}

export interface IterationPromptInput {
  objective: string;
  iteration: number;
  notes: string;
  /** Set when the previous iteration's commit failed and its work is still in the tree. */
  repairPending?: string;
  /** `--stop-when`: the user's own finish line, in their words. */
  stopWhen?: string;
}

export function buildIterationPrompt(input: IterationPromptInput): string {
  const { objective, iteration, notes, repairPending, stopWhen } = input;
  const sections: string[] = [
    `You are working unattended towards the objective below. No human will read or
answer anything until morning. This is iteration ${iteration} of an overnight run.`,
    `## How to work
1. Read the run notes below: what previous iterations did and learned.
2. Pick the next smallest unit of work that is individually verifiable and moves
   the objective forward. That is this iteration's whole scope.
3. If an attempt does not move the needle, stop pivoting: record what you learned
   and finish with success=false.
4. Validate your change: run the build, tests, linters or formatters that exist.
5. Do NOT commit, push, switch branches, or rewrite git history — the harness
   commits for you after you finish.
6. Stop any background process you started.
7. Then call finish_iteration exactly once. It ends the iteration.`,
    `## Decisions
Nobody can answer questions. When you face a choice, decide it yourself: prefer
the option that is reversible and inside the objective's scope; record it in
finish_iteration.decisions. If a choice truly needs the human (credentials, a
product call, something irreversible), do not guess — list it in
finish_iteration.needs_human and work on something else.`,
    `## Permissions
Actions outside this run's branch and working tree are refused automatically —
pushing, publishing, installing globally, writing outside the project. A refusal
is final for this run; work around it or list it in needs_human.`,
  ];

  if (repairPending) {
    sections.push(`## Repair first
The previous iteration's changes could not be committed: ${repairPending}
The uncommitted changes are still in the tree. Fix what blocks the commit first.`);
  }

  if (stopWhen) {
    sections.push(`## Stop condition
The user will consider the run finished when: ${stopWhen}
Set should_stop=true only when that is fully true after this iteration. If it is
not yet true, keep should_stop false however much progress you made.`);
  }

  const trimmed = trimNotes(notes).trim();
  sections.push(
    `## Run notes\n${trimmed || "(none yet — this is the first iteration.)"}`,
  );
  sections.push(`## Objective\n${objective}`);

  return sections.join("\n\n");
}

/** The one re-poke when a model stops without calling the finish tool (§4.4). */
export const FINISH_POKE =
  "Call finish_iteration now to end this iteration. Report what you did, " +
  "including success=false if this attempt did not move the objective forward.";
