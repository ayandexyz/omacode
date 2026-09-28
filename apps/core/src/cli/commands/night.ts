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
  allow: string[];
  deny: string[];
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

export const nightCommand: CommandModule<object, NightArgs> = {
  command: "night [objective..]",
  describe:
    "Work unattended towards an objective, committing each verified step to its own branch",
  builder: (yargs) =>
    yargs
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
  handler: async (argv) => {
    // Lazy: `night` pulls in the whole backend, which --help must not pay for.
    const { runNightCli } = await import("./night-run.js");
    await runNightCli(argv);
  },
};
