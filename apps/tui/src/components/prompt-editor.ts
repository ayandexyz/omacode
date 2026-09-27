import {
  Editor,
  decodeKittyPrintable,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { palette } from "../palette.js";
import type { ContextSummary } from "./context-status.js";

/** Image data from clipboard */
export interface PendingImage {
  data: string;
  mediaType: string;
}

/**
 * Format the prompt-history index for the bottom-border indicator.
 * 1-based from the most recent entry, so `[3/12]` is the 3rd-most-recent of
 * 12. Returns null when not browsing (`historyIndex === -1`) or when the
 * ring is empty.
 *
 * Pure helper — extracted from `PromptEditor` so it can be unit-tested
 * without standing up a pi-tui `TUI` + `Terminal`.
 */
export function formatHistoryIndicator(
  historyIndex: number,
  total: number,
): string | null {
  if (historyIndex < 0 || total === 0) return null;
  return `[${historyIndex + 1}/${total}]`;
}

/**
 * What the composer is about to do with what has been typed. Drives the
 * prompt glyph and its colour, the way jcode's `composer_mode` does: the
 * input line itself says whether Enter sends a prompt, runs a shell command
 * or opens a slash command, so no separate mode indicator is needed.
 */
export type ComposerMode = "chat" | "command" | "shell" | "processing";

/**
 * Classify composer state from the text and whether a turn is running.
 *
 * Shell wins over slash: `!` is a prefix on the raw text, checked before the
 * leading-`/` test, matching how `index.ts` dispatches a submitted prompt
 * (bang first, then slash). "processing" only applies to an empty composer —
 * once the user starts typing, what Enter will do matters more than what the
 * agent is currently doing.
 */
export function composerMode(text: string, isProcessing: boolean): ComposerMode {
  if (text.startsWith("!")) return "shell";
  if (text.trimStart().startsWith("/")) return "command";
  if (isProcessing && text.length === 0) return "processing";
  return "chat";
}

/**
 * The glyph for a composer mode. One visible column plus a trailing space, so
 * every mode keeps the typed text on the same column and a mode switch never
 * reflows the line.
 *
 * Shell and command deliberately keep the plain `>`: the user has already
 * typed the `!` or `/` one column to the right, and `1$ !ls` / `1/ /model`
 * says the same thing twice. Those two modes are marked by the prompt's
 * colour instead, which costs no columns and never reads as a typo. Only
 * `processing` gets its own glyph, because an empty composer has no typed
 * text to carry the signal.
 */
export function promptGlyph(mode: ComposerMode): string {
  return mode === "processing" ? "… " : "> ";
}

/**
 * The full prompt prefix: the label (the git branch, or the 1-based turn
 * number outside a repo) then the mode glyph, e.g. `main> `. The branch is
 * what a prompt is about to act on, and the composer is the one place it is
 * read every time before pressing Enter.
 */
export function promptPrefix(label: string | number, mode: ComposerMode): string {
  return `${label}${promptGlyph(mode)}`;
}

/**
 * The dim chrome line under the composer: the history indicator on the left,
 * the status label (model, effort, mode) set against the right edge. Returns
 * null when there is nothing to say, so an idle composer costs zero rows.
 *
 * A label that would collide with the indicator is dropped rather than
 * wrapped — the indicator is transient and is what the user is looking at.
 */
export function buildStatusLine(
  width: number,
  indicator: string | null,
  label: string | null,
  indent = 0,
  context: ContextSummary | null = null,
): string | null {
  return layoutStatusLine(width, indicator, label, indent, context)?.line ?? null;
}

/** Column ranges (0-based, end exclusive) of the clickable context parts. */
export interface StatusLayout {
  line: string;
  tokens?: [number, number];
  cache?: [number, number];
}

/**
 * `buildStatusLine`, plus where the context summary landed so a click on it
 * can open the matching report. Widths are measured with `visibleWidth`: the
 * cache ratios arrive already coloured. When space runs out the cache part
 * goes first, then the right-hand label — the token count is the one number
 * that answers "how full is the context".
 */
export function layoutStatusLine(
  width: number,
  indicator: string | null,
  label: string | null,
  indent = 0,
  context: ContextSummary | null = null,
): StatusLayout | null {
  const sep = " · ";
  const build = (withCache: boolean) => {
    const parts: Array<{ text: string; key?: "tokens" | "cache" }> = [];
    if (indicator) parts.push({ text: chalk.dim(indicator) });
    if (context) parts.push({ text: chalk.dim(context.tokens), key: "tokens" });
    if (context?.cache && withCache) parts.push({ text: context.cache, key: "cache" });
    const ranges: Partial<Record<"tokens" | "cache", [number, number]>> = {};
    let col = indent;
    const texts: string[] = [];
    parts.forEach((part, i) => {
      if (i > 0) col += sep.length;
      const w = visibleWidth(part.text);
      if (part.key) ranges[part.key] = [col, col + w];
      col += w;
      texts.push(part.text);
    });
    return { left: texts.join(chalk.dim(sep)), ranges };
  };
  let right = label ?? "";
  const fits = (left: string) =>
    indent + visibleWidth(left) + (right ? 1 + visibleWidth(right) : 0) <= width;
  let built = build(true);
  if (!fits(built.left)) built = build(false);
  if (right && !fits(built.left)) right = "";
  let left = built.left;
  if (!left && !right) return null;
  if (indent + visibleWidth(left) > width) {
    left = truncateToWidth(left, Math.max(0, width - indent));
  }
  const gap = Math.max(1, width - indent - visibleWidth(left) - visibleWidth(right));
  return {
    line: chalk.dim(" ".repeat(indent)) + left + chalk.dim(" ".repeat(gap) + right),
    ...built.ranges,
  };
}

/**
 * Inline placeholder for a pasted image, in Claude Code's `[Image #N]` shape.
 * The token is ordinary editor text, so it word-wraps, moves, and deletes like
 * anything the user typed — the yellow chip styling and whole-token backspace
 * are layered on top by this class, the way pi-tui layers them onto its own
 * `[paste #N]` markers.
 */
const IMAGE_TOKEN = /\[Image #(\d+)\]/g;

/** Same token, anchored to the end of a string (for the char before the cursor). */
const IMAGE_TOKEN_AT_END = /\[Image #\d+\]$/;

/** CSI colour codes and pi-tui's zero-width APC cursor marker. */
const ANSI_SEQUENCE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|[_\]][^\x07]*\x07)/g;

/** Remove `[Image #N]` placeholders — the model gets the bytes, not the label. */
export function stripImageTokens(text: string): string {
  return text.replace(IMAGE_TOKEN, "");
}

/**
 * Whether a base-editor row is one of its horizontal rules. Content and
 * autocomplete rows start with padding spaces, so a row whose first visible
 * character is a box-drawing dash can only be a border (pi-tui draws the
 * `── ↓ N more` scroll indicators the same way).
 */
function isBorderRow(line: string): boolean {
  return line.replace(ANSI_SEQUENCE, "").startsWith("─");
}

/**
 * The `↑ N more` / `↓ N more` text pi-tui writes into a border when the
 * composer has scrolled, or null for a plain border.
 *
 * Dropping the borders would otherwise drop this with them, leaving a tall
 * pasted prompt silently truncated — the one piece of information those
 * rows carried that the prompt glyph does not replace. It is re-emitted on
 * the status row instead.
 */
export function scrollNotice(border: string): string | null {
  return /([↑↓] \d+ more)/.exec(border.replace(ANSI_SEQUENCE, ""))?.[1] ?? null;
}

/**
 * Prompt colour per composer mode. Shell is green because `$` meaning "this
 * runs on your machine" is worth a distinct colour rather than the accent
 * everything else uses; processing is dim so a composer the user is not
 * typing into recedes. `chat` is absent on purpose — it falls back to the
 * editor's `borderColor`, which the agent-mode cycle already repaints.
 */
const MODE_PAINT: Partial<Record<ComposerMode, (s: string) => string>> = {
  shell: palette.brightGreen,
  command: palette.brightCyan,
  processing: chalk.dim,
};

/**
 * Highlight @mentions in the editor content with yellow color.
 * Matches @word patterns (alphanumeric + underscore + dash + slash + dot)
 */
function highlightMentions(text: string): string {
  // Match @ followed by word characters, path separators, dots, etc.
  // This captures: @filename, @path/to/file, @file.ts, etc.
  return text.replace(/(@[^\s]+)/g, (match) => palette.yellow(match));
}

/** Split a rendered line into alternating escape-sequence and plain-text runs. */
function splitAnsi(line: string): Array<{ ansi: boolean; text: string }> {
  const parts: Array<{ ansi: boolean; text: string }> = [];
  let last = 0;
  for (const m of line.matchAll(ANSI_SEQUENCE)) {
    if (m.index > last) parts.push({ ansi: false, text: line.slice(last, m.index) });
    parts.push({ ansi: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ ansi: false, text: line.slice(last) });
  return parts;
}

/**
 * Paint `[Image #N]` tokens as a yellow chip on an already-rendered line.
 *
 * The line may already carry escape codes — mention highlighting, and pi-tui's
 * fake cursor (`\x1b[7m<grapheme>\x1b[0m`) which can land *inside* a token and
 * split it. So tokens are located in the escape-stripped text and the chip is
 * applied per plain-text run, leaving every existing sequence untouched. The
 * run under the cursor is skipped so the cursor stays visible on top of a chip.
 *
 * Only escape codes are added, never characters, so the editor's column math
 * and line padding are unaffected.
 */
function styleImageTokens(line: string): string {
  const parts = splitAnsi(line);
  const plain = parts.filter((p) => !p.ansi).map((p) => p.text).join("");
  if (!plain.includes("[Image #")) return line;

  // Mark the plain-text columns covered by a token.
  const inToken = new Uint8Array(plain.length);
  for (const m of plain.matchAll(IMAGE_TOKEN)) {
    inToken.fill(1, m.index, m.index + m[0].length);
  }

  let out = "";
  let col = 0;
  let underCursor = false;
  for (const part of parts) {
    if (part.ansi) {
      out += part.text;
      if (part.text === "\x1b[7m") underCursor = true;
      else if (part.text === "\x1b[0m") underCursor = false;
      continue;
    }
    // Emit maximal runs that are uniformly inside or outside a token.
    let i = 0;
    while (i < part.text.length) {
      const inside = inToken[col + i];
      let j = i + 1;
      while (j < part.text.length && inToken[col + j] === inside) j++;
      const run = part.text.slice(i, j);
      out += inside && !underCursor ? palette.bgSelection(palette.fgSelection(run)) : run;
      i = j;
    }
    col += part.text.length;
  }
  return out;
}

/**
 * PromptEditor — pi-tui Editor rendered as a borderless composer, in the
 * shape jcode uses: no box, just a turn-numbered prompt (`3> `) whose glyph
 * and colour say what Enter will do, and a dim status line underneath.
 *
 * The box was carrying two jobs — framing the input and hosting the status
 * label on its bottom border. Neither needs a frame: the prompt glyph marks
 * where input begins, and the status reads fine as a plain dim row. Dropping
 * it removes four columns of chrome and two drawn borders per frame, which
 * suits an Omarchy-targeted agent where the terminal is already framed by
 * the window manager.
 *
 * Highlights @filename mentions in yellow.
 *
 * Pasted images are inserted inline as `[Image #N]` tokens at the cursor, so
 * they sit between the words the user typed and can be repositioned or removed
 * by editing. One backspace deletes a whole chip.
 *
 * Padding reserves exactly the prompt's width on every content line; the
 * prefix is painted into that reserved space on the first line and later
 * lines are left blank, so wrapped text stays aligned under the first
 * character the user typed and cursor column math is unchanged.
 */
export class PromptEditor extends Editor {
  /** Image ID → bytes. Entries are dropped when their token leaves the text. */
  private images = new Map<number, PendingImage>();
  /** Next 1-based token ID; reset per submitted prompt, like pi's paste IDs. */
  private nextImageId = 1;
  /**
   * Plain text set into the right end of the bottom border — model, effort
   * and mode, so the box itself says what a prompt will run against. Read at
   * render time, so a mode cycle or model change needs only a re-render.
   */
  statusLabel?: () => string;
  /** Context usage + cache ratios for the left side of the status row. */
  statusContext?: () => ContextSummary | null;
  /**
   * Where the last render put the status row (index into this component's
   * lines) and its clickable context parts — read by the click handler.
   */
  lastStatus: { row: number; layout: StatusLayout } | null = null;
  /** Width of the prompt prefix at the last render — the text column. */
  promptIndent = 0;
  /**
   * Label shown before the glyph: the git branch, or the 1-based turn number
   * outside a repo. A getter so a checkout or a completed turn relabels the
   * composer without the editor needing to be told.
   */
  promptLabel: () => string | number = () => 1;
  /** Whether a turn is currently running — selects the `…` prompt glyph. */
  isProcessing: () => boolean = () => false;

  constructor(tui: TUI, theme: EditorTheme) {
    // Padding is re-derived per render from the prompt width; this is just
    // the width of the initial `1> `.
    super(tui, theme, { paddingX: 3 });
  }

  /** Insert an image at the cursor as a `[Image #N]` chip. Returns its ID. */
  insertImageAtCursor(image: PendingImage): number {
    const id = this.nextImageId++;
    this.images.set(id, image);
    this.insertTextAtCursor(`[Image #${id}]`);
    return id;
  }

  /** True if these exact bytes are still attached — used to reject a re-paste. */
  hasImage(data: string): boolean {
    return this.resolve(this.getText()).some((img) => img.data === data);
  }

  /**
   * Images referenced by the submitted text, in the order they appear, and
   * reset for the next prompt. Call this from `onSubmit`: pi-tui clears the
   * editor *before* firing the callback, so the tokens only exist in `text`
   * by then. Chips the user deleted are simply absent and never uploaded.
   */
  takeImagesFor(text: string): PendingImage[] {
    const images = this.resolve(text);
    this.images.clear();
    this.nextImageId = 1;
    return images;
  }

  /**
   * Look up the images `text` refers to, dropping any whose token is gone so a
   * deleted chip stops costing an upload.
   */
  private resolve(text: string): PendingImage[] {
    const seen = new Set<number>();
    const found: PendingImage[] = [];
    for (const m of text.matchAll(IMAGE_TOKEN)) {
      const id = Number.parseInt(m[1] ?? "", 10);
      if (seen.has(id)) continue;
      seen.add(id);
      const image = this.images.get(id);
      if (image) found.push(image);
    }
    for (const id of this.images.keys()) {
      if (!seen.has(id)) this.images.delete(id);
    }
    return found;
  }

  /**
   * Make backspace delete a whole chip. A `[Image #1]` token is ten characters
   * the user never typed individually, so erasing it one at a time (and briefly
   * leaving `[Image #` on screen) is not what backspace means here. The delete
   * is replayed through the base editor so cursor, wrapping, and undo stay in
   * its hands.
   */
  handleInput(data: string): void {
    // Alt+Enter submits as a follow-up (delivered after the run ends) instead
    // of a steer (delivered inside the running turn). Only meaningful while a
    // turn is running; otherwise both are a plain send. The flag is read once
    // by onSubmit via takeSubmitBehavior().
    if (matchesKey(data, "alt+enter")) {
      this.submitBehavior = "followUp";
      // `submitValue` is what Enter calls; it is not in pi-tui's public types.
      (this as unknown as { submitValue(): void }).submitValue();
      return;
    }
    // `/` on an empty composer opens the command menu instead of typing.
    // A `/` anywhere else is text (paths, `a/b`), and so is a pasted one.
    if (
      this.onSlashMenu &&
      this.getText() === "" &&
      (data === "/" || decodeKittyPrintable(data) === "/")
    ) {
      this.onSlashMenu();
      return;
    }
    if (this.isBackspace(data)) {
      const token = this.tokenBeforeCursor();
      if (token) {
        for (let i = 0; i < token.length; i++) super.handleInput(data);
        return;
      }
    }
    super.handleInput(data);
  }

  /** Opens the `/` menu; unset keeps `/` as plain text with inline completion. */
  onSlashMenu?: () => void;

  private submitBehavior: "steer" | "followUp" = "steer";

  /** How the submission just made should be queued if a turn is running. Resets to "steer". */
  takeSubmitBehavior(): "steer" | "followUp" {
    const b = this.submitBehavior;
    this.submitBehavior = "steer";
    return b;
  }

  private isBackspace(data: string): boolean {
    return (
      getKeybindings().matches(data, "tui.editor.deleteCharBackward") ||
      matchesKey(data, "shift+backspace")
    );
  }

  /** The `[Image #N]` token ending exactly at the cursor, if any. */
  private tokenBeforeCursor(): string | null {
    const { line, col } = this.getCursor();
    const text = this.getLines()[line] ?? "";
    return IMAGE_TOKEN_AT_END.exec(text.slice(0, col))?.[0] ?? null;
  }

  render(width: number): string[] {
    // The prompt is the left padding, so its width has to be set before the
    // base class lays text out — otherwise the first render after the turn
    // counter rolls to 10 wraps one column short.
    const mode = composerMode(this.getText(), this.isProcessing());
    const prefix = promptPrefix(this.promptLabel(), mode);
    this.setPaddingX(prefix.length);
    this.promptIndent = prefix.length;

    const editorLines = super.render(width);

    // Base output is: top border, content rows, bottom border, then any
    // autocomplete rows. Both borders are dropped. Content and autocomplete
    // rows are padded identically, so the split is found by locating the
    // bottom border — the first `─` row after index 0 — rather than assuming
    // a position.
    const bottomIdx = editorLines.findIndex((l, i) => i > 0 && isBorderRow(l));
    const end = bottomIdx === -1 ? editorLines.length : bottomIdx;
    const pad = " ".repeat(prefix.length);
    const paint = MODE_PAINT[mode] ?? this.borderColor;

    const out: string[] = [];
    for (let i = 1; i < end; i++) {
      // Mentions are highlighted first so the chip pass sees their escape
      // codes as sequences rather than swallowing them.
      const body = (editorLines[i] ?? "").slice(prefix.length);
      out.push((i === 1 ? paint(prefix) : pad) + styleImageTokens(highlightMentions(body)));
    }

    // Status chrome sits on its own dim row under the input: on the left the
    // scroll notice rescued from the dropped borders, else the history
    // position while paging with up/down; on the right the model · mode
    // label. pi-tui keeps historyIndex private, so `historyIndicator`
    // reaches for the runtime field TypeScript hides.
    const scrolled = [editorLines[0] ?? "", bottomIdx === -1 ? "" : editorLines[bottomIdx] ?? ""]
      .map(scrollNotice)
      .filter((n): n is string => n !== null)
      .join(" · ");
    const status = layoutStatusLine(
      width,
      scrolled || this.historyIndicator(),
      this.statusLabel?.() || null,
      prefix.length,
      this.statusContext?.() ?? null,
    );
    this.lastStatus = status ? { row: out.length, layout: status } : null;
    if (status !== null) out.push(status.line);

    // Autocomplete rows follow the bottom border and hang below the status
    // line, unframed and unstyled.
    if (bottomIdx !== -1) out.push(...editorLines.slice(bottomIdx + 1));
    return out;
  }

  /**
   * `[N/total]` for the current up/down position, or null when not browsing
   * history (historyIndex === -1) or when the ring is empty.
   */
  private historyIndicator(): string | null {
    const base = this as unknown as {
      historyIndex?: number;
      history?: string[];
    };
    const idx = base.historyIndex ?? -1;
    const total = base.history?.length ?? 0;
    return formatHistoryIndicator(idx, total);
  }
}
