// =============================================================================
// `freecode agents list` — the sub-agent types a project resolves to, which
// scope each came from, and what a later scope shadowed (spec
// 2026-09-27-agent-control-and-definitions.md §2.6).
// =============================================================================

import * as path from "path";
import type { CommandModule } from "yargs";
import { loadAgentDefinitions } from "../../agent/definitions/index.js";
import { listTools } from "../../tools/index.js";

interface AgentsArgs {
  action: string;
  project?: string;
}

export const agentsCommand: CommandModule<object, AgentsArgs> = {
  command: "agents <action>",
  describe: "List the sub-agent types the agent tool can spawn",
  builder: (y) =>
    y
      .positional("action", { choices: ["list"] as const, type: "string", demandOption: true })
      .option("project", { type: "string", describe: "Project directory (default: cwd)" }) as never,
  handler: (args) => {
    const projectPath = path.resolve(args.project ?? process.cwd());
    const { definitions, shadowed } = loadAgentDefinitions({
      projectPath,
      knownTools: new Set(listTools().map((t) => t.id)),
    });
    console.log(`\nSub-agent types for ${projectPath}:\n`);
    for (const d of definitions) {
      const tools = d.tools ? d.tools.join(", ") : "all its mode allows";
      console.log(`  ${d.name}  [${d.scope}, ${d.mode}${d.model ? `, ${d.model}` : ""}]`);
      console.log(`    ${d.description}`);
      console.log(`    tools: ${tools}${d.location ? `\n    file: ${d.location}` : ""}`);
    }
    if (shadowed.length) {
      console.log("\nShadowed by a later scope:");
      for (const d of shadowed) console.log(`  ${d.name}  [${d.scope}]${d.location ? ` ${d.location}` : ""}`);
    }
    console.log(
      "\nScopes, later wins: builtin → ~/.claude/agents → ~/.freecode/agents → <project>/.claude/agents → <project>/.freecode/agents." +
        "\nFREECODE_CLAUDE_CODE_AGENTS=0 skips the .claude ones.\n",
    );
  },
};
