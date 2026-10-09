// =============================================================================
// Deferred tool loading — spec docs/specs/2026-10-10-deferred-tool-loading.md
//
// MCP tool schemas are held back from the provider-facing tool list and found
// on demand with `tool_search`. Everything here is pure so the loop's only job
// is to call it: which tools are deferred, which a session has loaded, and the
// list that results.
//
// The loaded set is DERIVED from history, never stored: a `tool_search` result
// names what it loaded. (A call to a deferred tool is NOT evidence — a call
// made before loading is refused, and its refusal is in history too.) So
// resume, fork, `/tree` and `/rewind` carry the right set for free — they all
// hand the loop the active path — and a tool whose MCP server is gone simply
// falls out (pi's resume-before-reconnect bug cannot happen). Compaction drops
// old loads; it already invalidates the prefix, and a dropped tool is one
// search away.
//
// Two paths (spec §4.2). Everywhere: deferred tools are left out of the list
// and a load changes it — one cache miss per load. On Anthropic models that
// support it ("native"): every tool is sent from the first request, deferred
// ones with `defer_loading`, and the `tool_search` result carries
// `tool_reference` blocks that Anthropic expands in place — the list never
// changes, so nothing is re-sent. Same search, same guard, same derived set.
//
// Settings — project → user → default, like checkpoint/settings.ts:
//   { "tools": { "deferral": { "enabled": true, "minTokens": 4000, "native": true } } }
// Env: FREECODE_DEFER_TOOLS / FREECODE_DEFER_TOOLS_NATIVE — "1" on, "0" off,
// beating the files.
// Off by default: it changes what the model sees, so the default flips only on
// an `eval ab` delta (spec §5 Phase 4).
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { envFlag } from "../agent/signals/settings.js";
import type { Message } from "../agent/types.js";
import type { ProviderToolDef } from "./defs-cache.js";

export const TOOL_SEARCH_TOOL = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

export interface DeferralSettings {
  enabled: boolean;
  /**
   * Defer only when the deferrable schemas are at least this big. Below it a
   * load's cache miss costs more than the schemas would (spec §4.5).
   */
  minTokens: number;
  /** Use Anthropic's `defer_loading` + `tool_reference` where the model supports it. */
  native: boolean;
}

export const DEFAULT_DEFERRAL_SETTINGS: DeferralSettings = {
  enabled: false,
  minTokens: 4000,
  native: true,
};

type Scope = Partial<DeferralSettings>;

function readScope(filePath: string): Scope | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      tools?: { deferral?: Scope };
    };
    return parsed.tools?.deferral;
  } catch {
    return undefined;
  }
}

export function resolveDeferralSettings(
  scopes: Scope[],
  env: NodeJS.ProcessEnv = process.env,
): DeferralSettings {
  const enabled = scopes.find((s) => typeof s.enabled === "boolean")?.enabled;
  const native = scopes.find((s) => typeof s.native === "boolean")?.native;
  const minTokens = scopes.find(
    (s) =>
      typeof s.minTokens === "number" &&
      Number.isFinite(s.minTokens) &&
      s.minTokens >= 0,
  )?.minTokens;
  return {
    enabled:
      envFlag(env.FREECODE_DEFER_TOOLS) ??
      enabled ??
      DEFAULT_DEFERRAL_SETTINGS.enabled,
    minTokens: minTokens ?? DEFAULT_DEFERRAL_SETTINGS.minTokens,
    native:
      envFlag(env.FREECODE_DEFER_TOOLS_NATIVE) ??
      native ??
      DEFAULT_DEFERRAL_SETTINGS.native,
  };
}

export function loadDeferralSettings(projectRoot: string): DeferralSettings {
  const scopes = [
    path.join(projectRoot, ".freecode", "settings.json"),
    path.join(os.homedir(), ".freecode", "settings.json"),
  ]
    .map(readScope)
    .filter((s): s is Scope => s !== undefined);
  return resolveDeferralSettings(scopes);
}

/** Only MCP tools are deferred; built-ins are used every turn (spec §2). */
export function isDeferrable(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * Whether the native path applies: Anthropic's own endpoint, on a model with
 * tool search (Sonnet/Opus 4.5+, any 5-family model). MiniMax and Z.ai speak
 * the same SDK but not this feature, hence the provider id, not the package.
 * An unrecognised id is false — the other path works everywhere.
 */
export function supportsNativeDeferral(
  provider: string,
  model: string | undefined,
): boolean {
  if (provider !== "anthropic" || !model) return false;
  // `(?!\d)` keeps a date suffix from reading as a minor: claude-sonnet-4-20250514.
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d)(?!\d))?/.exec(model);
  if (!m) return false;
  const major = Number(m[2]);
  const minor = m[3] ? Number(m[3]) : 0;
  if (m[1] === "haiku") return major >= 5;
  return major > 4 || (major === 4 && minor >= 5);
}

/** chars/4 over the serialized schema — the estimator `/context` uses. */
export function estimateDefTokens(defs: readonly ProviderToolDef[]): number {
  return Math.ceil(
    defs.reduce((sum, d) => sum + JSON.stringify(d).length, 0) / 4,
  );
}

/** The tools this request holds back, or an empty set when deferral is off. */
export function selectDeferred(
  offered: readonly ProviderToolDef[],
  settings: DeferralSettings,
): Set<string> {
  if (!settings.enabled) return new Set();
  const deferrable = offered.filter((d) => isDeferrable(d.name));
  if (deferrable.length === 0) return new Set();
  if (estimateDefTokens(deferrable) < settings.minTokens) return new Set();
  return new Set(deferrable.map((d) => d.name));
}

const LOADED_HEADER = "Loaded ";
const LOADED_LINE = /^- ([^\s:]+):/gm;

/** The `tool_search` result. `parseLoadedNames` reads it back — keep them together. */
export function formatSearchResult(
  matches: readonly { name: string; description: string }[],
): string {
  if (matches.length === 0) return "No matching tools found.";
  const lines = matches.map(
    (m) => `- ${m.name}: ${m.description.trim().split(/\r?\n/)[0] ?? ""}`,
  );
  return (
    `${LOADED_HEADER}${matches.length} tool${matches.length === 1 ? "" : "s"}. ` +
    `They are available from your next call:\n${lines.join("\n")}`
  );
}

export function parseLoadedNames(result: string): string[] {
  if (!result.startsWith(LOADED_HEADER)) return [];
  return [...result.matchAll(LOADED_LINE)].map((m) => m[1]);
}

/** Deferred tools this conversation has loaded, read off its history. */
export function loadedFromHistory(
  history: readonly Message[],
  deferred: ReadonlySet<string>,
): Set<string> {
  const loaded = new Set<string>();
  for (const msg of history) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue;
      if (part.tool.tool === TOOL_SEARCH_TOOL && part.result) {
        for (const n of parseLoadedNames(part.result)) {
          if (deferred.has(n)) loaded.add(n);
        }
      }
    }
  }
  return loaded;
}

/**
 * The list to send. `tool_search` is offered whenever anything is deferred —
 * even once all of it is loaded — so the list does not flip back and forth.
 *
 * Search path: deferred tools out unless loaded; loaded ones go LAST, in load
 * order (history order). Providers serialize the tool list before the
 * conversation, so a load re-sends everything after the point it changed —
 * at the end, every built-in stays cached and a second load leaves the first
 * one's position alone. (MiniMax-M3, live 2026-10-10: a mid-list insert read
 * 5.9K of a 25.8K prompt back from cache.)
 * Native path: every deferred tool in, marked `deferLoading`, after the rest —
 * loaded or not, so the list is the same on every request. A loaded one is
 * made visible by the `tool_reference` in history, not by this list.
 */
export function applyDeferral(
  offered: readonly ProviderToolDef[],
  deferred: ReadonlySet<string>,
  loaded: ReadonlySet<string>,
  toolSearch: ProviderToolDef | undefined,
  native = false,
): ProviderToolDef[] {
  if (deferred.size === 0 || !toolSearch) return [...offered];
  if (native) {
    return [
      ...offered.filter((d) => !deferred.has(d.name)),
      toolSearch,
      ...offered
        .filter((d) => deferred.has(d.name))
        .map((d) => ({ ...d, deferLoading: true })),
    ];
  }
  const byName = new Map(offered.map((d) => [d.name, d]));
  return [
    ...offered.filter((d) => !deferred.has(d.name)),
    toolSearch,
    ...[...loaded].flatMap((name) => byName.get(name) ?? []),
  ];
}
