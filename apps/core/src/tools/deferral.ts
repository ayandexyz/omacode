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
// Settings — project → user → default, like checkpoint/settings.ts:
//   { "tools": { "deferral": { "enabled": true, "minTokens": 4000 } } }
// Env: FREECODE_DEFER_TOOLS — "1" on, "0" off, beating the files.
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
}

export const DEFAULT_DEFERRAL_SETTINGS: DeferralSettings = {
  enabled: false,
  minTokens: 4000,
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
 * The list to send: deferred tools out unless loaded, `tool_search` in. It is
 * offered whenever anything is deferred — even once all of it is loaded — so
 * the list does not flip back and forth and cost a miss each way.
 */
export function applyDeferral(
  offered: readonly ProviderToolDef[],
  deferred: ReadonlySet<string>,
  loaded: ReadonlySet<string>,
  toolSearch: ProviderToolDef | undefined,
): ProviderToolDef[] {
  if (deferred.size === 0 || !toolSearch) return [...offered];
  return [
    ...offered.filter((d) => !deferred.has(d.name) || loaded.has(d.name)),
    toolSearch,
  ];
}
