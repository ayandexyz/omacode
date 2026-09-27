import { Chalk } from "chalk";
import {
  loadOmarchyPalette,
  omarchyPalette,
  OMARCHY_KEYS,
  type OmarchyPalette,
} from "./utils/omarchy-theme.js";

/**
 * The one place the TUI picks a colour. Every component paints through these
 * semantic names rather than `chalk.yellow` / `chalk.hex("#…")` directly, so
 * on Omarchy the whole UI follows the active theme and everywhere else the
 * look is exactly the chalk defaults the TUI shipped with.
 *
 * Level is forced to 3 (same as `themes.ts`): the TUI only ever runs on a
 * TTY, and a hex colour has no 16-colour approximation worth falling back to.
 */
const chalk = new Chalk({ level: 3 });

type Paint = (text: string) => string;

/** Mix `amount` of `over` into `base`; both `#rrggbb`. */
export function mix(base: string, over: string, amount: number): string {
  const ch = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const blend = (i: number): string =>
    Math.round(ch(base, i) * (1 - amount) + ch(over, i) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${blend(0)}${blend(1)}${blend(2)}`;
}

export interface Palette {
  /** App chrome: logo, editor border, /shells, question card, build mode. */
  accent: Paint;
  /** Second tone of the accent (logo's dim half, editor hints). */
  accentDim: Paint;
  /** Secondary chrome: /agents card and chip. */
  accent2: Paint;
  /** Labels, borders, placeholder text. */
  muted: Paint;
  /** Body text. */
  fg: Paint;
  fgBright: Paint;

  red: Paint;
  green: Paint;
  yellow: Paint;
  orange: Paint;
  blue: Paint;
  magenta: Paint;
  cyan: Paint;
  brightRed: Paint;
  brightGreen: Paint;
  brightYellow: Paint;
  brightBlue: Paint;
  brightMagenta: Paint;
  brightCyan: Paint;

  /** Text painted over a coloured chip/badge background. */
  onAccent: Paint;
  /** Raised surface: status bar, frame stats, inline input box. */
  bgSurface: Paint;
  /** Background of a submitted prompt in the transcript. */
  bgUserMessage: Paint;
  /** Selected text in the editor. */
  bgSelection: Paint;
  /** Selected text foreground, paired with `bgSelection`. */
  fgSelection: Paint;
  bgDiffAdd: Paint;
  bgDiffDel: Paint;
  /** Chip / badge backgrounds. */
  bgAccent: Paint;
  bgAccent2: Paint;
  bgRed: Paint;
  bgGreen: Paint;
  bgBlue: Paint;
  bgMagenta: Paint;

  /** Syntax highlighting (cli-highlight theme keys). */
  syntax: {
    keyword: Paint;
    builtin: Paint;
    literal: Paint;
    string: Paint;
    comment: Paint;
    function: Paint;
    attr: Paint;
    default: Paint;
  };

  /**
   * In-progress phrase shimmer (see `utils/shimmer.ts`): the resting tone
   * and the highlight that sweeps across it. Hex strings, since the band
   * is blended per character.
   */
  shimmer: { base: string; glow: string };

  /** Context-usage report segments, hex strings (the grid needs enough hues). */
  segments: Record<string, string>;
  segmentFree: string;
}

function defaultPalette(): Palette {
  return {
    accent: chalk.yellowBright,
    accentDim: chalk.yellow,
    accent2: chalk.hex("#5FD7FF"),
    muted: chalk.hex("#666666"),
    fg: chalk.white,
    fgBright: chalk.whiteBright,

    red: chalk.red,
    green: chalk.green,
    yellow: chalk.yellow,
    orange: chalk.hex("#ffb86c"),
    blue: chalk.blue,
    magenta: chalk.magenta,
    cyan: chalk.cyan,
    brightRed: chalk.redBright,
    brightGreen: chalk.greenBright,
    brightYellow: chalk.yellowBright,
    brightBlue: chalk.blueBright,
    brightMagenta: chalk.magentaBright,
    brightCyan: chalk.cyanBright,

    onAccent: chalk.black,
    bgSurface: chalk.bgHex("#262626"),
    bgUserMessage: chalk.bgHex("#262626"),
    bgSelection: chalk.bgYellow,
    fgSelection: chalk.black,
    bgDiffAdd: chalk.bgHex("#143c1a"),
    bgDiffDel: chalk.bgHex("#4d1419"),
    bgAccent: chalk.bgHex("#FFD700"),
    bgAccent2: chalk.bgHex("#5FD7FF"),
    bgRed: chalk.bgHex("#FF4444"),
    bgGreen: chalk.bgHex("#3CFB3C"),
    bgBlue: chalk.bgHex("#5B9BD5"),
    bgMagenta: chalk.bgHex("#D92688"),

    // Dracula.
    syntax: {
      keyword: chalk.hex("#ff79c6"),
      builtin: chalk.hex("#8be9fd"),
      literal: chalk.hex("#bd93f9"),
      string: chalk.hex("#f1fa8c"),
      comment: chalk.hex("#6272a4"),
      function: chalk.hex("#50fa7b"),
      attr: chalk.hex("#ffb86c"),
      default: chalk.hex("#f8f8f2"),
    },

    segments: {
      "system-prompt": "#d78700",
      "project-instructions": "#5fafff",
      skills: "#00afaf",
      "agent-types": "#5fd7af",
      "memory-guidance": "#af87ff",
      tools: "#ff5f87",
      "mcp-tools": "#ff875f",
      "compaction-summary": "#87875f",
      memories: "#af5fff",
      todos: "#5fd75f",
      "project-context": "#00d7af",
      messages: "#ffd75f",
    },
    segmentFree: "#585858",
    shimmer: { base: "#8a8a8a", glow: "#ffffff" },
  };
}

function omarchyThemedPalette(t: NonNullable<typeof omarchyPalette>): Palette {
  return {
    accent: chalk.hex(t.accent),
    accentDim: chalk.hex(t.yellow),
    accent2: chalk.hex(t.bright_cyan),
    muted: chalk.hex(t.muted),
    fg: chalk.hex(t.foreground),
    fgBright: chalk.hex(t.bright_foreground),

    red: chalk.hex(t.red),
    green: chalk.hex(t.green),
    yellow: chalk.hex(t.yellow),
    orange: chalk.hex(t.orange),
    blue: chalk.hex(t.blue),
    magenta: chalk.hex(t.magenta),
    cyan: chalk.hex(t.cyan),
    brightRed: chalk.hex(t.bright_red),
    brightGreen: chalk.hex(t.bright_green),
    brightYellow: chalk.hex(t.bright_yellow),
    brightBlue: chalk.hex(t.bright_blue),
    brightMagenta: chalk.hex(t.bright_magenta),
    brightCyan: chalk.hex(t.bright_cyan),

    onAccent: chalk.hex(t.background),
    bgSurface: chalk.bgHex(t.lighter_background),
    // lighter_background is often within a few steps of background (Ristretto,
    // Osaka Jade), so a prompt painted with it barely reads as a block. Tint
    // toward the accent instead — visible on every theme, still the theme's.
    bgUserMessage: chalk.bgHex(mix(t.background, t.accent, 0.2)),
    bgSelection: chalk.bgHex(t.selection),
    fgSelection: chalk.hex(t.bright_foreground),
    // No diff colours in colors.toml; tint the background toward the theme's
    // green/red the way the Dracula defaults do.
    bgDiffAdd: chalk.bgHex(mix(t.background, t.green, 0.25)),
    bgDiffDel: chalk.bgHex(mix(t.background, t.red, 0.3)),
    bgAccent: chalk.bgHex(t.accent),
    bgAccent2: chalk.bgHex(t.bright_cyan),
    bgRed: chalk.bgHex(t.red),
    bgGreen: chalk.bgHex(t.green),
    bgBlue: chalk.bgHex(t.blue),
    bgMagenta: chalk.bgHex(t.magenta),

    syntax: {
      keyword: chalk.hex(t.magenta),
      builtin: chalk.hex(t.cyan),
      literal: chalk.hex(t.bright_magenta),
      string: chalk.hex(t.yellow),
      comment: chalk.hex(t.muted),
      function: chalk.hex(t.green),
      attr: chalk.hex(t.orange),
      default: chalk.hex(t.foreground),
    },

    segments: {
      "system-prompt": t.orange,
      "project-instructions": t.blue,
      skills: t.cyan,
      "agent-types": t.bright_cyan,
      "memory-guidance": t.magenta,
      tools: t.red,
      "mcp-tools": t.bright_red,
      "compaction-summary": t.yellow,
      memories: t.bright_magenta,
      todos: t.green,
      "project-context": t.bright_cyan,
      messages: t.bright_yellow,
    },
    segmentFree: t.muted,
    shimmer: {
      base: mix(t.foreground, t.muted, 0.5),
      glow: t.bright_foreground,
    },
  };
}

// =============================================================================
// Live palette
//
// `palette` is a STABLE FACADE, not the colours themselves. Every paint on it
// is a permanent wrapper that resolves against `current` when it is CALLED.
//
// That indirection is the whole trick. Components capture paints at module
// scope — `const accent = palette.accent`, `const SHELLS_CHIP_BG =
// palette.bgAccent`, `diffTheme` in code-block.ts, `STATUS_BAR_BG` in
// themes.ts — and they call them inside `render()`. Swapping the object behind
// the facade therefore repaints all of them with no change at any of the ~28
// call sites. Reassigning `palette` itself would strand every one of those
// captures on the old theme, which is the bug this shape exists to avoid.
// =============================================================================

/** The colours in force. Replaced wholesale by `applyPalette`. */
let current: Palette = omarchyPalette
  ? omarchyThemedPalette(omarchyPalette)
  : defaultPalette();

/** The raw OS palette the current theme was built from, for change detection. */
let currentSource: OmarchyPalette | null = omarchyPalette;

/** A paint that looks itself up at call time. */
const live =
  (pick: (p: Palette) => Paint): Paint =>
  (text: string) =>
    pick(current)(text);

function buildFacade(): Palette {
  const syntax = {} as Palette["syntax"];
  for (const key of Object.keys(current.syntax) as (keyof Palette["syntax"])[]) {
    syntax[key] = live((p) => p.syntax[key]);
  }

  const facade = {
    syntax,
    // Object identity is preserved for these two: `context-report.ts` captures
    // `palette.segments` at module scope, so they are mutated in place by
    // `applyPalette` rather than replaced.
    segments: { ...current.segments },
    shimmer: { ...current.shimmer },
  } as Palette;

  for (const key of Object.keys(current) as (keyof Palette)[]) {
    if (typeof current[key] === "function") {
      facade[key] = live((p) => p[key] as Paint) as never;
    }
  }

  // A plain string cannot be made live by capture, so it is a getter; the one
  // consumer reads `palette.segmentFree` at use rather than hoisting it.
  Object.defineProperty(facade, "segmentFree", {
    get: () => current.segmentFree,
    enumerable: true,
  });

  return facade;
}

export const palette: Palette = buildFacade();

/** Swap the colours behind the facade. */
function applyPalette(next: Palette): void {
  current = next;
  for (const key of Object.keys(palette.segments)) delete palette.segments[key];
  Object.assign(palette.segments, next.segments);
  Object.assign(palette.shimmer, next.shimmer);
}

/**
 * Re-read the OS theme and repaint if it changed.
 *
 * Returns true when the palette actually moved, so a caller can skip a render.
 * A failed read — theme mid-swap, CLI missing, a key it cannot resolve —
 * KEEPS the last valid palette: a half-written theme must not flash the UI
 * back to the chalk defaults and then forward again.
 *
 * `load` is injectable so the liveness contract can be tested off Omarchy;
 * production callers pass nothing.
 */
export function refreshPalette(load: () => OmarchyPalette | null = loadOmarchyPalette): boolean {
  const next = load();
  if (!next) return false;
  if (currentSource && OMARCHY_KEYS.every((k) => currentSource![k] === next[k])) {
    return false;
  }
  currentSource = next;
  applyPalette(omarchyThemedPalette(next));
  return true;
}

/**
 * The bare opening SGR sequence of a paint, for renderers that must open a
 * colour, pad, and reset exactly once per line (a nested paint's own close
 * code would end a background band mid-row). Resolved at call time, so it
 * follows a live theme switch like the paint itself.
 */
export function sgrOpen(paint: Paint): string {
  const painted = paint("\u0000");
  return painted.slice(0, painted.indexOf("\u0000"));
}
