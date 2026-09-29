// =============================================================================
// The judged set's contamination control. Spec §4.8.
//
// The repo is public since its first commit, so the only thing keeping a model
// from having trained on a task is time: every task must postdate the model.
// Rule: each agent's pinned model was released BEFORE the window's first day.
// Stricter than "not after the window's end", which would pass a model
// released mid-window, one that may have trained on the window's early tasks.
// An unknown release date fails the check: unknown is not clean.
// =============================================================================

import * as fs from "fs";
import * as path from "path";

export interface TaskWindow {
  /** First day of the `bench:commits` window, YYYY-MM-DD. */
  since: string;
  until: string | null;
}

/** instances/model-releases.json, keyed by `modelKey`. */
export type ModelReleases = Record<string, { released: string | null; source: string | null }>;

export const RELEASES_FILE = path.join(import.meta.dirname, "..", "instances", "model-releases.json");

export interface ContaminationCheck {
  ok: boolean;
  problems: string[];
  window: TaskWindow | null;
  /** model (as the adapter spells it) → release date, or null when unknown. */
  releases: Record<string, string | null>;
}

/** `minimax/MiniMax-M3` and `MiniMax-M3` are the same model. */
export function modelKey(model: string): string {
  return model.split("/").pop()!.toLowerCase();
}

export function readReleases(file = RELEASES_FILE): ModelReleases {
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  // Keys starting with "_" are notes for the human filling the file in.
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_"))) as ModelReleases;
}

export function checkContamination(
  window: TaskWindow | null | undefined,
  releases: ModelReleases,
  models: string[],
): ContaminationCheck {
  const problems: string[] = [];
  const known: Record<string, string | null> = {};
  if (!window) {
    problems.push("the task file records no window: regenerate candidates with `pnpm bench:commits --since … --out …`");
  }
  for (const model of new Set(models)) {
    const released = releases[modelKey(model)]?.released ?? null;
    known[model] = released;
    if (!released) {
      problems.push(`${model}: no release date in instances/model-releases.json (key "${modelKey(model)}")`);
    } else if (window && released >= window.since) {
      problems.push(
        `${model}: released ${released}, on or after the window's first day ${window.since}; ` +
          `it may have trained on the tasks (window must start after the release)`,
      );
    }
  }
  return { ok: problems.length === 0, problems, window: window ?? null, releases: known };
}

/** Tasks from two windows must not share a file: the check reads one window. */
export function mergeWindow(
  held: TaskWindow | null | undefined,
  heldCount: number,
  incoming: TaskWindow | null | undefined,
): TaskWindow | null {
  if (heldCount === 0) return incoming ?? null;
  const same = (held?.since ?? null) === (incoming?.since ?? null) && (held?.until ?? null) === (incoming?.until ?? null);
  if (!same) {
    throw new Error(
      `window mismatch: the file holds tasks from ${JSON.stringify(held ?? null)}, ` +
        `these come from ${JSON.stringify(incoming ?? null)}; finish or clear it first`,
    );
  }
  return held ?? null;
}
