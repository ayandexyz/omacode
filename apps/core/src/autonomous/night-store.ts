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
export const reportPathFor = (runId: string): string =>
  path.join(runDir(runId), "report.md");

/** What replaces a line that carries a credential. Kept visible, not dropped. */
export const REDACTED = "[redacted: looked like a credential]";

/** Per line, so one bad line does not cost the whole note. */
export function scrub(text: string): string {
  return text
    .split("\n")
    .map((line) => (containsSecret(line) ? REDACTED : line))
    .join("\n");
}

/**
 * Scrub the STRING FIELDS of a record, not its serialized form.
 *
 * Scrubbing the finished JSON line replaced the whole line with the redaction
 * marker, which is not JSON — so the reader skipped it and the record vanished
 * instead of appearing redacted. A `needs_human` item that happens to quote a
 * credential is exactly the case where the user must still be told something
 * needs them.
 */
export function scrubFields<T>(value: T): T {
  if (typeof value === "string") {
    return (containsSecret(value) ? REDACTED : value) as T;
  }
  if (Array.isArray(value)) return value.map(scrubFields) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        scrubFields(v),
      ]),
    ) as T;
  }
  return value;
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
  append(decisionsPath(runId), `${JSON.stringify(scrubFields(decision))}\n`);
}

/** Iterations and waits share one log: the night is both, in order. */
export function appendIteration(
  runId: string,
  record: IterationRecord | WaitRecord,
): void {
  append(iterationsPath(runId), `${JSON.stringify(scrubFields(record))}\n`);
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
