# FreeCode Roadmap

Features and redesigns that are **not built and not debt** — each needs a spec
(or at least a decision) before code. Grows over time; that is fine. Bugs and
dead code live in `TODO.md`; recorded design decisions live in
`docs/DECISIONS.md`. Things ship from here as minors after 1.0.


## Extensibility

What a user can extend without editing FreeCode's source. Covered today: MCP servers,
skills (incl. `~/.claude/plugins` scope), permission rules via `.freecode/settings.json`,
and `CLAUDE.md`/`AGENTS.md` instructions. Ranked by value per line of work.


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

**Suggested order:** 4 first. Item 5 is a larger, self-contained project.

## Subagent permission profiles (added 2026-09-08)

User-defined subagents (Extensibility item 3) shipped without these: a definition restricts a subagent with its mode (explore/build) plus a tool allowlist, not a capability profile. The dead-code half of this (`PROFILES`, `PermissionChecker`, duplicate `PermissionProfile` interface) is also tracked under Tool system in `TODO.md`.


**Status:** partly mitigated. Item 3 shipped a per-definition tool allowlist (spec `2026-09-27-agent-control-and-definitions.md` §2.4), which narrows a writing subagent's tools; path and network scoping are still missing.

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
authority of its parent: no path scoping and no network restriction. A definition's
`tools:` allowlist can now narrow which tools it has, but not where they reach.
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

### Unattended mode (no longer blocking — `freecode night` shipped around both)

`docs/specs/2026-09-28-overnight-runs.md` is built (Phases 0–5, 2026-09-28) and
answered both items for night runs without building them as written: per-iteration
turn/time caps plus reset-on-failure bound a stuck loop (an iteration that stalls
fails as `turn_cap` / `stuck` / `timeout`, distinct from `provider`/`auth`), and the
permission envelope decides asks instead of parking them. The items below remain
open only for a *general* unattended mode outside `freecode night` — e.g. a
headless `freecode run` that should stop itself or park a prompt.

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

## Codemode (pi parity — added 2026-10-05)

- [ ] **Codemode tool** — the model writes a JavaScript script that calls tools in a
      QuickJS sandbox; only the script's output reaches the transcript. Nested calls
      must go through `AgentLoop.executeTool()` so permissions, hooks and the night
      envelope still apply. Off by default until `eval ab` shows a cost-per-passed-task
      saving. Spec `docs/specs/2026-10-05-codemode.md` (Phases 0–3).
