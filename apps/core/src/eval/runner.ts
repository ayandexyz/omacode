// =============================================================================
// Runner — drives one case through the real agent loop and folds the result.
//
// Reuses `cli/commands/run.ts`'s boot path IN-PROCESS rather than shelling out
// to the binary, so a case can be stepped through in a debugger and the
// harness works from a source checkout without `pnpm build:bun`.
// =============================================================================

import { buildTrace, type Trace } from "../rollout/trace.js";
import { loadSessionEvents } from "../rollout/history.js";
import { createSandbox, insideSandbox, type Sandbox } from "./sandbox.js";
import type { JudgeConfig } from "./judge-config.js";
import type { EvalCase, RunRecord, TrialResult } from "./types.js";
import { trialEfficiency } from "./scorers/efficiency.js";
import { echoedModels } from "./model-echo.js";
import { scoreOutcome } from "./scorers/outcome.js";
import { scoreTrajectory } from "./scorers/trajectory.js";
import { envInt } from "../utils/env.js";
import { drainMemoryJobs } from "../memory/background-jobs.js";
import {
  countMemories,
  FROZEN_MEMORY_ENV,
  removeMemoryStore,
  seedMemories,
} from "./memory-fixture.js";
import { trackMemoryJob } from "../memory/background-jobs.js";
import { RolloutRecorder } from "../rollout/recorder.js";
import { runConsolidationIfDue } from "../memory/consolidate-run.js";
import type { ConsolidationResult } from "../memory/consolidate.js";
import { subscriptionAuth } from "../providers/config.js";
import { traceCost, traceCostByOperation } from "../rollout/cost.js";

export interface RunnerConfig {
  provider: string;
  model?: string;
  projectPath: string;
  /** Resolved judge, when one is configured and is not the model under test. */
  judge?: JudgeConfig;
}

/**
 * A trial that has not finished by now is not going to teach us anything, and
 * one dead case must not cost the other nineteen. Generous: the slowest honest
 * case observed is ~40s, and a case whose own `expectMaxTurns` is large can
 * legitimately take minutes.
 */
const TRIAL_TIMEOUT_MS = envInt("FREECODE_EVAL_TRIAL_TIMEOUT_MS", 300_000, {
  // A sub-second budget fails every trial for infrastructure reasons and reads
  // as an agent failure, which is the most expensive wrong answer this harness
  // can give. An empty variable used to produce exactly that.
  min: 1_000,
});
const MEMORY_DRAIN_TIMEOUT_MS = envInt(
  "FREECODE_EVAL_MEMORY_DRAIN_TIMEOUT_MS",
  10_000,
  { min: 1 },
);

/**
 * Undo `initRunner`'s MCP boot. Each configured MCP server is a child process
 * (Claude Code's are imported too, e.g. `npx @agentmemory/mcp`), and a live
 * child holds node's event loop open: without this the suite prints its report
 * and then never exits.
 */
export async function shutdownRunner(): Promise<void> {
  const { stopMcpServers } = await import("../mcp/index.js");
  await stopMcpServers();
}

/** Boots providers + MCP once for the whole suite, not once per case. */
export async function initRunner(
  modelOverride?: string,
): Promise<RunnerConfig> {
  const { initProviders } = await import("../providers/index.js");
  const { initMcpServers } = await import("../mcp/index.js");
  const { readConfig } = await import("../providers/config.js");

  await initProviders();
  await initMcpServers();

  const config = readConfig();
  let provider = config.current?.provider;
  let model = config.current?.model;
  if (modelOverride) {
    const slash = modelOverride.indexOf("/");
    if (slash > 0) {
      provider = modelOverride.slice(0, slash);
      model = modelOverride.slice(slash + 1);
    } else {
      model = modelOverride;
    }
  }
  if (!provider) {
    throw new Error(
      "No provider configured. Set current.provider in ~/.freecode/config.json, " +
        "or pass --model <provider>/<model>.",
    );
  }
  return { provider, model, projectPath: process.cwd() };
}

/**
 * One trial. A case that pins `model` overrides the suite default — an
 * unpinned baseline silently reprices when a provider changes its default,
 * and a repriced baseline is worse than none because it looks like data.
 */
export async function runTrial(
  kase: EvalCase,
  config: RunnerConfig,
): Promise<TrialResult> {
  // A sandboxed case runs in a fresh tmpdir seeded from `files`, which becomes
  // its project root; an unsandboxed one runs in the real working directory
  // (and `dataset.ts` has already refused to let it mutate anything).
  const sandbox = kase.files ? createSandbox(kase.files) : undefined;
  // Scoped to the trial and restored after it, including on the throw path.
  // Safe because `suite.ts` awaits each trial in turn — a parallel runner would
  // have to carry this into the loop's own configuration instead.
  const restoreEnv = applyEnv(kase.env);
  // Captured after case-local env, before a consolidation fixture freezes the
  // gate; this is the A/B variant value we restore for its controlled pass.
  const originalConsolidationGate =
    process.env.FREECODE_DISABLE_MEMORY_CONSOLIDATION;
  // A memory case measures recall over a frozen corpus: seed it into the
  // sandbox's own store and stop anything writing to it for the trial.
  // `dataset.ts` guarantees `memories` implies a sandbox.
  // Fixtures freeze automatic writers. Consolidation cases release only that
  // one gate after their teaching sessions, then call the production scheduler
  // explicitly once; extraction stays disabled throughout — the corpus is
  // pre-seeded via `memories`, so organic extraction would contaminate it.
  //
  // A `sessions`-only consolidation fixture (spec 2026-09-25 §7, ROADMAP §4)
  // has no pre-seeded corpus to protect: the whole point is letting extraction
  // build the store across the teaching sessions. Only consolidation itself
  // is frozen during teaching, so the forced pass below is genuinely the
  // FIRST one, not one of several the production per-turn gate already ran.
  const restoreMemoryEnv = kase.memories
    ? applyEnv(
        kase.consolidateBeforeFinal
          ? { FREECODE_DISABLE_MEMORY_EXTRACTION: "1", FREECODE_DISABLE_MEMORY_CONSOLIDATION: "1" }
          : FROZEN_MEMORY_ENV,
      )
    : kase.sessions && kase.consolidateBeforeFinal
      ? applyEnv({ FREECODE_DISABLE_MEMORY_CONSOLIDATION: "1" })
      : () => {};
  let removeMemories = () => {};
  try {
    if (kase.memories && sandbox) {
      removeMemories = await seedMemories(sandbox.dir, kase.memories);
    }
    return await runTrialIn(kase, config, sandbox, originalConsolidationGate);
  } finally {
    removeMemories();
    // A multi-session case writes into the sandbox's store as it learns.
    if (kase.sessions && sandbox) removeMemoryStore(sandbox.dir);
    restoreMemoryEnv();
    restoreEnv();
    sandbox?.cleanup();
  }
}

/**
 * The same `UnattendedContext` a night run builds, minus the persistence: what
 * the model sees and what it is refused must match production exactly, or the
 * suite measures a harness that does not ship. Records are dropped — the
 * trajectory scorer reads the trace, not this.
 */
async function buildUnattendedContext(
  tree: string,
): Promise<import("../autonomous/types.js").UnattendedContext> {
  const { decideUnattendedAsk, REFUSAL_TEXT } = await import(
    "../autonomous/envelope.js"
  );
  return {
    iteration: 1,
    decideAsk(toolName, args) {
      const verdict = decideUnattendedAsk({ tree, toolName, args });
      return verdict.allowed
        ? { allowed: true }
        : { allowed: false, reason: verdict.reason ?? REFUSAL_TEXT };
    },
    record: () => {},
  };
}

/**
 * Set the case's env, returning the undo. Restores an absent variable by
 * deleting it rather than setting "" — the compaction knobs treat an empty
 * string as unset, but nothing guarantees the next key added will.
 */
export function applyEnv(env: Record<string, string> | undefined): () => void {
  if (!env) return () => {};
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function runTrialIn(
  kase: EvalCase,
  config: RunnerConfig,
  sandbox: Sandbox | undefined,
  originalConsolidationGate: string | undefined,
): Promise<TrialResult> {
  const { getAppRuntime } = await import("../effect/runtime.js");
  const { createAgentLoopEffect } = await import("../agent/loop.js");
  const { getSessionManager } = await import("../session/index.js");
  const { answerPermission, bus, rejectPermission, rejectQuestion } =
    await import("../bus/index.js");
  const { endSession } = await import("../session/end-session.js");
  const { sessionMemoryFlush } = await import("../session/session-flush.js");
  const { SessionStoreTag } = await import("../effect/context.js");
  const { getAgentRegistry } = await import("../agent/registry/index.js");
  const { disposeShellRegistry } = await import("../tools/shells/index.js");

  const projectPath = sandbox?.dir ?? config.projectPath;

  let provider = config.provider;
  let model = config.model;
  if (kase.model) {
    const slash = kase.model.indexOf("/");
    if (slash > 0) {
      provider = kase.model.slice(0, slash);
      model = kase.model.slice(slash + 1);
    } else {
      model = kase.model;
    }
  }

  const manager = await getSessionManager();
  // Fresh session per trial: each gets its own rollout aggregate, and
  // therefore its own Trace. Sharing one would fold two runs into one span set.
  const sessionId = await manager.start(projectPath, provider);
  // Earlier sessions of a multi-session case (spec 2026-09-25 §7). Their ids
  // are collected so the prompt handlers below answer for them too, and so
  // their cost is summed into the trial.
  const earlierSessionIds: string[] = [];
  // Per-session memory snapshots for the long-horizon suite. Pushed after
  // each teaching session's end-of-session flush, and once more for the
  // scored session. Cost per entry is `null` when the model is unpriced for
  // any call in that session — same convention as `costUsd` on the trial.
  const memorySnapshots: NonNullable<TrialResult["memorySnapshots"]> = [];
  let consolidation: ConsolidationResult | null | undefined;
  // A subagent asks under its own synthetic id; it belongs to this trial when
  // its tree hangs off one of the trial's sessions. Without this a writing
  // subagent's permission prompt went unanswered until the trial timed out.
  const ownsSession = (id: string | undefined): boolean => {
    if (id === undefined) return true;
    const root = getAgentRegistry().rootOf(id);
    return root === sessionId || earlierSessionIds.includes(root);
  };

  // The rollout log deliberately carries no message bodies (spec §5.2), so the
  // reply text is captured live here. Nothing scores it in Phase 1; the judge
  // (Phase 3) is its only consumer.
  // Reset at the start of each turn rather than accumulated, so a multi-turn
  // case hands the judge the FINAL reply — which is what a rubric grades — and
  // not three answers concatenated.
  let response = "";
  const unsubscribe = bus.subscribe("stream", (e) => {
    if (e.sessionId !== sessionId) return;
    if (e.event.type === "text_delta") response += e.event.delta;
  });

  // Play the part a frontend plays: answer the question, by declining it.
  //
  // Without this a case that makes the model call `question` ends the whole
  // SUITE. `askQuestion()` unref()s its 30-minute timer (`bus/index.ts`) so a
  // pending question cannot hold the event loop open, and headless there is
  // nothing else holding it — so node drains and exits **0** mid-run, with no
  // report written and no verdict. Under `--gate` that reads as a green CI job.
  // Rejecting is the honest headless answer, and the tool already recovers from
  // it ("You can continue without this information").
  let questionsRejected = 0;
  const unsubscribeQuestions = bus.subscribe("question.asked", (e) => {
    if (!ownsSession(e.sessionId)) return;
    questionsRejected++;
    rejectQuestion(e.requestId);
  });
  // Play the frontend's part for permission prompts too, but ONLY inside a
  // sandbox. `build` mode's default for a mutating tool is "ask", and a
  // headless ask resolves to DENY (`permission/prompt.ts`) — so without this
  // every coding case would score a model that was never allowed to write, and
  // the suite would measure the permission layer instead of the agent.
  //
  // Scoped, not blanket: a path argument that resolves outside the sandbox is
  // refused. Tools with no path argument — `bash` above all — are granted,
  // because a coding case needs to run its own checks, and because §6.3 is
  // already explicit that a tmpdir does not contain an agent holding a shell.
  // Nothing subscribes when the case has no sandbox, so an unsandboxed case
  // keeps Phase 1's behaviour exactly: headless ask, deny.
  const unsubscribePermissions = sandbox
    ? bus.subscribe("permission.asked", (e) => {
        if (!ownsSession(e.sessionId)) return;
        const target = (e.args.filePath ?? e.args.path ?? e.args.cwd) as
          | string
          | undefined;
        if (typeof target === "string" && !insideSandbox(sandbox.dir, target)) {
          rejectPermission(e.requestId);
          return;
        }
        answerPermission(e.requestId, { decision: "allow-once" });
      })
    : () => {};
  const cleanup = () => {
    unsubscribe();
    unsubscribeQuestions();
    unsubscribePermissions();
    // The scored session never goes through endSession, so a background
    // subagent or shell (`run_in_background`) would outlive its trial: spending
    // tokens the trial does not count, writing into a sandbox about to be
    // deleted, and holding the process open after the report.
    for (const id of [sessionId, ...earlierSessionIds]) {
      getAgentRegistry().disposeRoot(id);
      disposeShellRegistry(id);
    }
  };

  // An unattended case is scored on what `freecode night` would actually offer
  // the model: finish_iteration on the tool list, `question` answering itself,
  // and the envelope deciding permission asks against the sandbox — NOT the
  // blanket allow above, which would make an envelope case unmeasurable by
  // approving the very call it is supposed to refuse. `dataset.ts` guarantees
  // an unattended case is sandboxed.
  const unattended = kase.unattended
    ? await buildUnattendedContext(projectPath)
    : undefined;

  const startedAt = Date.now();
  let memoryJobsPending = 0;
  try {
    const loop = await getAppRuntime().runPromise(
      createAgentLoopEffect(
        sessionId,
        unattended
          ? {
              unattended,
              sessionDenies: (await import("../autonomous/envelope.js"))
                .ENVELOPE_DENY_RULES,
            }
          : undefined,
      ),
    );
    // One user turn per prompt, on the same session and the same loop. Each
    // `run()` reloads history from the store, so a follow-up sees everything
    // the previous turn did — which is what makes a compaction reachable at
    // all (see `EvalCase.followUps`).
    const prompts = [kase.prompt, ...(kase.followUps ?? [])];
    const agentMode = kase.agentMode ?? (sandbox ? "build" : "explore");
    const turns = (async () => {
      // Each earlier session: one prompt in a fresh session, then ended the
      // way the daemon ends one, session-end flush included. The flush is
      // tracked and drained, so its cost is in the trial and what it learned
      // is in the store before the next session starts.
      for (const [sessionIndex, earlier] of (kase.sessions ?? []).entries()) {
        const sid = await manager.start(projectPath, provider);
        earlierSessionIds.push(sid);
        const earlierLoop = await getAppRuntime().runPromise(
          createAgentLoopEffect(sid),
        );
        await getAppRuntime().runPromise(
          earlierLoop.runEffect({
            prompt: earlier,
            sessionId: sid,
            provider,
            model,
            projectPath,
            agentMode,
          }),
        );
        for (const followUp of kase.sessionFollowUps?.[sessionIndex] ?? []) {
          await getAppRuntime().runPromise(
            earlierLoop.runEffect({
              prompt: followUp,
              sessionId: sid,
              provider,
              model,
              projectPath,
              agentMode,
            }),
          );
        }
        const flush = sessionMemoryFlush({
          sessionId: sid,
          projectPath,
          provider,
          getStore: () => getAppRuntime().runPromise(SessionStoreTag),
        });
        await endSession(sid, {
          reason: "switch",
          flush: () => trackMemoryJob(sid, flush()),
        });
        memoryJobsPending += (
          await drainMemoryJobs(sid, MEMORY_DRAIN_TIMEOUT_MS)
        ).pending;
        // Snapshot the store after the flush so a long-horizon trial can
        // answer "how much had memory learned by session N?" without
        // re-running. The per-session cost is folded from the session's own
        // rollout log (`traceCost` keys partial separately, so an unpriced
        // call in the session makes this entry `null` rather than zero).
        // `memoriesCaptured` is the delta against the previous snapshot —
        // the same number the savings curve needs, derived rather than
        // re-counted so a passing flush that did nothing shows zero.
        if (sandbox && (kase.memories || kase.sessions)) {
          const earlierEvents = loadSessionEvents(sid);
          const earlierTrace = earlierEvents
            ? buildTrace(sid, earlierEvents.events)
            : null;
          const sessionCost = earlierTrace
            ? traceCost(earlierTrace)
            : undefined;
          const storeSize = countMemories(sandbox.dir);
          const previousSize = memorySnapshots.at(-1)?.storeSize ?? storeSize;
          memorySnapshots.push({
            sessionId: sid,
            index: sessionIndex,
            storeSize,
            memoriesCaptured: Math.max(0, storeSize - previousSize),
            costUsd: sessionCost?.usd ?? null,
            scored: false,
          });
        }
      }
      if (kase.consolidateBeforeFinal) {
        // `runTrial` temporarily set this gate to keep automatic background
        // consolidation out of the teaching sessions. Restore the A/B side's
        // value before the controlled pass: `=1` is the real off arm.
        const frozen = process.env.FREECODE_DISABLE_MEMORY_CONSOLIDATION;
        const external = originalConsolidationGate;
        if (external === undefined) delete process.env.FREECODE_DISABLE_MEMORY_CONSOLIDATION;
        else process.env.FREECODE_DISABLE_MEMORY_CONSOLIDATION = external;
        try {
          const metas = await manager.list({ projectPath });
          const recorder = new RolloutRecorder(sessionId);
          consolidation = await runConsolidationIfDue({
            projectPath,
            provider,
            sessionId,
            sessions: metas.map((m) => ({
              id: m.id,
              lastTurnAt: m.lastTurnAt,
              turnCount: m.turnCount,
            })),
            onAuxiliaryCall: (call) =>
              recorder.recordMemoryAuxiliary(undefined, {
                purpose: call.purpose,
                provider: call.provider,
                model: call.model,
                duration_ms: call.duration_ms,
                outcome: call.outcome,
                inputTokens: call.usage?.inputTokens,
                outputTokens: call.usage?.outputTokens,
                cacheReadTokens: call.usage?.cacheReadInputTokens,
                cacheWriteTokens:
                  call.usage?.cacheWriteInputTokens ?? call.usage?.cacheCreationInputTokens,
                authMode: subscriptionAuth(call.provider),
              }),
          });
        } finally {
          // The final agent loop must still see the fixture's frozen state.
          if (frozen === undefined) delete process.env.FREECODE_DISABLE_MEMORY_CONSOLIDATION;
          else process.env.FREECODE_DISABLE_MEMORY_CONSOLIDATION = frozen;
        }
      }
      for (const prompt of prompts) {
        response = "";
        await getAppRuntime().runPromise(
          loop.runEffect({
            prompt,
            sessionId,
            provider,
            model,
            projectPath,
            // A sandboxed case defaults to `build` (spec §6) — it has a tmpdir
            // to write in. An unsandboxed one defaults to read-only and
            // `dataset.ts` rejects any mutating override, because there
            // `forbidTools` only SCORES a mutation; it cannot prevent one.
            // Mode enforcement can.
            agentMode,
          }),
        );
      }
      // Final snapshot: the scored session's own cost and the store size
      // immediately after its answer — what a savings-curve point at
      // `sessions.length` plots against. `costUsd` is taken from the trial's
      // own cost fold below, so this snapshot is filled in once that number
      // is computed (here we only carry the store state).
      if (sandbox && (kase.memories || kase.sessions)) {
        const storeSize = countMemories(sandbox.dir);
        const previousSize = memorySnapshots.at(-1)?.storeSize ?? storeSize;
        memorySnapshots.push({
          sessionId,
          index: memorySnapshots.length,
          storeSize,
          memoriesCaptured: Math.max(0, storeSize - previousSize),
          costUsd: null,
          scored: true,
        });
      }
    })();
    await Promise.race([
      turns,
      // The backstop for anything that blocks without a timeout of its own.
      // Deliberately spans the WHOLE trial rather than each turn: the budget is
      // what a case may cost, and a three-turn case that takes three times as
      // long is not three times as informative.
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`trial exceeded ${TRIAL_TIMEOUT_MS}ms`)),
          TRIAL_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    memoryJobsPending += (
      await drainMemoryJobs(sessionId, MEMORY_DRAIN_TIMEOUT_MS)
    ).pending;
  } catch (err) {
    // An infrastructure failure is a failed trial, not a crashed suite: one
    // dead case must not cost the other nineteen.
    cleanup();
    return {
      passed: false,
      reason: `run failed: ${(err as Error).message}`.slice(0, 200),
      infra: true,
      durationMs: Date.now() - startedAt,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
      repeatedCalls: 0,
      redirects: 0,
      redirectsSkipped: 0,
      questionsRejected,
      sessionId,
      // A rubric case carries `score` even when it never reached the judge.
      // The key's PRESENCE is how `gate.ts` knows a result was judged at all;
      // dropping it on the crash path made a judged suite whose cases all died
      // look like a deterministic suite, and the judged rules — including "no
      // judge configured" — then had nothing to apply to.
      ...(kase.rubric ? { score: null } : {}),
    };
  }
  cleanup();

  const recorded = loadSessionEvents(sessionId);
  if (!recorded) {
    return {
      passed: false,
      reason: "no rollout events recorded",
      infra: true,
      durationMs: Date.now() - startedAt,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
      repeatedCalls: 0,
      redirects: 0,
      redirectsSkipped: 0,
      questionsRejected,
      sessionId,
      ...(kase.rubric ? { score: null } : {}),
    };
  }

  const trace = buildTrace(sessionId, recorded.events);
  const run: RunRecord = {
    trace,
    prompt: kase.prompt,
    response,
    sandboxDir: sandbox?.dir,
  };
  // Trajectory first: it is the cheaper verdict, and a run that hung or called
  // a forbidden tool should report THAT rather than whatever `verify` makes of
  // the wreckage.
  const trajectory = scoreTrajectory(run, kase);
  const score = trajectory.passed ? scoreOutcome(run, kase) : trajectory;

  // The judge runs LAST and only on a case that asked for one. It is the most
  // expensive and least trustworthy scorer here, so a case that already failed
  // objectively does not pay for an opinion about its prose.
  let judged:
    | { score: number | null; reason: string; costUsd?: number }
    | undefined;
  if (kase.rubric) {
    if (!score.passed) {
      judged = { score: null, reason: "not judged: failed deterministically" };
    } else if (!config.judge) {
      judged = { score: null, reason: "not judged: no judge configured" };
    } else {
      const { scoreJudged, toolSummary } = await import("./scorers/judge.js");
      judged = await scoreJudged({ run, kase, judge: config.judge });
      // Every numeric verdict becomes a calibration sample awaiting a human
      // label (`freecode eval calibrate`). Best-effort on purpose: capture is
      // bookkeeping, and bookkeeping must never fail the trial it books.
      if (typeof judged.score === "number") {
        try {
          const { recordCalibrationSample } = await import("./calibration.js");
          recordCalibrationSample({
            caseId: kase.id,
            rubric: kase.rubric,
            ranAt: new Date().toISOString(),
            sessionId,
            model: model ? `${provider}/${model}` : provider,
            judge: config.judge,
            judgeScore: judged.score,
            judgeReason: judged.reason,
            prompt: kase.prompt,
            response: response.trim(),
            tools: toolSummary(run),
            human: null,
          });
        } catch {
          // A read-only checkout or a broken samples file loses one sample,
          // never a verdict.
        }
      }
    }
  }

  const { JUDGE_CASE_FLOOR } = await import("./gate.js");
  // The bill covers every session of the trial; scoring stays on the final
  // one, which is the session the case's expectations describe.
  const earlierTraces = earlierSessionIds.flatMap((id) => {
    const ev = loadSessionEvents(id);
    return ev ? [buildTrace(id, ev.events)] : [];
  });
  const billed: Trace = {
    ...trace,
    modelSpans: [trace, ...earlierTraces].flatMap((t) => t.modelSpans),
    auxiliarySpans: [trace, ...earlierTraces].flatMap((t) => t.auxiliarySpans),
  };
  const sumOf = (pick: (t: Trace) => number) =>
    [trace, ...earlierTraces].reduce((n, t) => n + pick(t), 0);
  const cost = memoryJobsPending === 0 ? traceCost(billed) : undefined;
  const costByOperation = Object.fromEntries(
    Object.entries(traceCostByOperation(billed)).map(([op, c]) => [
      op,
      c?.usd ?? null,
    ]),
  );
  const echoed = echoedModels(trace);

  // Back-fill the scored session's snapshot with its own USD. The teaching
  // sessions already carry theirs from the per-session `traceCost` fold above;
  // this entry was deliberately left `null` because its cost is the trial's
  // `costUsd` minus the sum of the teaching sessions. `null` stays `null`
  // when the trial has no priced cost (unpriced calls, drain timeout).
  let teachingCostUsd: number | undefined;
  if (memorySnapshots.length > 0) {
    const teachingSnapshots = memorySnapshots.filter((s) => !s.scored);
    const pricedTeaching = teachingSnapshots.filter(
      (s) => typeof s.costUsd === "number",
    );
    if (
      pricedTeaching.length === teachingSnapshots.length &&
      typeof cost?.usd === "number"
    ) {
      const teachingSum = pricedTeaching.reduce(
        (n, s) => n + (s.costUsd as number),
        0,
      );
      const scoredCost = cost.usd - teachingSum;
      teachingCostUsd = teachingSum;
      const scoredSnapshot = memorySnapshots.find((s) => s.scored);
      if (scoredSnapshot) scoredSnapshot.costUsd = scoredCost;
    }
  }

  // A judged case that scored below the floor is a failure; one the judge
  // could not answer for keeps the deterministic verdict, because an outage
  // must never fail a run (spec §7 constraint 3).
  const judgedOk =
    typeof judged?.score === "number" ? judged.score >= JUDGE_CASE_FLOOR : true;

  return {
    passed: score.passed && judgedOk,
    // An objective failure always reports itself: "not judged: failed
    // deterministically" tells you nothing about WHAT failed.
    reason: !score.passed
      ? score.reason
      : typeof judged?.score === "number"
        ? `${judged.score}/5 — ${judged.reason}`
        : (judged?.reason ?? score.reason),
    ...(score.infra ? { infra: true } : {}),
    ...(kase.rubric ? { score: judged?.score ?? null } : {}),
    ...(judged?.costUsd !== undefined ? { judgeCostUsd: judged.costUsd } : {}),
    durationMs: Date.now() - startedAt,
    inputTokens: sumOf((t) => t.inputTokens),
    outputTokens: sumOf((t) => t.outputTokens),
    costUsd: cost?.usd,
    ...(cost?.partial ? { costPartial: true } : {}),
    ...(Object.keys(costByOperation).length > 0 ? { costByOperation } : {}),
    memoryCostComplete: memoryJobsPending === 0,
    ...(memoryJobsPending > 0 ? { memoryJobsPending } : {}),
    turns: billed.modelSpans.length,
    ...(kase.sessions && sandbox
      ? { memoriesCaptured: countMemories(sandbox.dir) }
      : {}),
    ...(sandbox && (kase.memories || kase.sessions)
      ? { storeSize: countMemories(sandbox.dir) }
      : {}),
    ...(memorySnapshots.length > 0 ? { memorySnapshots } : {}),
    ...(typeof teachingCostUsd === "number" ? { teachingCostUsd } : {}),
    ...(kase.consolidateBeforeFinal
      ? {
          consolidation: consolidation
            ? {
                ran: true,
                merged: consolidation.merged,
                promoted: consolidation.promoted,
                episodes: consolidation.episodes,
                deleted: consolidation.deleted,
                ok: consolidation.ok,
              }
            : { ran: false },
        }
      : {}),
    repeatedCalls: countRepeatedCalls(trace),
    nestedCalls: trace.toolSpans.filter((s) => s.parentCallId).length,
    redirects: trace.redirects,
    redirectsSkipped: trace.redirectsSkipped,
    questionsRejected,
    efficiency: trialEfficiency(trace),
    ...(echoed.length > 0 ? { echoedModels: echoed } : {}),
    sessionId,
  };
}

/**
 * How many tool calls repeated a signature already seen in this trial. Counts
 * the *redundant* ones, so six identical greps score 5 and a clean run scores 0
 * — the number that has to fall if redirection is working.
 *
 * A call whose opening `function.call` was lost has no args (`trace.ts`), so it
 * keys on the tool name alone rather than silently matching every other
 * argument-less call of the same tool.
 *
 * Only calls the model made: a codemode script's own calls (`parentCallId`)
 * never enter the transcript, and two scripts re-reading the same files used
 * to score as dozens of repeats (spec 2026-10-05-codemode.md §6.2). They are
 * counted separately in `nestedCalls`, matching `updateLoopHealth`, which
 * likewise sees only top-level calls.
 */
export function countRepeatedCalls(trace: Trace): number {
  const seen = new Set<string>();
  let repeats = 0;
  for (const [index, span] of trace.toolSpans.entries()) {
    if (span.parentCallId) continue;
    const key = span.args
      ? `${span.tool}:${JSON.stringify(span.args)}`
      : `${span.tool}:#${index}`;
    if (seen.has(key)) repeats++;
    else seen.add(key);
  }
  return repeats;
}
