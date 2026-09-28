// =============================================================================
// The morning report.
//
// PURE fold: manifest + iterations.jsonl + decisions.jsonl → markdown. Nothing
// here reads a clock, a repo or a network, which is what lets the report be
// REGENERATED after a crash — the logs are the source of truth, the file is a
// convenience (`freecode night report <id>`).
//
// Order is not cosmetic. It leads with what the user has to act on, then what
// was decided for them, then what was refused. A report that opens with a
// commit list is a report that buries the one line that needed a human.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.10
// =============================================================================

import type {
  Decision,
  IterationRecord,
  NightManifestFields,
  WaitRecord,
} from "./types.js";

export interface ReportInput {
  runId: string;
  night: NightManifestFields;
  status: string;
  startedAt?: number;
  endedAt?: number;
  provider: string;
  model?: string;
  authMode?: "oauth" | "api-key";
  usd?: number;
  records: Array<IterationRecord | WaitRecord>;
  decisions: Decision[];
  /** `git diff --stat` against the branch point, when the repo could be read. */
  diffstat?: string;
  /** Commit subjects keyed by hash, for the iteration list. */
  subjects?: Record<string, string>;
}

const isWait = (r: IterationRecord | WaitRecord): r is WaitRecord =>
  r.kind === "wait";

export function renderReport(input: ReportInput): string {
  const { night, records, decisions } = input;
  const iterations = records.filter(
    (r): r is IterationRecord => !isWait(r),
  );
  const waits = records.filter(isWait);
  const ok = iterations.filter((i) => i.commit).length;
  const failed = iterations.filter((i) => i.failure).length;

  const out: string[] = [];
  out.push(`# Night run ${input.runId} — ${night.objective}`);
  out.push(headline(input, ok, failed));
  out.push("");

  const needsHuman = decisions.filter(
    (d): d is Extract<Decision, { kind: "needs_human" }> =>
      d.kind === "needs_human",
  );
  const decided = decisions.filter(
    (d): d is Extract<Decision, { kind: "decided" }> => d.kind === "decided",
  );
  const asked = decisions.filter(
    (d): d is Extract<Decision, { kind: "asked" }> => d.kind === "asked",
  );
  const denied = decisions.filter(
    (d): d is Extract<Decision, { kind: "denied" }> => d.kind === "denied",
  );

  // FIRST, always — even when empty, so its absence is a statement rather than
  // a section that might have been dropped.
  out.push(`## Needs you (${needsHuman.length})`);
  if (needsHuman.length === 0) {
    out.push("Nothing is waiting on you.");
  } else {
    for (const d of needsHuman) out.push(`- it.${d.iteration}  ${d.item}`);
  }
  out.push("");

  if (decided.length > 0 || asked.length > 0) {
    out.push(`## Decisions made for you (${decided.length})`);
    // Irreversible first: if the reader stops after one line, it should be the
    // one they might have to undo.
    for (const d of [...decided].sort(
      (a, b) => Number(a.reversible) - Number(b.reversible),
    )) {
      out.push(
        `- it.${d.iteration}  ${d.choice} — ${
          d.reversible ? "reversible" : "NOT reversible"
        }${d.why ? ` — "${d.why}"` : ""}`,
      );
    }
    // A question the model asked and never answered in its report is shown,
    // never hidden: it is the case where nobody decided anything.
    for (const a of unansweredAsks(asked, decided)) {
      out.push(
        `- it.${a.iteration}  asked "${a.question}" — answer not recorded`,
      );
    }
    out.push("");
  }

  if (denied.length > 0) {
    out.push(`## Refused actions (${denied.length})`);
    for (const d of denied) {
      out.push(
        `- it.${d.iteration}  ${d.tool}${d.target ? ` \`${d.target}\`` : ""}  — ${d.rule}`,
      );
    }
    out.push("");
  }

  if (waits.length > 0) {
    out.push(`## Waits (${waits.length})`);
    for (const w of waits) {
      out.push(
        `- before it.${w.n}  ${w.provider} — ${duration(w.until - w.from)} (${w.reason})`,
      );
    }
    out.push("");
  }

  out.push("## Iterations");
  for (const r of records) {
    out.push(isWait(r) ? waitLine(r) : iterationLine(r, input.subjects));
  }
  out.push("");

  if (input.diffstat?.trim()) {
    out.push("## Changes");
    out.push("```");
    out.push(input.diffstat.trim());
    out.push("```");
    out.push("");
  }

  out.push("## Review");
  out.push("```sh");
  out.push(`git log --oneline main..${night.branch}`);
  out.push(`git diff main...${night.branch} --stat`);
  const traceable = iterations.find((i) => i.sessionId);
  if (traceable) {
    out.push(`freecode trace ${traceable.sessionId}   # any iteration's trace`);
  }
  out.push(`git branch -D ${night.branch}   # discard the whole night`);
  out.push("```");

  if (night.uncommitted?.length) {
    out.push("");
    out.push(`## Uncommitted (${night.uncommitted.length} paths)`);
    out.push(
      "Left in the working tree on purpose — a forced stop or a crash must never destroy work.",
    );
    for (const p of night.uncommitted.slice(0, 40)) out.push(`- ${p}`);
  }

  return `${out.join("\n")}\n`;
}

function headline(input: ReportInput, ok: number, failed: number): string {
  const { night } = input;
  const parts = [
    `Stopped: ${night.stopReason ?? input.status}`,
    // `!== undefined`, not truthiness: a timestamp of 0 is a real value, and
    // the falsy check silently dropped the elapsed time.
    input.startedAt !== undefined && input.endedAt !== undefined
      ? duration(input.endedAt - input.startedAt)
      : undefined,
    `${night.iterations} iteration${night.iterations === 1 ? "" : "s"} (${ok} committed, ${failed} failed)`,
  ].filter(Boolean);

  const cost =
    input.usd && input.usd > 0
      ? `$${input.usd.toFixed(2)}`
      : // Never $0: an unpriced model must stay distinguishable from a free one.
        "cost unknown (model not priced)";
  const money = [
    cost,
    `${input.provider}${input.model ? `/${input.model}` : ""}${
      input.authMode ? `, ${input.authMode}` : ""
    }`,
    night.waitedMs > 0 ? `waited ${duration(night.waitedMs)} on quota` : undefined,
    night.fallbackIterations.length > 0
      ? `${night.fallbackIterations.length} iteration(s) on ${night.fallbackModel ?? "the fallback model"}`
      : undefined,
  ].filter(Boolean);

  const branch = [
    `Branch ${night.branch}`,
    `${night.commits.length} commit${night.commits.length === 1 ? "" : "s"}`,
    night.verifyCommand ? `verified with \`${night.verifyCommand}\`` : "NOT verified (no --verify)",
  ];

  return [parts.join(" · "), money.join(" · "), branch.join(" · ")].join("\n");
}

function iterationLine(
  r: IterationRecord,
  subjects: Record<string, string> | undefined,
): string {
  const n = String(r.n).padStart(2);
  if (r.commit) {
    const short = r.commit.slice(0, 7);
    return `${n} ✓ ${short}  ${subjects?.[r.commit] ?? r.summary ?? ""}`;
  }
  if (r.failure) {
    return `${n} ✗          ${r.failure}${r.summary ? ` — ${r.summary}` : ""}`;
  }
  // Succeeded with nothing to commit: learnings only.
  return `${n} · (notes)  ${r.summary ?? ""}`;
}

function waitLine(w: WaitRecord): string {
  return `   ⏸          waited ${duration(w.until - w.from)} — ${w.reason}`;
}

/**
 * Asks with no decision recorded in the same iteration.
 *
 * Deliberately coarse — one ask and one decision in an iteration are paired
 * without comparing their text, because the model rewords a question when it
 * answers it. Over-pairing hides nothing; the count is what matters.
 */
function unansweredAsks(
  asked: Array<Extract<Decision, { kind: "asked" }>>,
  decided: Array<Extract<Decision, { kind: "decided" }>>,
): Array<{ iteration: number; question: string }> {
  const answers = new Map<number, number>();
  for (const d of decided) {
    answers.set(d.iteration, (answers.get(d.iteration) ?? 0) + 1);
  }
  const out: Array<{ iteration: number; question: string }> = [];
  for (const a of asked) {
    for (const question of a.questions) {
      const left = answers.get(a.iteration) ?? 0;
      if (left > 0) {
        answers.set(a.iteration, left - 1);
        continue;
      }
      out.push({ iteration: a.iteration, question });
    }
  }
  return out;
}

export function duration(ms: number): string {
  if (ms < 0) return "0m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}
