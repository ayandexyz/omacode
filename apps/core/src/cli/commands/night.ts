import type { CommandModule } from "yargs";

// `freecode night "<objective>"` — an unattended run of short iterations, each
// a fresh session ending in finish_iteration, each success its own commit on
// night/<slug>. Foreground by design (Phase 1): the terminal stays open, which
// is what gnhf ships and what covers a night. Spec 2026-09-28-overnight-runs.md.

interface NightArgs {
  objective: string[];
  model?: string;
  maxIterations?: number;
  maxUsd?: number;
  until?: string;
  maxWait?: string;
  fallbackModel?: string;
  verify?: string;
  stopWhen?: string;
  inhibit: boolean;
  worktree: boolean;
  push: boolean;
  allow: string[];
  deny: string[];
  detach: boolean;
  at?: string;
  sandbox: boolean;
  commitStyle: "night" | "conventional";
}

/** `--max-wait 8h` / `90m` → ms. Returns undefined if unparseable. */
export function parseDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(m|h)$/.exec(value.trim());
  if (!match) return undefined;
  const n = Number.parseFloat(match[1]!);
  return n * (match[2] === "h" ? 3_600_000 : 60_000);
}

/** `--until 07:00` or `--until 8h` → epoch ms. Returns undefined if unparseable. */
export function parseUntil(value: string, now = Date.now()): number | undefined {
  const duration = /^(\d+(?:\.\d+)?)(m|h)$/.exec(value.trim());
  if (duration) {
    const n = Number.parseFloat(duration[1]!);
    return now + n * (duration[2] === "h" ? 3_600_000 : 60_000);
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (clock) {
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    // A time already past today means tomorrow — "--until 07:00" typed at
    // midnight must not be an already-expired deadline.
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  return undefined;
}

/** Scheduled start: local HH:MM, duration, or an ISO timestamp in the future. */
export function parseStartAt(value: string, now = Date.now()): number | undefined {
  const relative = parseUntil(value, now);
  if (relative !== undefined) return relative;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : undefined;
}

/** `night status|report|list|stop` — reading a night, during or after it. */
const opsCommands: CommandModule[] = [
  {
    command: "status [id]",
    describe: "how a run is going, or how it ended (detects a crashed run)",
    builder: (y) =>
      y.positional("id", { type: "string", describe: "run id or branch" }),
    handler: async (argv) => {
      const { nightOps } = await import("./night-ops-cli.js");
      await nightOps.status(argv.id as string | undefined);
    },
  },
  {
    command: "report [id]",
    describe: "print the morning report, regenerating it from the logs",
    builder: (y) =>
      y.positional("id", { type: "string", describe: "run id or branch" }),
    handler: async (argv) => {
      const { nightOps } = await import("./night-ops-cli.js");
      await nightOps.report(argv.id as string | undefined);
    },
  },
  {
    command: "list",
    describe: "every night run, newest first",
    handler: async () => {
      const { nightOps } = await import("./night-ops-cli.js");
      await nightOps.list();
    },
  },
  {
    command: "stop [id]",
    describe: "ask a running night to stop after the current iteration",
    builder: (y) =>
      y.positional("id", { type: "string", describe: "run id or branch" }),
    handler: async (argv) => {
      const { nightOps } = await import("./night-ops-cli.js");
      await nightOps.stop(argv.id as string | undefined);
    },
  },
];

export const nightCommand: CommandModule<object, NightArgs> = {
  command: "night",
  describe:
    "Work unattended towards an objective, committing each verified step to its own branch",
  builder: (yargs) =>
    yargs
      .command(opsCommands)
      // The default: `night "<objective>"`, and with no objective, resume the
      // run on the current night/* branch. Declared as a command rather than
      // parsed out of the positional, so `night status` can never be read as
      // an objective called "status".
      .command({
        command: "* [objective..]",
        describe: false,
        handler: async (argv) => {
          const { runNightCli } = await import("./night-run.js");
          await runNightCli(argv as unknown as NightArgs);
        },
      })
      .positional("objective", {
        type: "string",
        array: true,
        default: [] as string[],
        describe: "what the run should achieve",
      })
      .option("model", {
        alias: "m",
        type: "string",
        describe: "model to use, in provider/model format",
      })
      .option("max-iterations", {
        type: "number",
        describe: "stop after this many iterations",
      })
      .option("max-usd", {
        type: "number",
        describe: "stop once the run has cost this much",
      })
      .option("until", {
        type: "string",
        describe: "wall-clock deadline: 07:00, or a duration like 8h",
      })
      .option("max-wait", {
        type: "string",
        describe:
          "total time the run may spend waiting out a spent quota, e.g. 12h (default 12h)",
      })
      .option("fallback-model", {
        type: "string",
        describe:
          "provider/model to retry on the first time a usage window is spent, instead of waiting",
      })
      .option("verify", {
        type: "string",
        describe:
          "command that must exit 0 before each commit, e.g. 'pnpm test'",
      })
      .option("stop-when", {
        type: "string",
        describe: "finish line, in your words — the model decides when it is met",
      })
      .option("worktree", {
        type: "boolean",
        default: false,
        describe:
          "run in a dedicated git worktree instead of this checkout (lets you keep working)",
      })
      .option("push", {
        type: "boolean",
        default: false,
        describe: "push the run's branch after each commit (never forced)",
      })
      .option("detach", {
        type: "boolean",
        default: false,
        describe: "run in a detached worker; the terminal may close",
      })
      .option("at", {
        type: "string",
        describe:
          "start later in a detached worker: HH:MM, duration (90m), or ISO timestamp",
      })
      .option("sandbox", {
        type: "boolean",
        default: true,
        describe:
          "confine unattended bash writes to the run tree with bubblewrap (--no-sandbox to opt out)",
      })
      .option("commitStyle", {
        alias: "commit-style",
        choices: ["night", "conventional"] as const,
        default: "night" as const,
        describe:
          "commit subject preset: 'night N: …' or Conventional Commits 'chore(night): …'",
      })
      .option("inhibit", {
        type: "boolean",
        default: true,
        describe:
          "keep the machine awake for the run (--no-inhibit to leave sleep alone)",
      })
      .option("allow", {
        type: "string",
        array: true,
        default: [] as string[],
        describe: "extra permission rule to allow (repeatable)",
      })
      .option("deny", {
        type: "string",
        array: true,
        default: [] as string[],
        describe: "extra permission rule to deny (repeatable)",
      }),
  // Every path is a subcommand (including `*`), so this only runs if yargs
  // matched none — which it cannot, `*` catches the rest.
  handler: () => {},
};
