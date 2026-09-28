// =============================================================================
// Night-run sidecar files: notes.md, decisions.jsonl, iterations.jsonl.
//
// All three live beside the manifest under ~/.freecode/runs/<id>/ — NOT in the
// repository. Nothing the run writes about itself can end up in a commit, and
// the model cannot edit them (they are outside the working tree, which the
// envelope's path rule refuses).
//
// Every string that reaches disk goes through the secret filter first: notes
// and decisions quote command output and file content, and the morning report
// is read by a human who may paste it somewhere.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.13
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { containsSecret } from "../memory/graph/secret-filter.js";
import { runDir } from "./run-store.js";
import type { Decision, IterationRecord, WaitRecord } from "./types.js";

export const notesPath = (runId: string): string =>
  path.join(runDir(runId), "notes.md");
export const decisionsPath = (runId: string): string =>
  path.join(runDir(runId), "decisions.jsonl");
export const iterationsPath = (runId: string): string =>
  path.join(runDir(runId), "iterations.jsonl");

/** What replaces a line that carries a credential. Kept visible, not dropped. */
export const REDACTED = "[redacted: looked like a credential]";

/** Per line, so one bad line does not cost the whole note. */
export function scrub(text: string): string {
  return text
    .split("\n")
    .map((line) => (containsSecret(line) ? REDACTED : line))
    .join("\n");
}

function append(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, text, "utf-8");
}

export function appendNotes(runId: string, section: string): void {
  append(notesPath(runId), `${scrub(section.trimEnd())}\n\n`);
}

export function readNotes(runId: string): string {
  try {
    return fs.readFileSync(notesPath(runId), "utf-8");
  } catch {
    return "";
  }
}

export function appendDecision(runId: string, decision: Decision): void {
  append(decisionsPath(runId), `${scrub(JSON.stringify(decision))}\n`);
}

/** Iterations and waits share one log: the night is both, in order. */
export function appendIteration(
  runId: string,
  record: IterationRecord | WaitRecord,
): void {
  append(iterationsPath(runId), `${scrub(JSON.stringify(record))}\n`);
}

/** Unparseable lines are skipped: a truncated last line must not lose the rest. */
function readJsonl<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip — see above.
    }
  }
  return out;
}

export const readDecisions = (runId: string): Decision[] =>
  readJsonl<Decision>(decisionsPath(runId));

export const readIterations = (
  runId: string,
): Array<IterationRecord | WaitRecord> =>
  readJsonl<IterationRecord | WaitRecord>(iterationsPath(runId));
