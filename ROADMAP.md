# FreeCode Roadmap

Features and redesigns that are **not built and not debt** — each needs a spec
(or at least a decision) before code. Grows over time; that is fine. Bugs and
dead code live in `TODO.md`; recorded design decisions live in
`docs/DECISIONS.md`. Things ship from here as minors after 1.0.


## Extensibility

What a user can extend without editing FreeCode's source. Covered today: MCP servers,
skills (incl. `~/.claude/plugins` scope), permission rules via `.freecode/settings.json`,
and `CLAUDE.md`/`AGENTS.md` instructions. Ranked by value per line of work.


- [ ] **3. User-defined subagents** — `SubagentType` (`apps/core/src/agent/types.ts:38-43`)
      is a closed union of five, with descriptions in `SUBAGENT_DEFINITIONS`. No
      `.freecode/agents/*.md` loader. Bind loaded agents to the existing capability
      profiles in `permission/profiles.ts`. Reuse the frontmatter-markdown loader
      already in `commands/loader.ts` (which shipped item 2, user-defined slash
      commands).

- [ ] **4. Rules hierarchy** — `context/instructions.ts` reads `CLAUDE.md`/`AGENTS.md` from
      exactly two dirs (global `~/.freecode/`, project root), first match wins.
      Missing: walk-up for monorepos, `@imports` (both deferred in the comment at line 6),
      and glob-scoped rules (the Cursor `.mdc` model — "apply only for `**/*.tsx`").
      Nested-directory rules would also give scoped skills somewhere to live.

- [ ] **5. Multimodal input** — `MessagePart` (`packages/shared/src/types.ts:12-19`) is
      text/code/tool only, and `read` cannot return an image. Blocks screenshots, design
      mocks, and diagram debugging. Touches the shared protocol + every provider adapter.

- [ ] **7. MCP server (expose)** — serve FreeCode's tools *as* an MCP server. The client
      side is done. Already listed as deferred in `CLAUDE.md`.

**Suggested order:** 3, then 4. Item 5 is a larger, self-contained project.
(Item 2, user-defined slash commands, shipped as `commands/loader.ts`. Item 6,
background bash, shipped as `tools/shells/` + `bashoutput`/`killbash` and the
TUI's `/shells` panel. Item 8, checkpoints/rewind, shipped 2026-09-23 as
`checkpoint/` + `/rewind` — spec `2026-09-23-checkpoints-rewind.md`; its §9
open questions, chiefly non-git projects, are the remaining work.)

## Background shell completion notifications (added 2026-09-08)

**Status:** delivery built 2026-09-27 for **background subagents only**
(`agent(run_in_background: true)`); shells are not wired yet. Follow-up to the
background-bash work (ex-item 6).

What exists now: `agent/task-notify.ts` formats the `<task-notification>` and
owns the switch (`tasks.notify`, `FREECODE_TASK_NOTIFY`, **default on** — the
user chose Claude Code's behaviour over the default-off below). `server.ts`
installs the sink: mid-turn a notification rides `AgentLoop.steer()` and lands
at the next tool-batch boundary (persisted `synthetic: "task_notification"`);
idle, it starts a turn (the idle watcher below), coalescing a 250ms burst into
one turn, with `startingTurns` guarding the window before `activeLoops.set`. An
undelivered one is re-queued as a notification, not a follow-up. With the
switch off, `run_in_background` runs the agent in the foreground.

Remaining for shells: call `notifyTask` from the `onExit` in `tools/bash.ts`
`startBackground`, and suppress it when the model already drained the shell to
completion via `bashoutput`.

Today a background shell is **pull-only**: the model learns a command finished
only by calling `bashoutput`, and it has no reason to call it once the turn has
ended. So "run the eval, tell me when it's done" works if the user asks again
30 minutes later, and never volunteers the result. Claude Code does volunteer
it, and the mechanism is worth copying rather than inventing:
`tasks/LocalShellTask` calls `enqueuePendingNotification({ mode:
'task-notification' })` on exit, which pushes a synthetic user message
(`<task-notification><status>completed</status><summary>Background command "X"
completed (exit code 0)</summary>`) onto the message queue; the REPL drains
that queue between turns **including when idle**, so the model is re-invoked
and reports back on its own. `utils/collapseBackgroundBashNotifications.ts`
exists only to squash a burst of those into one line.

What FreeCode already has:

- exit detection with a callback — `ShellRegistry.start({ onExit })`
  (`tools/shells/registry.ts:31`), already fired on natural exit and on
  `kill`/`killAll` (`:190`).
- a follow-up message queue — `queue-store.ts`, `server.ts:476`.
- per-turn reminder injection — `AgentLoop.pendingReminders`.

The two gaps:

- [ ] **Nothing tells the model.** `shell_exit` is a `StreamEvent` consumed by
      the TUI only. `pendingReminders` cannot carry it as-is: `loop.ts:648`
      resets the array at the start of every `run()`, so anything pushed after
      a turn ends is discarded. Needs a cross-turn queue (or an enqueue into
      the existing message queue, which is closer to Claude Code's shape).
- [ ] **The queue never drains while idle.** `server.ts:267` drains it in the
      `finally` of a *running* turn, and `:284` deletes the session from
      `activeLoops` when there is nothing queued. With no turn in flight
      nothing ever looks at the queue again, so an enqueued notification would
      sit there until the user typed. **This is the actual work**: an idle
      watcher that starts a turn when the queue gains an item and
      `!activeLoops.has(sessionId)`.

Also needed once those land: collapse a burst (five shells finishing at once is
one notification, not five turns), and suppress the notification when the model
already drained that shell to completion via `bashoutput` — otherwise the
notification buys a redundant paid turn.

**Why it is not built yet:** gap 2 means the agent starts *billable turns with
no user input*. A misfiring watcher burns tokens while nobody is watching, and
it overlaps the deliberately-Phase-0-only `autonomous/` work, whose whole point
is that unattended execution gets signed off per phase. Ship it default-**off**
behind a setting (`shells.notifyOnExit`, plus the usual
`FREECODE_DISABLE_*` escape hatch), and decide explicitly whether a completion
may interrupt a turn already in progress or must wait for it.

## Parallel foreground subagents (added 2026-09-27)

**Status:** not built. Found by the `delegation` eval suite.

Two `agent` calls in one response run one after another: `agent` has
`isConcurrencySafe: false`, and `tools/batching.ts` decides by tool **name**
(`IsConcurrencySafeFn = (toolName) => boolean`). Claude Opus 5 parallelizes
with `run_in_background` (3/3); MiniMax-M3 batches two foreground calls
instead (0/3 before and 0/3 after the description said foreground calls are
sequential), which is the normal way a model asks for parallel tool calls.

Fix: let batching consult the call's arguments, and treat an `agent` call
with `readOnly` not `false` as concurrency-safe. A read-only subagent
cannot see write/edit/bash (explore mode filters them), so two of them
cannot race on the tree. Writing subagents stay sequential. The results then
come back in one follow-up call, which is the
`extras/background-completions` rule in its best form.

## Subagent permission profiles (added 2026-09-08)

Blocked on user-defined subagents (Extensibility item 3). The dead-code half of this (`PROFILES`, `PermissionChecker`, duplicate `PermissionProfile` interface) is also tracked under Tool system in `TODO.md`.


**Status:** partly mitigated, the real fix is item 3 above.

`createToolOrchestrator()` is called with `{}` at all three production sites
(`effect/layers.ts:63`, `:179`, `agent/loop.ts:429`). `OrchestratorOptions.permissionProfile`
is real and checked (`tools/orchestrator.ts:150`, `:329`), but nothing outside
`permission/` ever constructs a profile, so `PROFILES`, `PermissionChecker`,
`TOOL_PERMISSIONS`, `getProfile`, `createProfile` and `validateProfile` are all
dead — plus there is a duplicate `PermissionProfile` interface in
`tools/types.ts:39`.

Subagents are **not** unsandboxed, which is the part that is easy to overstate:
`executeSubagent` maps `defaultReadOnly` to `agentMode: "explore"`
(`agent/subagent.ts`), and explore hard-denies mutating tools
(`modeEnforcement`), filters them out of the tool list entirely
(`tools/defs-cache.ts:59-71`), and never prompts (`modeAllowsAsk`). So
explorer/reviewer/summarizer/verifier are genuinely confined.

The real gap is that **mode is binary**. There is nothing between explore and
build, so a subagent that is allowed to write at all runs with the exact
authority of its parent: no path scoping, no network restriction, no allowlist.
Two guard rails now stand in for the missing sandbox — `MAX_AGENT_DEPTH`
(`agent/registry/`) bounds the spawn tree, and `agent(readOnly)` defaults true
so the common case (analysis, search, review) is confined to `explore` and
cannot mutate anything. Neither is a substitute for per-agent capabilities: a
`readOnly: false` subagent under a `danger` parent has the whole toolbox and
nothing scopes it to the files it was asked about.

Wiring `permissionProfile` in **as it stands would break subagents
immediately**: the profile axes (`fileRead`/`fileWrite`/`network`/`shell`/
`subprocess`) are a second, coarser permission model bolted beside
`permission/rules.ts` + `mode-policy.ts`, and `isToolAllowed` fails closed on
any tool missing from the hand-maintained `TOOL_PERMISSIONS` map — which today
lacks `ls`, `grep`, `glob`, `webfetch`, `todowrite`, `lsp`, `bashoutput`,
`killbash`, and every MCP tool. So before item 3 binds user-defined agents to
profiles, either complete that map or replace it with a per-subagent tool
allowlist that rides the existing rules evaluation rather than sitting beside
it.

## Memory: knowledge-graph roadmap (docs audit 2026-08-23)

- [ ] **Learning from archived sessions.** Extraction reads live transcripts;
      consolidation merges saved memories but does not mine old transcripts.
      Backfill remains separate from the shipped consolidation pass (see below).
- [ ] **Bi-temporal validity** — valid-time vs transaction-time, so "the host ran
      Apache until March" is expressible instead of only replaceable. Entries carry
      `createdAt`/`updatedAt` (transaction time) only.
- [ ] **Learned procedural memory** — skills and `.freecode/commands/` are real
      procedural memory, but hand-authored. Nothing distills a successful sequence
      into a reusable procedure with preconditions.
- [ ] **ANN index for vectors** — `cosineTopK` scans every vector
      (`vector-store.ts:199`). Exact and correct for hundreds; this is the ceiling.
- [ ] **Tuning values are guesses** — cap 3, interval 8, 200-char minimum, seed
      threshold 0.4, decay 0.7. Chosen to bound cost, not derived from data.

## Memory: consolidation roadmap (prior-art review 2026-08-23)

From reviewing `codex`, `jcode`, `mem0`, and `agentmemory` against
`docs/specs/2026-08-23-memory-consolidation.md` (amended same day,
D12–D14). These are actionable independently of that spec's phases.

- **Progressive disclosure instead of a byte cap.** codex's always-loaded
  artifact is a navigational index (`memory_summary.md`) with bodies fetched on
  demand through a read-only memory-fs MCP server (`codex-rs/memories/mcp/`), so
  a long memory is never truncated, only not-yet-read. Strictly better than the
  spec's D2 byte cap, but it is a read-path redesign touching the MCP surface
  and prompt caching.
- **Backfill the rollout archive.** ~390 session directories under
  `~/.freecode/rollout/sessions/` have never been mined; extraction only ever
  reads the live transcript, and the spec's end-of-session flush (D4) does not
  go back for them. codex's answer is a bounded, leased, parallel Phase 1 at
  startup.

## Memory: long-horizon evaluation (after spec 2026-09-25 §7.1)

The existing `memory-sessions` suite measures capture and recall over 2–3
sessions. Its completed work and results live in
[`2026-09-25-memory-efficiency-and-graph-explorer.md`](docs/specs/2026-09-25-memory-efficiency-and-graph-explorer.md)
§7. The following are measurement projects, not missing production features.
Build and validate the harnesses first; run paid experiments afterward.

1. [x] **Consolidation comparison harness.** Built 2026-09-26 as
   `evals/memory-consolidation.jsonl` plus `consolidateBeforeFinal` in the
   eval runner. Seed identical isolated stores
   with duplicates, complementary facts, corrections, and unrelated controls.
   Run the production consolidator on one copy, then freeze both stores and
   score the same held-out tasks at the same injection byte budget. Use
   fixture-only eligible session history and project-local scheduling settings;
   preserve production defaults. Record whether consolidation actually ran,
   its outcome, merge counts, retained facts, and its model cost. A skipped or
   failed pass must not count as a successful consolidation experiment.
2. [x] **Consolidation experiment.** Two fixtures, two verdicts (full detail
   in spec §7.2 and `EVAL.md`). `consolidate-production-endpoint` (pure
   near-duplicate merge): a 5-trial replicate reversed the earlier 3-trial
   "−4.7% cost" reading — candidate cost went +10% and pass rate was NOT
   preserved (one candidate-only failure right after a merge+delete) —
   **rejected**. `consolidate-stale-then-corrected` (stale vs. corrected
   memory, plus a distractor/control that must not be touched): two
   independent 3-trial runs both went 3/3 on both arms and consolidation was
   consistently cheaper — **kept**. `storeSize` and `costByOperation` are now
   in the ledger; rendered recall and irrelevant bytes at trial level remain
   unaddressed (would need a per-turn recording channel). Net: consolidation
   earns its cost when there is a real conflict to supersede, not proven (and
   showed one regression) when there is only a near-duplicate to fold.
3. [x] **Long-horizon harness.** Built 2026-09-26: `TrialResult.memorySnapshots`
   / `teachingCostUsd` (`eval/types.ts`, `eval/runner.ts`), the `sessions[]` +
   `sessionFollowUps[][]` fixture shape (`eval/dataset.ts`), and
   `evals/memory-long-horizon.jsonl` (5 cases, up to 12 sessions each,
   dilution/correction/gap/assembly/control). Evidence: `dataset.test.ts`
   ("the shipped long-horizon suite is valid"), `runner.test.ts` (6/6).
4. [x] **Savings-curve experiment.** Run 2026-09-26 (MiniMax-M3, 3 trials,
   two paired comparisons; `evals/experiments.jsonl`
   `2026-09-26-memory-long-horizon-{1,2}`, both **kept**; full numbers in
   spec §7.3, suite doc in `EVAL.md`). Memory off passed 3/15, learning +
   scheduled consolidation 10/15 (cost per passed probe −66%); consolidation
   off (still learning) 8/15, on-schedule 11/15 (a further −41%). No
   break-even in teaching cost itself at any of the 1/3/6/9/12 checkpoints —
   learning costs more to teach, session over session, and the entire return
   is the final probe passing. The memory tool stayed callable with
   auto-recall/extraction off (2 voluntary writes, no effect since recall was
   off). One case (`long-incremental-assembly`) never passed in any arm
   (0/12). Its fixture confound is fixed (`595b9dd3`); the re-run is still
   0/3 vs 0/3 and now fails on memory — last-taught fact not retained,
   consolidation dropping an earlier one — filed in `TODO.md`.
5. [x] **External-corpus adapter.** Built and validated 2026-09-26,
   `apps/core/src/eval/longmemeval-adapter.ts` + `.test.ts` (12/12, no model
   calls). Licence check: `xiaowu0162/longmemeval` (containing the
   `longmemeval_s` split this item names) is deprecated by its own
   maintainer for noisy sessions; the adapter targets the replacement,
   `xiaowu0162/longmemeval-cleaned`'s `longmemeval_s_cleaned` split — both
   MIT. Pinned: revision `98d7416c`, file `longmemeval_s_cleaned.json`,
   sha256 `d6f21ea9…c3a442`, 277 MB (`LONGMEMEVAL_SOURCE` in the adapter —
   re-check `revisionSha` before #6, a dataset can move without a version
   bump). Ingestion goes straight through `extractMemories` per haystack
   session in chronological order — no live agent turn per session, since the
   haystack is fixed historical dialogue and replaying it through our own
   agent would substitute invented replies for the recorded ones. Answer
   leakage is guarded on the scored question only (never the haystack, where
   the taught fact is supposed to appear — an early version of this guard
   wrongly fired there and had to be fixed). Ingestion cost and scored-turn
   cost are tracked separately, matching the item's ask.

   **One paid smoke run (2026-09-26, MiniMax-M3), a real finding, not just a
   mechanics check:** a synthetic 4-session haystack (one session: "I just
   adopted a beagle puppy... I named him Biscuit") ingested cleanly
   ($0.00046, 4/4 sessions) but saved **zero** memories, and the live scored
   turn — asked "what is the name of my dog?" in a fresh session — correctly
   answered that it had no information, rather than hallucinating. The
   mechanics are sound (chronological order, cost separation, no leak); the
   substance is that `extractMemories`'s production prompt is scoped to
   "durable memories from a coding session" across four types (user,
   feedback, project, reference), and on this one trial with this one model
   did not judge a personal biographical fact worth saving. LongMemEval's
   question types are general-assistant-shaped (preferences, biographical
   detail, plans), not coding-project-shaped — **running the real corpus as
   the production prompt stands today would likely measure a domain-scope
   gap, not a retrieval or consolidation failure.** This is a single trial,
   not a replicate — but it is exactly what "validate with tiny synthetic
   fixtures before running the corpus" is for. #6 was run anyway, with that
   caveat stated up front, and confirmed it at scale.
6. [x] **External evaluation.** Run 2026-09-26 as an **adapted subset, not
   an official LongMemEval score** — full method, deviations and per-sample
   detail in spec §7.4; reproduce with `pnpm bench:longmemeval`
   (`scripts/longmemeval.ts`). 24 of 500 questions, stratified over all six
   question types (seed 20260926), MiniMax-M3 as the agent. Result:
   **answerable questions 1/18, and that one was answered from world
   knowledge (a Borges quote), not memory — memory-attributable recall
   0/18**; abstention questions 5/5 (the model honestly says it has no
   record, which is the right answer there). The cause is upstream of
   retrieval: `extractMemories` kept **4 memories from 1,090 ingested
   sessions** (0.4%), so recall had nothing to find. This confirms the #5
   smoke finding at scale — the production extraction prompt is scoped to
   coding sessions, and LongMemEval's personal-assistant facts do not clear
   it. Not tuned on (the prompt was not changed to chase this number).
   Whether FreeCode's memory *should* capture this kind of fact is a product
   scope question, not a bug — it is recorded, not decided.

Completion requires both a working harness and a recorded experiment for
each question. Remove completed entries from this roadmap only after moving
their method and results into the spec, `EVAL.md`, and experiment ledger.

## Memory graph explorer (moved out of the memory-efficiency spec, 2026-09-25)

Presentation only: none of this changes what is injected or what it costs.
Measured state at audit: 79 nodes, 6 disconnected components (27/16/16/11/6/3),
68 of 75 edges are cluster memberships.

- [ ] **Layout.** Repulsion `-180`, link distance `60`, strength `0.5`, and
      `forceCenter` only translates, so components drift apart. Add gentle
      `forceX`/`forceY` attraction and size-aware component packing; make link
      distance intentional per edge type, or delete the comment claiming
      weight-dependent distance (it is not implemented).
- [ ] **Real fit-to-view.** `fitToView()` recentres and reheats but never fits
      bounds. Fit after settling and on reset, accounting for the detail
      panel; handle resize without restarting the layout.
- [ ] **Navigation.** One/two-hop local view of a selected memory, node/edge
      filters, labels by zoom/hover/selection, cluster hubs hidden by default
      with an inspect toggle, keyboard focus states.
- [ ] **Honest search labels.** Explorer search bypasses the judge, session
      carry, episode decay, and the byte budget; label results "retrieval
      candidates", not "what was injected".
- [ ] **Injection inspector.** Show a recorded request's candidates, judge
      outcome, rendered subset, and budget drops, read from recorded state
      only (opening the page must never trigger a paid judge call).

Ships via `graph-ui.tar.gz` + `freecode memory ui-install`; a source-only
change does not reach installed binaries.

## Long-running sessions (OpenHands comparison — 2026-09-01)

Found while reading the `OpenHands/OpenHands` Agent Canvas frontend (`ca4024e3a`)
for what makes its long-running sessions survivable.

### Unattended mode (blocks `autonomous/` Phase 1)

- [ ] **No configuration in which a stuck loop stops itself.**
      `effect/loop-health.ts` declares `LoopAction { continue | warn | stop }`
      and returns `warn` from all four detectors (`:38`, `:44`, `:53`, `:62`);
      `stop` is never produced. The only hard stop is `maxIterations`, which is
      `?? Infinity` outside headless (`agent/loop.ts:403`). Correct for attended
      use — see `specs/2026-08-26-trajectory-redirection.md` §1 for why eager
      `stop` was the wrong answer — but an unattended run needs a finite ceiling
      and a `stuck` terminal state distinct from `error`, so a report can say
      "stopped making progress" rather than "crashed". Do **not** copy Canvas's
      own `use-agent-state.ts:31`, which maps `STUCK → ERROR` and loses exactly
      that distinction.

- [ ] **Permission prompts cannot park.** In-band and synchronous, so an
      unattended run that hits one fails rather than waiting. OpenHands models
      this as a durable `waiting_for_confirmation` conversation status plus a
      REST endpoint to answer it later.

### Reconnect hygiene (wanted once replay is rollout-backed)

- [ ] **Replay dedupe must also suppress non-idempotent side effects**, not just
      duplicate rendering. OpenHands issue #1656 was replayed events re-firing
      error banners and cache invalidations
      (`conversation-websocket-context.tsx:553`). FreeCode inherits this hazard
      the moment replay can return events the client already processed.

- [ ] **SSE client needs capped-exponential backoff and a handshake watchdog.**
      Theirs is 1s → 2s → 4s capped at 30s with an abort for sockets stuck in
      `CONNECTING` (`use-websocket.ts:19`, `:61`). The TUI's
      `[250, 1_000, 3_000]`-then-give-up budget (`apps/tui/src/ipc/client.ts:87`)
      is right for a local child process but wrong for a network client.

## Open design questions

### `/agents (N)` counts running agents, which is almost always 1 (added 2026-09-08)

**Status:** open design question, not a bug.

`AgentTool` declares `isConcurrencySafe: false`, so `planToolBatches` puts every
`agent` call in its own batch and subagents run strictly one at a time. The
ModeLine chip counts RUNNING agents, so it reads `(1)` whenever anything is
delegated and nothing otherwise — the roster accumulates rows, the chip does
not. Three options, none obviously right:

- leave it (honest about what is running, matches the `/shells` chip);
- count agents spawned this session, so the chip matches the roster's length;
- make `agent` concurrency-safe so they genuinely run in parallel. That is the
  Claude Code behaviour, but the tool is marked `isDestructive` deliberately,
  and parallel subagents mutating one tree is what that flag guards against.
