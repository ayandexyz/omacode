// =============================================================================
// Codemode enablement (spec 2026-10-05-codemode.md §4.9) — off by default,
// like the signal gates: it changes what the model can do, and flipping the
// default is an `eval ab` decision.
//
//   ~/.freecode/settings.json  or  <project>/.freecode/settings.json
//   { "codemode": { "enabled": true } }
//
// Env FREECODE_CODEMODE: "1" on, "0" off, beating the files. Read once per
// AgentLoop, so `eval ab` can flip it per trial (VARIABLE_ENV_KEYS).
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { envFlag } from "../agent/signals/settings.js";

function readEnabled(filePath: string): boolean | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      codemode?: { enabled?: unknown };
    };
    const v = parsed.codemode?.enabled;
    return typeof v === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Project file beats user file; env beats both. */
export function resolveCodemodeEnabled(
  scopes: Array<boolean | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const fromEnv = envFlag(env.FREECODE_CODEMODE);
  if (fromEnv !== undefined) return fromEnv;
  for (const v of scopes) if (v !== undefined) return v;
  return false;
}

export function loadCodemodeEnabled(projectRoot: string): boolean {
  return resolveCodemodeEnabled([
    readEnabled(path.join(projectRoot, ".freecode", "settings.json")),
    readEnabled(path.join(os.homedir(), ".freecode", "settings.json")),
  ]);
}
