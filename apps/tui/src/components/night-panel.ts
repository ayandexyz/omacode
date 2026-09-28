import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { palette } from "../palette.js";
import type { NightRunSummary } from "@thisisayande/freecode-shared";

// Same card chrome as /agents and /shells, its own accent so the three are
// told apart at a glance.
const accent = palette.blue;
const dim = palette.muted;
/** Reserved for "a human has to act" — the one thing that must not blend in. */
const warn = palette.yellow;
const PAD_X = 2;
/** Top border, hint, bottom border. */
const CHROME_ROWS = 3;
const MIN_INNER_WIDTH = 40;

export interface NightPanelCallbacks {
  /** Open a run's morning report in place of the conversation. */
  onOpen: (runId: string) => void;
  /** Ask a running night to stop after its current iteration. */
  onStop: (runId: string) => void;
  onClose: () => void;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The right-hand cell: what the reader needs before deciding to open it.
 *
 * `needs you` outranks everything, including the commit count — a night that
 * produced nine commits and one question the user has to answer is, to them, a
 * night with a question in it.
 */
function statusCell(run: NightRunSummary): string {
  // Alone on the row when it applies: a question the user has to answer is not
  // one fact among several, and appending the commit count would dilute it.
  if (run.needsHuman > 0) {
    return warn(`${run.needsHuman} need${run.needsHuman === 1 ? "s" : ""} you`);
  }
  const commits = `${run.commits} commit${run.commits === 1 ? "" : "s"}`;
  // The wait lives here rather than beside the objective: this cell keeps its
  // width and the label absorbs the truncation, so a long objective used to
  // eat the wait entirely.
  const waited = run.waitedMs > 0 ? ` · waited ${duration(run.waitedMs)}` : "";
  if (run.status === "running") {
    return accent(`running · it.${run.iterations} · ${commits}`) + dim(waited);
  }
  if (run.status === "crashed") return warn(`crashed · ${commits}`) + dim(waited);
  return dim(`${run.stopReason ?? run.status} · ${commits}${waited}`);
}

/**
 * NightPanel — the `/night` card: every overnight run, newest first.
 *
 * READ-ONLY on purpose. A night is a separate foreground process
 * (`freecode night …`), so this shows what it left on disk and can ask it to
 * stop; it cannot start one. Starting a run from inside the TUI would put an
 * unattended agent loop in the same daemon as the user's own session, sharing
 * its permission surface — and detached execution is deliberately Phase 5.
 *
 * Height is content-driven, like /agents: three runs is a five-row card.
 */
export class NightPanel implements Component {
  private runs: NightRunSummary[] = [];
  private selected = 0;
  private listScroll = 0;
  private maxRowsSource: () => number = () => 24;

  constructor(private readonly callbacks: NightPanelCallbacks) {}

  setMaxRows(rows: number | (() => number)): void {
    this.maxRowsSource = typeof rows === "function" ? rows : () => rows;
  }

  /** Replaces the roster, keeping the cursor on the same run. */
  setRuns(runs: NightRunSummary[]): void {
    const previousId = this.runs[this.selected]?.runId;
    this.runs = runs;
    const next = runs.findIndex((r) => r.runId === previousId);
    this.selected = next >= 0 ? next : Math.min(this.selected, runs.length - 1);
    if (this.selected < 0) this.selected = 0;
  }

  runningCount(): number {
    return this.runs.filter((r) => r.status === "running").length;
  }

  /** Runs with something the user has to answer — what the chip should shout. */
  needsYouCount(): number {
    return this.runs.reduce((sum, r) => sum + r.needsHuman, 0);
  }

  isEmpty(): boolean {
    return this.runs.length === 0;
  }

  selectedRun(): NightRunSummary | undefined {
    return this.runs[this.selected];
  }

  private get listRows(): number {
    return Math.max(
      1,
      Math.min(Math.max(this.runs.length, 1), this.maxRowsSource() - CHROME_ROWS),
    );
  }

  heightFor(width: number): number {
    void width;
    return this.listRows + CHROME_ROWS;
  }

  render(width: number): string[] {
    const inner = Math.max(MIN_INNER_WIDTH, width - 2);
    const bodyWidth = inner - PAD_X * 2;
    const border = accent("│");

    const row = (text: string): string => {
      const clipped =
        visibleWidth(text) > bodyWidth ? truncateToWidth(text, bodyWidth) : text;
      const fill = " ".repeat(Math.max(0, bodyWidth - visibleWidth(clipped)));
      const pad = " ".repeat(PAD_X);
      return `${border}${pad}${clipped}${fill}${pad}${border}`;
    };

    const entry = (label: string, meta: string, isSelected: boolean): string => {
      const marker = isSelected ? accent("> ") : "  ";
      const metaWidth = visibleWidth(meta);
      const labelWidth = Math.max(8, bodyWidth - metaWidth - 4);
      const text = truncateToWidth(label, labelWidth);
      const gap = " ".repeat(
        Math.max(1, bodyWidth - 2 - visibleWidth(text) - metaWidth),
      );
      return `${marker}${isSelected ? chalk.bold(text) : text}${gap}${meta}`;
    };

    const rows: string[] = [];
    const title = " Night runs ";
    rows.push(
      accent("╭─") +
        chalk.bold(title) +
        accent("─".repeat(Math.max(0, inner - visibleWidth(title) - 1)) + "╮"),
    );

    if (this.runs.length === 0) {
      // Say how to make one rather than just reporting emptiness — the panel
      // cannot start a run, so the command is the whole answer.
      rows.push(row(dim("No overnight runs yet.")));
      rows.push(row(dim('freecode night "<objective>" --until 07:00')));
      rows.push(accent("╰" + "─".repeat(inner) + "╯"));
      return rows;
    }

    const entries = this.runs.map((run, i) =>
      entry(
        run.objective,
        statusCell(run),
        i === this.selected,
      ),
    );

    const listRows = this.listRows;
    if (this.selected < this.listScroll) this.listScroll = this.selected;
    if (this.selected >= this.listScroll + listRows) {
      this.listScroll = this.selected - listRows + 1;
    }
    for (const text of entries.slice(this.listScroll, this.listScroll + listRows)) {
      rows.push(row(text));
    }

    // The hint names only what applies to the current selection.
    const sel = this.selectedRun();
    const actions =
      sel?.status === "running" ? ["enter report", "k stop"] : ["enter report"];
    rows.push(row(dim(["up/down select", ...actions, "esc close"].join(" · "))));
    rows.push(accent("╰" + "─".repeat(inner) + "╯"));
    return rows;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") {
      this.callbacks.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = Math.min(this.runs.length - 1, this.selected + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      const run = this.selectedRun();
      if (run) this.callbacks.onOpen(run.runId);
      return;
    }
    if (data === "k") {
      // Only a running night has anything to stop, and the stop is a request
      // it picks up at its next iteration boundary — never a kill.
      const run = this.selectedRun();
      if (run?.status === "running") this.callbacks.onStop(run.runId);
    }
  }

  invalidate(): void {}
}
