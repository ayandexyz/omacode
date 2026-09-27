// =============================================================================
// Agent definitions — `<scope>/agents/*.md` role files for the `agent` tool.
//
// Claude Code's format, so an existing `.claude/agents/*.md` loads unchanged:
//
//   ---
//   name: scout
//   description: Read-only reconnaissance before anyone edits.
//   tools: Read, Grep, Glob          # optional allowlist (comma list or YAML list)
//   model: inherit                   # optional: inherit | provider/model
//   mode: explore                    # optional FreeCode extension: explore | build
//   ---
//   System prompt for the agent.
//
// Scopes, later wins on a name clash (spec 2026-09-27-agent-control-and-
// definitions.md §2.3): built-in → ~/.claude/agents → ~/.freecode/agents →
// <project>/.claude/agents → <project>/.freecode/agents.
//
// Synchronous and uncached on purpose: the roster is rendered into the system
// prompt, which is compiled per turn from disk like CLAUDE.md, and these
// directories hold a handful of small files.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logger } from "../../utils/logger.js";
import { BUILTIN_AGENT_DEFINITIONS } from "./builtin.js";
import type { AgentDefinition, AgentDefinitionScope } from "./types.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/** Claude Code's model aliases; they name no provider, so they mean "inherit". */
const CLAUDE_CODE_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable", "inherit"]);

/**
 * `key: value`, `key: [a, b]` and `key:` followed by `- item` lines — the
 * three shapes Claude Code's agent files use. Nothing else of YAML.
 */
export function parseFrontmatter(
  text: string,
): { fields: Record<string, string | string[]>; body: string } | null {
  const match = text.match(FRONTMATTER);
  if (!match) return null;
  const fields: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const raw of match[1]!.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    const item = line.match(/^\s*-\s+(.+)$/);
    if (item && listKey) {
      (fields[listKey] as string[]).push(unquote(item[1]!));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv as unknown as [string, string, string];
    listKey = undefined;
    if (value === "") {
      fields[key] = [];
      listKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      fields[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else {
      fields[key] = unquote(value);
    }
  }
  return { fields, body: match[2]!.trim() };
}

function unquote(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "");
}

function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : v.split(",");
  return list.map((t) => t.trim()).filter(Boolean);
}

function asString(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * One file → one definition, or null with a warning. `knownTools` maps the
 * lowercased names FreeCode registers; Claude Code's capitalised names
 * (`Read`, `Grep`) resolve through it.
 */
export function parseAgentFile(
  text: string,
  file: string,
  scope: AgentDefinitionScope,
  knownTools: ReadonlySet<string>,
): AgentDefinition | null {
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    logger.warn(`[agents] ${file}: no frontmatter, skipped`);
    return null;
  }
  const { fields, body } = parsed;
  const name = asString(fields.name) ?? path.basename(file, ".md");
  const description = asString(fields.description);
  if (!NAME.test(name) || !description) {
    logger.warn(`[agents] ${file}: needs a name (letters, digits, - or _) and a description, skipped`);
    return null;
  }

  let tools: string[] | undefined;
  const listed = asList(fields.tools);
  if (listed) {
    tools = [...new Set(listed.map((t) => t.toLowerCase()).filter((t) => knownTools.has(t)))];
    const unknown = listed.filter((t) => !knownTools.has(t.toLowerCase()));
    if (unknown.length) logger.debug(`[agents] ${file}: ignoring unknown tools ${unknown.join(", ")}`);
    if (tools.length === 0) {
      logger.warn(`[agents] ${file}: none of its tools exist here (${listed.join(", ")}), skipped`);
      return null;
    }
  }

  const rawModel = asString(fields.model);
  const model =
    !rawModel || CLAUDE_CODE_MODEL_ALIASES.has(rawModel.toLowerCase()) ? undefined : rawModel;

  const rawMode = asString(fields.mode)?.toLowerCase();
  if (rawMode && rawMode !== "explore" && rawMode !== "build") {
    logger.warn(`[agents] ${file}: mode must be explore or build, skipped`);
    return null;
  }
  // No mode: a file that lists a writing tool means to write (Claude Code has
  // no mode field, and its `tools: Edit, Write` would be dead in explore).
  const writes = tools?.some((t) => t === "write" || t === "edit" || t === "bash") ?? false;
  const mode = (rawMode as "explore" | "build" | undefined) ?? (writes ? "build" : "explore");

  return { name, description, prompt: body, tools, model, mode, scope, location: file };
}

function readScope(
  dir: string,
  scope: AgentDefinitionScope,
  knownTools: ReadonlySet<string>,
): AgentDefinition[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: AgentDefinition[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      const def = parseAgentFile(fs.readFileSync(file, "utf-8"), file, scope, knownTools);
      if (def) out.push(def);
    } catch (error) {
      logger.warn(`[agents] ${file}: unreadable (${String(error)}), skipped`);
    }
  }
  return out;
}

export interface LoadAgentsOptions {
  projectPath: string;
  knownTools: ReadonlySet<string>;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The effective roster, sorted by name. `shadowed` lists the definitions a
 * later scope replaced, for `freecode agents list`.
 */
export function loadAgentDefinitions(opts: LoadAgentsOptions): {
  definitions: AgentDefinition[];
  shadowed: AgentDefinition[];
} {
  const home = opts.homeDir ?? os.homedir();
  const env = opts.env ?? process.env;
  const claudeCode = env.FREECODE_CLAUDE_CODE_AGENTS !== "0";
  const layers: AgentDefinition[][] = [
    BUILTIN_AGENT_DEFINITIONS,
    claudeCode ? readScope(path.join(home, ".claude", "agents"), "claude-code-user", opts.knownTools) : [],
    readScope(path.join(home, ".freecode", "agents"), "user", opts.knownTools),
    claudeCode
      ? readScope(path.join(opts.projectPath, ".claude", "agents"), "claude-code-project", opts.knownTools)
      : [],
    readScope(path.join(opts.projectPath, ".freecode", "agents"), "project", opts.knownTools),
  ];
  const byName = new Map<string, AgentDefinition>();
  const shadowed: AgentDefinition[] = [];
  for (const layer of layers) {
    for (const def of layer) {
      const prev = byName.get(def.name);
      if (prev) shadowed.push(prev);
      byName.set(def.name, def);
    }
  }
  const definitions = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { definitions, shadowed };
}
