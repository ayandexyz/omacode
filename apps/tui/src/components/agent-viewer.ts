import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { palette } from "../palette.js";
import type { AgentSummary, StreamEvent } from "@thisisayande/freecode-shared";
import { MessageStore } from "../state/message-store.js";
import { Transcript } from "./transcript.js";
import { VirtualMessageList } from "./virtual-message-list.js";
import { createMessageComponent } from "./message-row.js";

const accent = palette.accent2;
const dim = palette.muted;
/** Header, rule, hint. */
const CHROME_ROWS = 3;
const MIN_BODY_ROWS = 3;
/** A subagent's transcript is bounded like the main one, just smaller. */
const MAX_MESSAGES = 500;

export interface AgentViewerCallbacks {
  /** Interrupt the agent being watched. */
  onStop: (agentId: string) => void;
  /** Hand the main area back to the main agent's transcript. */
  onBack: () => void;
}

function elapsed(agent: AgentSummary): string {
  const ms = (agent.endedAt ?? Date.now()) - agent.startedAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m}m` : `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * AgentViewer — a subagent's transcript, rendered IN PLACE OF the main one.
 *
 * It takes the main area's slot in `tui.children` while a subagent is being
 * watched. The body is the same VirtualMessageList the conversation uses,
 * over the agent's own MessageStore, fed by its own Transcript: tool cards,
 * thinking blocks and streaming rows look and behave exactly as they do for
 * the main agent, and nothing leaks between the two.
 */
export class AgentViewer implements Component {
  private agent: AgentSummary | null = null;
  private readonly store = new MessageStore({ maxMessages: MAX_MESSAGES });
  private readonly transcript: Transcript;
  private readonly list: VirtualMessageList;
  private maxRowsSource: () => number = () => 24;

  constructor(
    private readonly callbacks: AgentViewerCallbacks,
    tui?: TUI,
  ) {
    this.transcript = new Transcript(this.store, tui ?? null);
    this.list = new VirtualMessageList(
      200,
      () => this.bodyRows,
      undefined,
      () => null,
      () => 0,
      this.store,
    );
    if (tui) this.list.setTui(tui);
  }

  setMaxRows(rows: number | (() => number)): void {
    this.maxRowsSource = typeof rows === "function" ? rows : () => rows;
  }

  /** Point the viewer at an agent, replaying its recorded activity. */
  open(agent: AgentSummary, activity: StreamEvent[]): void {
    this.agent = agent;
    this.transcript.reset();
    this.store.clear();
    // The instruction the parent sent opens the transcript as a user turn,
    // exactly as the main agent's own prompt does. It lives on the roster
    // record, not in the activity ring buffer, so it survives truncation.
    if (agent.prompt) {
      this.store.add(
        "user",
        agent.prompt,
        createMessageComponent("user", agent.prompt),
      );
    }
    for (const event of activity) this.transcript.apply(event);
    this.list.scrollToBottom();
  }

  /** Roster refresh — status and elapsed time only, never the transcript. */
  update(agent: AgentSummary | undefined): void {
    if (agent && this.agent && agent.id === this.agent.id) this.agent = agent;
  }

  agentId(): string | undefined {
    return this.agent?.id ?? undefined;
  }

  /** A live stream event published under the watched agent's session id. */
  apply(event: StreamEvent): boolean {
    return this.transcript.apply(event);
  }

  /** Rows of transcript in the store, for tests and the empty-state check. */
  messageCount(): number {
    return this.store.getMessages().length;
  }

  private get bodyRows(): number {
    return Math.max(MIN_BODY_ROWS, this.maxRowsSource() - CHROME_ROWS);
  }

  render(width: number): string[] {
    const agent = this.agent;
    if (!agent) return [];

    const status =
      agent.status === "running"
        ? accent(`running ${elapsed(agent)}`)
        : dim(`${agent.status} ${elapsed(agent)}`);
    const kind = agent.background ? "Background subagent" : "Subagent";
    const label = `${kind}: ${agent.task.split("\n")[0]}`;
    const head = `${chalk.bold(truncateToWidth(label, Math.max(10, width - 24)))}  ${status}`;

    const rows: string[] = [head, accent("─".repeat(Math.max(0, width)))];

    if (this.store.getMessages().length === 0) {
      rows.push(dim("(no activity yet)"));
    } else {
      const body = this.list.render(width);
      // Follow mode renders the full history; the header and hint must stay
      // on screen, so window the tail to the rows this viewer was given.
      rows.push(...body.slice(-this.bodyRows));
    }

    rows.push(
      dim(
        [
          "esc back to main",
          "pgup/pgdn scroll",
          ...(this.list.isScrolled ? ["end follow"] : []),
          ...(agent.status === "running" ? ["k stop"] : []),
        ].join(" · "),
      ),
    );
    return rows;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") {
      this.callbacks.onBack();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.list.scrollPageUp();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.list.scrollPageDown();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.list.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.list.scrollBy(1);
      return;
    }
    if (matchesKey(data, Key.end) || data === "G") {
      this.list.scrollToBottom();
      return;
    }
    if (data === "k" && this.agent?.status === "running") {
      this.callbacks.onStop(this.agent.id);
    }
  }

  invalidate(): void {
    this.list.invalidate();
  }

  /** Release the store subscription when the viewer is discarded. */
  destroy(): void {
    this.list.destroy();
  }
}
