# FreeCode Agent Guide

> How to work on this codebase — architectural principles, patterns, and practices.

**IMPORTANT: Architecture Spec Compliance**
This codebase follows `docs/specs/2026-05-25-architecture-v4.md` (supersedes v3). Before implementing features, read that spec. If implementation deviates from it, the spec takes precedence unless explicitly overridden. Topical specs worth reading before touching a subsystem:

| Area                | Spec                                                    |
| ------------------- | ------------------------------------------------------- |
| Agent loop          | `specs/2026-05-25-agent-loop.md`                        |
| Multi-provider API  | `specs/2026-05-28-multi-provider-api-design.md`         |
| Web-session provider | `specs/2026-08-29-gemini-web-provider.md` — incl. the E1/E2 measurements that shaped the design. §10: text-protocol tool bridge (`tool-bridge.ts`) — reply must be `[TOOL_CALLS]` or `FINAL:`, violations get one gated retry before anything streams. **On by default since §10.4**; opt out `experimentalTools: false` / `FREECODE_GEMINI_WEB_TOOLS=0`; watchdog suite `evals/gemini-web-tools.jsonl` |
| Anthropic OAuth (Pro/Max) | `specs/2026-09-05-anthropic-oauth-provider.md` — subscription auth mode on the `anthropic` entry. **Phases 0–2 built**: `providers/anthropic-oauth.ts` + `auth-store.ts` (import Claude Code's login, refresh, fetch rewrite, identity block) and `providers/anthropic-oauth-login.ts` + `cli/commands/auth.ts` (`freecode auth login|status|logout` — PKCE, localhost callback, paste fallback). Opt-in via `freecode auth login anthropic`, `providers.anthropic.authMode: "oauth"`, or `FREECODE_ANTHROPIC_AUTH=oauth`; login pins the mode, logout un-pins it. `state` **is** the PKCE verifier, so login is single-process (no `--code` flag). Phase 2: an "OAuth not allowed for this organization" 403 is detected **at the fetch** (both SDK paths surface it differently), latches for the process, and falls back to the API key — which also drops the identity block, keeping the §0.1 invariant. **Cost is stamped on the call, not read at fold time**: `model.response` carries `authMode`, `priceUsd(provider, model, usage, authMode?)` takes it as an argument, and `pricing.ts` does not import `config.ts` — reading live config there repriced historical sessions and made pricing machine-dependent. The OAuth system param leads with **two** blocks: Claude Code's billing-attribution line (`x-anthropic-billing-header: cc_version=…` — a system block, not an HTTP header; `cc_version` tracks the spoofed User-Agent) then the identity block. Tool-name mapping stays unbuilt: jcode forwards unmapped tools under their own names, so it is a tool-use-quality tweak, **not** an access or billing requirement — §9 Q1 waits on a real turn. Eval integration (§8) is built: `SuiteReport.authMode` is recorded and `baselineFor` refuses to compare across an auth-mode switch, so a subscription run never becomes the bar an API-key run is measured against. Read §0.1 (ToS risk) before extending |
| OpenAI OAuth (ChatGPT Plus/Pro) | `specs/2026-09-29-openai-codex-oauth-provider.md` — subscription auth mode on the `openai` entry via the Codex backend (`chatgpt.com/backend-api/codex/responses`). `providers/openai-oauth.ts` (refresh, fetch wrapper) + `openai-oauth-body.ts` (pure: body rewrite, SSE→JSON fold) + `openai-oauth-login.ts`; `freecode auth login\|status\|logout openai`. Opt-in like Anthropic (`authModeFor` in `config.ts`, `FREECODE_OPENAI_AUTH`). The backend **only streams** and 400s on `max_output_tokens`/`temperature` — the wrapper forces `stream`, strips those, and folds SSE back to JSON for `generateText`; with `store: false` `response.completed.output` is EMPTY, so the fold rebuilds it from `output_item.done`. Redirect is fixed at `localhost:1455`. **Never imports `~/.codex/auth.json`** — shared rotating refresh tokens log one side out. Live-verified 2026-09-29 (tool call + second turn + non-streaming + `freecode run`). |
| Memory + sessions   | `specs/2026-06-02-memory-session-design.md`             |
| Memory graph        | `specs/2026-07-26-memory-knowledge-graph.md`            |
| Memory write path   | `specs/2026-08-09-memory-write-path.md`                 |
| Memory consolidation | `specs/2026-08-23-memory-consolidation.md` (built 2026-08-23) |
| **Memory (all of it)** | **`docs/MEMORY_SYSTEM.md`** — start here |
| MCP client          | `specs/2026-06-08-mcp-client-design.md`                 |
| Observability       | `specs/2026-08-10-agent-observability.md`               |
| **Trace (commands)** | **`TRACE.md`** — `freecode trace` flags, how to read the waterfall |
| **Backlog (three files)** | **`TODO.md`** = debt that must shrink to zero before 1.0 (bugs, dead code, stale docs) · **`ROADMAP.md`** = unbuilt features needing a spec · **`docs/DECISIONS.md`** = deliberate behaviour that must NOT be "fixed". File a finding in the right one; never fix something listed in DECISIONS without deleting its entry. |
| Eval harness        | `specs/2026-08-23-eval-harness.md` (Phases 0–5, built) + `specs/2026-08-29-eval-case-registry.md` |
| **Eval (commands)** | **`EVAL.md`** — which command, which flag, when to run it |
| **Agent comparison (commands)** | **`AGENT-BENCH.md`** — `pnpm bench:agents` (+ `bench:grade`, `bench:bundle`, `--isolate`) vs Claude Code / OpenCode; metering, grading, isolation, `/benchmark`. Spec `2026-09-03-agent-comparison-benchmark.md`. **Not `pnpm eval`.** |
| **Auto-poke (operator)** | **`AUTO_POKE.md`** — what it does, `settings.json` / env to enable it, skip reasons, how to read §06 on `/bench`, what is measured so far. |
| **Harness bench (commands)** | **`HARNESS-BENCH.md`** — `pnpm bench:jcode` (jcode bench v1 optimisation tasks, `bench/jcode-bench/`) + `pnpm bench:signals` (confidence stepping / hill-climbable goals / auto-poke folded from rollout logs, `bench/harness-signals/`) → `/bench` hub page. Spec `2026-09-12-harness-bench.md`. |
| Agent comparison (design) | `specs/2026-09-03-agent-comparison-benchmark.md` — harness-vs-harness on SWE-bench Lite. Deliberately outside `eval/`. Runtime RAM is `Benchmark.md` |
| **Judged commit bench** | `specs/2026-09-29-commit-reconstruction-bench.md` — agent-bench Phase 5: BuffBench's method (freebuff, Apache-2.0) on this repo's own `apps/core`/`apps/tui` commits. Judges **Gemini 3.5 Flash + GPT-5.5**, the GPT judge via `codex exec` on the owner's Codex subscription (Sonnet-via-Claude-OAuth was refused by Anthropic). **Default is audit mode** (`judge-audit.ts`): Gemini scores every trial, GPT re-judges a deterministic 20% sample (`sha256(task|agent|trial)`) and scores only when Gemini fails. The score is never a mean; "scored by Gemini" holds only with ≥5 two-sided audits and a mean gap ≤1.5. A GPT call here is ~118K tokens, so the full panel (`judgePanel`, BuffBench's arithmetic: mean, median analysis, degraded warning, both dead → 0 + `judgeFailed`) is kept for publishing. No judge may share the agents' model family (`assertNoCollision`). `--since` is required and is the only contamination control (the repo is public since commit 1): the window rides with the tasks, and `bench:agents --set freecode-commits` refuses to start unless every pinned model was released BEFORE the window's first day (`instances/model-releases.json`; unknown fails; `--contamination-unchecked` = smoke run, unpublishable). Full-panel runs need ≤10% of trials scored by fewer than two judges. `codex exec` calls pass the message on **stdin** (argv caps at 128KB) and disable the owner's hooks/plugins. Built: `pnpm bench:commits`, `pnpm bench:tasks generate\|list\|approve`, `pnpm bench:agents --set freecode-commits` (clones the LOCAL repo, `pnpm install --prefer-offline`, 60-min timeout, final checks tail-cut to 20K), `pnpm bench:judge` (audit or `--panel`; Gemini retried twice before GPT falls back). With `--isolate`, setup and final checks run in the agent's image (native modules must match the image's Node, not the host's): the install on the egress net into an operator-owned host-dir pnpm store (`.cache/pnpm-store`; a docker volume would be root-owned), the checks with `--network none`. The image carries the repo's pinned pnpm, and older images are refused. Not yet run live. Operator page `AGENT-BENCH.md` §3d |
| Hooks               | `apps/core/src/hooks/hooks-system.md`                   |
| **Pi parity (steering, cache warmer, session tree, fuzzy edit, extensions)** | `specs/2026-09-20-pi-parity-plan.md` — six phases, all built 2026-09-20 on `feat/pi-parity`. **Steering**: `session.send` with `streamingBehavior: "steer"` while busy hands the prompt to `AgentLoop.steer()`; `drainSteers()` persists it as a `synthetic: "steer"` user message between one tool batch and the next model call (TUI: Enter steers, Alt+Enter queues a follow-up). **Cache warmer** (`providers/cache-warmer.ts`): replays the run's last request with `maxTokens: 1` at 90% of the Anthropic TTL when expected saving ≥ $0.05; **off by default** (`cache.warming` / `FREECODE_CACHE_WARMING=idle`), recorded as `cache.warm`, never as a model turn. **Session tree**: `messages.jsonl` is a tree with zero migration — `parentId` is written only on the first append after `navigate()`, `meta.leafId` only while the leaf is not the last line; `getMessages()` returns the active path so every reader got the tree for free; compaction still drops other branches. `/tree` in the TUI, `session.tree|navigate|label` IPC, abandoned branch → `synthetic: "branch_summary"`. **Extensions** (`extensions/`): `~/.freecode/extensions/*.ts` exporting `(api) => …`, `registerTool`/`registerCommand`/`on`; project extensions need `extensions.trustedProjects`; `/reload`. |
| **Checkpoints / rewind** | `specs/2026-09-23-checkpoints-rewind.md` — built 2026-09-23. `/rewind` undoes a turn's **file** changes and the conversation together; `/tree` stays conversation-only. Snapshots are **git trees in a shadow repo** (`~/.freecode/snapshots/<hash>/`) whose work tree is the project — the project's own `.git`, index and `git status` are never touched (`shadow-git.test.ts` pins that). One capture per user turn, keyed by the user message's **session-store entry id**, so the same id `session.tree` lists is the one `session.rewind` targets. Restore diffs target-vs-now and writes **only the paths that changed**: `M`/`D` are checked out, `A` is deleted (it did not exist yet) and its emptied dirs pruned. **The diff cannot tell an agent edit from a hand edit**, so anything changed since the checkpoint is reverted — which is why the TUI previews every path and requires a confirm (spec §4.2 + §9 Q4; per-tool path tracking is the fix and is unbuilt). **Requires a git repo** (`add -A` leans on the project's `.gitignore`; without one the first capture would walk `node_modules`); a non-git project logs one line and stays inert. On by default (`checkpoints.enabled`, `FREECODE_CHECKPOINTS=0`) — unlike the loop gates it does not change what the model does, so the eval-ab-before-flipping rule does not apply. Subagents never capture. Paths never enter the rollout log (counts only, OTLP stays leak-free). `freecode checkpoint status\|gc` — gc discards **every** snapshot |
| **Overnight runs** | `specs/2026-09-28-overnight-runs.md` — **built through Phase 5** (2026-09-28), branch `autonomous`; user doc `apps/docs/app/guides/overnight-runs/page.mdx`. `freecode night "<objective>"`: gnhf-style loop of short fresh-session **iterations**, each ending in a `finish_iteration` tool call; the orchestrator (not the model) commits a success to `night/<slug>`, `git reset --hard`s a failure, keeps `notes.md`, and aborts after 3 consecutive failures. No human is ever waited on: `question` answers itself and is recorded, permissions go through a fixed **envelope** (deny git-history/push/publish/sudo, writes only inside the run tree) with every denial recorded. A spent subscription window is waited out (reset from response headers on a typed `QuotaExhaustedError`), credits/auth abort. Morning report leads with needs-you, then decisions, refusals, commits, cost. Supersedes Phases 1–5 of the 2026-08-10 autonomous spec. |

## Implemented Subsystems

The v4 architecture systems are implemented and live in `apps/core/src/`:

| System                     | Location                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Effect/Layer DI**        | `effect/context.ts`, `effect/layers.ts`, `effect/runtime.ts`, `effect/loop-health.ts`                            |
| **Providers (API)**        | `providers/` — one generic driver over a models.dev-derived catalogue, not per-provider files. `catalogue.ts` resolves provider identity (id, name, SDK package, baseURL, env keys) from three layers: `catalogue-snapshot.ts` (generated by `pnpm gen:catalogue`, the offline floor) → models-dev.ts's disk cache → `OVERRIDES`. **The network is never consulted on the startup path.** `sdk-factories.ts` maps npm package → a lazily `import()`ed `createXxx`; ~198 of models.dev's 212 providers register, being every one whose SDK authenticates with a plain API key. `generic-provider.ts` builds the request, branching on **SDK package, not provider id** — `@ai-sdk/anthropic` gets `applyMessageCaching`, everything else is openai-shaped, and `promptCacheKey` is set for `@ai-sdk/openai` alone (openai-compatible endpoints reject unknown fields). The SDK and API key are read on **first request**, not at registration, so `getProvider()` stays synchronous at its nine call sites. `OVERRIDES` in `catalogue.ts` is the only hand-written provider data left and every entry states why it disagrees with models.dev. **An SDK package major that outruns the installed `ai` fails only at request time** ("Unsupported model version vN") — `sdk-compat.test.ts` is the guard; pin new `@ai-sdk/*` deps to the generation using `@ai-sdk/provider@3.x`. Also `registry.ts`, `config.ts`, `streaming.ts`.|
| **Agent loop**             | `agent/loop.ts`, `agent/subagent.ts`, `agent/recovery/`, `agent/title-generator.ts`                              |
| **Bus (PubSub)**           | `bus/index.ts`, `bus/bridge.ts` — question + streaming events                                                     |
| **Hooks**                  | `hooks/` — PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PreCompact, PostCompact, SessionStart, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Notification, TurnStart, TurnEnd |
| **Skills System**          | `skills/manager.ts`, `skills/loader.ts`, `skills/registry.ts`, `skills/injection.ts`, `skills/types.ts`          |
| **Rollout/Event Sourcing** | `rollout/recorder.ts`, `rollout/types.ts`, `rollout/history.ts`, `rollout/replay.ts`                              |
| **Observability**          | Spec `2026-08-10-agent-observability.md`. Model-call events (`model.request`/`first_token`/`response`/`error`) recorded by `rollout/recorder.ts` around `callProviderOnce`; `model.request` is written *before* the call so an unterminated request is itself the evidence of a hang. **Timeouts live at the fetch layer** (`providers/fetch-timeout.ts`, wired as the `fetch` option on every provider): 300s for response headers, 180s of silence on a live SSE stream (`FREECODE_HEADER_TIMEOUT_MS` / `FREECODE_SSE_STALL_TIMEOUT_MS`, `0` disables). Do NOT move this back above `normalizeAiSdkStream` — it drops `tool-input-delta`, so a large tool call looks like a dead stream. `rollout/trace.ts` (pure fold → spans; `in_flight` vs `hung` past `HANG_THRESHOLD_MS`) + `trace-render.ts` + `rollout/otlp.ts` (OTLP/HTTP JSON, no SDK dep, exported from the log not the hot path). CLI: `freecode trace [id] [--follow|--slow|--list|--json|--otlp]` — **operator reference is `TRACE.md` at the repo root** (flag interactions, how to read the verdict line). **A refused tool call is `function.denied` → `Trace.deniedSpans`, never `toolSpans`** (spec §5.1): `loop.ts` returns before `recordFunctionCall`, so before this event a mode-blocked call left no trace at all and a model looping against a mode it cannot satisfy folded to "did nothing". All four deny sites go through one `denyToolCall()` exit. `toolSpans` means **tools that ran** and its seven consumers depend on that, so denials stay out of it — which is also why an eval's `forbidTools` cannot see a refusal, and must be paired with an `expectTool` or it asserts nothing. **Cost**: `providers/pricing.ts` (USD/Mtok keyed `provider/model`, `~/.freecode/pricing.json` overrides, `PRICES_AS_OF` vintage) — an unknown model prices as `undefined`, never 0 or a near-miss, and a cache read is a **discount off the inclusive `inputTokens`, not an addend**. OTLP root span is `invoke_agent` with `gen_ai.conversation.id` on every span; `attrs()` rounds numerics to ints except the explicit `FRACTIONAL` set (cost, score) — adding a rate outside that set silently reports 0.5 as 1. **Prompt-cache invariant (RC8, fixed 2026-09-06)**: mutable per-turn prompt state — memory recalls, todo block, drained `<system-reminder>`s — rides `ExecuteOptions.ephemeralTail`, a final user message appended AFTER `applyMessageCaching` places its anchors; it must never go in the system param (system precedes every message, so one changed byte re-sends the whole conversation) and must never carry a breakpoint. Only the compaction summary may be a mutable system block, because compaction documents its own invalidation. The D2 miss detector (`providers/cache-miss.ts`) holds an undocumented miss one sample and acquits it if the next read recovers to the pre-miss boundary — implicit caches (MiniMax) blip without a rewrite. `FREECODE_EPHEMERAL_TAIL=0` reverts placement, for `eval ab` measurement only. See `docs/caching-architecture.md` §1.1 + cache-observability spec §D2.1. **§D2.2 (2026-09-22)**: the same module keeps jcode's KV-cache widget numbers — `getCacheStats()` → `cache_status.stats` → the TUI's status row under the input renders `tokens / limit · yield · last · session` (`context-status.ts`; was a top-right overlay that covered conversation text) with a `miss attribution` list below it, shown only when there are misses (`run.call>`, tokens, reason). **yield** = read ÷ the previous request's full prompt (harness health); `last`/`session` = read ÷ prompt (cost). Misses are classified journal → provider switch → model switch → expired → (held one sample) provider blip / `harness:*`; only `harness:*` alarms, so a mid-session model switch is no longer a false D2 alarm. Accounting runs even with `FREECODE_CACHE_MISS_NOTICES=0`. |
| **Thread Store**           | `store/thread-store.ts`, `store/sqlite-store.ts`, `store/json-store.ts`, `store/remote.ts`                        |
| **Sessions**               | `session/manager.ts`, `session/store.ts`, `session/prompt.ts`, `session/end-session.ts`        |
| **Checkpoints**            | `checkpoint/` — `shadow-git.ts` (git plumbing: `add -A` + `write-tree` → a tree id; `checkout <tree> -- <paths>` restores), `store.ts` (`checkpoints.json` beside `messages.jsonl`), `service.ts`, `settings.ts`. IPC `session.checkpoints\|rewindPreview\|rewind`; TUI `/rewind`. Capture is best-effort and never fails a turn; restore is explicit and reports. |
| **Compaction**             | `compaction/service.ts`, `compaction/selector.ts`, `compaction/summarizer.ts`, `compaction/tokens.ts`            |
| **Memory**                 | `memory/mem-store.ts`, `memory/mem-query.ts` (BM25 via `bm25.ts`), `memory/mem-prompt.ts`, `memory/mem-types.ts`. Five types: `user`/`feedback`/`project`/`reference` + `episode` (machine-written only). Write path (spec `2026-08-09-memory-write-path.md`): the `memory` tool, plus `extract.ts` mining finished turns, gated by `extract-policy.ts`; a final `force` flush on session end (`session/end-session.ts`, `memory/final-flush.ts`) bypasses the interval gate and nothing else. Consolidation (spec `2026-08-23-memory-consolidation.md`): `consolidate.ts` + `consolidate-run.ts` + `consolidate-policy.ts` + `consolidation-lock.ts`, one cheap call per project per day, merges only (**no delete verb**), over a **git diff** of the memory dir (`git-baseline.ts`). Retrieval judge `judge.ts` (fails closed, cadence-carried on the prefetch; **off by default** since 2026-09-25 — enable with `memory.retrievalJudge: true` or `FREECODE_DISABLE_MEMORY_JUDGE=0`, which is two-way and beats the files). Usage attribution `citations.ts` + `usage-store.ts` → `.graph/usage.json`. Recall benchmark: `pnpm bench:recall` (`memory/bench/`); injection benchmark `pnpm bench:inject` scores what the model actually receives (rendered recall, bytes on non-gold memories, lifecycle scenarios; spec `2026-09-25-memory-efficiency-and-graph-explorer.md` §4). Off via `memory.{autoExtract,retrievalJudge,autoConsolidate,autoRecall}: false` or `FREECODE_DISABLE_MEMORY_{EXTRACTION,JUDGE,CONSOLIDATION,RECALL}=1` (`RECALL` turns off automatic injection only — the `memory` tool stays; it is the off side of `pnpm eval ab memory`, whose runs found recall 23–24/24 vs 12–13/24 without, −45% cost per passed task; the fixed judge is neutral against no judge, hence off by default; `memory-sessions` shows it learning across sessions, 13/15 vs 4/15 at 3.9% extraction cost — spec `2026-09-25-…` §6.2, §7.1). |
| **Memory Graph**           | `memory/graph/` — derived KG over persistent memory (spec `2026-07-26-memory-knowledge-graph.md`). `embedder.ts` (local ONNX/fastembed, optional dep), `vector-store.ts` (packed f32 + content-hash cache), `builder.ts` (tag/wikilink/supersede edges), `clusters.ts` (deterministic k-means), `cascade.ts` (seed top-k → graph walk), `secret-filter.ts` (never embed or inject secrets), `supersession.ts` (obsolete candidates → newest live replacement before judging), `index.ts` (`MemoryGraphService`: async one-turn-behind injection, keyword fallback; store saves/deletes patch every session's prepared set at once). Sidecar in `<memory>/.graph/`; CLI: `memory graph stats|rebuild`. Keyword retrieval stays as fallback when the embedder is unavailable. **Explorer** (`graph-explorer/`, opt-in addon in `~/.freecode/addons/graph-ui/`, `127.0.0.1` only): `GET /api/graph` sends only `{id,kind,label}` per node — content is fetched per click via `GET /api/node?id=` (`nodeDetailForExplorer`). Page edits ship in `graph-ui.tar.gz` and need a release plus `freecode memory ui-install` to reach an installed binary. |
| **Permission**             | `permission/` — per-rule allow/ask/deny layer (`rules.ts`, `evaluate.ts`, `mode-policy.ts`, `settings.ts`, `prompt.ts`; spec `2026-07-18-permission-rules.md`) + `profiles.ts` capability profiles (minimal/readonly/standard/elevated/admin, used for subagents). Agent modes (plan/build/review/explore/danger) live in `agent/types.ts`. |
| **MCP Client**             | `mcp/client-registry.ts`, `mcp/service.ts`, `mcp/transport.ts`, `mcp/convert-tool.ts`. **Claude Code's servers are imported** (`mcp/claude-code-config.ts`, 2026-09-22): `loadMcpConfig` merges `~/.claude.json` (`mcpServers` + `projects[cwd].mcpServers`) and `<cwd>/.mcp.json` after FreeCode's own `~/.freecode/config.json`, same-name FreeCode entry wins, `${VAR:-default}` expanded, `source: "claude-code"` marks them read-only (`freecode mcp remove` refuses), `FREECODE_MCP_CLAUDE_CODE=0` disables. Skills likewise scan `~/.claude/skills` + `~/.claude/plugins` (`skills/loader.ts`); `plugins.list` IPC exposes the installed-plugin roster for the TUI header's `Plugins:` count. |
| **Context Engine**         | `context/collector.ts`, `context/compiler.ts`, `context/tree-cache.ts`, `context/strategies/`                    |
| **Eval harness**           | `eval/` — spec `2026-08-23-eval-harness.md`, Phases 0–5 (Phase 3's judge is built but needs `FREECODE_JUDGE_PROVIDER`/`FREECODE_JUDGE_MODEL` pointing at a provider that is **not** the one under test; §12's live OTLP export is deliberately unbuilt). Cases live in `evals/*.jsonl` (one JSON object per line) and **run a real agent turn**; anything that doesn't is a `*.test.ts` and belongs next to its code. Three suites: `trajectory.jsonl` (did the right tool fire — `scorers/trajectory.ts`, pure fold, unsandboxed and read-only), `coding.jsonl` (did the end state match — `scorers/outcome.ts`, `verify`'s exit code is the score), and `judged.jsonl` (was the reply good — `scorers/judge.ts` + `judge-config.ts`, 0–5 against a markdown rubric in `evals/rubrics/`). **A `rubric` makes a case judged**, which changes the blocking rule to *mean ≥3.5 and no case <2*, absolute rather than delta. The judge **must not be the model under test** — a collision throws before any case runs. An unconfigured judge does not throw (the deterministic expectations still run) but **closes the gate**: `judgeSkipped` is set on exactly one path (`resolveJudge` → `unconfigured`), which is how `gate.ts` tells "never configured" apart from a judge that failed mid-run. **A total blackout — 0 of N cases scored — also closes it**, whatever the cause: the first real judged run used a retired Gemini model id and reported 5/5 GATE OPEN having graded nothing. §7 constraint 3 ("an outage never fails a run") survives as: an unanswered case is excluded from the mean, and a *partial* outage passes on the cases that scored. Only silence-from-everything blocks. No override flag: omitting `--gate` is already how you run the suite without blocking. **Judge model ids rot** — a retired one surfaces as a passing suite, not an error, so `SuiteReport.judge` is recorded on every run. Unscored trials are excluded from the mean, never counted as zero. Scorers fold `RunRecord { trace, prompt, response, sandboxDir? }` — `trace` from the rollout log, text from the caller, because the log deliberately carries no message bodies (OTLP export must stay leak-free). Gate is **majority-of-N + delta vs the baseline**, never absolute 100% (see spec §9.1 for why: at p=0.93 across 20 cases, pass^3 is green ~1.3% of the time). **The baseline is the last run that did NOT close the gate, on the SAME resolved model** — blocked runs are written to history with `gateBlocked: true` and skipped by `baselineFor`, or a regression becomes its own baseline and is forgiven next run. That makes the baseline **sticky** when a suite is deliberately re-scoped (fewer cases ⇒ lower `passed` ⇒ permanent "regression"); `--accept-baseline` is the escape hatch, recording `baselineAccepted: true` so history can tell a waved-through baseline from an earned one. `--gate` implies `--trials 3`; an explicit `--trials 1` is honoured with a warning. `pnpm eval` / `pnpm eval:gate` from the repo root — `eval:gate` is the release ritual and runs all three suites in cost order (trajectory → coding → judged), so it **requires `FREECODE_JUDGE_PROVIDER`** and fails without one; CI is `.github/workflows/eval.yml`, **`workflow_dispatch` only** (real paid turns) and it caches `eval_runs.jsonl`, without which a fresh runner reports "run zero" and passes unconditionally. `evals/quarantine.txt` ships with the gate — flaky cases run and report but never block. **A case may mutate only if it has a `files` fixture** — that's what earns it a `sandbox.ts` tmpdir as its project root, `build` mode, and a runner that answers permission prompts scoped to that dir; without one, `dataset.ts` refuses mutating modes, since `forbidTools` only *scores* a mutation and mode enforcement *prevents* it. `danger` is refused either way. Coding fixtures are **dependency-free by rule** (plain `.mjs` + `node:assert`, no `node_modules` in the sandbox), and `immutable` byte-guards the checker so an agent can't edit its way green. `harvest.ts` + `freecode eval add <session-id> [--turn N] [--write]` turns a recorded session into a draft case — **it reads the SESSION store (`~/.freecode/sessions/<proj>/<id>/messages.jsonl`), not the thread store**: `createTurn`/`addTurn` have no production caller anywhere, so `StoredTurn` is always empty and the spec's §5.1 table row claiming otherwise is wrong (see §8.1). Turn scoping is by timestamp, not `turnId` — a `turnId` is a loop iteration, so one user turn spans many. **A case may run more than one user turn** (`followUps`) and may set an allowlisted `env` (`EVAL_ENV_ALLOWLIST` — the two compaction thresholds only, scoped to the trial by `applyEnv`). Both were added for `compaction-boundary`: until 2026-09-16 `selectForCompaction` returned nothing while `countUserTurns <= preserveRecentTurns` (2), and only a prompt makes a user turn — tool turns are `assistant` — so a single-`runEffect` case (and every `freecode run` / bench trial: ~200K input per turn against a 120K target, 99% cache hit so it was context size, not cache misses) **could not compact at any token count**. Fixed: with fewer user turns than N the selector preserves the last N messages instead, and the head carve-out keeps the prompt. `expectCompaction` folds `compact.occurred` out of the trace and is scored BEFORE the tool expectations, so a case whose env stopped reaching the trigger says that rather than blaming the model. Caveat when reading the number: `compact.occurred` records `MemoryService`'s ESTIMATED transcript (872 tokens on the shipped case) while the trigger judged the provider's MEASURED request (16K), so `Trace.compactedTokens` understates the saving — see TODO.md. CLI: `freecode eval [suite] [--trials N] [--gate] [--json] [--quarantine-report]`. **Operator reference — every command and flag, and when to run which — is `EVAL.md` at the repo root; read that before running anything that costs money.** |
| **Trajectory redirection** | `agent/redirect/` — spec `2026-08-26-trajectory-redirection.md`, Phases 0–2. Turns a loop-health `warn` into evidence-backed advice for the next turn: a bounded fold of the rollout log → one small non-streaming model call → up to three directions injected as a `<system-reminder>`. **Off by default** (`redirect.enabled`, `FREECODE_DISABLE_REDIRECT=1`); Phase 2 measured it and refused to flip — see §9.1 of the spec for why the criterion is unmeasurable until the eval sandbox lands. Capped at 2/run, 1/reason, 3-turn debounce, off for subagents; fails closed on every path; tokens billed to the run so the spend breaker sees them. Rollout: `redirect.triggered`/`redirect.skipped`, carrying `evidenceEventIds` but **never the advice text**. |
| **Background shells**      | `tools/shells/` — `bash(run_in_background: true)` registers a process in a per-session `ShellRegistry` and returns a `bash_id` immediately, so a dev server or long build stops holding the turn. `bashoutput` drains **only new output** (per-shell model cursor); `killbash` SIGTERMs the process group. Output lives in a `SHELL_BUFFER_CHARS` (256k) ring buffer — the OLDEST is dropped and `droppedChars` reports the gap, so a reader is told what it missed. **Two independent cursors on purpose**: `readForModel` advances the model's, `readFrom(cursor)` is positional for the TUI, so watching a shell in `/shells` never consumes output the agent has not read. Capped at `MAX_SHELLS_PER_SESSION` (16) *running*; settled ones are retained until dismissed (`d` in the panel) or the session ends — see TODO.md. `kill()`/`killAll()` fire the exit notification themselves, because settling the record short-circuits the child's own `exit` handler and the frontend counter would otherwise stick. Shells die with their session (`end-session.ts`) and with the daemon (`server.ts`, signal path + synchronous `exit` backstop). Foreground bash streams a coalesced 5-line tail every 200ms via `tool_output`. TUI: `/shells` panel + a `/shells (N)` chip in the ModeLine, both fed by `shell_start`/`shell_output`/`shell_exit` and the `shells.list|output|kill|remove` IPC. **Exit notifications** (2026-09-27): a background shell's exit is a `<task-notification>` (`kind: "shell"`, exit code + 4k tail) through the same path as background subagents (`agent/task-notify.ts`, `tasks.notify`); skipped when the model already knows the end — `ShellRegistry.modelKnowsEnd` (drained settled via `bashoutput`, or `killbash(…, byModel)`), re-checked at delivery via `isStale`. **Foreground bash**: `timeout` capped at `MAX_TIMEOUT` (600s); a command still running at its timeout is **adopted** into the registry (`ShellRegistry.adopt`, pre-move output kept) instead of killed, unless the model set `timeout` below the cap itself — then it is killed and the error now carries the partial output and advice (it used to be discarded). TUI idle deadline is 660s to clear the cap. **`monitor`** (`tools/monitor.ts`): a background shell whose output lines (or `pattern` matches) are `kind: "monitor"`, `status: "event"` notifications while it runs — batched per `FLUSH_MS` (1s), self-stops at `MAX_EVENTS` (20) or `timeout_ms` (≤60 min), refused with notifications off; permission rules match its `command` like bash (`COMMAND_TOOLS` in `permission/rules.ts`). `monitor({ bash_id })` attaches to a running shell instead (`ShellRegistry.watch`; buffered output is scanned too); its guard rails then **detach, never kill**, and the shell's own exit notification reports the end. An attach matches only `Monitor(bash_id:*)` (`ATTACH_PATTERN`), so "always allow" on one can never become a bare `Monitor` that approves every command. **Background ledger** (`agent/background-ledger.ts`, `~/.freecode/background/<session>.json`): every background agent/shell/monitor start is recorded with the core's pid and erased only when it finishes on its own; `endSession` (not `delete`) and process exit mark still-running entries `stopped` first, because the kills that follow fire the normal exit path. `session.resume` → `takeOrphans` → a notice now + a `<status>lost</status>` notification steered into the NEXT turn (`deferredNotifications`), never a turn of its own. User doc: `guides/tools#long-running-commands`. |
| **Subagent roster**        | `agent/registry/` — every subagent spawned under a session, for the `/agents` panel. **One registry for the process, not one per session**: a subagent's session id is synthetic, so resolving "which root session owns this agent" needs the whole tree in one map (`rootOf`/`depthOf` walk it; a session that is not an agent is its own root). Activity is folded OUT of the bus (`bus.subscribe("stream")` → `activity.ts` → ring buffer), not pushed in by the loop — a subagent's `AgentLoop` already publishes StreamEvents under its own id and nothing was listening, so nested agents are captured for free and `loop.ts` needs no knowledge of the panel. `agent_start`/`agent_output`/`agent_exit` are stamped with the **root** session id, because that is the only session a frontend subscribes to. **`MAX_AGENT_DEPTH` is 1** — a subagent may not re-delegate; before this nothing bounded the tree at all (a build-mode subagent sees the `agent` tool like any other). `MAX_AGENTS_PER_ROOT` (8) caps *running* agents per root, so a session that delegates twenty short tasks in sequence is not blocked at eight. `register()` throws on either breach and the tool turns that into a model-readable error. Both subagent entrypoints (`tools/agent.ts`, `agent/subagent.ts`) now `disposeShellRegistry(subagentId)` on settle: `endSession` never sees a synthetic id, so a background shell a subagent started used to outlive it, unkillable and invisible in `/shells` (which keys on the root). **Read-only `agent` calls in one response run concurrently** (`behavior.concurrencySafeFor(args)` → `batching.ts` decides per call; a writing one runs alone). **Spawned subagents are read-only by default** (`agent(readOnly)` defaults true → `explore` mode, so write/edit/bash are filtered out of the tool list entirely); `readOnly: false` inherits the PARENT's mode via `ToolContext.agentMode` rather than hardcoding `build`, which under a `danger` parent used to prompt for permissions the user had already switched off. **The `agent` tool only ever worked with `forkContext: true`** until 2026-09-08: the store was handed to the subagent loop but `createSession` was never called, so `appendMessage` (a bare append, no mkdir) threw ENOENT on the first user message — ~8ms, 0 turns, reported to the model as a bare `Status: FAILED` because the output builder also dropped `result.message`. Both fixed. **Background subagents** (2026-09-27): `agent(run_in_background: true)` returns at once; the result reaches the spawner as a `synthetic: "task_notification"` user message via `agent/task-notify.ts` → server sink — mid-turn it rides `AgentLoop.steer()`, idle it **starts a turn** (250ms coalesce, `startingTurns` guards the pre-`activeLoops.set` window). On by default (`tasks.notify`, `FREECODE_TASK_NOTIFY`); off ⇒ background falls back to foreground. `run()` no longer resets `pendingSteers` (a notification can land before it starts). The viewer's first message is the spawn `prompt` (on `AgentSummary`, not the ring buffer). **`agent_send` / `agent_stop`** (`tools/agent-control.ts`, spec `2026-09-27-agent-control-and-definitions.md` Phase 1): the direct parent (`parentId === ctx.sessionId`, anything else is a model-readable miss) steers a running subagent — `AgentRegistry.send` → late-bound `attachSteer` → `AgentLoop.steer` (queued on the record until the loop exists) — or stops it with `stop(id, byParent)`, which returns the last 2k of activity and suppresses the completion notification (`stoppedByParent`). A message the subagent never read is listed in its result (`takeUndeliveredSteers` + `takeUndelivered`), never dropped. **Sub-agent types** (`agent/definitions/`, spec §2): `agent({ subagent_type })` picks a role from Claude Code-format `*.md` files — built-in (`builtin.ts`: general/explorer/reviewer) → `~/.claude/agents` → `~/.freecode/agents` → `<project>/.claude/agents` → `<project>/.freecode/agents`, later wins, `FREECODE_CLAUDE_CODE_AGENTS=0` skips the `.claude` ones. The roster is a **system-prompt segment** (`agent-types`, per project), not the tool description, because tool defs are process-wide. A role's body lands in the subagent's cached system block (`UserInput.role` → `SessionState.role`); its `tools` allowlist is intersected with the mode's set in `callProviderOnce` and enforced again in `executeTool` (deny source `role`), so it narrows, never widens. `resolveSpawn` (`definitions/resolve.ts`) refuses an unknown type or provider before any session exists; `model` is the provider override now, `agentType` a hidden alias read as a type name, then a provider, else ignored. `Agent(<name>)` permission rules match `subagent_type`. `freecode agents list` prints the resolved roster. **Continuation** (`tools/agent-continue.ts`, spec §4): `agent({ continue: <id> })` forks the finished agent's session into a new id and runs it with the `AgentSpawnConfig` recorded at its spawn (`AgentRegistry.setSpawnConfig` — type, readOnly, provider/model, role), so it never changes role or authority; `subagent_type`/`model`/`readOnly`/`forkContext` alongside it are refused, as are a running target (→ `agent_send`), one stopped by `agent_stop`, a non-own one, and one with no recorded config (the verifier). The lookup is the in-process roster, so it does not survive a restart. The id reaches the model only through the result's `Agent id:` line — tool-result `metadata` is never shown to it. Background shells and `monitor` use the same notification path (see Background shells). User doc: `apps/docs/app/guides/subagents/page.mdx`. IPC `agents.list|output|stop|remove`; TUI: `/agents` is a **roster only** (`agents-panel.ts`, content-sized, status as words not glyphs) and Enter swaps `AgentViewer` into the message list's slot in `tui.children` so a subagent replaces the conversation instead of covering it. **The TUI now filters stream events by session** (`handleToolEvent`): core broadcasts every bus event on stdout, so a subagent's text/reasoning/tool calls were being drawn into the main transcript interleaved with the parent's — blocking prompts (`permission_asked`, `question_asked`) are exempt, since dropping one would leave the subagent waiting out the 30-minute timeout, which callers treat as DENY. Modals restore focus via `focusTarget()`, not straight to the editor, or a prompt arriving over an open card orphaned it with escape dead. |
| **Harness signals**        | `agent/signals/` — spec `2026-09-12-harness-bench.md`. `TodoItem` carries optional `confidence` / `hillClimbability` (0–100, `tools/todo.ts`). Three loop gates, **all off by default** (`signals.{autoPoke,confidenceGate,hillClimbGate}.enabled`, env `FREECODE_AUTO_POKE` / `FREECODE_CONFIDENCE_GATE` / `FREECODE_HILLCLIMB_GATE`, `1`/`0` beats the files): auto-poke sends a model that stopped with open todos back (cap 3/run — `pokeState` is reset in `run()`, or the cap silently became per-session; stops on a byte-identical list — `no_progress`; `no_budget` when the iteration cap would land before the poked turn; a poke and its stop each reach the frontend as a `notice`). **The poke is a persisted user message** (`SerializedMessage.synthetic: "auto_poke"`, history + store, not the compaction transcript), not an ephemeral `<system-reminder>`: jcode's finding is that a reminder-only turn reads as an empty user message and the model replies to it instead of acting, and a persisted turn keeps the transcript alternating on resume. Append-only, so cache anchors are untouched. `harvest.ts` skips synthetic messages; the TUI renders them as a one-line notice on resume. `cancelled` is a todo status: closed without claiming the work was done, so it neither pokes nor asks for a reframe — the reminder says cancel, never fake-complete. **`blocked` is the other exit** (added 2026-09-20 after session 698c5001 retried one 403 push 38 times): open but waiting on the user, never poked (`all_blocked`). The poke is one line naming ≤6 items, the fingerprint is `id:status` only (re-wording is not progress) and **survives across runs** (a "continue" on an unchanged list is one turn, not three more pokes), and a `repeated_identical_tool` warn with redirect off now reaches the model as one `repeatedCallReminder` before the hard stop at 6, the confidence gate sends a +40-in-one-call completion back to verify, the hill-climb gate asks for a reframe below 90. **Recording is always on** — `poke.triggered`/`poke.skipped` on every stop with a list present (`disabled` included), `todo.signal` with `gated` — so `pnpm bench:signals` can compare across the flip; item text never enters the log. Subagents never poke or get gated. The loop's rule that open todos do not override a stop still holds when the gate is off; flipping a default is an `eval ab` decision. **Todo nudge** (`agent/reminders.ts`): the "you haven't used todowrite" `<system-reminder>` fires after **10** turns without a write and at most every 10 (Claude Code's numbers) with CC's gentle wording; until 2026-09-20 it was 3/5 and read as an order — the rollout fold showed 45% of first todo lists were written on the nudged turn (1.8% → 36.7% per turn), which is where "todos for every task" came from. `FREECODE_TODO_NUDGE=legacy` restores 3/5 for `eval ab`. A poke answered with **no tool call** gets one harder re-poke (`retry: true`), and **read-only modes are never poked** (`read_only_mode`) — a planning-only prompt in explore mode was being sent back to "continue" and answering with forbidden reads. |
| **Overnight runs**         | `autonomous/` + `tools/finish-iteration.ts` + `cli/commands/night{,-run}.ts` — spec `2026-09-28-overnight-runs.md`, **Phases 0–5 built 2026-09-28** on branch `autonomous`. `freecode night "<objective>" --until 07:00\|--max-iterations N\|--max-usd N` (one limit is REQUIRED — an unbounded night must be a choice). Each **iteration** is a fresh session doing one small verifiable step and ending in a `finish_iteration` tool call; the ORCHESTRATOR commits each success to `night/<slug>` as `night <n>: <summary>`, `git reset --hard && clean -fd`s each failure, keeps `notes.md`, and aborts after 3 consecutive failures. Preflight refuses a dirty tree, a non-repo and a detached HEAD. **Nothing ever waits on a human**: `question` answers itself and records the ask (`ctx.unattended`, never the bus — an unattended ask used to burn `PROMPT_TIMEOUT_MS`), permissions go through the **envelope** (`envelope.ts`: `ENVELOPE_DENY_RULES` seeded into the session DENY tier via the new `addSessionDeny`, so a user's own `Bash(git:*)` allow cannot widen them; writes must resolve inside the tree, symlinks followed; `.git/` writes refused; everything else the mode would ask about is allowed). It is a **guard rail, not a sandbox** — what bounds the damage is reset-on-failure + own branch + no push. The loop's one seam is `AgentLoopConfig.unattended` (`UnattendedContext`): it decides asks, reaches tools via `ToolContext.unattended`, puts `finish_iteration` on the tool list (`unattendedToolDefs`; it is filtered out of `getToolDefs` so an attended session never sees it), and ends the run once `finish` is set. A model that stops without finishing gets one re-poke, then the iteration is `no_finish` and is reset. `success:true` with no diff and no learnings is `no_op`; learnings-only success is kept in the notes, not committed. A failed commit KEEPS the tree and the next iteration is told to repair it; twice in a row discards it. First Ctrl+C finishes the iteration, second leaves the tree **exactly as it is** — a forced stop must never destroy work. Sidecars (`notes.md`, `decisions.jsonl`, `iterations.jsonl`) live under `~/.freecode/runs/<id>/`, outside the tree and secret-scrubbed per line. **Phase 2 (2026-09-28)**: a spent quota is now WAITED OUT, not fatal. `quota-wait.ts` is pure policy (`planQuotaWait`): a stated reset is slept to +60s grace, no reset means probes at 1/2/4…30 min, one wait is capped at 24h (a weekly limit reports days out), `credits`/`auth` abort at once, and an `unknown` scope is probed 3 times then treated as permanent. Both budgets are checked against what the wait WOULD cost — `--max-wait` (default 12h) and never sleeping past `--until`. **A wait retries the SAME iteration number and is not a failure**, so a night of windows never reaches `maxConsecutiveFailures`; the tree is reset before waiting. `sleepUntil` re-checks the wall clock every minute, because one long `setTimeout` overflows 2^31 ms, a suspended laptop resumes to a timer that never fired, and the tick is where a Ctrl+C lands. `--fallback-model provider/model` spends itself on the FIRST window instead of waiting (opt-in — a night of commits from a model the user did not pick is a surprise). `--verify '<cmd>'` gates every commit (before, not after; output tail into the notes; skipped for learnings-only). `--stop-when` is a prompt section the model answers with `should_stop`. `inhibit.ts` spawns one killable `systemd-inhibit`/`caffeinate` child (`--no-inhibit`), best-effort — a missing binary warns and the run continues. **Phase 3 (2026-09-28)**: the morning. `report.ts` is a **pure fold** (manifest + `iterations.jsonl` + `decisions.jsonl` → markdown), which is what lets `freecode night report [id]` regenerate a report for a run that never reached its own exit path. Order is load-bearing: **needs-you first even when empty** (a section that vanishes is indistinguishable from one a bug dropped), then decisions with **irreversible sorted first**, refusals, waits, the iteration list, diffstat, and a review block ending in `git branch -D` — how to throw the whole night away. An ask with no matching decision prints as "answer not recorded", never hidden; an unpriced model reports "cost unknown", never $0. `freecode night status|report|list|stop [id]` resolves a run **by id or branch** and boots none of the backend. **Crashed-run detection**: `pidAlive()` (`kill(pid,0)`) reconciled on read and persisted, so `status`/`list` agree; a finished run is never re-judged by its long-gone pid. **Resume**: `freecode night` with no objective on a `night/*` branch continues that run — the branch is the handle, being what survives the terminal — keeping the first leg's iteration numbering, commits and wait total. `night stop` sets `cancelRequested` in the manifest, read at the iteration boundary (never signalled: a process killed mid-write is how manifests corrupt). `--worktree` runs in `<repo>-night-worktrees/<slug>` so the user keeps their checkout; `--push` pushes the branch after each commit, by the ORCHESTRATOR, never forced, and a failure is reported once without stopping the night (the commit is already safe locally). **The sidecar logs scrub string FIELDS, not the serialized line** — scrubbing the finished JSON produced a line that was no longer JSON, which the reader skipped, so a `needs_human` item quoting a credential vanished instead of appearing redacted. **Phase 4 (2026-09-28)**: `/night` in the TUI — `night-panel.ts`, a read-only roster (Enter opens the morning report as a markdown message in the transcript; `k` asks a running night to stop). IPC `night.list|report|stop` in `server.ts` boot **none** of the backend: reading a finished run must not start providers and MCP servers. `needsHuman` is counted in CORE, not the frontend — what "needs you" means is the run's business, and four clients must not each decide it — and in the card it **outranks the commit count**, because a night with nine commits and one unanswered question is, to the user, a night with a question in it. The panel deliberately **cannot start a run** (the spec's Phase 4 line said it should): a night started from the TUI would put an unattended loop inside the daemon serving the user's own session, sharing its permission surface; the empty card prints the command instead. A finished run fires the existing **Notification hook** (`night <id> ended: … , N thing(s) need you`), best-effort — a failing hook never changes the run's exit. **Phase 5 (2026-09-28)**: `--detach` / `--at <HH:MM|90m|ISO>` re-exec the same CLI as a detached worker (`supervisor.ts`; `pending` manifest written BEFORE spawn, env handoff `FREECODE_NIGHT_WORKER`/`_RUN_ID`/`_SCHEDULED_FOR`, output to `<run>/worker.log`) that **always** uses a dedicated worktree; `night stop` also cancels a pending scheduled run. `--sandbox` (**on by default**) wraps unattended bash, `--verify` and background shells in bubblewrap (`sandbox.ts`: `/` read-only, `$HOME` hidden, private `/tmp`, run tree the only rw bind, credential-shaped env stripped, network shared); Linux without a working `bwrap` fails closed unless `--no-sandbox`, other OSes warn and keep the envelope only. `--commit-style conventional` → `chore(night): …`. A resume needs its own limit like a fresh start; the first leg's limits are not reloaded (its `--until` is usually past), and `--max-iterations` / `--max-usd` count from the resume point. `evals/night.jsonl` **run 2026-09-28 on MiniMax-M3: 5/5, `finish_iteration` in 14/15 trials (93%)**, clearing the spec's ≥90% Phase-2 bar. It found three envelope bypasses — a deny rule is a string prefix, and a model told it cannot commit respells the verb: chained (`git init && … && git commit`, which `DECISIONS.md` says a prefix rule deliberately will not match), path-qualified (`/usr/bin/git commit`) and env-prefixed (`GIT_AUTHOR_NAME=… git commit`). Fixed in `envelope.ts` (`normalizeSegment` + `deniedSegment`), never in `rules.ts` — that recorded decision is about ALLOW semantics and is load-bearing; the envelope is the only caller whose rules are all denials. Still not a sandbox: an alias, a wrapper script or `eval "$(…)"` defeat it. Phase 0's typed evidence is in `agent/recovery/manager.ts` (`QuotaExhaustedError`, `classifyLoopFailure`) and `LoopResult.failure`. |

**Legacy / not wired into the primary path:** `browser/` (Playwright controller + ChatGPT DOM adapter). The default execution path is API providers, not browser automation. Don't extend the browser layer unless explicitly asked.

## Project Overview

FreeCode is a CLI-driven AI coding assistant. The architecture uses a **thin-client model**: multiple frontends (TUI, VS Code, Web, Tauri desktop) delegate all intelligence to a shared CLI backend (`apps/core`) via JSON-RPC over stdin/stdout.

The backend runs a **single agentic tool-use loop**: the model receives the prompt + project context (file tree, git head) and a set of tools, then drives work by emitting tool calls (read/write/edit/bash/grep/glob/etc.) which the loop executes — in parallel batches where safe — feeding results back until the model stops. Providers are reached through the **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`) with real streaming, native tool calling, extended thinking, prompt caching, and usage accounting.

---

## Architecture

**TUI, VS Code, and Web are pure presentation layers. All business logic lives in `apps/core`.**

> **TUI Framework**: For pi-tui customization, see [`pi-tui.md`](pi-tui.md).

```
        ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
        │     TUI      │  │   VS Code    │  │     Web      │  │  Desktop     │
        │  (apps/tui)  │  │ (apps/vscode)│  │  (apps/web)  │  │(apps/web-app)│
        │  pi-tui      │  │ React webview│  │  Next.js     │  │ Tauri + Vite │
        └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
               └─────────────────┴──── JSON-RPC ───┴─────────────────┘
                                       │ (stdin/stdout)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CLI Backend (apps/core) — ALL intelligence           │
│   Effect runtime + layers · Agent loop · Tools · Context engine · Sessions    │
│   Provider registry · MCP client · Hooks · Skills · Memory · Compaction ·     │
│   Rollout (event sourcing) · Thread store · Bus (PubSub) · Permission profiles│
└──────────────────────────────────────┬────────────────────────────────────────┘
                                       │  Vercel AI SDK
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│   AI Providers (API): ~198 from models.dev — Anthropic · OpenAI · Gemini ·    │
│   MiniMax · DeepSeek · Z.ai · Groq · Mistral · xAI · 170 OpenAI-compatible    │
│                       (legacy: browser automation via Playwright)              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key principle:** Frontends only render and speak IPC. All business logic lives in `apps/core`.

---

## Project Structure

```
freecode/
├── packages/
│   ├── shared/                     # Shared domain types + IPC protocol ONLY
│   │   └── src/
│   │       ├── types.ts             # Message, MessagePart, ToolDef, ToolResult, Session/Provider types
│   │       ├── ipc/protocol.ts     # JsonRpc*, StreamEvent, StreamResponse, METHODS
│   │       └── index.ts
│   ├── ui/                         # Shared UI primitives
│   ├── eslint-config/
│   └── typescript-config/
│
├── apps/
│   ├── core/                       # CLI backend — ALL intelligence
│   │   └── src/
│   │       ├── server.ts            # JSON-RPC stdin/stdout server
│   │       ├── web-server.ts        # HTTP/WS bridge for the web frontend
│   │       ├── cli.ts + cli/        # yargs entrypoint + subcommands (mcp, session, web)
│   │       ├── agent/              # Agentic tool-use loop, subagents, recovery
│   │       ├── providers/          # API provider adapters + registry (AI SDK)
│   │       ├── browser/            # LEGACY Playwright controller + ChatGPT adapter
│   │       ├── context/            # File tree, context compilation, tree cache
│   │       ├── tools/              # Tool defs + execution (see Tools below)
│   │       ├── session/            # Session manager, service, store, prompt
│   │       ├── store/              # Thread store (sqlite / json / remote)
│   │       ├── rollout/            # Event sourcing: recorder / history / replay
│   │       ├── compaction/         # Context window compaction + summarization
│   │       ├── memory/             # Persistent cross-session memory
│   │       ├── skills/             # Skills manager / loader / registry / injection
│   │       ├── hooks/              # Lifecycle hooks (Pre/PostToolUse, Session, Subagent, …)
│   │       ├── mcp/                # MCP client registry, transport, tool conversion
│   │       ├── permission/         # Permission profiles (plan/build/review/explore/danger)
│   │       ├── bus/                # PubSub event bus + IPC bridge
│   │       ├── effect/             # Effect runtime + layers (DI) + loop-health
│   │       └── utils/
│   │
│   ├── tui/                        # Pure UI shell (pi-tui) — components, state, ipc, themes
│   ├── vscode/                     # Pure UI shell — React webview + extension host + ipc
│   ├── web/                        # Pure UI shell — Next.js
│   ├── web-app/                    # Pure UI shell — Tauri desktop (Vite + React + src-tauri)
│   ├── tui-rs/                     # Experimental Rust TUI
│   └── docs/                       # Documentation site (Next.js)
│
└── docs/
    └── specs/                      # Design specifications (v4 is current)
```

### Tools

Built-in tools live in `apps/core/src/tools/` and are registered in `tools/index.ts`:
`read`, `ls`, `write`, `edit`, `glob`, `grep`, `bash`, `bashoutput`, `killbash`, `monitor`, `skill`, `agent` (subagent), `agent_send`, `agent_stop`, `output`, `question`, `webfetch`, `websearch`, `todowrite`, `lsp`, `memory`. MCP tools are registered dynamically at runtime via `registerMcpTool`. Each tool is built through `factory.ts` (`buildTool`) with `parameters`/`behavior`/`permissions`; execution and batching go through `orchestrator.ts` + `batching.ts`. Tools do **not** render — core emits `StreamEvent` data and each frontend draws it (TUI: `apps/tui/src/components/tool-result-message.ts`).

#### Adding a tool — registration checklist

`buildTool` + `index.ts` alone is **not enough**. Several permission/UI tables key off the tool *name*; miss one and the tool fails closed (blocked in read-only modes, or prompts for permission every call). When adding a tool, update:

1. **`tools/<name>.ts`** — the tool via `buildTool`. Declare a `type` on every schema property (providers like MiniMax send numbers/booleans as strings; a missing `type` yields "must be a number" reject-loops — coerce in `execute` too).
2. **`tools/index.ts`** — import + add to the `tools` map.
3. **`permission/mode-policy.ts`** — add to `READONLY_TOOLS` **if** the tool only reads (unlisted ⇒ treated as mutating ⇒ blocked in plan/review/explore).
4. **`permission/rules.ts`** — add to `PATH_TOOLS` (path arg) or `URL_TOOLS` (url arg) so path/url-scoped allow/deny rules match.
5. **`permission/suggest.ts`** — add to `DISPLAY_NAMES` for the capitalized rule label in permission prompts.
6. **Frontends (only for a custom icon; optional):** `apps/tui-rs/src/ui/tool.rs` `tool_icon()`. The TS TUI needs no change unless the tool wants Read/Bash-style content rendering (`apps/tui/src/components/tool-result-message.ts`). Both have catch-all fallbacks, so a tool works without touching them.

---

## Boundary: What Lives Where

| Concern                                    | core | TUI | VSCode | Web |
| ------------------------------------------ | ---- | --- | ------ | --- |
| Agent loop + tool execution                | ✅   | ❌  | ❌     | ❌  |
| Provider adapters (Anthropic/OpenAI/…)     | ✅   | ❌  | ❌     | ❌  |
| Sessions, store, rollout, compaction       | ✅   | ❌  | ❌     | ❌  |
| Context collection (file tree)             | ✅   | ❌  | ❌     | ❌  |
| Hooks, skills, memory, permission profiles | ✅   | ❌  | ❌     | ❌  |
| MCP client                                 | ✅   | ❌  | ❌     | ❌  |
| File read / write / diff                   | ✅   | ❌  | ❌     | ❌  |
| Browser automation (legacy Playwright)     | ✅   | ❌  | ❌     | ❌  |
| Rendering (pi-tui / React / Next.js)       | ❌   | ✅  | ✅     | ✅  |
| IPC client                                 | ❌   | ✅  | ✅     | ✅  |

---

## IPC Protocol

`apps/core` exposes a JSON-RPC 2.0 interface over stdin/stdout. All frontends use the same protocol. Method signatures are declared in `packages/shared/src/ipc/protocol.ts` (`METHODS`); handlers live in `apps/core/src/server.ts`.

### Methods

| Group        | Methods                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| **Tools**    | `tools.list`, `tools.call`                                                                             |
| **Session**  | `session.start`, `session.send` (streaming), `session.stop`, `session.list`, `session.resume`, `session.switch`, `session.fork`, `session.archive`, `session.delete`, `session.export`, `session.import`, `session.upload`, `session.download` |
| **Providers**| `providers.list`, `models.list`                                                                        |
| **Config**   | `config.get`                                                                                           |
| **Memory**   | `memory.list`, `memory.get`, `memory.save`, `memory.delete`, `memory.query`                            |
| **Question** | `question.answer`, `question.reject`                                                                   |
| **Usage**    | `usage.get`                                                                   |

### Streaming

`session.send` streams **`StreamEvent`** values (the modern protocol) back to the frontend:

```typescript
type StreamEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_output"; toolCallId: string; content: string }
  | { type: "tool_complete"; toolCallId: string; toolName: string; result: string; success: boolean; duration_ms?: number }
  | { type: "thinking"; content: string }        // full reasoning (turn end)
  | { type: "thinking_delta"; delta: string }    // incremental reasoning (streaming)
  | { type: "text"; content: string }            // full assistant text (turn end)
  | { type: "text_delta"; delta: string }        // incremental text (streaming)
  | { type: "done"; content: string }
  | { type: "error"; content: string }
  | { type: "question_asked"; requestId: string; sessionId?: string; questions: QuestionSpec[] };
```

The older `StreamResponse` union still exists in `protocol.ts` for backward compatibility — prefer `StreamEvent` for new work.

---

## Type Sharing

Core domain types live in `packages/shared/src/types.ts` (`Message`, `MessagePart`, `ToolDef`, `ToolResult`, `ToolContext`, `ProviderInfo`, `SessionConfig`, `SessionInfo`). No duplicate type definitions in frontends. Provider-internal types (`ExecuteOptions`, `ExecuteResult`, streaming) live in `apps/core/src/providers/types.ts` and stay in core.

---

## Architectural Principles

### Core Design Principles

1. **SOLID** — Single responsibility, Open-closed, Liskov substitution, Interface segregation, Dependency inversion
2. **YAGNI** — Only implement what's needed now; avoid speculative generalization
3. **DRY** — Don't repeat yourself; extract shared logic to single sources of truth
4. **Decomposition** — Each file/module does one thing well; avoid bloated files

### Thin Client Principles

1. **Zero business logic in frontends** — TUI, VSCode, and Web do only rendering and IPC. No provider calls, no file reading, no tool execution.
2. **IPC is the only bridge** — All frontend↔backend communication goes through JSON-RPC. No shared state.
3. **Core owns everything** — Providers, agent loop, context engine, tools, sessions, hooks, skills, memory all live in `apps/core`.

---

## Key Design Decisions

### 1. Long-Running CLI Daemon

`apps/core` stays alive between turns, maintaining session state, the provider connection, and the project context cache. This enables fast subsequent turns without re-initialization.

### 2. Single Agentic Tool-Use Loop

There is no "ask which files, then send them" pre-pass. The loop collects lightweight project context (name, path, cached file tree, git head — see `context/tree-cache.ts`, invalidated after any mutating tool) and hands the model a tool set. The model then drives the work by emitting tool calls, executed in parallel batches where safe (`tools/batching.ts`, `tools/orchestrator.ts`) and looped back until the model stops.

### 3. Provider Abstraction over the AI SDK

Providers implement a common `AIProvider` interface (`providers/types.ts`) and self-register into the registry (`providers/registry.ts`). Swapping Anthropic ↔ OpenAI ↔ Gemini ↔ MiniMax requires no change to the loop. Streaming, tool calls, extended thinking, and prompt caching are normalized in `providers/streaming.ts`.

### 4. Loop-Health Monitoring

The loop tracks repeated identical tool calls, stagnant turns (no file changes), and oscillation (editing the same file repeatedly) to detect and break stuck patterns (`effect/loop-health.ts`, `updateLoopHealth` in `agent/loop.ts`).

### 5. Permission Profiles & Diff Preview

Tool execution is gated by permission profiles (`permission/profiles.ts`: plan/build/review/explore/danger) and surfaced through the `PermissionRequest` hook. Mutating changes are shown before writing.

### 6. Durable Sessions

Sessions are persisted through the thread store (`store/`, sqlite/json/remote) and rollout event sourcing (`rollout/`), enabling `resume`, `fork`, `export/import`, and `upload/download`. Long contexts are compacted (`compaction/`).

---

## File Naming Conventions

| Type                 | Convention | Example                          |
| -------------------- | ---------- | -------------------------------- |
| React components     | PascalCase | `ChatLayout.tsx`, `CodePart.tsx` |
| Stores               | kebab-case | `chat-store.ts`                  |
| IPC client           | camelCase  | `ipc/client.ts`                  |
| Provider adapters    | camelCase  | `anthropic.ts`, `gemini.ts`      |
| Tool implementations | camelCase  | `read.ts`, `write.ts`            |
| Hook handlers        | PascalCase | `PreToolUse.ts`, `SessionStart.ts` |

---

## Adding New Features

### 1. Identify the domain

- **Providers** (`apps/core/src/providers/`) — AI SDK adapters, model routing
- **Agent** (`apps/core/src/agent/`) — the tool-use loop, subagents, recovery
- **Tools** (`apps/core/src/tools/`) — tool definitions and execution
- **Context** (`apps/core/src/context/`) — file tree, context compilation
- **Session/Store/Rollout** (`apps/core/src/{session,store,rollout}/`) — persistence, lifecycle
- **Hooks / Skills / Memory / MCP** (`apps/core/src/{hooks,skills,memory,mcp}/`) — extensibility
- **UI** (`apps/tui`, `apps/vscode`, `apps/web`, `apps/web-app`) — rendering only

### 2. Check existing patterns

Before adding code, verify:

- Does a similar pattern exist? Follow it. (Tools → copy an existing tool + `factory.ts`; providers → copy an existing adapter + self-register.)
- Is this functionality needed in more than one frontend? Types go in `packages/shared`.
- Does this component do more than one thing? Decompose.

### 3. File limits

If a file exceeds ~150 lines, decompose (extract sub-components, move helpers to utils, split logic). Note `agent/loop.ts` is an intentional exception — the loop is a cohesive state machine.

---

## Eval-Driven Development

Behavior changes are verified by evals, not by eyeballing a transcript. **Read
`EVAL.md` before running anything — every eval case is a real paid agent turn.**

- **Changed the agent's behavior** (prompt, tool description, system message,
  loop, redirect, recovery)? Run the A/B comparison EVAL.md prescribes for that
  change class before calling it done. `eval ab` is a report, not a gate — read
  the delta, don't just check the exit code.
- **Found a real failure in a session?** Harvest it: `freecode eval add
  <session-id> [--turn N] --write`, then fill in `failureCategory` and
  `whyModelBacked` (the registry audit in `dataset.test.ts` enforces both).
  Sessions that expose bugs become cases; bugs without cases regress silently.
- **New deterministic assertion?** That's a `*.test.ts` next to its code, not an
  eval case. Evals are only for what needs a real model turn.
- **Release ritual** stays `pnpm eval:gate` (needs `FREECODE_JUDGE_PROVIDER`).
  Nightly CI runs the trajectory suite gated; a red nightly is a regression to
  triage, not noise — quarantine (`evals/quarantine.txt`) is for flakes only,
  with a one-line reason.
- Never edit a coding fixture's `immutable` checker to make a case pass, and
  never delete or weaken a failing case without understanding why it fails.

## Key Invariants

1. **Frontends are dumb** — TUI/VSCode/Web only render UI and send/receive IPC. All logic is in `apps/core`.
2. **IPC is the only bridge** — No shared state between frontends and backend.
3. **Types are centralized** — Core domain types live in `packages/shared`. No duplicate definitions.
4. **Providers are swappable** — Adapters in `providers/` implement `AIProvider` and self-register; the loop never hard-codes a provider.
5. **Tools are uniform** — Every tool is built via `factory.ts` and executed through the orchestrator; MCP tools register through the same registry.

---

## Binary Builds & Distribution

- **Release binary = `pnpm build:bun`** (`scripts/build-bun.mjs`). This is the only distributable binary: it bakes `FREECODE_BUNDLED=1` and bundles core, so it runs from anywhere. The release workflow (`.github/workflows/release.yml`) publishes these.
- **`pnpm build:sea`** (`scripts/build-sea.mjs`) is a **TUI-shell-only, repo-root-only** dev artifact. It does *not* set `FREECODE_BUNDLED` and does *not* bundle core, so it spawns core from disk and only works inside the monorepo.
- **Never `cp apps/tui/dist/freecode` (the SEA build) into `~/.freecode/builds/versions/`.** That directory is managed by the installer and expects the bun release binary; dropping a SEA build there breaks `freecode` everywhere except the repo root. For local end-to-end testing use `pnpm build:bun` (produces the self-contained `dist/freecode-bun`), or just run from the repo.

---

## Deferred Items

- **MCP server (expose)** — an MCP *client* exists (`mcp/`); serving FreeCode tools *as* an MCP server is not done.
- **Rust TUI** — `apps/tui-rs` is experimental; pi-tui remains the primary TUI.
- **Browser providers beyond ChatGPT** — the browser path is legacy; extend only if explicitly requested.

Don't implement these unless explicitly requested.

# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
