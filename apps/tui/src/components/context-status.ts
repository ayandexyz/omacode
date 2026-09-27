import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { CacheStats, CacheMissSample } from "@thisisayande/freecode-shared";
import chalk from "chalk";
import { palette } from "../palette.js";
import { formatTokenCount } from "../utils/format-tokens.js";

// Sized to the widest miss row with the longest built-in reason,
// "12.3> 999.9k miss (harness: prefix rewritten)" — 45 columns; a documented
// reason (journal source + detail) is truncated to fit.
const MAX_WIDTH = 46;

/** Most recent misses shown before folding the rest into "… N more". */
const MAX_MISS_ROWS = 5;

/**
 * Context usage and prompt-cache accounting, drawn in the normal layout
 * rather than floating over it. It used to be a top-right overlay, which
 * covered whatever conversation text scrolled under it — pi-tui overlays
 * cannot reserve the space beneath them.
 *
 * Two pieces:
 *   - `contextSummary()` — the status row under the input, left side:
 *       12.3K / 200.0K · yield 99% · last 97% · session 91%
 *     (`tokens / limit`, then jcode's KV-cache-widget ratios). Before core has
 *     reported stats, the last run's plain hit rate (`cache 87%`) stands in.
 *   - `ContextMisses` — rows under the status row listing cache misses, shown
 *     only when there are any: "none" was a permanent row saying nothing.
 *
 * `yield` is the harness-health number (read ÷ what the previous request made
 * cacheable), `last`/`session` the cost numbers (read ÷ prompt). Every ratio
 * comes from core (`cache_status.stats`); this only draws. Nothing renders
 * while the limit is unknown, so it never fabricates numbers.
 */
export interface ContextSummary {
  /** `tokens / limit`, dim. */
  tokens: string;
  /** The coloured cache line, or null before any cache data exists. */
  cache: string | null;
}

export function contextSummary(
  contextTokens: number,
  contextLimit: number,
  cacheRate: number | undefined,
  stats: CacheStats | undefined,
): ContextSummary | null {
  if (contextLimit <= 0) return null;
  const fmt = (n: number) => formatTokenCount(n).toUpperCase();
  const cache = stats
    ? renderCacheSummary(stats)
    : cacheRate !== undefined
      ? chalk.dim(`cache ${cacheRate}%`)
      : null;
  return { tokens: `${fmt(contextTokens)} / ${fmt(contextLimit)}`, cache };
}

/** Cache-miss rows under the status row; renders nothing without misses. */
export class ContextMisses implements Component {
  constructor(
    private getStats: () => CacheStats | undefined,
    /** Columns to indent by, so the rows line up with the prompt text. */
    private getIndent: () => number = () => 0,
  ) {}

  render(width: number): string[] {
    const stats = this.getStats();
    if (!stats || stats.misses.length === 0 || width < MAX_WIDTH) return [];
    const pad = " ".repeat(this.getIndent());
    return renderMissAttribution(stats).map((line) => pad + line);
  }

  invalidate(): void {}
}

/** jcode's thresholds: red < 25, yellow < 60, blue < 85, green otherwise. */
function healthPaint(pct: number) {
  if (pct < 25) return palette.red;
  if (pct < 60) return palette.yellow;
  if (pct < 85) return palette.blue;
  return palette.green;
}

function renderCacheSummary(stats: CacheStats): string {
  // Colour follows the freshest health signal available, as in jcode.
  const health =
    stats.lastYieldPct ?? stats.lastPct ?? stats.yieldPct ?? stats.sessionPct;
  const paint = healthPaint(health);
  const label = (s: string) => chalk.dim(s);
  const value = (n: number) => chalk.bold(paint(`${n}%`));
  const parts: string[] = [];
  parts.push(
    stats.yieldPct === undefined
      ? chalk.bold(paint("priming"))
      : `${label("yield ")}${value(stats.yieldPct)}`,
  );
  if (stats.lastPct !== undefined) {
    parts.push(`${label("last ")}${value(stats.lastPct)}`);
  }
  parts.push(`${label("session ")}${value(stats.sessionPct)}`);
  return parts.join(chalk.dim(" · "));
}

function renderMissAttribution(stats: CacheStats): string[] {
  const total = stats.misses.reduce((sum, m) => sum + m.missedTokens, 0);
  const lines = [
    `${chalk.dim.bold("miss attribution")} ${chalk.dim(`· ${formatTokenCount(total)} missed total`)}`,
  ];
  const recent = stats.misses.slice(-MAX_MISS_ROWS);
  for (const miss of recent) lines.push(renderMissRow(miss));
  const hidden = stats.misses.length - recent.length;
  if (hidden > 0) lines.push(chalk.dim(`… ${hidden} more`));
  return lines;
}

function renderMissRow(miss: CacheMissSample): string {
  const turn = miss.turn
    ? miss.turn.call <= 1
      ? `${miss.turn.run}>`
      : `${miss.turn.run}.${miss.turn.call}>`
    : "?>";
  const head = `${chalk.bold(palette.blue(turn))} ${palette.yellow(
    `${formatTokenCount(miss.missedTokens)} miss`,
  )} `;
  // A harness bug is the one row worth a second look, so it keeps its colour;
  // legitimate causes stay dim.
  const reasonPaint = miss.harnessBug ? palette.red : chalk.dim;
  const room = MAX_WIDTH - visibleWidth(head) - 2; // the parentheses
  const reason =
    miss.reason.length > room
      ? `${miss.reason.slice(0, Math.max(0, room - 1))}…`
      : miss.reason;
  return `${head}${reasonPaint(`(${reason})`)}`;
}
