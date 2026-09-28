// =============================================================================
// System Prompt Loader
// Loads the canonical, provider-agnostic FreeCode system prompt from
// session/prompt/system.md. Per-model identity and small behavioral overlays
// are injected separately by the prompt compiler; policy stays in one base.
//
// Two runtimes to satisfy:
//   - dev (tsx): the .md sits on disk next to this file — read it directly so
//     edits are picked up without a rebuild.
//   - bundled single-file binary (`bun build --compile`): nothing is on disk,
//     so the prompt is embedded via a static-specifier text import, which bun
//     bakes into the executable. (Node/tsx can't execute a text import, which
//     is why the fs read comes first and this is only reached in the binary.)
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROMPT_FILE = "system.md";

// Ultimate fallback if neither the on-disk file nor the embedded copy is found.
const EMBEDDED_FALLBACK =
  "You are FreeCode, an AI coding assistant CLI. Complete the user's task.";

let cached: string | undefined;

// User overrides (spec 2026-09-20-pi-parity-plan, Phase 6; pi's SYSTEM.md /
// APPEND_SYSTEM.md). `SYSTEM.md` replaces the shipped prompt outright —
// project (`<project>/.freecode/SYSTEM.md`) over global (`~/.freecode/`).
// `APPEND_SYSTEM.md` is added after it, global then project, and composes
// with a replacement. Read every call so an edit lands on the next turn,
// like CLAUDE.md; the shipped prompt itself stays cached.
const OVERRIDE_FILE = "SYSTEM.md";
const APPEND_FILE = "APPEND_SYSTEM.md";
// The same two, by path, for `eval ab`: a prompt experiment has to be
// switchable per side through the environment (ab.ts VARIABLE_ENV_KEYS), and
// the files above are keyed by directory, not by variant. Both are read per
// call. The replacement stands in for the shipped prompt (a user's SYSTEM.md
// still wins — the experiment measures the shipped prompt, not theirs); the
// append goes after both APPEND_SYSTEM.md files.
const SYSTEM_ENV = "FREECODE_SYSTEM_FILE";
const APPEND_ENV = "FREECODE_APPEND_SYSTEM_FILE";

function readTrimmed(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, "utf-8").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The shipped prompt with the user's SYSTEM.md / APPEND_SYSTEM.md applied.
 * `projectPath` undefined means global overrides only.
 */
export async function loadSystemPromptFor(
  projectPath: string | undefined,
  globalDir: string = path.join(os.homedir(), ".freecode"),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const projectDir = projectPath ? path.join(projectPath, ".freecode") : undefined;
  const replacement =
    (projectDir && readTrimmed(path.join(projectDir, OVERRIDE_FILE))) ??
    readTrimmed(path.join(globalDir, OVERRIDE_FILE));
  const base =
    replacement ??
    (env[SYSTEM_ENV] ? readTrimmed(env[SYSTEM_ENV]) : undefined) ??
    (await loadSystemPrompt()).trim();
  const appended = [
    readTrimmed(path.join(globalDir, APPEND_FILE)),
    projectDir ? readTrimmed(path.join(projectDir, APPEND_FILE)) : undefined,
    env[APPEND_ENV] ? readTrimmed(env[APPEND_ENV]) : undefined,
  ].filter((s): s is string => Boolean(s));
  return [base, ...appended].join("\n\n");
}

// FREECODE_CONTEXT_FRAMING=legacy reverts the 2026-09-21 Identity/Autonomy
// edits so `eval ab` can pair old vs new prompt in one run. Applied on top of
// the cached file text, so the toggle works per call despite the cache.
const LEGACY_FRAMING: Array<[string, string]> = [
  [
    "You are FreeCode, a coding agent.",
    "You are FreeCode, a maximally proactive, world-class coding agent.",
  ],
  [
    "Be proactive within the work the user requests. A greeting or casual conversation calls for a brief conversational reply. Background project context helps answer relevant requests; it does not create a task.\n\n",
    "",
  ],
];

function applyFraming(prompt: string): string {
  if (process.env.FREECODE_CONTEXT_FRAMING !== "legacy") return prompt;
  return LEGACY_FRAMING.reduce((p, [from, to]) => p.replace(from, to), prompt);
}

/**
 * Load the canonical FreeCode system prompt. Cached after the first read.
 */
export async function loadSystemPrompt(): Promise<string> {
  return applyFraming(await loadRaw());
}

async function loadRaw(): Promise<string> {
  if (cached !== undefined) return cached;

  // dev / on-disk: read the live file.
  try {
    cached = fs.readFileSync(
      path.join(__dirname, "prompt", PROMPT_FILE),
      "utf-8",
    );
    return cached;
  } catch {
    // Not on disk — expected inside the compiled single-file binary.
  }

  // bundled binary: the prompt is embedded via this text import.
  try {
    // @ts-ignore - bun's text loader; resolved at build time, no Node analog.
    const mod = (await import("./prompt/system.md", {
      with: { type: "text" },
    })) as { default: string };
    cached = mod.default;
    return cached;
  } catch {
    // Fall through to the embedded minimal prompt.
  }

  // Reaching here means the agent runs with a one-line prompt: no tool
  // guidance, no coding standards, no mode behaviour. It degrades quality
  // invisibly instead of failing, so it stayed unnoticed until a session
  // showed the model ignoring instructions that were never sent. Say so.
  logger.warn(
    `[prompt] ${PROMPT_FILE} not found on disk or embedded — falling back to a ` +
      `minimal ${EMBEDDED_FALLBACK.length}-character system prompt. The agent ` +
      `will behave noticeably worse. In the monorepo this means dist is stale ` +
      `or missing assets: run \`pnpm --filter @thisisayande/freecode-core build\`.`,
  );
  cached = EMBEDDED_FALLBACK;
  return cached;
}
