// =============================================================================
// `freecode night` — the wiring: preflight, boot the backend, run the
// orchestrator against the real world, print the exit summary.
//
// Everything decidable lives in `autonomous/orchestrator.ts` (pure over
// injected deps) so this file stays a composition root with no policy in it.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.2, §4.8, §4.11
// =============================================================================

import * as path from "path";
import { parseUntil } from "./night.js";

interface NightCliArgs {
  objective: string[];
  model?: string;
  maxIterations?: number;
  maxUsd?: number;
  until?: string;
  allow: string[];
  deny: string[];
}

export async function runNightCli(argv: NightCliArgs): Promise<void> {
  const objective = argv.objective.join(" ").trim();
  if (!objective) {
    fail("Error: no objective given. `freecode night \"<what to work on>\"`");
  }

  const { runNight, DEFAULT_MAX_CONSECUTIVE_FAILURES } = await import(
    "../../autonomous/orchestrator.js"
  );
  const { runIteration } = await import("../../autonomous/iteration.js");
  const { createGitOps, branchSlug } = await import("../../autonomous/git.js");
  const { ENVELOPE_DENY_RULES } = await import("../../autonomous/envelope.js");
  const store = await import("../../autonomous/night-store.js");
  const { writeManifest, updateManifest, readManifest } = await import(
    "../../autonomous/run-store.js"
  );
  const { DEFAULT_RUN_LIMITS, EMPTY_USAGE } = await import(
    "../../autonomous/types.js"
  );
  const { initProviders } = await import("../../providers/index.js");
  const { initMcpServers } = await import("../../mcp/index.js");
  const { readConfig, fallbackProviderFromCredentials } = await import(
    "../../providers/config.js"
  );
  const { initHooks } = await import("../../hooks/bootstrap.js");
  const { randomUUID } = await import("crypto");

  const projectPath = process.cwd();
  const git = createGitOps(projectPath);

  // ---- Preflight (§4.2). Refuse rather than start something we cannot protect.
  if (!(await git.isRepo())) {
    fail(
      "Error: not a git repository. A night run commits each step, and without a repo there is nothing to commit to (and nothing to roll back).",
    );
  }
  if ((await git.currentBranch()) === undefined) {
    fail("Error: detached HEAD. Check out a branch before starting a night run.");
  }
  const dirty = await git.dirtyPaths();
  if (dirty.length > 0) {
    fail(
      `Error: the working tree is dirty. A night run resets the tree on a failed step, which would discard this work:\n${dirty
        .slice(0, 20)
        .map((p) => `  ${p}`)
        .join("\n")}${dirty.length > 20 ? `\n  … and ${dirty.length - 20} more` : ""}`,
    );
  }

  await initProviders();
  await initMcpServers();
  const hookSettings = initHooks(projectPath, { watch: false });

  const config = readConfig();
  let provider = config.current?.provider;
  let model = config.current?.model;
  if (argv.model) {
    const slash = argv.model.indexOf("/");
    if (slash > 0) {
      provider = argv.model.slice(0, slash);
      model = argv.model.slice(slash + 1);
    } else {
      model = argv.model;
    }
  }
  if (!provider) {
    try {
      provider = fallbackProviderFromCredentials();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
  if (!provider) {
    fail(
      "No provider configured. Set current.provider in ~/.freecode/config.json, export a provider API key, or pass --model <provider>/<model>.",
    );
  }

  const until = argv.until ? parseUntil(argv.until) : undefined;
  if (argv.until && until === undefined) {
    fail(`Error: --until "${argv.until}" is not a time (07:00) or a duration (8h).`);
  }
  // An unbounded night has to be a choice, not a default (§4.12).
  if (
    argv.maxIterations === undefined &&
    argv.maxUsd === undefined &&
    until === undefined
  ) {
    fail(
      "Error: a night run needs a limit. Pass at least one of --until <07:00|8h>, --max-iterations <n>, --max-usd <n>.",
    );
  }

  // ---- Branch
  let branch = `night/${branchSlug(objective)}`;
  for (let suffix = 1; await git.branchExists(branch); suffix += 1) {
    branch = `night/${branchSlug(objective)}-${suffix}`;
  }
  await git.createOrSwitchBranch(branch);

  const runId = randomUUID().slice(0, 8);
  writeManifest({
    runId,
    status: "running",
    createdAt: Date.now(),
    startedAt: Date.now(),
    projectPath,
    provider: provider!,
    model,
    limits: {
      ...DEFAULT_RUN_LIMITS,
      ...(argv.maxIterations ? { maxTurns: argv.maxIterations } : {}),
      ...(argv.maxUsd !== undefined ? { maxUsd: argv.maxUsd } : {}),
    },
    usage: EMPTY_USAGE,
    turns: 0,
    verifyCommand: "",
    pid: process.pid,
    taskCardCount: 0,
  });
  store.appendNotes(
    runId,
    `# Night run ${runId}\n\nObjective: ${objective}\n\nBranch: ${branch}`,
  );

  // ---- Interrupts (§4.8). First Ctrl+C finishes the current iteration; the
  // second stops now and leaves the tree exactly as it is.
  const stop = { graceful: false, hard: false };
  const hardAbort = new AbortController();
  const onSigint = (): void => {
    if (stop.graceful) {
      stop.hard = true;
      hardAbort.abort();
      process.stderr.write(
        "\nStopping now. Uncommitted changes are left in the tree on purpose.\n",
      );
      return;
    }
    stop.graceful = true;
    process.stderr.write(
      "\nStopping after this iteration finishes. Press Ctrl+C again to stop immediately.\n",
    );
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", () => {
    stop.hard = true;
    hardAbort.abort();
  });

  console.log(
    [
      `night run ${runId} on ${branch}`,
      `  objective: ${objective}`,
      `  model:     ${provider}${model ? `/${model}` : ""}`,
      `  limits:    ${describeLimits(argv, until)}`,
      `  notes:     ${path.dirname(store.notesPath(runId))}`,
      "",
      "Note: closing the lid still suspends most laptops. Sleep inhibition arrives in Phase 2.",
      "",
    ].join("\n"),
  );

  const result = await runNight(
    {
      runIteration: (input) =>
        runIteration({
          ...input,
          objective,
          projectPath,
          provider: provider!,
          model,
          denyRules: [...ENVELOPE_DENY_RULES, ...argv.deny],
          allowRules: argv.allow,
          onDecision: (d) => store.appendDecision(runId, d),
          signal: hardAbort.signal,
        }),
      git,
      notes: {
        read: () => store.readNotes(runId),
        append: (section) => store.appendNotes(runId, section),
      },
      record: (record) => store.appendIteration(runId, record),
      decision: (d) => store.appendDecision(runId, d),
      now: () => Date.now(),
      stopRequested: () => stop.graceful || stop.hard,
      hardStopped: () => stop.hard,
      report: (line) => console.log(line),
    },
    {
      maxIterations: argv.maxIterations,
      maxUsd: argv.maxUsd,
      until,
      maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
    },
  );

  updateManifest(runId, (m) => ({
    ...m,
    status: result.stopReason === "objective_met" ? "completed" : "stopped",
    endedAt: Date.now(),
  }));

  // ---- Exit summary (§4.10 v0: terminal only; report.md is Phase 3).
  const decisions = store.readDecisions(runId);
  const needsHuman = decisions.filter((d) => d.kind === "needs_human");
  const denied = decisions.filter((d) => d.kind === "denied");
  const asked = decisions.filter((d) => d.kind === "asked");
  const decided = decisions.filter((d) => d.kind === "decided");

  console.log(
    [
      "",
      `night ${runId} ended: ${result.stopReason}`,
      `  ${result.commits.length} commit${result.commits.length === 1 ? "" : "s"} on ${branch} over ${result.iterations} iteration${result.iterations === 1 ? "" : "s"}`,
      `  cost: ${result.usd > 0 ? `$${result.usd.toFixed(2)}` : "unknown (no pricing for this model)"}`,
      needsHuman.length > 0
        ? `\n  NEEDS YOU (${needsHuman.length}):\n${needsHuman
            .map((d) => `    - ${(d as { item: string }).item}`)
            .join("\n")}`
        : "",
      decided.length > 0 ? `  decisions made for you: ${decided.length}` : "",
      asked.length > decided.length
        ? `  questions asked without a recorded answer: ${asked.length - decided.length}`
        : "",
      denied.length > 0 ? `  refused actions: ${denied.length}` : "",
      result.uncommitted
        ? `\n  UNCOMMITTED (${result.uncommitted.length} paths still in the tree):\n${result.uncommitted
            .slice(0, 10)
            .map((p) => `    ${p}`)
            .join("\n")}`
        : "",
      "",
      `  review:  git log --oneline ${branch}`,
      `  details: ${path.dirname(store.notesPath(runId))}`,
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  process.off("SIGINT", onSigint);
  hookSettings.dispose();
  // The manifest is the record; a non-zero exit is for "the night did not do
  // what it was asked", which is only true when nothing was committed.
  process.exit(result.commits.length > 0 ? 0 : 1);
}

function describeLimits(argv: NightCliArgs, until: number | undefined): string {
  const parts: string[] = [];
  if (until !== undefined) parts.push(`until ${new Date(until).toLocaleTimeString()}`);
  if (argv.maxIterations !== undefined) parts.push(`${argv.maxIterations} iterations`);
  if (argv.maxUsd !== undefined) parts.push(`$${argv.maxUsd}`);
  return parts.join(", ");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
