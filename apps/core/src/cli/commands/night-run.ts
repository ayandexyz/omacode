// =============================================================================
// `freecode night` — the wiring: preflight, boot the backend, run the
// orchestrator against the real world, print the exit summary.
//
// Everything decidable lives in `autonomous/orchestrator.ts` (pure over
// injected deps) so this file stays a composition root with no policy in it.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.2, §4.8, §4.11
// =============================================================================

import * as path from "path";
import { parseDuration, parseStartAt, parseUntil } from "./night.js";

interface NightCliArgs {
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

/**
 * Sleep in wall-clock steps, not one long timer.
 *
 * A single `setTimeout` to a reset eight hours out is wrong twice over: it
 * overflows past 2^31 ms, and a suspended laptop resumes to a timer that never
 * fired. Re-checking the clock every minute survives both, and gives the
 * interrupt a place to land — a graceful stop should not have to wait out a
 * quota window before it takes effect.
 */
const WAIT_TICK_MS = 60_000;

function sleepUntil(
  until: number,
  shouldStop: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (shouldStop() || Date.now() >= until) return resolve();
      const timer = setTimeout(tick, Math.min(WAIT_TICK_MS, until - Date.now()));
      timer.unref?.();
    };
    tick();
  });
}

export async function runNightCli(argv: NightCliArgs): Promise<void> {
  const typed = argv.objective.join(" ").trim();

  // Phase 5: the parent does no backend bootstrapping. It records a pending
  // manifest, launches this exact CLI as a detached worker, and can exit.
  const isWorker = process.env.FREECODE_NIGHT_WORKER === "1";
  if (!isWorker && (argv.detach || argv.at !== undefined)) {
    if (!typed) fail("Error: detached and scheduled runs need an explicit objective.");
    const scheduledFor = argv.at ? parseStartAt(argv.at) : undefined;
    if (argv.at && scheduledFor === undefined) {
      fail(
        `Error: --at "${argv.at}" is not a future time (23:30), duration (90m), or ISO timestamp.`,
      );
    }
    if (
      argv.maxIterations === undefined &&
      argv.maxUsd === undefined &&
      argv.until === undefined
    ) {
      fail(
        "Error: a night run needs a limit. Pass at least one of --until, --max-iterations, --max-usd.",
      );
    }
    if (argv.until && parseUntil(argv.until) === undefined) {
      fail(`Error: --until "${argv.until}" is not a time (07:00) or duration (8h).`);
    }
    if (argv.maxWait && parseDuration(argv.maxWait) === undefined) {
      fail(`Error: --max-wait "${argv.maxWait}" is not a duration (8h, 90m).`);
    }
    if (argv.fallbackModel && !argv.fallbackModel.includes("/")) {
      fail(`Error: --fallback-model "${argv.fallbackModel}" must be provider/model.`);
    }
    if (argv.sandbox && process.platform === "linux") {
      const { bubblewrapAvailable } = await import("../../autonomous/sandbox.js");
      if (!bubblewrapAvailable()) {
        fail(
          "Error: --sandbox requires bubblewrap (`bwrap`) on Linux. Install it, or explicitly pass --no-sandbox.",
        );
      }
    }
    const { launchDetachedNight } = await import(
      "../../autonomous/supervisor.js"
    );
    const selected: { provider?: string; model?: string } = argv.model
      ? splitModel(argv.model)
      : {};
    const launched = launchDetachedNight({
      objective: typed,
      projectPath: process.cwd(),
      scheduledFor,
      provider: selected.provider,
      model: selected.model,
      maxIterations: argv.maxIterations,
      maxUsd: argv.maxUsd,
      verify: argv.verify,
      stopWhen: argv.stopWhen,
      sandbox: argv.sandbox,
      commitStyle: argv.commitStyle,
    });
    console.log(
      [
        `${scheduledFor ? "scheduled" : "detached"} night run ${launched.runId} (pid ${launched.pid})`,
        scheduledFor ? `  starts: ${new Date(scheduledFor).toLocaleString()}` : "",
        `  status: freecode night status ${launched.runId}`,
        `  log:    ${launched.logPath}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }

  // A scheduled worker owns its wait and sleep inhibitor. Cancellation is a
  // manifest bit, just like cancellation between live iterations.
  if (isWorker) {
    const scheduledFor = Number(process.env.FREECODE_NIGHT_SCHEDULED_FOR);
    const workerRunId = process.env.FREECODE_NIGHT_RUN_ID;
    if (workerRunId && Number.isFinite(scheduledFor) && scheduledFor > Date.now()) {
      const { inhibitSleep } = await import("../../autonomous/inhibit.js");
      const { readManifest, updateManifest } = await import(
        "../../autonomous/run-store.js"
      );
      const scheduledInhibitor = inhibitSleep(argv.inhibit);
      while (Date.now() < scheduledFor) {
        const manifest = readManifest(workerRunId);
        if (manifest?.cancelRequested) {
          updateManifest(workerRunId, (m) => ({
            ...m,
            status: "cancelled",
            endedAt: Date.now(),
          }));
          scheduledInhibitor.release();
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1_000, scheduledFor - Date.now())),
        );
      }
      scheduledInhibitor.release();
    }
  }

  const { runNight, DEFAULT_MAX_CONSECUTIVE_FAILURES, DEFAULT_MAX_WAIT_MS } =
    await import("../../autonomous/orchestrator.js");
  const { inhibitSleep } = await import("../../autonomous/inhibit.js");
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const exec = promisify(execFile);
  const { runIteration } = await import("../../autonomous/iteration.js");
  const { createGitOps, branchSlug } = await import("../../autonomous/git.js");
  const { ENVELOPE_DENY_RULES } = await import("../../autonomous/envelope.js");
  const store = await import("../../autonomous/night-store.js");
  const { writeManifest, updateManifest, readManifest, runDir } = await import(
    "../../autonomous/run-store.js"
  );
  const { DEFAULT_RUN_LIMITS, EMPTY_USAGE } = await import(
    "../../autonomous/types.js"
  );
  const { findNightRun, regenerateReport } = await import(
    "../../autonomous/night-ops.js"
  );
  const { initProviders } = await import("../../providers/index.js");
  const { initMcpServers } = await import("../../mcp/index.js");
  const { readConfig, fallbackProviderFromCredentials } = await import(
    "../../providers/config.js"
  );
  const { initHooks } = await import("../../hooks/bootstrap.js");
  const { randomUUID } = await import("crypto");
  const { bubblewrapAvailable, sandboxEnvironment, sandboxPlan } = await import(
    "../../autonomous/sandbox.js"
  );

  let projectPath = process.cwd();
  let git = createGitOps(projectPath);

  // ---- Resume: `freecode night` on a night/* branch continues that run
  // rather than refusing for want of an objective. The branch is the handle —
  // it is what the user still has in the morning after the terminal is gone.
  const branchNow = await git.currentBranch();
  const resuming =
    typed === "" && branchNow?.startsWith("night/")
      ? findNightRun(branchNow)
      : undefined;
  if (typed === "" && !resuming) {
    fail(
      branchNow?.startsWith("night/")
        ? `Error: no recorded run for branch ${branchNow}. Start a new one with an objective.`
        : 'Error: no objective given. `freecode night "<what to work on>"`, or run it on a night/* branch to resume.',
    );
  }
  const objective = resuming?.night?.objective ?? typed;
  // Detached workers always isolate themselves; knowing that at preflight is
  // important for scheduled starts, because the user may have edited their
  // checkout by the time the worker wakes and those edits are not in its tree.
  const useWorktree = argv.worktree || isWorker;

  // ---- Preflight (§4.2). Refuse rather than start something we cannot protect.
  if (!(await git.isRepo())) {
    fail(
      "Error: not a git repository. A night run commits each step, and without a repo there is nothing to commit to (and nothing to roll back).",
    );
  }
  if ((await git.currentBranch()) === undefined) {
    fail("Error: detached HEAD. Check out a branch before starting a night run.");
  }
  const dirty = useWorktree ? [] : await git.dirtyPaths();
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

  let sandbox = resuming?.night?.sandbox ?? argv.sandbox;
  if (sandbox && process.platform === "linux" && !bubblewrapAvailable()) {
    fail(
      "Error: --sandbox requires bubblewrap (`bwrap`) on Linux. Install it, or explicitly pass --no-sandbox to use only the permission envelope.",
    );
  }
  if (sandbox && process.platform !== "linux") {
    console.warn(
      `Warning: the Phase 5 OS sandbox is unavailable on ${process.platform}; continuing with the permission envelope.`,
    );
    sandbox = false;
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
  const maxWaitMs = argv.maxWait ? parseDuration(argv.maxWait) : DEFAULT_MAX_WAIT_MS;
  if (argv.maxWait && maxWaitMs === undefined) {
    fail(`Error: --max-wait "${argv.maxWait}" is not a duration (8h, 90m).`);
  }
  if (argv.fallbackModel && !argv.fallbackModel.includes("/")) {
    fail(
      `Error: --fallback-model "${argv.fallbackModel}" must be provider/model.`,
    );
  }
  // An unbounded night has to be a choice, not a default (§4.12). A resume
  // needs one too: the first leg's limits are not reloaded (its --until is
  // usually already past by the time anyone resumes), so without a flag here
  // the resumed leg would have no ceiling at all.
  if (
    argv.maxIterations === undefined &&
    argv.maxUsd === undefined &&
    until === undefined
  ) {
    fail(
      resuming
        ? "Error: resuming needs a limit for this leg. Pass at least one of --until <07:00|8h>, --max-iterations <n> (counted from here), --max-usd <n>."
        : "Error: a night run needs a limit. Pass at least one of --until <07:00|8h>, --max-iterations <n>, --max-usd <n>.",
    );
  }

  // ---- Branch. A resumed run keeps its own; a new one takes the next free
  // name, so a second night on the same objective never lands on the first's
  // commits.
  let branch = resuming?.night?.branch ?? `night/${branchSlug(objective)}`;
  if (!resuming) {
    for (let suffix = 1; await git.branchExists(branch); suffix += 1) {
      branch = `night/${branchSlug(objective)}-${suffix}`;
    }
  }

  // A detached worker must never switch the branch in the checkout the user
  // is still using. It always gets a dedicated worktree, even if the caller
  // omitted --worktree (foreground runs preserve the explicit flag behavior).
  if (useWorktree && !resuming) {
    // A worktree means the user keeps their checkout while the night runs.
    // The run's project path becomes the worktree, which is also what the
    // envelope bounds writes to.
    const worktreeDir = path.join(
      path.dirname(projectPath),
      `${path.basename(projectPath)}-night-worktrees`,
      branchSlug(branch.replace(/^night\//, "")),
    );
    try {
      await git.addWorktree(worktreeDir, branch);
    } catch (error) {
      fail(
        `Error: could not create the worktree at ${worktreeDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    projectPath = worktreeDir;
    git = createGitOps(projectPath);
    // The agent loop hands every tool `cwd: process.cwd()`, so without this
    // bash and every relative read/edit/write resolved against the USER'S
    // checkout while the envelope and git worked on the worktree. The first
    // live detached night found it: the sandbox refused every bash call
    // ("workdir … is outside the run tree") until the turn cap; with
    // --no-sandbox the commands would have run in the user's checkout.
    process.chdir(projectPath);
    console.log(`worktree: ${worktreeDir}`);
  } else {
    await git.createOrSwitchBranch(branch);
  }

  // Where the branch started, for the report's diffstat. Captured before the
  // run adds to it, and persisted so a resumed leg still reports the whole night.
  const baseCommit =
    resuming?.night?.baseCommit ?? (await git.headHash()) ?? "HEAD";

  const runId =
    resuming?.runId ??
    process.env.FREECODE_NIGHT_RUN_ID ??
    randomUUID().slice(0, 8);
  const stopWhen = resuming?.night?.stopWhen ?? argv.stopWhen;
  const commitStyle = resuming?.night?.commitStyle ?? argv.commitStyle;
  const verifyCommand = resuming?.night?.verifyCommand ?? argv.verify;
  const fallbackModel = resuming?.night?.fallbackModel ?? argv.fallbackModel;
  const night = {
    objective,
    branch,
    baseCommit,
    stopWhen,
    verifyCommand,
    fallbackModel,
    // A resumed run continues the first one's numbering and commit list, so
    // the report covers the whole night rather than the last leg of it.
    iterations: resuming?.night?.iterations ?? 0,
    commits: resuming?.night?.commits ?? [],
    waitedMs: resuming?.night?.waitedMs ?? 0,
    fallbackIterations: resuming?.night?.fallbackIterations ?? [],
    detached: isWorker || resuming?.night?.detached,
    scheduledFor:
      (Number.isFinite(Number(process.env.FREECODE_NIGHT_SCHEDULED_FOR))
        ? Number(process.env.FREECODE_NIGHT_SCHEDULED_FOR)
        : undefined) ?? resuming?.night?.scheduledFor,
    logPath:
      resuming?.night?.logPath ??
      (isWorker ? path.join(runDir(runId), "worker.log") : undefined),
    sandbox,
    commitStyle,
  };
  writeManifest({
    runId,
    status: "running",
    createdAt: resuming?.createdAt ?? Date.now(),
    startedAt: resuming?.startedAt ?? Date.now(),
    projectPath,
    provider: provider!,
    model,
    limits: {
      ...DEFAULT_RUN_LIMITS,
      ...(argv.maxIterations ? { maxTurns: argv.maxIterations } : {}),
      ...(argv.maxUsd !== undefined ? { maxUsd: argv.maxUsd } : {}),
    },
    usage: resuming?.usage ?? EMPTY_USAGE,
    turns: 0,
    verifyCommand: verifyCommand ?? "",
    pid: process.pid,
    taskCardCount: 0,
    night,
  });
  store.appendNotes(
    runId,
    resuming
      ? `# Resumed ${new Date().toISOString()}\n\nThe previous leg ended as ${resuming.status}.`
      : `# Night run ${runId}\n\nObjective: ${objective}\n\nBranch: ${branch}`,
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

  const inhibitor = inhibitSleep(argv.inhibit);

  console.log(
    [
      `night run ${runId} on ${branch}`,
      `  objective: ${objective}`,
      `  model:     ${provider}${model ? `/${model}` : ""}`,
      `  limits:    ${describeLimits(argv, until)}`,
      verifyCommand ? `  verify:    ${verifyCommand}` : "",
      stopWhen ? `  stop when: ${stopWhen}` : "",
      `  notes:     ${path.dirname(store.notesPath(runId))}`,
      "",
      inhibitor.kind === "none"
        ? "Note: the machine may suspend mid-run — nothing is holding it awake."
        : "Note: idle sleep is inhibited for this run, but closing the lid still suspends most laptops.",
      "",
    ].join("\n"),
  );

  // Pushing is the ORCHESTRATOR's act, after a commit — never the model's, which
  // the envelope denies outright. A failed push is reported and does not stop
  // the night: the commit is already safe locally.
  let pushFailed = false;
  const pushBranch = async (): Promise<void> => {
    const pushed = await git.push(branch);
    if (!pushed.ok && !pushFailed) {
      pushFailed = true;
      console.log(`  push failed (reported once): ${pushed.error ?? "unknown"}`);
    }
  };

  const result = await runNight(
    {
      runIteration: (input) =>
        runIteration({
          ...input,
          objective,
          stopWhen,
          projectPath,
          // `--fallback-model` is spent on the first quota window, and only
          // then: the orchestrator decides, this just resolves the string.
          ...(input.useFallback && fallbackModel
            ? splitModel(fallbackModel)
            : { provider: provider!, model }),
          denyRules: [...ENVELOPE_DENY_RULES, ...argv.deny],
          allowRules: argv.allow,
          onDecision: (d) => store.appendDecision(runId, d),
          signal: hardAbort.signal,
          sandbox,
        }),
      git,
      notes: {
        read: () => store.readNotes(runId),
        append: (section) => store.appendNotes(runId, section),
      },
      ...(verifyCommand
        ? {
            verify: async () => {
              try {
                const plan = sandbox
                  ? sandboxPlan(verifyCommand, projectPath, projectPath)
                  : undefined;
                const { stdout, stderr } = plan
                  ? await exec(plan.command, plan.args, {
                    cwd: projectPath,
                    maxBuffer: 8 * 1024 * 1024,
                    env: sandboxEnvironment(),
                    })
                  : await exec(verifyCommand, {
                      cwd: projectPath,
                      shell: true,
                      maxBuffer: 8 * 1024 * 1024,
                    } as never);
                return { ok: true, output: `${stdout}${stderr}` };
              } catch (error) {
                const e = error as { stdout?: string; stderr?: string; message?: string };
                return {
                  ok: false,
                  output: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? ""),
                };
              }
            },
          }
        : {}),
      sleepUntil: (at) => sleepUntil(at, () => stop.graceful || stop.hard),
      record: (record) => {
        store.appendIteration(runId, record);
        // Keep the manifest current so `freecode night status` from another
        // terminal reads real progress, and so a crash leaves an accurate
        // account rather than the startup snapshot.
        if (record.kind === "iteration") {
          updateManifest(runId, (m) => ({
            ...m,
            night: m.night && {
              ...m.night,
              iterations: Math.max(m.night.iterations, record.n),
              commits: record.commit
                ? [...m.night.commits, record.commit]
                : m.night.commits,
            },
          }));
          if (record.commit && argv.push) void pushBranch();
        } else {
          updateManifest(runId, (m) => ({
            ...m,
            night: m.night && {
              ...m.night,
              waitedMs: m.night.waitedMs + Math.max(0, record.until - record.from),
            },
          }));
        }
      },
      decision: (d) => store.appendDecision(runId, d),
      now: () => Date.now(),
      // `freecode night stop` from another terminal sets this in the manifest.
      // Read at the boundary rather than signalled: a process killed mid-write
      // is how manifests corrupt.
      stopRequested: () =>
        stop.graceful || stop.hard || readManifest(runId)?.cancelRequested === true,
      hardStopped: () => stop.hard,
      report: (line) => console.log(line),
    },
    {
      maxIterations: argv.maxIterations,
      maxUsd: argv.maxUsd,
      until,
      maxWaitMs: maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      startIteration: resuming?.night?.iterations ?? 0,
      fallbackModel,
      stopWhen,
      commitStyle,
      maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
    },
  );
  inhibitor.release();

  const finished = updateManifest(runId, (m) => ({
    ...m,
    status: result.stopReason === "objective_met" ? "completed" : "stopped",
    endedAt: Date.now(),
    usage: { ...m.usage, usd: (resuming?.usage.usd ?? 0) + result.usd },
    night: m.night && {
      ...m.night,
      // Cumulative across legs. `iterations` is already absolute (the
      // orchestrator numbers from the resume offset); the rest would otherwise
      // be overwritten with this leg's totals and lose the first night's work.
      iterations: Math.max(m.night.iterations, result.iterations),
      commits: [...new Set([...m.night.commits, ...result.commits])],
      waitedMs: night.waitedMs + result.waitedMs,
      fallbackIterations: [
        ...new Set([...m.night.fallbackIterations, ...result.fallbackIterations]),
      ],
      stopReason: result.stopReason,
      uncommitted: result.uncommitted,
    },
  }));

  // The morning report, written where `freecode night report` will regenerate
  // it from the same logs if this process never got the chance.
  if (finished?.night) await regenerateReport(finished);

  const decisions = store.readDecisions(runId);
  const needsHumanCount = decisions.filter((d) => d.kind === "needs_human").length;

  // The night is over and nobody has been watching. Fire the existing
  // Notification hook so a user who wired one up (desktop toast, phone push)
  // learns it ended without having to check the terminal. Best-effort: a
  // failing hook must not change the run's exit.
  try {
    const { runNotificationHooks } = await import("../../hooks/Notification.js");
    await runNotificationHooks(
      `night ${runId} ended: ${result.stopReason} — ` +
        `${result.commits.length} commit${result.commits.length === 1 ? "" : "s"} on ${branch}` +
        `${needsHumanCount > 0 ? `, ${needsHumanCount} thing(s) need you` : ""}`,
      { sessionId: runId, projectPath, turnCount: result.iterations },
    );
  } catch {
    // A notification nobody receives is not worth failing a night over.
  }

  // ---- Exit summary (§4.10 v0: terminal only; report.md is Phase 3).
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
      result.waitedMs > 0
        ? `  waited ${(result.waitedMs / 3_600_000).toFixed(1)}h on a spent quota`
        : "",
      result.fallbackIterations.length > 0
        ? `  ran on the fallback model: iteration${result.fallbackIterations.length === 1 ? "" : "s"} ${result.fallbackIterations.join(", ")}`
        : "",
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
      `  report:  freecode night report ${runId}`,
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

function splitModel(spec: string): { provider: string; model?: string } {
  const slash = spec.indexOf("/");
  return slash > 0
    ? { provider: spec.slice(0, slash), model: spec.slice(slash + 1) }
    : { provider: spec };
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
