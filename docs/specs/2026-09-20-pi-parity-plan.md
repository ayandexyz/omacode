# Pi Parity Plan

Features that exist in pi (`earendil-works/pi`, surveyed at v0.86.0) but not in
FreeCode, ranked by how much they change what the agent can do in a session.
Each phase is independently shippable and lands behind its own flag where it
touches loop behaviour. The eval rule from `CLAUDE.md` applies: anything that
changes the loop or the prompt gets an `eval ab` before its default flips.

Survey notes (what was checked, so this is not re-derived):

- Already at parity or ahead — **not in this plan**: follow-up queue (spec
  `2026-08-05-queued-messages-design.md`), context-overflow compact-and-retry
  (`agent/recovery/`), tool-output truncation + `output` tool recovery,
  429/5xx retry (`recovery/manager.ts`), Anthropic OAuth, skills, hooks,
  compaction, eval harness.
- Things pi deliberately skips that FreeCode has: subagents, MCP,
  permissions, todos, background shells. Nothing to do.

Pi reference paths are under `packages/coding-agent/src/core/` unless stated.

---

## Phase 1 — Mid-turn steering

**Built 2026-09-20.** `AgentLoop.steer()` / `drainSteers()`, `session.send` `streamingBehavior`, `message_steered` event, Alt+Enter in the TUI, `FREECODE_STEERING_MODE=all`. Tests: `agent/loop-steer.test.ts`.

### Problem

`session.send` during a running turn parks the message in the follow-up queue
(spec 2026-08-05), which is delivered only after the run ends. Its §Non-goals
line 52 explicitly excludes steering. So when the model heads down a wrong
path, the operator's only options are Esc (abort, lose the in-flight tool
work) or wait it out.

### Goal

A second queue, **steering**, delivered at the seam between one tool batch
finishing and the next model call — the model sees the correction on its very
next request without the turn being aborted. Pi: `agent/src/agent.ts`
`steeringQueue` / `followUpQueue`, `PendingMessageQueue`, modes
`"one-at-a-time" | "all"`.

### Design

**Core**

- `server.ts`: alongside `messageQueues` add `steeringQueues: Map<sessionId,
  QueuedMessage[]>`. `session.send` gains `streamingBehavior?: "steer" |
  "followUp"` (default `followUp`, preserving today's behaviour). A steer while
  no turn is running is a plain send.
- `agent/loop.ts`: at the point where drained `<system-reminder>`s are
  attached (~L1678, after tool results are appended and before
  `callProviderOnce`), drain the steering queue. Each steered message is
  **persisted as a real user message** with `SerializedMessage.synthetic:
  "steer"` — the same shape as the auto-poke message and for the same reason
  (jcode's finding: a reminder-only turn reads as an empty user message and
  the model replies to it instead of acting). Append-only, so cache anchors
  are untouched (RC8 invariant holds).
- If the tool batch that just completed would have ended the run, a pending
  steer forces one more model call (pi does the same).
- Steering is a user act, so it does not count toward the auto-poke cap and
  resets `no_progress` fingerprinting for the poked list.
- `steeringMode: "one-at-a-time" | "all"` in `settings.json` (default
  `one-at-a-time`).
- Rollout: `message.steered` with the message id only — never text.
- Subagents: a steer to a root session is not forwarded to its subagents.
  (Steering a subagent is out of scope.)

**Protocol** (`packages/shared/src/ipc/protocol.ts`)

- `session.send` params: `+ streamingBehavior?: "steer" | "followUp"`.
- `session.dequeue` also removes from the steering queue.
- `StreamEvent`: `message_queued` gains `kind: "steer" | "followUp"` so the
  TUI badge can differ.

**TUI**

- Enter while a turn is running = steer (pi's default); Alt+Enter = follow-up.
  This flips today's Enter-queues-a-follow-up behaviour — it is the change the
  phase exists for, and Alt+Enter keeps the old path one key away.
- Queued row badge reads `steering` vs `queued`.
- `harvest.ts` skips `synthetic` messages already; verify the new value.

### Verify

- `loop.test.ts`: a steer queued during a tool batch becomes the next user
  message before the next provider call; an ended run with a pending steer
  makes one more call; an empty queue changes nothing.
- `server.test.ts`: send-while-busy with `steer` routes to the steering queue.
- `eval ab` on `trajectory.jsonl` with the flag on vs off — steering is
  operator-driven so the suite cannot exercise it, but it proves no
  regression on the unsteered path.

---

## Phase 2 — Prompt-cache warmer

**Built 2026-09-20.** `providers/cache-warmer.ts` (pure economics + `CacheWarmer` + per-session registry), armed from `callProviderOnce`, idled from `complete()`/`fail()`, disposed in `end-session.ts`. Records `cache.warm`, bills the day, resets the cold-cache clock, and tells the TUI. Off by default; `cache.warming` / `FREECODE_CACHE_WARMING`. Tests: `providers/cache-warmer.test.ts`.

### Problem

FreeCode has deep cache *observability* (`providers/cache-miss.ts`, D2
detector, `docs/caching-architecture.md`) but nothing keeps a cache entry
alive while the operator is reading or typing. Anthropic short retention is 5
minutes; a pause longer than that re-writes the whole prefix.

### Goal

Port pi's `cache-warmer.ts`: after a real request, schedule a 1-output-token
replay of the same prompt at ~90% of the cache TTL, only when the expected
saving justifies it.

### Design

- `providers/cache-warmer.ts`, per session, owned by the loop's session
  runtime (starts after `model.response`, cancelled on the next real request,
  on session end, and when the model changes).
- Delay: `min(ttl * 0.9, ttl - 10s)` (pi's `getCacheWarmingDelayMs`).
  TTL comes from the model's `promptCache` tier in the catalogue; models
  without one never warm.
- Economics (pi's constants, revisit with our own usage data): send only when
  `expectedSaving = P(continuation) * (writeCost - readCost) - refreshCost`
  ≥ `$0.05`, with `P = 0.15` when idle. Stop 60 min after the last real
  request (30 min for idle mode).
- Replayability guard: Anthropic budget-based thinking derives
  `budget_tokens` from `max_tokens`, so a capped replay changes the cache key
  and the model may still think for thousands of tokens — skip unless the
  model uses adaptive thinking (pi's `isReplayable`).
- Uses `priceUsd()` from `pricing.ts` with the call's `authMode`; an
  `undefined` price means never warm.
- Rollout: `cache.warm` with `expectedSavingUsd`, `delayMs`, and the
  replay's usage — so `freecode trace` can show it and the D2 detector can
  tell a warm from a real turn.
- Settings: `cache.warming: "off" | "streaming" | "idle"` (default `off`
  until measured); `FREECODE_CACHE_WARMING`.

### Verify

- Unit: delay math, TTL lookup, replayability, economics threshold, cancel on
  real request.
- `pnpm bench:signals`-style fold of rollout logs: cache-read ratio and USD
  per session with warming on vs off across ≥10 real sessions before
  flipping the default.

---

## Phase 3 — Session tree and branch summarization (`/tree`)

**Built 2026-09-20.** Deviations from the design below, all deliberate:
- `parentId` is written on a line **only when it differs from the previous line** (the first append after a navigate), so a session that never branches is byte-identical to today's log and needs no migration. The leaf pointer is `meta.leafId`, set only while the leaf is not the last line.
- `getMessages()` returns the active path, so every existing reader (loop, compaction, harvest, fork, resume) got the tree for free; `getTree()` is the new all-branches view.
- Compaction (`replaceMessages`) still trims the log to the preserved tail — other branches are dropped with it. Pi keeps everything; we do not, because the compaction summary lives in `MemoryService`, not the log.
- The branch summary is a `synthetic: "branch_summary"` user message (compaction summarizer, heuristic fallback, `FREECODE_BRANCH_SUMMARY=heuristic` for tests). `MemoryService.resetTranscript()` rebuilds the compaction transcript from the new path.
- `session.navigate` refuses while a turn is running; the TUI stops the turn first. `/fork` = new session from the active path (`session.fork`); `/clone` was not added — it is the same operation.
- TUI `/tree` is a `SearchableSelectList` (newest first, ● active / ○ abandoned, tools and ★ labels shown); fold/unfold and the filter modes are not built. Labels have an IPC (`session.label`) but no TUI key yet.
Tests: `session/store-tree.test.ts`, `session/navigate.test.ts`.

### Problem

Sessions are linear. `session.fork` copies a session into a new one; there
is no way to jump back to an earlier point *in place*, continue from there,
and keep the abandoned branch's knowledge.

### Goal

Pi's `/tree`: every entry has `id` + `parentId`; navigation moves the active
leaf; switching away from a branch writes a `branch_summary` entry so the
work done there survives as context. Pi: `session-manager.ts`,
`compaction/branch-summarization.ts`, `docs/session-format.md`.

### Design

- `session/store.ts`: `SerializedMessage` gains `parentId`. Existing sessions
  are linear chains (migration is `parentId = previous.id`). "Active path" =
  walk from the leaf pointer to the root. All readers that today take
  `messages[]` take `activePath()` instead — `history.ts`, `compact-apply.ts`,
  `harvest.ts`, `replay.ts`.
- Leaf pointer is a store-level field (`leafId`), persisted atomically with
  the append.
- New IPC: `session.tree` (returns `{id, parentId, role, preview,
  timestamp, label?}` per entry — never full content), `session.navigate({
  entryId, summarize: boolean })`, `session.label({ entryId, label })`.
- Branch summarization: on `navigate` with `summarize`, run the compaction
  summarizer over the abandoned path (entries after the common ancestor)
  and append a `branch_summary` message under the new leaf. Reuses
  `compaction/summarizer.ts`; goes through `PreCompact`/`PostCompact` hooks
  like any summary. Same cut-point rule as compaction: never split a tool
  call from its result.
- Navigation while a turn is running cancels the turn first; refused while
  compaction is running.
- Compaction on a tree: `firstKeptEntryId` semantics from pi — summarize
  from the previous kept boundary on the *active path*.
- Rollout: `session.navigate` with `from`, `to`, `summarized: boolean`.
- TUI: `/tree` panel (searchable list, fold/unfold, filter modes
  default → no-tools → user-only → labeled-only → all, Ctrl+X copy,
  Shift+L label). Enter swaps the panel into the message list's slot the
  way `/agents` does.
- `/fork` and `/clone` become thin wrappers: fork = new session from an
  entry, clone = new session from the current active path.

### Verify

- Store tests: linear migration, append under a non-tip leaf, activePath,
  navigate + summarize produces exactly one `branch_summary`.
- `compaction/service.test.ts`: compaction over a branched history.
- The `compaction-boundary` eval still passes (it walks the active path).

---

## Phase 4 — Fuzzy edit matching + per-file mutation queue

**Built 2026-09-20** (`unicodeNormalizedReplacer` in `tools/edit.ts`). The mutation queue was not needed: `edit`/`write` are `isConcurrencySafe: false`, so the batcher already serializes them.

### Problem

`tools/edit.ts` has whitespace-collapsed and indentation-flexible replacers,
but not Unicode normalization: a model that emits `’` for `'` or `—` for
`--` fails the edit and enters a retry loop.

### Design

- Add a replacer after `indentationFlexibleReplacer`: NFKC + smart quote/dash
  → ASCII + trailing-whitespace strip, matched in normalized space and
  **mapped back to original offsets** so untouched lines are byte-identical
  (pi's `edit-diff.ts` `fuzzyFindText` + `applyToOriginal`). Report
  `fuzzy: true` in the result so the trace shows it.
- Serialize mutations per realpath (pi's `file-mutation-queue.ts`) in
  `tools/batching.ts` — check first whether the batcher already refuses to
  run two edits on the same file in one parallel batch; if it does, only the
  cross-batch case needs the queue.

### Verify

- `edit.test.ts`: curly-quote and em-dash inputs match, replacement leaves
  neighbouring lines untouched, ambiguous fuzzy matches still fail closed.
- `pnpm bench:jcode` before/after — edit-retry count per task is already
  folded there.

---

## Phase 5 — In-process TypeScript extensions

**Built 2026-09-20** (smaller than the outline, deliberately): `extensions/` — `loader.ts` discovers `~/.freecode/extensions/*.{ts,js,mjs}` always and `<project>/.freecode/extensions/` only when the project is in `extensions.trustedProjects` (`~/.freecode/settings.json`) or `FREECODE_TRUST_PROJECT_EXTENSIONS=1`; plain `import()` (tsx and bun both take .ts), no jiti. `ExtensionAPI`: `registerTool` (goes through `buildTool`, a `readOnly: true` claim reaches mode policy via `claimToolReadOnly`, built-in names cannot be shadowed), `registerCommand` (prompt command, same precedence as built-ins), `on(event, handler, {matcher})` (callback hook, source `"plugin"`), `log`. Every registration is tracked per file and undone on reload or on a throwing factory. IPC `extensions.list` / `extensions.reload`; TUI `/extensions`, `/reload` (re-registers prompt commands too). `FREECODE_DISABLE_EXTENSIONS=1` skips loading. Not built: `registerProvider`, extension UI. Example: `docs/examples/extensions/hello.ts`. Tests: `extensions/loader.test.ts`.

### Problem

Adding a tool or a slash command means editing core. Hooks are shell
executors; skills are prompts; MCP is out-of-process.

### Design (outline — its own spec before building)

- `extensions/` loader over `~/.freecode/extensions/*.ts` and
  `.freecode/extensions/*.ts`, loaded with `jiti` (pi's
  `extensions/jiti-loader.ts`).
- `ExtensionAPI`: `registerTool` (goes through `buildTool` and the
  registration checklist in `CLAUDE.md` — mode policy, path/url tools,
  display names — automatically), `registerCommand`, `on(event)` mapped onto
  the existing hooks bus, `registerProvider` onto `catalogue.ts` `OVERRIDES`.
- Project extensions need the trust decision pi gates on
  (`project-trust.ts`); untrusted projects load only user-level extensions.
- `/reload`.
- No UI hooks in the first cut — the TUI stays a thin client, so extension
  UI would need an IPC surface that does not exist yet.

---

## Phase 6 — Ergonomics (each is a day or less)

| Item | Pi ref | Note |
|------|--------|------|
| `!cmd` runs a shell command and sends output to the model; `!!cmd` runs without sending | `agent-session.ts` BashExecution message | Persisted as its own message role so compaction can cut at it |

**`!cmd` reworked 2026-10-10.** The first cut sent the output as a prompt, which
started a turn — unlike pi and Claude Code, where it is only context for the
user's next message. Now `session.bash` (core, `session/user-bash.ts`) runs the
command in the session's project and persists the result as a
`synthetic: "user_bash"` user message plus a compaction-transcript entry; no
turn starts. Mid-turn results are held and written when the turn ends, before
a queued follow-up loads history. Model-facing text keeps the last 20K chars.
`!!cmd` runs through the same method and records nothing.
| Ctrl+G opens `$VISUAL`/`$EDITOR` on the prompt buffer | `tui` editor | TUI-only |
| Prompt templates `~/.freecode/prompts/*.md`, `{{args}}`, expand as `/name` | `prompt-templates.ts` | Loader next to skills; a template is a prompt, a skill is a capability |
| `/share` (gist + HTML export), `/bug` | `session-export.ts`, `export-html/`, `bug-report.ts` | Export must strip secrets the way OTLP export does |
| `AGENTS.override.md`, `SYSTEM.md`, `APPEND_SYSTEM.md` | `system-prompt.ts` | Prompt change ⇒ `eval ab` |

---

## Order and gating

1. Phase 1 (steering) — changes every session, small diff, seam exists.
2. Phase 4 (fuzzy edit) — small, deterministic, measurable on `bench:jcode`.
3. Phase 2 (cache warmer) — off by default until the rollout fold shows the
   saving.
4. Phase 3 (tree) — largest change; touches the store, every history reader,
   and the TUI. Own branch off this one.
5. Phase 6 items as filler.
6. Phase 5 — own spec first.

Each phase gets its own PR off `feat/pi-parity`; this doc is updated with a
"built YYYY-MM-DD" line per phase as they land, and `CLAUDE.md`'s spec table
gets a row once Phase 1 merges.
