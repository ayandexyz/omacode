// =============================================================================
// Codemode enablement (spec 2026-10-05-codemode.md §4.9) — off by default,
// like the signal gates: it changes what the model can do, and flipping the
// default is an `eval ab` decision.
//
//   ~/.freecode/settings.json  or  <project>/.freecode/settings.json
//   { "codemode": { "enabled": true, "mode": "on" | "only" } }
//
// Env FREECODE_CODEMODE: "1"/"on", "only", or "0"/"off", beating the files.
// Read once per AgentLoop, so `eval ab` can flip it per trial
// (VARIABLE_ENV_KEYS).
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { envFlag } from "../agent/signals/settings.js";

export type CodemodeMode = "off" | "on" | "only";

interface CodemodeFileSetting {
  enabled?: boolean;
  mode?: "on" | "only";
}

function readSetting(filePath: string): CodemodeFileSetting | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      codemode?: { enabled?: unknown; mode?: unknown };
    };
    const enabled = parsed.codemode?.enabled;
    const mode = parsed.codemode?.mode;
    if (typeof enabled !== "boolean" && mode !== "on" && mode !== "only") {
      return undefined;
    }
    return {
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(mode === "on" || mode === "only" ? { mode } : {}),
    };
  } catch {
    return undefined;
  }
}

function envMode(value: string | undefined): CodemodeMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "only") return "only";
  if (normalized === "on") return "on";
  if (normalized === "off") return "off";
  const enabled = envFlag(value);
  return enabled === undefined ? undefined : enabled ? "on" : "off";
}

/** Environment beats project, project beats user, and disabled beats mode. */
export function resolveCodemodeMode(
  scopes: Array<CodemodeFileSetting | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): CodemodeMode {
  const fromEnv = envMode(env.FREECODE_CODEMODE);
  if (fromEnv !== undefined) return fromEnv;
  for (const setting of scopes) {
    if (!setting) continue;
    if (setting.enabled === false) return "off";
    if (setting.mode) return setting.mode;
    if (setting.enabled === true) return "on";
  }
  return "off";
}

/** Project file beats user file; env beats both. */
export function resolveCodemodeEnabled(
  scopes: Array<boolean | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    resolveCodemodeMode(
      scopes.map((enabled) =>
        enabled === undefined ? undefined : { enabled },
      ),
      env,
    ) !== "off"
  );
}

export function loadCodemodeMode(projectRoot: string): CodemodeMode {
  return resolveCodemodeMode([
    readSetting(path.join(projectRoot, ".freecode", "settings.json")),
    readSetting(path.join(os.homedir(), ".freecode", "settings.json")),
  ]);
}

export function loadCodemodeEnabled(projectRoot: string): boolean {
  return loadCodemodeMode(projectRoot) !== "off";
}

/**
 * Tools a script may not call: itself (no recursion), the night-run exit, and
 * subagents / monitors — long-lived things a script would start and then lose
 * track of when it ends (spec §4.3). A leaf module, so
 * tools/codemode.ts and tools/defs-cache.ts can both import it without a cycle.
 */
export const NOT_CALLABLE_FROM_CODEMODE = new Set([
  "codemode",
  "finish_iteration",
  "agent",
  "agent_send",
  "agent_stop",
  "monitor",
]);

/**
 * pi's system-prompt contribution for codemode (`promptSnippet` +
 * `promptGuidelines`), added to the static system prompt only when codemode is
 * on (spec §4.12). Constant text, so it is safe in the cached prefix.
 */
export function codemodeSystemGuidance(
  mode: Exclude<CodemodeMode, "off">,
): string {
  const base =
    "codemode: run JavaScript that calls other tools. Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.";
  return mode === "only"
    ? `${base} Direct tool declarations are hidden in codemode-only mode; use the callable tools documented by codemode.`
    : base;
}

/** Backward-compatible constant for the normal additive mode. */
export const CODEMODE_SYSTEM_GUIDANCE = codemodeSystemGuidance("on");
