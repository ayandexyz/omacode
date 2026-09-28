# FreeCode TODOs

Debt only: bugs, dead code, stale docs, uncalibrated numbers. **This file is
meant to shrink** — the "Real fixes" here are what must reach zero before
1.0.0. Verify each entry against the code before fixing (several audit
sections predate the provider refactor); delete an entry, and its twin in the
docs page's *Known gaps*, in the same PR that fixes it.

Not here: unbuilt features → `ROADMAP.md`; deliberate behaviour that must not
be "fixed" → `docs/DECISIONS.md`.


## Small known limitations

### `freecode eval` does not exit after printing its results (found 2026-09-24)

**Status:** confirmed, wastes wall-clock only, not money. Pre-dates the
checkpoints branch.

A `pnpm eval trajectory --trials 1` run printed `25/25 cases passed` and its
cost summary, then sat for **18 minutes** without exiting, until killed. During
the stall the process was idle in `do_epoll_wait` — 25s of CPU across 22
minutes, **no open TCP sockets**, no child `git`. So it is not a provider call
(and the 300s header timeout would have fired three times over); it is a
non-daemon handle keeping the event loop alive after the suite is done.

Prime suspect is the MCP stdio client. The run spawns `npm exec
@agentmemory/mcp` — imported from Claude Code's config by
`mcp/claude-code-config.ts` — and that child was still alive, idle, with 0s of
CPU. Nothing in the eval path appears to call a shutdown/`close()` on the MCP
clients when a suite finishes.

Why it matters beyond patience: `.github/workflows/eval.yml` runs `trajectory
--gate` nightly. A job that never exits burns the runner's whole timeout and
reports as a timeout failure, not as the green run it actually was.

**Cause: confirmed 2026-09-24.** `FREECODE_MCP_CLAUDE_CODE=0 pnpm eval:gate`
ran all three suites to completion. Without it the `&&` chain cannot advance
past the first suite at all, because the chain only proceeds when trajectory
*exits* — so this bug does not merely delay `eval:gate`, it prevents coding and
judged from ever running.

Fix: close the MCP clients when a suite finishes (or open them lazily, since
no eval case uses an MCP tool). Reproduce with `pnpm eval trajectory --trials
1` and Claude Code MCP servers present in `~/.claude.json`.


### The compaction eval case is a 20KB JSONL line (added 2026-09-08)

**Status:** known, cosmetic, needs a paid run to fix.

`compaction-survives-multi-file-edit` is 20,339 characters on one line; every
other case in `evals/coding.jsonl` is 743-921. The spec chose JSONL because it
is "diffable, appendable, one case per line", and a 20KB line is not diffable —
any future edit to that case renders as one unreadable changed line.

The six padded fixture modules are what make it big, and they may now be larger
than they need to be: the padding was sized to grow the transcript, before the
calibration runs showed that growth is not what gates compaction (user-turn
count is). They still have to clear the 16,000-token threshold — the base
request measured ~12.5k WITH the padding — so shrinking them means either a
smaller threshold or fewer modules, and either way one more calibration run
(~$0.025) to confirm it still compacts 3/3. Not worth doing on its own; worth
folding into the next change that touches the case.

### Settled background shells are retained until dismissed (added 2026-09-08)

**Status:** known, bounded, low priority.

`ShellRegistry` caps *running* shells at `MAX_SHELLS_PER_SESSION` (16) but does
not cap settled ones — a completed shell keeps its record and up to
`SHELL_BUFFER_CHARS` (256k) of output until the user presses `d` in `/shells`
or the session ends. A long session that backgrounds many short commands
therefore creeps: ~0.5 MB per settled shell, worst case. Deliberate for now —
keeping the output is the point, and `d` plus session teardown both free it —
but if it bites, evict the oldest settled shells past a retention count in
`ShellRegistry.start()`. Do NOT evict running ones: nothing else holds a handle
that can kill the process (same reason `remove()` refuses a running shell).

### `@` mention fallback ignores .gitignore

**Status:** Known limitation of the fd-less path (added 2026-09-01)

`apps/tui/src/utils/file-search.ts` stands in for fd when fd isn't installed (the normal
case on Windows — see `at-mention-provider.ts`). fd respects `.gitignore`; the walker only
skips a hardcoded `SKIP_DIRS` list, so ignored-but-not-listed paths (build output under an
unusual name, `.claude/worktrees/`, generated fixtures) still show up in `@` suggestions.
Fix by parsing the nearest `.gitignore` files, or by shipping fd the way
`hooks/builtin/rtk-installer.ts` ships rtk. Neither is worth doing until someone complains.

Related, same Windows-parity batch: `readImageOnWindows()` in `apps/tui/src/utils/clipboard.ts`
goes through `Clipboard.GetImage()`, which reads the DIB clipboard format and therefore
drops alpha — a screenshot is fine, a copied transparent PNG comes back matted. Apps like
Chrome and the Snipping Tool also publish a `PNG` clipboard format; preferring
`GetDataObject().GetData('PNG')` when present would preserve the original bytes.

## Docs-audit findings (memory, sessions, knowledge graph — 2026-08-23)

Found while writing `apps/docs/app/internals/{memory,sessions,knowledge-graph}`.
Each is also listed in that page's **Known gaps** section. Deliberate behaviour from this audit is in `docs/DECISIONS.md`.

### Real fixes

- [ ] **`Contradicts` edges are never produced** — the kind, its zero weight, and
      the cascade skip are implemented and tested (`graph-types.ts:17`,
      `cascade.ts:59`), but nothing detects that two memories disagree. Contradiction
      handling is `supersedes:` only, which requires the writer to already know.
- [ ] **VectorStore rewrites everything on every write** — `put()`/`remove()` call
      `persist()`, re-serializing all vectors + both files (`vector-store.ts:181`).
      ~768 KB rewritten per save at 500 memories.
- [ ] **VectorStore lookups are linear scans** — `hasFresh`/`has`/`remove` `find()`
      over the array (`vector-store.ts:129`), and `syncVectors()` calls them per
      entry → O(n²) per full sync. Add an id→index `Map`.
- [ ] **Cluster ids are positional** — adding one memory can renumber every
      cluster (`clusters.ts:139`), so cluster identity doesn't survive a rebuild and
      anything the explorer persists about one is meaningless afterwards.
- [ ] **`nodeDetailForExplorer` is O(nodes + edges) per click** —
      rebuilds a node map and scans all edges per request (`graph/index.ts:394`).
- [ ] **Dangling wikilinks are invisible** — skipped correctly (`builder.ts:78`),
      but a typo'd `[[link]]` never surfaces anywhere. The explorer should list
      unresolved links.
- [ ] **`compact.occurred` under-reports what compaction did** — it records
      `MemoryService`'s ESTIMATED transcript sizes, while the real trim is
      `keepLastNUserTurns` over the session store. Measured on the new
      `compaction-boundary` eval case: the event says 872 → 748 tokens for a
      request that measured 16K. So `freecode trace` and the harness's
      `Trace.compactedTokens` understate compaction by an order of magnitude.
      `ApplyCompactionResult` already carries `messagesBefore`/`messagesAfter`
      and neither is recorded — record those, and the measured count alongside
      the estimate.
- [ ] **Dead export: `renderPromptMemoryContext()`** (`selector.ts:64`) —
      referenced only by `loop.ts` comments explaining why it must not be used.
- [ ] **`getContextLimit(model)` ignores its argument** (`tokens.ts:20`) and
      returns the constant floor. Rename or drop the parameter.
- [ ] **Blocked-compaction retry threshold is hardcoded** — fixed 5,000 tokens
      (`service.ts:34`, flagged `ponytail` in-code); make it a `CompactionConfig`
      field if a hook ever needs tighter control.
- [ ] **`METHODS` declares 24 of 49 implemented IPC methods** — all of `memory.*`,
      `config.*`, `models.*`, and `session.{fork,switch,archive,delete,export,
      import,upload,download,getInterrupted}` exist in `server.ts` but not in
      `packages/shared/src/ipc/protocol.ts`. Frontends calling them get zero
      compile-time checking, which is the entire purpose of that map.
      (`CLAUDE.md` describes it as the source of truth — it isn't yet.)
- [ ] **`METHODS["session.send"]` is wrong** — declares
      `StreamResponse | { queued, id }` as the result; the handler resolves a
      `LoopResult` (`agent/types.ts:309`). Declared params also omit `model` and
      `agentMode`, both read by the handler (`server.ts:376`).
- [ ] **No `-32602` invalid-params validation** — every handler does
      `params as { … }` with no runtime check, so a missing or mistyped field
      becomes `undefined` deep inside and surfaces as a confusing `-32603`.
      A one-line guard per handler (or a shared validator keyed off `METHODS`)
      would move the failure to the boundary where it belongs.
- [ ] **TUI client can only stream one session at a time** — single
      `activeStreamId` + single `onStreamEvent` slot (`apps/tui/src/ipc/client.ts:46`),
      even though `bus/bridge.ts` stamps `sessionId` specifically to allow
      multiplexing. Blocks any multi-session UI over one core process.

        One thing I checked and didn't report as a bug: manual /compact builds its own MemoryService separate from the loop's. That would be a divergence risk,
  except a fresh loop (and service) is constructed per turn at server.ts:199 and reloads state from disk, so they stay consistent.

## Docs-audit findings (reference: CLI, settings, env, IPC, hooks — 2026-08-23)

Found while writing `apps/docs/app/reference/{cli,settings,env,ipc-methods,hook-events}`.
Each is also listed in that page's **Known gaps**. IPC items already covered by the
earlier audit are not repeated here.

### Real fixes

- [ ] **`settings.json` has three loaders and three different merge rules.**
      `permissions` concatenates both scopes, `hooks` override by `event + name`,
      `memory` takes the first definition (project → user → default). Nothing states
      the difference and `/getting-started/configuration` claims a single "project
      wins" rule that only holds for hooks. One loader that parses the file once and
      hands each subsystem its section would make one answer true.
- [ ] **`FREECODE_HOME` is read in exactly one place** — the updater's
      `builds/stable/freecode` lookup (`apps/tui/src/entry.ts:101`). Every data path
      (`config.json`, `sessions/`, `projects/`, `rollout/`, `history.jsonl`) builds
      from `os.homedir()` directly, so setting it produces a half-relocated install.
      Honour it through one `freecodeHome()` helper, or rename it.
- [ ] **Six env vars need a process restart and nothing says so** —
      `FREECODE_TOOL_RESULT_BUDGET_CHARS` (`loop.ts:152`) and the five
      `FREECODE_OUTPUT_*` values (`tools/output-store/config.ts`) are module-load
      consts, while the compaction and cache vars are deliberately read per call.
- [ ] **`graph.explore` breaks the memory naming convention** and hard-codes
      `process.cwd()` while every neighbouring `memory.*` method takes `projectPath`.
- [ ] **MCP servers are user-scope only.** `getConfigDir()` is hard-wired to
      `~/.freecode` (`cli/utils/config.ts`), so a repository cannot ship the MCP
      servers its contributors need the way it can ship rules and hooks.
- [ ] **`freecode session` exposes 2 of 12 session operations.** `fork`, `switch`,
      `archive`, `export`, `import`, `upload`, `download` are IPC-only, so scripting
      session management means speaking JSON-RPC by hand.
- [ ] **No way to print effective configuration.** Diagnosing "why is it compacting
      so early" means reading source. A `freecode config env` dumping
      name / default / effective / source would pay for itself.

## Docs-audit findings (agent loop — 2026-08-23)

Found while writing `apps/docs/app/internals/agent-loop`. Each is also listed in
that page's **Known gaps**.

### Real fixes

- [ ] **A loop-health `warn` still reaches nobody by default.** The signal is now trustworthy,
      but every `warn` goes to `logger.debug` (`loop.ts:737`) — invisible at the
      default log level and never shown to the model, so nothing acts on a stuck
      pattern until it doubles into a `stop`. Phase 1 of
      `specs/2026-08-26-trajectory-redirection.md`.
- [ ] **The spend circuit breaker is off by default** (`loop.ts:812`,
      `compaction/tokens.ts:105`). `FREECODE_MAX_TURN_TOKENS` is unset unless the
      user sets it, so nothing caps actual spend. `freecode run` now has
      `--max-turns` for a turn cap, but nothing caps tokens by default, and
      loop-health only *warns* on the stuck patterns most likely to burn quota
      (stagnation never stops at all). Consider a default ceiling for headless
      runs.

## Docs-audit findings (provider layer — 2026-08-23)

Found while writing `apps/docs/app/internals/providers`. Each is also listed in
that page's **Known gaps**.

### Real fixes

- [ ] **`getProvider()` builds a fresh SDK client per call and reads config from
      disk each time.** `registry.ts:24` calls `def.create("")` on every lookup;
      each adapter's factory calls `getApiKey()`, which does a synchronous
      `readFileSync` + `JSON.parse` of `~/.freecode/config.json`. That is a
      blocking disk read at least once per turn (`callProviderOnce`) plus once per
      compaction (`compactOptions`). Memoize per provider id, invalidating when
      config changes.
- [ ] **`summarizeCache`'s hit ratio is both wrong and unused.**
      `read / (read + inputTokens)` (`cache-awareness.ts:71`) treats `inputTokens`
      as the fresh portion, but `NormalizedUsage.inputTokens` is inclusive of
      cache reads and writes — so reads are double-counted in the denominator.
      Nothing outside `cache-awareness.test.ts:38` reads `hitRatio` (the loop
      destructures only `readTokens`/`writeTokens`), and the test asserts the old
      non-inclusive semantics. Either fix to
      `read / (read + nonCachedInputTokens + write)` and use it, or delete it.
- [ ] **A total cache failure is invisible to the miss detector.**
      `emitCacheWarm` returns before `checkCacheHealth` when reads and writes are
      both zero (`loop.ts:1910`), and `checkCacheUsage`'s `!reportsCache` branch
      would bail anyway (`cache-miss.ts:82`) — so `expected_read_missing` is
      reachable only when a write happened. "Caching stopped entirely" is the case
      most worth alarming on.
- [ ] **Only `anthropic` is treated as a caching provider for the cold warning.**
      `CACHING_PROVIDERS` (`cache-awareness.ts:24`) is a one-element set, but
      `minimax` and `zai` use the same Anthropic endpoint shape and carry the same
      `cacheControl` markers, so their users never see the cold-cache warning.
- [ ] **A changing tool set busts the prompt cache with nothing in the
      journal.** `invalidateToolDefs()` (`tools/defs-cache.ts:49`) fires on
      `tools.changed` / `mcp.tools.changed`; the tools array sits inside the
      cached prefix, so the next request necessarily misses. No
      `recordInvalidation` call, so the detector reports an unexplained bust —
      the false positive the journal exists to prevent.
- [ ] **`ProviderRegistryTag` has no consumer.** Defined at
      `effect/context.ts:60` and wired into both live and test layers
      (`effect/layers.ts:68`, `:182`), but nothing resolves it — the loop calls
      `getProvider()` directly, so the seam that would let a test swap providers
      is inert.
- [ ] **`ProviderDefinition.create(apiKey)` ignores its argument.** All six
      adapters take `_apiKey` and call `getApiKey()` themselves; `getProvider`
      passes `""`. Drop the parameter or actually thread the key through it.
- [ ] **`ExecuteResult.thinking` is dead for every provider.** All six set
      `thinking: undefined` in `execute()`; reasoning reaches the loop only as
      `thinking_delta` on the streaming path, so a non-streaming turn loses
      extended thinking silently. Related: there is no thinking-budget or
      reasoning-effort field anywhere in `ExecuteOptions`.
- [ ] **`ProviderInfo.maxOutputTokens`'s doc comment is stale** (`types.ts:10`).
      It says compaction subtracts it; compaction subtracts
      `resolveMaxOutputTokens()` (models.dev ∧ `OUTPUT_TOKEN_CAP`). The field is
      only a fallback for callers that omit `maxTokens`, and it is 4096 for four
      of the six providers.
- [ ] **`session/normalize/` is unreachable dead code.** The v4 spec describes a
      `ProviderResponseNormalizer` layer with per-provider modules; nothing
      imports it. Real normalization is `streaming.ts` + `mapUsage`. It also holds
      a second `[TOOL_CALLS]` parser duplicating `loop.ts:1959`.
- [ ] **`browser/` has zero importers.** `CLAUDE.md` calls the Playwright path
      "legacy / not wired into the primary path"; it is actually unreachable — no
      file outside the directory imports it, and `chatgpt` is not registered.
      Decide: delete it, or wire it behind a flag and say so.

## Docs-audit findings (tool system — 2026-08-23)

Found while writing `apps/docs/app/internals/tools`. Each is also listed in that
page's **Known gaps**.

### Real fixes

- [ ] **Four `Tool` metadata fields have zero readers.**
      `behavior.maxResultSizeChars` (set by every tool and by MCP; truncation
      actually uses the global 30K `adaptiveTruncate` budget),
      `behavior.interruptBehavior`, `permissions.operations`, and
      `permissions.requiresApproval` — `bash.ts:290` sets the last to `true` and
      nothing consults it. Either wire them or delete them; right now they read as
      a working permission model that isn't.
- [ ] **`getPath` and `isSearchOrReadCommand` are implemented widely and read
      nowhere.** `getPath` is shadowed by `extractTarget` + `PATH_TOOLS`
      (`permission/rules.ts`), which is what `CLAUDE.md`'s registration checklist
      tells contributors to update — two independent answers to "which path does
      this tool touch", one of them live. `isSearchOrReadCommand` has no consumer
      at all.
- [ ] **`checkPermissions` has no implementers.** The orchestrator calls it when
      present (`orchestrator.ts:107`); no tool defines it.
- [ ] **Permission profiles are unreachable.** `createToolOrchestrator()` is
      called with no arguments at all three production sites (`loop.ts:331`,
      `effect/layers.ts:63`, `:179`), so `permissionProfile` is always `undefined`
      and the `isToolAllowed` branch (`orchestrator.ts:145`, `:286`) never runs.
      `CLAUDE.md` says profiles are "used for subagents" — they are used nowhere.
      Either pass a profile when spawning a subagent or drop `profiles.ts`.
- [ ] **`executeTool` in `factory.ts:88` is dead code**, exported and re-exported
      from `tools/index.ts` but called by nothing; it also implements a different
      result contract from the orchestrator's.
- [ ] **`tool_complete` streams the full untruncated output over IPC.** The
      event carries `result.stdout` (`loop.ts:2280`), correct for rendering but
      uncapped — a 10 MB `bash` result crosses the boundary in one message.
      Consider a display cap with a "show more" fetch, mirroring the `output`
      tool.
- [ ] **`read`'s image path pays before the visibility check.** The tool
      base64-encodes any supported image up to 10 MB and returns it as
      `metadata.image`; whether the model can see images is only decided later in
      the loop (`loop.ts:1525`). A text-only model pays the full read and gets a
      "not sent" notice. Push `modelSupportsImages` into the tool, or pass the
      capability through `ToolContext`.

## Docs-audit findings (getting started — 2026-08-23)

Found while writing `apps/docs/app/getting-started` (installation, quickstart,
providers, configuration). Each is also listed in that page's **Known gaps**.
Items already tracked elsewhere (`providers.list` returning models.dev's whole
catalogue, the `gemini`/`google` id mismatch, hooks not loading under
`freecode run`, MCP being user-scope only, root-only instruction files) are cited
on the pages but not repeated here.

### Real fixes

- [ ] **Nothing reports which source an API key came from.** The environment
      now overrides the stored key (fixed 2026-09-05), but when both are set
      nothing surfaces which one a request used — a wrong-key 401 still means
      checking both by hand.
- [ ] **`freecode uninstall` ignores the variables the installer honours.** The
      handler hard-codes `~/.freecode` plus four Unix bin paths
      (`cli/commands/uninstall.ts:44`), while `install.sh` supports
      `FREECODE_HOME` and `FREECODE_INSTALL_DIR` and `install.ps1` installs the
      launcher to `%LOCALAPPDATA%\freecode\bin`. On Windows the command reports
      success while leaving the binary on PATH.
- [ ] **Nothing removes the PATH lines the installer appended.** `install.sh`
      writes an `export PATH=…` block into `~/.zshenv`, `~/.bashrc`,
      `~/.profile`, fish's `config.fish`, and any existing `~/.zshrc` /
      `~/.zprofile` / `~/.bash_profile`; uninstalling leaves every one of them
      pointing at a directory that no longer exists.

## Docs-audit findings (context engine — 2026-08-23)

Found while writing `apps/docs/app/internals/context`. Each is also listed in
that page's **Known gaps**.

### Real fixes

- [ ] **`collector.ts` + `context/types.ts` + `context/strategies/` are
      unreachable.** `collectContext()` resolves a strategy from a registry that
      only `createDefaultStrategies()` fills, and that function has no callers — so
      the lookup would fail even if something invoked it. Nothing does:
      `AgentLoop.collectContext` (`loop.ts:2295`) is a private method calling
      `getFrozenSessionContext`. Delete the trio, or wire it and drop `tree-cache`'s
      parallel implementation.
- [ ] **`FileTreeStrategy` implements the design the project explicitly
      rejected** — depth-3 walk reading the **full contents of every file** into
      `files` (`strategies/file-tree.ts:90`), i.e. the "collect files then send
      them" pre-pass the single-agentic-loop architecture exists to avoid. Dead,
      but 126 lines of dead code that reads like the intended design. It also
      builds keys with `path.relative(process.cwd(), …)` instead of the project
      path.
- [ ] **`ProjectContext` is declared twice with different fields** —
      `context/types.ts:5` (dead: `{ projectPath, name, tree, files, metadata }`)
      and `context/tree-cache.ts:14` (live: `{ name, projectPath, tree, gitHead }`).
- [ ] **`invalidateSymbolCache` has no callers** (`repo-map/index.ts:196`). The
      whole-project symbol cache relies on git HEAD + a 5-minute TTL, so
      uncommitted edits inside that window return stale `workspaceSymbol` results.
      The tree-watcher already detects the relevant changes and could call it.
- [ ] **`compileDynamicContext`'s `memoryContext` and `ignorePatterns` are
      permanently dead parameters** (`compiler.ts:185`). Both are always passed
      empty by the only caller. `memoryContext` is load-bearing in reverse — the
      comment explaining why it must never be used is the real documentation — so
      keep the comment, drop the parameter.
- [ ] **The prompt's "file tree" is a single non-recursive `readdirSync` of the
      project root** (`tree-cache.ts:29`). That is a defensible floor, but the word
      "tree" in `CLAUDE.md`, in the compiler's own output header, and in the docs
      oversells it. Rename it, or make the depth a knob.

## Eval quarantine hygiene (2026-09-20)

From releasing `todowrite-for-multistep` and `review-mode-readonly` from
`evals/quarantine.txt` (10/10 recent trials each; gate opened on the confirm run).

- [ ] **Infra trials are not flagged on the outcome scorer.** `TrialResult.infra`
      (2026-09-20) excludes provider errors / stalls / hangs from `majority()`
      on the trajectory suite; `scorers/outcome.ts` only fails on `verify`, so a
      `coding` case whose model call died still counts as an agent failure.
- [ ] Three cases remain quarantined and are all deterministic M3 gaps, not
      flakes: `frustrated-user-wants-one-line` (0/10), `ask-when-the-answer-is-
      off-repo` (1/10), `greeting-uses-no-tools` (3/10, one 25-turn session on
      `hi`). The first two share a cause (M3 answers from memory instead of
      reaching for a tool). A fix is a prompt change measured by `eval ab`.

## Harness signals — uncalibrated numbers (2026-09-22)

From refreshing `apps/web/app/data/harness/signals.json` (5,313 sessions; the
published file had been a stale 30-day / 8-session window that showed zeros
everywhere). Two fold bugs were fixed in the same pass — spike flags never
resolved because `todo.signal` is recorded after the `function.call` it diffed,
and `aggregate` discarded the recorded spike tally in favour of an
assigned→completed recompute that counts a legitimate 50→70→95 climb as a
spike. What is left is measurement, not code:

- [ ] **`/bench` shows the gate making auto-poke's headline metric worse.**
      Ended-open is 58/106 (54.7%) with the gate on vs 144/276 (52.2%) off. The
      106 gate-on sessions are recent bench/eval runs on longer tasks, not a
      matched sample, so this is almost certainly confounding — but the page
      states it flat. Either split bench sessions out of the fold, or label the
      arms as unmatched. The honest answer needs an `eval ab`, per EVAL.md.
- [ ] **The spike rate mixes two eras.** `confidence.spikes.n` can only count
      sessions recorded after the signals code landed (2026-09-12), while
      `confidence.n` (370 trajectories) reaches back to 07-27. So 11/370 is not
      a rate of anything. Either scope the denominator to sessions that could
      have emitted a `todo.signal`, or report the two windows separately.
- [ ] **The hill-climb headline is not on jcode's axis.** We publish
      first-rating-per-item (mean 87.56, 36.3% below the gate); jcode publishes
      every submission (mean 91.29, 18.0%). On their axis we are at 91.67 /
      21.2% — a tie, not the loss the page implies. Publish both, and say which
      is which. (`fold.ts` builds the histogram from `hillClimbFirst`;
      HARNESS-BENCH.md §3 still claims "re-ratings count again".)
- [ ] **71 of 740 rated items got their first confidence number on the call
      that completed them** — a claim with no prior assessment, which the fold's
      own comment calls the number jcode trusts least. Nothing acts on it.

## Spec findings (eval harness — 2026-08-23)

From writing `docs/specs/2026-08-23-eval-harness.md`. Details in that
spec's §12; these are the parts that are actionable independently of it.

### Real fixes

- [ ] **There is no cost accounting in USD anywhere.** `usage/tracker.ts` records
      tokens and `usage.get` serves them, but a price table exists in exactly one
      file — `providers/minimax.ts`. A shared `providers/pricing.ts` keyed by
      `provider/model` would give `freecode trace`, `usage.get`, and the eval
      harness's efficiency scorer a real number. Without it, "this change made
      every turn 18% more expensive" is undetectable.
- [ ] **OTLP export has no session-level root span** (`rollout/otlp.ts`). Model
      spans are emitted per call, so a multi-turn session renders in Langfuse as N
      unrelated LLM calls. An `invoke_agent` root span plus
      `gen_ai.conversation.id = sessionId` makes it one tree. Cheap — both are
      attribute additions in a file that already builds spans by hand.
- [ ] **Two specs promise a verifier that does not exist.**
      `2026-08-10-autonomous-runs-design.md` says the "verifier/evaluator decides
      completion when configured gates" are set, and
      `2026-08-08-continual-harness-design.md` lets the agent rewrite its own
      harness with no way to measure whether the rewrite helped. Both are blocked
      on the eval spec's Phase 1, and both should say so.

### Docs findings (writing `/internals/eval` — 2026-08-23)

- [ ] **`evalsDir()` is CWD-relative** (`eval/dataset.ts:19`,
      `path.resolve("evals")`), so `freecode eval` fails with "no such suite"
      anywhere but the repo root unless `FREECODE_EVALS_DIR` is set. The shipped
      cases also reference FreeCode's own source paths, so the suite is
      repo-specific and nothing in `--help` says so.

### Docs findings (eval Phase 2 — sandbox + outcome scorer, 2026-08-27)

- [ ] **`bash` escapes the sandbox.** `eval/sandbox.ts` scopes the *file* tools
      and the runner's permission answers to the tmpdir, but a coding case needs
      `bash` and `bash` reaches the whole filesystem (spec §6.3 says so
      explicitly). Cases are trusted fixtures, so this is a limit rather than a
      live hole — but it is why `danger` mode still has no eval coverage, and
      why an untrusted case would need a container (spec §13).
- [ ] **Coding cases are synthetic and small.** Six dependency-free `.mjs`
      fixtures, three-to-four turns each. They catch a harness change that
      breaks editing outright; they will not catch one that degrades work on a
      real codebase. That is the Tier 2 sandbox, blocked on `node_modules`
      (spec §6.2).
- [ ] **`referencedFiles()` in `eval/dataset.ts` is a token scan.** It only
      catches script paths ending `.mjs`/`.cjs`/`.js`/`.json`, so a `verify`
      that reaches a fixture file some other way (a shell redirect, a path built
      inside `node -e`) is not validated at load and will fail at score time,
      reading as an agent failure. Deliberately narrow — broadening it to
      "anything path-shaped" rejects `node --test` — but the gap is real.
- [ ] **`immutable` is checked only against files the case seeded.** A case
      cannot assert "the agent created no new files", so an agent that leaves
      scratch files behind still passes. Nothing depends on this yet.

### Findings (eval Phase 4 — `eval add`, 2026-08-27)

- [ ] **The thread store's turn table is dead code.** `createTurn` is
      implemented in `store/json-store.ts`, `store/sqlite-store.ts` and
      `ThreadStore.addTurn` (`store/thread-store.ts:164`), and **nothing in the
      repo calls any of them**. Verified against a real installation:
      `~/.freecode/state/store.json` holds 118 threads and 0 turns. So
      `StoredTurn`, `StoredToolCall` and `getTurnItemsView` are a persistence
      layer with no writer. Either wire it up or delete it — but it should not
      keep sitting there looking like a source of truth. It already misled the
      eval spec (§5.1's table, corrected in §8.1).
- [ ] **`eval add` cannot harvest a coding case.** A recorded session has no
      `files` fixture, so `--suite coding` is refused. Harvesting a *sandboxed*
      case would mean reconstructing the fixture from the tool calls that
      created it — possible in principle, not attempted.
- [ ] **`expectMaxTurns` is harvested as the observed count exactly**, so a
      drafted case fails on a run one turn longer. A note says so, but a human
      who skims it commits a case that is red by construction. Consider
      emitting `observed + 1`, or a `--slack N` flag.

### Findings (eval Phase 5 — LLMOps close-out, 2026-08-27)

- [ ] **Daily usage has no USD.** `providers/pricing.ts` now exists and feeds
      `freecode trace`, `freecode eval` and the OTLP export, but
      `usage/tracker.ts` still records tokens only — `recordDailyUsage` never
      receives the provider/model that spent them, so the `/usage` heatmap
      cannot be priced without threading that through.
- [ ] **The built-in price table has no refresh path.** Six models, stamped
      `PRICES_AS_OF = "2026-05"`. Nothing warns when it goes stale, and a stale
      table is only safe because the contract is *comparison, not billing* —
      which holds only while everyone remembers it.
- [ ] **`attrs()` in `rollout/otlp.ts` rounds numerics to integers**, with an
      explicit `FRACTIONAL` exception set. Adding a future rate-valued
      attribute outside that set silently reports 0.5 as 1 — this already
      happened once with the suite pass rate, caught only because a test was
      re-read rather than trusted.
- [ ] **§12 item 2 (live OTLP export on turn end) is not built, on purpose.**
      It reverses `2026-08-10-agent-observability.md` §7 and puts a network
      call in the path of a normal run. Wants an explicit decision.

### Findings (eval Phase 3 — the judge, 2026-08-27)

- [ ] **The judged thresholds are uncalibrated.** `JUDGE_MEAN_FLOOR = 3.5` and
      `JUDGE_CASE_FLOOR = 2` come from the spec, which itself says to set them
      "from the first real run, not from this document". No real run has
      happened — no second provider key is configured here. Until one does, a
      judged `--gate` verdict is a guess with an exit code.
- [ ] **No judged run has ever executed.** Everything is unit-tested through the
      `complete` seam, and the unconfigured + same-model paths are verified
      live, but no rubric has been graded by a real judge model. The rubric
      wording in `evals/rubrics/answer-quality.md` is therefore untested against
      an actual grader.
- [ ] **The same-model check cannot see through a gateway route.** It compares
      normalised ids and refuses on same-provider-with-no-model, which catches
      the obvious cases. An OpenRouter path or a vanity alias serving the same
      weights will pass. Mitigation is `SuiteReport.judge` disclosure; there is
      no detection fix, because nothing in a response says what served it.
- [ ] **Judged cases cannot be harvested.** `eval add` emits trajectory cases;
      a rubric is a human judgement about what "good" means for that prompt.

### Findings (eval gate hardening, 2026-08-27)

Closes the four items above that stood between "the harness runs" and "the
harness can block a release". Remaining:

- [ ] **`evalsDir()` is still CWD-relative.** `pnpm eval` covers a checkout and
      the CI workflow sets nothing, but an *installed* binary run from anywhere
      but a repo root still needs `FREECODE_EVALS_DIR`.
- [ ] **No shipped case pins `model`**, though spec §11 says every one should.
      The hazard — comparing across models — is now caught by `baselineFor`
      refusing a cross-model baseline, so this is belt-and-braces rather than an
      open hole.
- [ ] **The CI workflow has never run.** It needs `secrets.*_API_KEY` and
      `vars.FREECODE_EVAL_MODEL` set on the repo, and is `workflow_dispatch`
      only by choice — every case is a real paid agent turn, so billing should
      scale with releases, not pushes. Uncomment `schedule:` to go nightly.

### Docs findings (rewriting `/internals/eval` — 2026-08-31)

- [ ] **`stuck-loop` has 8 cases and none of them can block a release.** All of
      them live in `redirect.jsonl` / `redirect-build.jsonl`, which are A/B
      material and deliberately not part of `eval:gate`. So the registry counts
      the category as covered while the gate has never asserted anything about
      repetition. Either promote one to `trajectory.jsonl` or record why the gate
      does not cover it — `CATEGORIES_WITHOUT_CASES` cannot see the difference,
      because it folds every suite together.

## Memory consolidation — open items (shipped 2026-08-23)

Spec `specs/2026-08-23-memory-consolidation.md`; benchmark findings that contradicted the spec are in `docs/DECISIONS.md`.

### Found by the smoke test (2026-08-23, real MiniMax turns)

It also found two bugs every unit test passed through — a citation tag that
streamed to the user, and citations parsed and then dropped by an `unref`'d
debounce on a short-lived process. Both are fixed; the fixes are in
`CitationStreamFilter` and `UsageStore`'s synchronous exit flush. One
limitation is still open:

- [ ] **Headless runs never complete background memory work.** `freecode run`
      exits before fire-and-forget extraction or consolidation lands. Fine for
      the daemon (the TUI stays alive), but it means scripted runs never
      consolidate. Consider awaiting them on the headless path with a budget.

### Still open

- [ ] **Wire up LongMemEval-S** (`bench/longmemeval.ts`). The committed corpus
      was written by the same people who wrote the retriever; it catches
      regressions and proves nothing about absolute quality. LongMemEval-S uses
      `all-MiniLM-L6-v2`, the embedder we already run, so agentmemory's published
      numbers are a directly comparable baseline.
- [ ] **Measure the judge with a real model.** Every judge figure so far is from
      `--judge=oracle`, a perfect reader, and is therefore a ceiling.
- [ ] **Watch the judge degradation rate.** It fails closed, so a provider
      outage silently turns memory off. `isDegradation()` marks the cases; if
      they fire often, revisit the direction.
- [ ] **Backfill the rollout archive.** Hundreds of historical session
      directories have never been mined; the end-of-session flush only covers
      live sessions.
- [ ] **`Contradicts` edges are still never produced.** Consolidation emits
      `Supersedes` (the writer-knows case) only.
- [ ] **VectorStore id→index `Map`.** O(n²) full sync matters more now that
      consolidation does pairwise-cosine candidate selection.

## Findings (gemini-web provider — 2026-08-29)

Found while writing `docs/specs/2026-08-29-gemini-web-provider.md`.
Ranked by value. Full context in §8 of that spec.

### Real fixes

- [ ] **E1–E5 are not eval cases.** Every measurement behind the provider's
      design (no tools, mention inlining across turns) was run by hand, so
      nothing detects a regression that re-introduces tools here or breaks
      cross-turn `@mention` collection. The `evals/` sandbox landed 2026-08-27
      and could hold at least E2 (tools vs inlining) and E5 (turn-1 file still
      present on turn 2).
- [ ] **A stale model id degrades silently.** `resolveGeminiWebModel` falls back
      to the default rather than erroring (deliberate — see D8), but the user is
      then served a different model than the one they picked with no signal.
      Wants a one-line notice on fallback, not a throw.
- [ ] **No per-provider "usage not measurable" affordance.** `gemini-web`
      reports no usage on purpose (the endpoint returns no token counts, and
      `chars / 4` would reach the daily tracker as though measured). The
      consequence is a blank meter that reads as "zero spend" rather than
      "unmeasured".

### Housekeeping

- [ ] **`readWebCredential`'s `providers` fallback** is a compatibility shim for
      configs written before the `web` block existed, with no removal plan.
      Dropping it would surface as Pro quietly serving Flash, not as an error,
      so it needs a migration rather than a deletion.
- [ ] **`ProviderCredentials.model` is declared and read by nothing** —
      pre-existing dead field, noticed while designing the `web` block.

## Findings (OpenHands comparison — 2026-09-01)

Found while reading the `OpenHands/OpenHands` Agent Canvas frontend (`ca4024e3a`)
for what makes its long-running sessions survivable.

### Long-session fidelity

- [ ] **Compaction summarizes the original task away.** `selectForCompaction`
      preserves only the tail — last `preserveRecentTurns: 2` user turns capped
      at `maxPreserveRecentTokens: 8_000` (`compaction/types.ts:62-63`) — and
      takes `messages.slice(0, firstPreservedIndex)` for the summary
      (`compaction/selector.ts:54`). No head carve-out, so the founding
      instruction is compacted first and, on the next compaction, the summary of
      it is re-summarized. Lossy compounding on the oldest content, which is a
      plausible mechanism for long-session drift off the brief. OpenHands'
      `CondensationEvent.summary_offset` implies a head-preserving condenser
      (inference — their SDK is a separate repo, not readable locally).

- [ ] **`compact.occurred` records magnitude, not content.**
      `rollout/types.ts:125` carries `beforeTokens`/`afterTokens` only. When a
      long session forgets something, "which events left the view" is the first
      question `freecode trace` should answer. OpenHands' `CondensationEvent`
      carries `forgotten_event_ids`. The ids are known at the call site and
      contain no message bodies, so this does not threaten the leak-free OTLP
      constraint.

- [ ] **`rollout/history.ts` has no range query.** `loadSessionEvents` (whole
      file), `getEventsByType`, `getEventCount` — no cursor, no timestamp
      window. Prerequisite for backing SSE replay with the durable log rather
      than the in-memory buffer, which also needs a `RolloutEvent →
      StreamEvent` projection (necessarily lossy: the log stores no message
      bodies, by design).

## Harness cost efficiency (2026-09-04)

### Found writing the docs page (2026-09-04)

- [ ] **Output compression only covers `bash`** — no other tool sets
      `metadata.outputKind`, so MCP tools (which can be just as log-noisy) always
      take the blind head+tail path. Extend classification once the D2 A/B proves
      the approach. Recorded in `/internals/cost-efficiency` Known gaps.

## Docs findings (Anthropic subscription login — 2026-09-05)

Found while writing `/getting-started/anthropic-subscription`, the page that
publishes the OAuth ToS stance (`beforeStable.md` P0 #5). Recorded in that
page's Known gaps.

- [ ] **Tool names are forwarded unmapped on the OAuth path.** jcode renames
      tools to the ones Claude Code ships; freecode does not. Spec §9 Q1 — a
      tool-use-*quality* question, not an access or billing one, and it waits on
      a real turn.

## Findings (ephemeral-tail cache fix — 2026-09-06)

RC8 in the token-efficiency spec: memory/todo/reminder session system blocks
rewrote the cached prefix every inner-loop turn; moved to
`ExecuteOptions.ephemeralTail` (final user message, appended after the cache
anchors). Detector gained a one-sample deferral for provider blips
(cache-observability spec §D2.1). What remains open:

- [ ] **A full provider-side eviction still alarms as a rewrite.** D2.1 acquits
      a miss whose next read recovers to the pre-miss boundary; a miss where the
      read never recovers (upstream evicted everything) is indistinguishable
      from a real rewrite by usage numbers alone and produces the same warning.
      `FREECODE_DEBUG_CACHE=1` segment hashes are the manual tiebreak.
- [ ] **The UserPromptSubmit hook no longer sees memory/todo/reminder text.**
      The hook rewrites the joined *system* prompt, and those blocks are message
      content now. No known hook depended on them; if one surfaces, the hook
      contract needs a decision (expose the tail read-only, or accept the loss).
- [ ] **`FREECODE_EPHEMERAL_TAIL=0` should eventually be deleted.** It existed
      so `eval ab` could price the two placements; the ledger entry
      (`2026-09-05-redirect-1`) is decided "kept", so the old placement is now
      dead code behind an env flag. Delete the flag, its `VARIABLE_ENV_KEYS`
      row, and the `!tailEnabled` branches in `loop.ts` together.
- [ ] **Watch: do tail-placed todo nudges lengthen tedious runs?** In the A/B,
      `count-something-tedious` ran 22 candidate turns vs 11 baseline (one
      spiral-by-design case, 3 trials — could be variance). If long-run turn
      counts creep after this change, the nudge's salience as the final user
      message is the first suspect.

## Eval-harness finding (memory-system review — 2026-09-06)

- [ ] **Eval turns inject the developer's live memory store, so trajectory runs
      are environment-dependent.** `eval/runner.ts` sets `projectPath:
      process.cwd()` and the loop's `prepareMemories` runs against
      `~/.freecode/projects/<repo>/memory` — a store that grows with every real
      session on the machine. Measured 2026-09-06: the recorded 23/24 baseline
      was unreproducible on the same commit (`main` re-run scored 23/24 but
      flipped `no-tool-for-live-infra-data`, closing the gate; a fix branch with
      byte-identical injection behavior scored 22 then 21). Off-topic prompts
      like the live-infra case get a full 8-memory block (vector cosine floor,
      see `memory/bench/README.md`), and that block differs per machine and per
      week. Fix shape: the runner should isolate memory for unsandboxed cases
      (point the store at an empty temp dir, or a committed fixture store) so a
      case's verdict depends on the code, not on what the developer did
      yesterday. Until then, cross-day gate deltas on trajectory are partly
      memory-store drift.

## Found running the release gate on feat/memory-efficiency (2026-09-26)

- [ ] **`bash` runs in the process cwd, not the session's project.**
      `agent/loop.ts:3043` builds the tool context with `cwd: process.cwd()`
      beside `projectPath: this.state.projectPath` (unchanged since May), and
      `tools/bash.ts` runs in `ctx.cwd`. So a sandboxed eval case's shell
      commands execute in the developer's repo — a `coding` trial on
      2026-09-26 ran `node dump.mjs | grep -c ERR > answer.txt` and wrote
      `answer.txt` (`0`) into the repo root ("Cannot find module
      '/home/ayan-de/Projects/freecode/dump.mjs'"). The case still passed via
      absolute paths, so scores were unaffected, but the isolation `CLAUDE.md`
      describes for fixture cases does not hold for `bash`. In production it
      bites a daemon serving a session whose `projectPath` differs from where
      it started. Fix is `cwd: this.state.projectPath ?? process.cwd()`
      (and the orchestrator default); it changes every `bash` call's cwd, so
      it wants a test plus an `eval ab` per `CLAUDE.md`.
- [ ] **The judged gate compares across a judge switch.** `baselineFor`
      (`eval/report.ts:100`) refuses a baseline from a different `authMode`
      but not from a different `judge`. With Gemini out of quota the judged
      gate ran on `anthropic/claude-haiku-4-5` and reported "regression: 4/6
      vs baseline 6/6" against Gemini-graded history. Key the baseline on
      `SuiteReport.judge` the way it already keys on `authMode`.
- [ ] **Haiku 4.5 misapplies the `answer-quality` rubric.** It scored
      `admit-what-is-not-there` 1–2 for correct, tool-free answers ("made
      claims without reading any files") that Gemini scored 5/5 seventeen
      times; the rubric says to penalise only a claim the tool list
      *contradicts*. Do not use it as the judged-gate judge until
      `freecode eval calibrate` has human labels showing it agrees.
- [ ] **`frustrated-user-gets-no-padding` answers from `CLAUDE.md` without
      reading.** 3/3 tool-free with memory recall off too, occasionally wrong
      ("nothing is written to history") or self-contradicting ("No… Yes") —
      the same flakiness Gemini scored 0/1/3 on 2026-09-06/08. Pre-existing,
      not this branch; a candidate for `evals/quarantine.txt` with that reason.

## Found running the memory long-horizon savings-curve experiment (2026-09-26)

`evals/memory-long-horizon.jsonl`, `long-incremental-assembly` (three tax
rates taught across six sessions, one probe that needs all three). Its fixture
confound — `regions.mjs` was immutable although the teaching says "the rate
table lives in regions.mjs" — is fixed (`595b9dd3`), and an oracle solution
passes `verify`. The re-run (`evals/experiments.jsonl`
`2026-09-26-memory-long-horizon-3`, rejected) is still 0/3 vs 0/3, now for
memory reasons. Evidence is store sizes plus the model's stated recall; the
stores are deleted after each trial, so contents were not read directly —
set `FREECODE_EVAL_KEEP_SANDBOX=1` and keep the store to confirm.

- [ ] **The last-taught fact is not retained.** Session 6 ("the region table
      also needs ap-northeast-1 at 10 percent") grew the store in 0 of 3
      candidate trials. In the one trial where consolidation did nothing, the
      model used the first two rates correctly and had no ap-northeast-1 —
      so the fact was either never extracted or overwritten in place under an
      existing memory name (`extract.ts` saves over a same-name entry rather
      than merging content). Distinguish the two before fixing.
- [ ] **Consolidation lost a fact it had.** In 2 of 3 candidate trials the
      forced pass merged 2 and deleted 2 memories right before the scored
      turn, and the probe then used a rate taught earlier wrongly
      (us-east-1 = 0) or not at all (eu-west-2 missing). Same shape as spec
      §7.2's rejected `consolidate-production-endpoint` result — a merge that
      drops content from the entries it folds together. Check what the merge
      prompt keeps when combining entries that each hold part of a table.
