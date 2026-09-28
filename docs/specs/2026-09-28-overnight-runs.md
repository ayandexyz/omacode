# Overnight Runs — `freecode night`

> **Status:** Built through Phase 5 (2026-09-28). The phase notes in §8 are the
> implementation record; remaining measurements and open questions are called out there.
> **Branch:** `autonomous`.
> **Supersedes:** Phases 1–5 of `2026-08-10-autonomous-runs-design.md`. Its Phase 0
> (`autonomous/types.ts`, `budget.ts`, `run-store.ts`) is kept and extended; its
> §4.4 (detached child process), §4.8 (shell allowlisted to the verify command
> only) and §0's "FreeCode has no OAuth" premise are replaced — see §3.
> **Prior art:** `gnhf` ("good night, have fun"), MIT, TypeScript, local clone
> `~/Projects/githubProjects/gnhf` at `8913e1c` (v0.1.50). Primary files
> `src/core/orchestrator.ts` (1176 lines), `src/templates/iteration-prompt.ts`,
> `src/core/sleep.ts`, `src/core/agents/claude.ts`, `VISION.md`.
> **Related specs:** `2026-09-05-anthropic-oauth-provider.md` (subscription windows),
> `2026-07-18-permission-rules.md` (the envelope is built from its rules),
> `2026-09-12-harness-bench.md` (auto-poke, reused for the finish contract),
> `2026-09-23-checkpoints-rewind.md` (why checkpoints are off inside a run).

---

## 0. Read this first (plain language)

The user types one command before going to sleep:

```sh
freecode night "reduce the TUI's render cost without changing behaviour" --until 07:00
```

and in the morning finds:

1. a branch `night/reduce-the-tui-render-cost` with **one small commit per step
   that worked** — each can be reviewed, cherry-picked or reverted alone;
2. a **morning report** that leads with what needs them (things the agent could
   not decide), then the **decisions it made on its own** and why, the actions it
   was **refused**, what it cost, and how long it waited on a spent quota;
3. nothing touched outside that branch: `main`, the user's checkout, the remote.

Between those two moments nobody is watching, so the run has to handle everything
a human would normally handle, **without hanging and without doing anything that
cannot be undone**:

| Situation at 3 a.m. | Attended FreeCode today | `freecode night` |
| --- | --- | --- |
| Model asks a question | TUI modal, waits for the user | Answered by the model itself under a stated rule, **recorded** for the morning |
| Tool needs permission | Prompt, waits up to 30 min, then deny | Decided instantly by a fixed **safety envelope**; denials recorded |
| Subscription 5-hour window spent | Turn fails (quota is fatal by design) | Iteration rolled back, run **sleeps until the window resets**, then retries |
| API-key credits exhausted | Turn fails | Run **aborts** — waiting cannot fix it |
| Model goes in circles | Loop-health warns, human intervenes | Iteration fails and is rolled back; 3 in a row ends the run |
| A step broke the build | Human notices | Iteration rolled back (`git reset --hard`), next one starts clean |
| Laptop wants to sleep | Sleeps | Sleep inhibited for the run's lifetime |
| Objective is done | Human says stop | Model reports it, or `--stop-when` condition met, run ends |

The unit of work is an **iteration**: a fresh agent session that does one small,
verifiable step, then reports a structured result. The orchestrator — not the
model — commits, rolls back, keeps notes, waits, and decides when the night is over.

---

## 1. Problem

1. **Every run dies with its human.** `freecode run` is one turn; the TUI needs a
   person at the keyboard. There is no way to hand over "work on this until
   morning" (spec 2026-08-10 §1 still stands).
2. **Headless FreeCode hangs or fails on the first human-shaped event.**
   - A `question` call with no frontend attached waits `PROMPT_TIMEOUT_MS`
     (30 min, `bus/index.ts:299`) before rejecting. `question` is in
     `READONLY_TOOLS` and is not filtered from headless runs.
   - A permission `ask` either becomes a blanket allow (`--yes`) or a denial
     (`permission/prompt.ts:44`). Neither is recorded anywhere a human reads.
3. **A spent quota is fatal, and the reset time is thrown away.**
   `isQuotaExhaustedError` short-circuits retries (`agent/recovery/manager.ts:201`)
   and the error is re-thrown as a plain `Error` (`:454-458`), which deliberately
   drops the SDK error (to avoid leaking `requestBodyValues`) — and with it the
   response headers. Correct when a human is watching; wrong for a subscription
   user whose window resets at 04:12.
4. **`LoopResult` cannot say why a turn failed** (`agent/types.ts:324`) —
   `success: false` plus a message string. An orchestrator has to tell "quota
   window" from "credits gone" from "model gave up" from "user interrupt".
5. **A stuck loop never stops itself** (ROADMAP "Unattended mode":
   `effect/loop-health.ts` never returns `stop`; `maxIterations` is `Infinity`
   outside headless). Tolerable when a human watches; not overnight.

## 2. Goal

### 2.1 Success criteria

1. `freecode night "<objective>"` runs unattended until a limit, a stop condition,
   or a permanent error ends it — and **never blocks on a human**.
2. Every successful iteration is exactly one commit on the run's branch; every
   failed one leaves the branch exactly as the previous success left it.
   **No work is ever silently lost** (§5.6 lists the only cases where
   uncommitted work is left behind, and the report names each one).
3. Every decision the agent made on the user's behalf, and every action it was
   refused, appears in the morning report.
4. A spent subscription window pauses the run and resumes it after the reset
   without counting as a failure; a permanent billing/auth error aborts at once.
5. The run never pushes, never force-pushes, never touches a branch other than
   its own, and never runs in `danger` mode — unless the user passed an explicit
   flag for the first of those (`--push`) and none exists for the others.
6. The user can stop it: Ctrl+C once = finish the current iteration and stop;
   twice = stop now. `SIGTERM` = stop now.

### 2.2 Non-goals

- **Detached/daemonised execution.** v1 runs in the foreground of a terminal the
  user leaves open (plus sleep inhibition). gnhf ships exactly this and it covers
  "overnight". Detach (old spec §4.4) is Phase 5, only if asked for.
  *(Superseded: Phase 5 was asked for and built 2026-09-28 — `--detach` / `--at`.
  Foreground remains the default.)*
- **Ambient / self-scheduled runs** (old spec Tier B). Still deferred.
- **Opening PRs, merging, releasing.** The run produces a branch; publishing is
  the user's act (gnhf VISION: "opening PRs belongs to outer automation").
- **Judging the night's work.** The report presents; it does not grade. An
  optional `--verify` command is a gate the *user* chose, not a reviewer.
- **Running other vendors' CLIs.** gnhf is agent-agnostic because it wraps CLIs.
  FreeCode *is* the agent; the orchestrator calls `runEffect` in-process, which is
  what buys typed errors, a finish tool and a permission envelope (§3.2).

### 2.3 What already exists and is reused

| Piece | Where | Used for |
| --- | --- | --- |
| Four-way budget, cache reads excluded | `autonomous/budget.ts` | USD / token / time ceilings |
| Atomic run manifest + runs dir | `autonomous/run-store.ts` | `~/.freecode/runs/<id>/` |
| Headless loop wiring | `cli/commands/run.ts` | Template for booting providers/MCP/hooks and calling `runEffect` |
| `autoApproveAsks` / `sessionGrants` | `agent/loop.ts:308-314` | The envelope's plumbing |
| Permission rule evaluator | `permission/rules.ts`, `evaluate.ts` | Envelope deny/allow rules |
| Auto-poke machinery | `agent/signals/` | One re-poke when the model stops without finishing |
| Per-session shell registry | `tools/shells/` | Kill everything an iteration left running |
| Pricing | `providers/pricing.ts` | Cost per iteration, `maxUsd` |
| Rollout + trace | `rollout/` | Every iteration is a normal session → `freecode trace <id>` works |
| Secret filter | `memory/graph/secret-filter.ts` | Scrub notes/decisions/report |

---

## 3. What we take from gnhf, and what we change

### 3.1 Taken as-is (with the gnhf reference)

| Idea | gnhf | Why it's right |
| --- | --- | --- |
| Many short iterations, not one long session | `orchestrator.ts` loop | A bad step costs one rollback, not a poisoned 3-hour context; each step reviewable |
| Iteration contract: smallest verifiable step, validate, don't commit, stop background processes, then report | `iteration-prompt.ts` | Makes "done with this step" a structured event |
| No-op iteration = failure | prompt §Output `success` | Stops the loop spinning on empty turns |
| Orchestrator owns commit / reset / notes | `orchestrator.ts`, `run.ts:appendNotes` | The model cannot corrupt its own history |
| `notes.md` as cross-iteration memory | `run.ts:408` | Fresh context each iteration, continuity via notes |
| 3 consecutive failures → abort | `maxConsecutiveFailures: 3` | Bounded waste when the objective is out of reach |
| Wait out a usage window; retry the same iteration; not a failure | `RATE_LIMIT_*` constants, `orchestrator.ts:95-115` | The night resumes on its own |
| Resume at reset + 60 s; escalating 1→30 min probe when no reset time; 24 h per-wait cap; total-wait leash | same | Clock skew, stale resets, `setTimeout` 2³¹ ms overflow |
| Permanent errors abort at once | `PermanentAgentError` | Don't burn the night retrying a dead card |
| Sleep inhibition | `sleep.ts` (`systemd-inhibit`, `caffeinate`) | Otherwise the laptop sleeps at 00:30 |
| Commit failure preserves work; next iteration repairs | `CommitFailedError` path | "No work is ever lost" |
| Unsigned commits | `commitAll` | A GPG/SSH signing prompt would hang the night |
| Clean tree required; dedicated branch; optional worktree; never force-push/auto-pull | README §How It Works | Never start on work it can't protect |
| Graceful first Ctrl+C, hard second | `interrupt-state.ts` | User holds the leash |
| `--stop-when "<condition>"`, persisted across resume | prompt §Stop Condition | Natural-language finish line |
| Exit summary with review commands | `exit-summary.ts` | The morning starts from one screen |

### 3.2 Changed, because FreeCode owns the agent loop

| gnhf | FreeCode | Why |
| --- | --- | --- |
| Final JSON parsed out of the agent's stdout (with fence/prose recovery, `json-extract.ts`) | A **`finish_iteration` tool** registered only in unattended runs (§4.4) | We own the tool set; a tool call is schema-validated, a JSON blob in prose is a guess |
| Agent run in bypass-permissions mode; safety = branch + reset | A **permission envelope** (§4.6) evaluated per call, denials recorded | Branch isolation doesn't stop `git push`, `rm -rf ~`, or `npm publish`; we can, cheaply |
| Questions avoided (non-interactive agents don't ask) | `question` returns instantly with the unattended rule; decisions recorded (§4.5) | The user explicitly wants to learn in the morning what was decided for them |
| Rate-limit reset read from Claude CLI's `rate_limit_event` | Reset read from provider **response headers** on the 429, carried on a typed error (§4.7) | We call the API, not a CLI |
| Instruct the agent to stop background processes | Prompt asks **and** the orchestrator disposes the iteration's `ShellRegistry` | Enforced, not requested |
| Token cap only | Token **and USD** cap (`budget.ts`), `--until` wall-clock deadline | API-key users pay per token |
| Notes and run metadata under `.gnhf/runs/` inside the repo (git-ignored) | Under `~/.freecode/runs/<id>/` | Nothing to ignore, nothing to leak into the branch |
| Commit message `gnhf <n>: <summary>` | `night <n>: <summary>` (conventional preset later) | — |

### 3.3 Changed from the 2026-08-10 spec

| 2026-08-10 | Here | Why |
| --- | --- | --- |
| §0 "no OAuth, every turn metered" | OAuth subscription exists (spec 2026-09-05); windows reset | Waiting out a window is now the main overnight blocker |
| One long session, gate decides "done" | Iterations; model reports done / `--stop-when`; optional `--verify` gates each **commit** | Gate-decides-done had no answer for "what's the next step" |
| §4.4 detached child as Phase 2 | Foreground + sleep inhibition by default; detach built in Phase 5 as opt-in `--detach` / `--at` | gnhf proves the foreground form covers a night |
| §4.8 shell allowlisted to the verify command only | Envelope: broad allow inside the worktree, deny list for irreversible/outward actions | An agent that can only run `pnpm test` can't do real work |
| Task cards written by the model mid-run | `finish_iteration` result **is** the task card | One structured record per iteration, no second channel |
| `report.md` generated at end | Kept; plus live `notes.md`, `decisions.jsonl`, `iterations.jsonl` | Report can be regenerated from the logs after a crash |

---

## 4. Design

### 4.1 Where it lives

```
apps/core/src/autonomous/
├── types.ts           # extended: NightRun, IterationRecord, Decision, Denial, WaitRecord
├── budget.ts          # exists — unchanged
├── run-store.ts       # exists — add notes/decisions/iterations paths
├── orchestrator.ts    # the iteration state machine (§4.2) — pure over injected deps
├── iteration.ts       # run ONE iteration: new session → runEffect → IterationOutcome
├── prompt.ts          # iteration prompt builder (§4.3)
├── envelope.ts        # unattended permission policy (§4.6)
├── decisions.ts       # decisions.jsonl + denials append/read
├── quota-wait.ts      # classify a failed iteration, compute the wait (§4.7)
├── git.ts             # clean-check, branch/worktree, commit, reset, diffstat
├── inhibit.ts         # sleep inhibition (§4.9)
├── notes.ts           # notes.md append (secret-filtered)
└── report.ts          # morning report (§4.10)
apps/core/src/tools/finish-iteration.ts   # the finish tool (§4.4)
apps/core/src/cli/commands/night.ts       # CLI surface (§4.11)
```

`orchestrator.ts` takes its effects as an injected interface
(`runIteration`, `git`, `clock.sleep`, `store`) so the whole state machine —
including waits, interrupts and resume — is unit-testable with fakes and a fake
clock, the way gnhf's 2600-line `orchestrator.test.ts` tests theirs.

### 4.2 The loop

```
 preflight ─► git clean? repo? not detached HEAD? provider resolvable? mode ≠ danger?
    │         create/resume branch night/<slug> (or worktree), write manifest, inhibit sleep
    ▼
 ┌─► budget / deadline / stop requested? ──yes──► finish
 │      │ no
 │      ▼
 │   iteration n: fresh session, prompt = objective + notes + contract (§4.3)
 │      │  runEffect(...)  — envelope answers permissions, question answers itself
 │      ▼
 │   classify outcome (§4.7)
 │      ├─ finished, success=true ──► [--verify passes?] ──► commit "night n: …"
 │      │                               append notes, decisions; failures=0
 │      │                               should_stop or --stop-when met? ──► finish
 │      ├─ finished, success=false ─► reset --hard; notes (learnings kept); failures++
 │      ├─ no finish call after 1 re-poke / turn cap / loop stuck ─► reset; failures++
 │      ├─ commit failed ───────────► keep tree; next prompt carries "repair" note
 │      ├─ usage window spent ──────► reset; NOT a failure; sleep until reset (§4.7)
 │      ├─ permanent (credits/auth) ► reset; abort
 │      └─ interrupted ─────────────► graceful: finish iteration first / hard: stop now
 │      ▼
 └── failures ≥ maxConsecutiveFailures (3)? ──yes──► abort
```

Per-iteration guard rails, all passed to `createAgentLoopEffect`:

- `maxIterations` (loop turns) per iteration, default **60**. A step that takes
  60 model turns is not "the smallest verifiable step".
- Per-iteration wall clock, default **30 min**, via the loop's abort signal.
- `agentMode: "build"`. `danger` is refused at preflight.
- Subagents allowed (read-only by default, as today). Background subagents and
  shells are stopped at iteration end.
- Checkpoints **off** for night sessions — the run's git commits are the
  checkpoints; capturing a shadow tree per iteration would double the work.
- Memory: `autoRecall` on (useful context, cheap); `autoExtract` **off** during
  iterations (per-turn cost, and `notes.md` covers the run). §9 Q3.

### 4.3 Iteration prompt

Adapted from gnhf's `iteration-prompt.ts`; the output section is replaced by the
finish tool. Sent as the user message of a fresh session:

```
You are working unattended towards the objective below. No human will read or
answer anything until morning. This is iteration {n} of an overnight run.

## How to work
1. Read the run notes below: what previous iterations did and learned.
2. Pick the next smallest unit of work that is individually verifiable and moves
   the objective forward. That is this iteration's whole scope.
3. If an attempt does not move the needle, stop pivoting: record what you learned
   and finish with success=false.
4. Validate your change: run the build, tests, linters or formatters that exist.
5. Do NOT commit, push, switch branches, or rewrite git history — the harness
   commits for you after you finish.
6. Stop any background process you started.
7. Then call finish_iteration exactly once. It ends the iteration.

## Decisions
Nobody can answer questions. When you face a choice, decide it yourself: prefer
the option that is reversible and inside the objective's scope; record it in
finish_iteration.decisions. If a choice truly needs the human (credentials, a
product call, something irreversible), do not guess — list it in
finish_iteration.needs_human and work on something else.

## Permissions
Actions outside this run's branch and working tree are refused automatically —
pushing, publishing, installing globally, writing outside the project. A refusal
is final for this run; work around it or list it in needs_human.

{if repairPending}## Repair first
The previous iteration's changes could not be committed: {commitError}.
The uncommitted changes are still in the tree. Fix what blocks the commit first.

{if stopWhen}## Stop condition
The user will consider the run finished when: {stopWhen}
Set should_stop=true only when that is fully true after this iteration.

## Run notes
{notes.md, tail-trimmed to NOTES_BUDGET_CHARS}

## Objective
{objective}
```

`NOTES_BUDGET_CHARS` (default 24k) keeps the first iteration and the most recent
ones when notes grow; the full file stays on disk. The prompt is the user turn,
not system content, so it never disturbs the cached system prefix (the
ephemeral-tail invariant is untouched).

### 4.4 `finish_iteration` tool

Registered **only** when the loop runs with an `unattended` context (never visible
in attended sessions, so no tool-list change for anyone else).

```ts
finish_iteration({
  success: boolean,            // meaningful progress; false ⇒ changes discarded
  summary: string,             // one sentence — becomes the commit subject
  key_changes: string[],       // material outcomes, grouped by logical unit
  key_learnings: string[],     // surprising, not already in notes
  decisions: { question: string; choice: string; why: string; reversible: boolean }[],
  needs_human: string[],       // blocking items only the user can resolve
  should_stop?: boolean,       // present when --stop-when is set, or objective fully met
})
```

- Declares a `type` on every property and coerces string booleans in `execute`
  (CLAUDE.md tool checklist — MiniMax sends `"true"`).
- Calling it ends the loop run after the current batch (same exit path the loop
  uses for a model stop), and stores the parsed result on the unattended context.
- Registration checklist: `tools/index.ts` (conditional), **not** in
  `READONLY_TOOLS` (it changes run state), `suggest.ts` display name, no path/url.
- **Missing finish:** if the model stops without calling it, one re-poke through
  the auto-poke path (`synthetic: "auto_poke"`, text: "Call finish_iteration now
  to end this iteration."). Still missing ⇒ iteration failed with reason
  `no_finish`, changes reset. This is the risk to measure first (§8 Phase 1
  eval): how reliably each provider calls a finish tool.

### 4.5 Questions

In an unattended loop, `question` does not touch the bus. It records the call to
`decisions.jsonl` as `{kind:"asked", iteration, questions, options}` and returns
immediately:

> No human is available (unattended run). Decide this yourself: choose the option
> you would recommend, preferring the reversible one within scope, state your
> choice in one line, and record it in `finish_iteration.decisions`. If it truly
> cannot be decided without the user, add it to `needs_human` and move on.

The report pairs each `asked` record with the iteration's reported decision. An
asked question with no matching decision is shown as **"asked — answer not
recorded"**, never hidden. We deliberately do not have the harness pick "option
1": the model wrote the options, their order carries no guaranteed meaning, and
a harness pick would be a decision nobody made.

### 4.6 Permission envelope

Replaces both `--yes` (blanket allow) and the bus prompt (hangs/denies silently).
Built from the existing rule system so there is one evaluator, not two:

1. **Deny rules** (seeded for the night session, highest precedence):
   - `Bash(git push:*)`, `Bash(git commit:*)`, `Bash(git reset:*)`,
     `Bash(git checkout:*)`, `Bash(git switch:*)`, `Bash(git rebase:*)`,
     `Bash(git merge:*)`, `Bash(git branch -D:*)`, `Bash(git worktree:*)`,
     `Bash(git tag:*)`, `Bash(git config:*)` — the orchestrator owns git.
   - `Bash(gh:*)`, `Bash(npm publish:*)`, `Bash(pnpm publish:*)`,
     `Bash(cargo publish:*)`, `Bash(docker push:*)` — nothing leaves the machine.
   - `Bash(sudo:*)`, `Bash(npm i -g:*)`, `Bash(npm install -g:*)`,
     `Bash(pnpm add -g:*)` — no system changes.
   - `Bash(rm -rf /*)`, `Bash(rm -rf ~*)`.
   - `--push` removes nothing: pushing is done by the orchestrator after a
     commit, never by the model.
2. **Path rule:** `write`/`edit` (and any `PATH_TOOLS` mutation) is allowed iff
   the resolved target is inside the run's working tree (branch checkout or
   worktree); otherwise denied.
3. **Everything else** that the mode would `ask` about ⇒ **allow**, logged at
   debug. Read tools, `webfetch`/`websearch`, and in-tree bash run as in `build`.
4. The user's own `deny` rules from settings still apply (they only narrow).
5. User extras: `--allow '<rule>'` / `--deny '<rule>'` (repeatable) as in `run`.

Every denial is appended to `decisions.jsonl` as
`{kind:"denied", iteration, tool, target, rule}` and returned to the model with
the "refusal is final, work around it or list in needs_human" text. It never
waits.

**Honest limit:** the envelope is a guard rail, not a sandbox. `bash` can still
`cd` elsewhere or `curl` something; prefix rules match commands, not effects.
What actually bounds the damage: (a) the orchestrator resets every failed
iteration, (b) the run is on its own branch/worktree, (c) nothing is pushed
unless `--push`, (d) the deny list covers the irreversible and outward-facing
commands a model reaches for in practice. §9 Q1 asks whether to add an OS-level
sandbox (bubblewrap) later; the eval `sandbox.ts` precedent says bash escaping is
already a known gap (TODO.md).

### 4.7 Classifying a failed iteration, and waiting on quota

`LoopResult` gains a typed failure field (the one loop change this needs beyond
the unattended context):

```ts
failure?:
  | { kind: "quota"; scope: "window" | "credits" | "unknown"; resetAt?: number; provider: string }
  | { kind: "auth" }                    // 401/403 that isn't the OAuth org fallback
  | { kind: "interrupted" }
  | { kind: "turn_cap" } | { kind: "timeout" } | { kind: "stuck" }
  | { kind: "provider"; message: string }   // recovery exhausted, other errors
```

To fill `quota`, `recovery/manager.ts:454` throws a `QuotaExhaustedError` class
instead of a plain `Error`. It keeps the current property — **no
`requestBodyValues`, nothing that can spill the conversation** — and adds only:

- `resetAt`: from `retry-after-ms` / `retry-after` / the provider's rate-limit
  reset header(s), parsed where the existing `retryAfterMs` reads headers
  (`manager.ts:260`). Which headers Anthropic's OAuth path actually sends on a
  spent window is **unmeasured** — Phase 0 records them (§8).
- `scope`: `credits` for an API-key "credit balance is too low" / OpenAI
  "exceeded your current quota" / 402; `window` for an OAuth provider or a
  message/headers naming a reset; `unknown` otherwise.

Orchestrator policy (constants mirror gnhf's):

| Failure | Action | Counts as failure? |
| --- | --- | --- |
| `quota/window`, `resetAt` in future | reset tree; sleep until `resetAt + 60 s` (cap 24 h per wait); retry same iteration number | no |
| `quota/window`, no or past `resetAt` | reset; probe after 1, 2, 4 … min, capped 30 min | no |
| `quota/unknown` | as above, but abort after 3 probes that all fail | no |
| `quota/credits`, `auth` | reset; **abort** — `permanent_error` | — |
| total waiting would exceed `--max-wait` (default 12 h) | abort — `wait_budget` | — |
| waiting would cross `--until` | abort — `deadline` (don't sleep past morning) | — |
| `turn_cap`, `timeout`, `stuck`, `no_finish`, `provider` | reset | yes |
| `interrupted` | see §4.8 | no |

`--fallback-model <provider/model>` (opt-in, off by default, like gnhf): on the
first `quota/window` of the night, retry the iteration on the fallback instead of
waiting; the report says which iterations ran on it. Without the flag the run
never changes models.

Each wait writes `{kind:"wait", from, until, reason, provider}` to
`iterations.jsonl` and a `run.wait` rollout event, and updates the terminal
line ("waiting for anthropic window — resumes 04:13").

### 4.8 Interrupts and stop

- **First Ctrl+C:** graceful — mark `stopRequested`; the current iteration
  finishes and is committed or reset normally; a wait ends immediately.
- **Second Ctrl+C / `SIGTERM`:** abort the loop's signal now. The tree is left
  **as is** (not reset) and the report says "iteration n interrupted — N files
  uncommitted on night/…". Not resetting is deliberate: a forced stop must never
  destroy work (gnhf VISION §1).
- **`freecode night stop [id]`** from another terminal sets `cancelRequested` in
  the manifest (existing `requestCancel`); checked between iterations and each
  minute during a wait = graceful stop.

### 4.9 Keeping the machine awake

`inhibit.ts`, started after preflight, released in every exit path:

- Linux: spawn `systemd-inhibit --what=idle:sleep --who=freecode --why="night run"
  --mode=block sleep infinity` as a child; kill it at exit. (Simpler than gnhf's
  self re-exec; avoids its documented worktree-cleanup leak.) Missing binary ⇒
  one warning line, run continues.
- macOS: `caffeinate -i -w <our pid>`.
- Windows: out of scope for v1 (warning only).
- `--no-inhibit` disables.
- Closing the lid still suspends on most laptops regardless — the preflight
  prints that once.

### 4.10 The morning report

Written to `~/.freecode/runs/<id>/report.md` at exit, regenerable from the logs
with `freecode night report <id>` (so a crashed run still gets one). Also printed
as the terminal exit summary. Order is what the user needs first:

```
# Night run 7f3c — reduce the TUI's render cost
Stopped: deadline 07:00 · 9h02m · 14 iterations (9 ok, 4 failed, 1 interrupted)
Cost $3.84 (anthropic/claude-opus-5-5, oauth) · waited 2h11m on usage window
Branch night/reduce-the-tui-render-cost · 9 commits · 23 files, +412 −198

## Needs you (2)
- it.6  Snapshot tests need updated golden files — regenerate or keep the old ones?
- it.11 `pnpm bench:tui` needs a display; could not measure frame time headless.

## Decisions made for you (5)
- it.3  Memoise per-line width, not per-component   — reversible — "fewer invalidations…"
- it.8  Kept the old render path behind a flag      — reversible — …
- it.9  asked "drop the legacy theme?" — answer not recorded
…
## Refused actions (3)
- it.4  bash `git commit -m …`           rule Bash(git commit:*)
- it.7  write /home/…/.config/…          outside run tree
## Iterations
 1 ✓ 3a1c2e0  Cache wrapped lines per width
 2 ✗          Tried virtualising list; slower (learned: …)
…
## Review
  git log --oneline main..night/reduce-the-tui-render-cost
  git diff main...night/reduce-the-tui-render-cost --stat
  freecode trace <session-id-of-iteration>     # any iteration's full trace
  git branch -D night/…                        # discard the whole night
```

All free text (summaries, decisions, needs_human, learnings) passes through
`containsSecret` before it is written anywhere.

### 4.11 CLI surface

```
freecode night "<objective>"            start (objective also from stdin / --file prd.md)
  --until <HH:MM|duration>                wall-clock deadline (e.g. 07:00, 8h)
  --max-iterations <n>
  --max-usd <n>                           required for API-key providers unless --until given (§4.12)
  --max-tokens <n>                        billed tokens, cache reads excluded
  --max-wait <duration>                   total quota-wait leash (default 12h)
  --stop-when "<condition>"
  --verify "<command>"                    must exit 0 before each commit
  --fallback-model <provider/model>
  --worktree                              run in <repo>-night-worktrees/<slug>
  --push                                  push the run branch after each commit (never force)
  --detach                                detached worker; always uses a dedicated worktree
  --at <HH:MM|duration|ISO>               scheduled detached start
  --[no-]sandbox                          bubblewrap filesystem sandbox (on by default on Linux)
  --commit-style night|conventional       commit-subject preset
  --model / --effort / --allow / --deny   as in `freecode run`
  --no-inhibit
freecode night                           on a night/* branch: resume that run
freecode night status [id]               manifest summary; detects a dead pid → crashed
freecode night report [id]               print/regenerate the morning report
freecode night list
freecode night stop [id]                 graceful stop request
```

Output while running: one status line (iteration, elapsed, cost, commits,
state: working / waiting until …), assistant text suppressed; `--verbose` streams
like `freecode run`. No TUI in v1 (§8 Phase 4).

### 4.12 Budgets and defaults

| Limit | Default | Notes |
| --- | --- | --- |
| `--until` / timeout | none, but **one of** `--until`, `--max-iterations`, `--max-usd` is required | an unbounded night must be a choice |
| `--max-usd` | none for OAuth (the window is the ceiling); for API-key providers the preflight prints the per-iteration estimate from recent sessions and requires either `--max-usd` or `--until` | old spec §4.9's cost confirmation, as a flag instead of a dialog |
| consecutive failures | 3 | config `night.maxConsecutiveFailures` |
| per-iteration turns | 60 | |
| per-iteration time | 30 min | |
| `--max-wait` | 12 h | |

Budget checks use `budget.ts` against the running total after every iteration
(and mid-iteration for USD via the existing spend breaker).

### 4.13 Storage

```
~/.freecode/runs/<runId>/
├── manifest.json      # existing RunManifest + night fields (branch, objective, stopWhen,
│                      #   iteration counters, pid, status, stopReason, sessionIds[])
├── notes.md           # orchestrator-written, fed to each iteration
├── iterations.jsonl   # one line per iteration outcome + one per wait
├── decisions.jsonl    # asked / decided / denied / needs_human
└── report.md          # morning report
```

Nothing is written into the repository except the commits themselves. Resume
finds the run by branch name (`manifest.branch`). `FREECODE_RUNS_HOME` (exists)
relocates the directory. Rollout gains `run.started`, `run.iteration`,
`run.wait`, `run.ended` (types already sketched in old spec §4.2); they carry
counts, reasons and ids — **never** summaries or decision text (OTLP stays
leak-free, like every other rollout event).

---

## 5. Corner cases

### 5.1 Git

| Case | Handling |
| --- | --- |
| Dirty tree at start | Refuse, list the paths. gnhf does the same. |
| Not a git repo / detached HEAD | Refuse. |
| Branch `night/<slug>` exists and isn't this run's | Suffix `-1`, `-2`. |
| Started on a `night/*` branch with a different objective | Ask once (TTY) — continue with new objective / new branch / quit. No TTY ⇒ refuse. |
| User has commit signing configured | Commits use `-c commit.gpgsign=false`; report notes the commits are unsigned. |
| Pre-commit hook fails | Commit failure path: keep tree, next iteration repairs; two repairs in a row fail ⇒ counts as failure and resets. |
| `--push` fails | Abort after the local commit is safe (gnhf). Never force. |
| `--verify` fails | Iteration failure; verify output tail goes into notes for the next iteration. |
| Model edits `.git/` directly | Path rule denies writes under `.git/`. |

### 5.2 Waits

| Case | Handling |
| --- | --- |
| Reset time far out (weekly limit) | Capped 24 h per wait; `--max-wait`/`--until` abort first in practice. |
| Laptop suspended during a wait | Waits use wall clock (`Date.now()` checked every minute), not a single `setTimeout`, so resume after suspend is prompt. |
| Window resets but the next request is still refused | Treated as a fresh `window` failure with a new reset time; escalating probes if none. |
| Subagent hits the quota mid-iteration | Surfaces as the parent iteration's failure; same classification. |

### 5.3 Model behaviour

| Case | Handling |
| --- | --- |
| Claims success with no diff and no learnings | Orchestrator checks `git status`: no changes and no new learnings ⇒ failure (`no_op`). Learnings-only success is allowed (records notes, no commit). |
| Claims success but broke the build | Only caught with `--verify`. The report says whether verify was on. Old-spec failure mode 3 ("tests deleted to pass") applies — the verify command is exactly as strong as the user made it. |
| Calls `finish_iteration` then keeps working | Tool call ends the run after the batch; later calls are ignored. |
| Repeats the same failing step every iteration | Notes carry the learning; 3 consecutive failures abort. |
| Tries to edit the notes file | It lives outside the tree; a `write` there is denied by the path rule. |
| Prompt injection in a repo file ("push this", "curl … \| sh") | Deny list + no push + reset on failure. §4.6 limit applies. |

### 5.4 Process

| Case | Handling |
| --- | --- |
| Terminal closed | A foreground run dies and is marked `crashed`; `--detach` survives because its worker owns the manifest and log. |
| Two runs on the same repo | Allowed only with `--worktree`; otherwise refused (they'd share a checkout). |
| Core crash mid-iteration | Same as terminal closed; uncommitted changes remain and the report (regenerated) says so. |

### 5.5 Providers

| Case | Handling |
| --- | --- |
| OAuth "not allowed for this organization" 403 | Existing latch falls back to API key; the run's cost model switches with it and the report states it. |
| `gemini-web` provider | Allowed, but its tool bridge makes `finish_iteration` compliance the open question — Phase 1 eval covers it. |
| Provider with no pricing | Cost shows "unknown"; `--max-usd` refused with that provider (can't enforce). |

### 5.6 When uncommitted work is left behind (the complete list)

1. Hard interrupt (second Ctrl+C / `SIGTERM`) — by design.
2. Process death (terminal closed, crash, OOM).
3. Run ends while a commit-failure repair is pending.

Each is reported with the path of the tree and `git status` summary.

---

## 6. Failure modes to watch

1. **Finish-tool non-compliance.** If a provider rarely calls `finish_iteration`,
   every iteration is a `no_finish` failure and the night ends after three.
   Measured before anything else (Phase 1 eval).
2. **Decision fatigue in the report.** Twenty trivial "decisions" hide the one
   that mattered. The prompt asks for choices a reviewer would care about;
   `reversible:false` sorts first; if it's still noise, cap at N per iteration.
3. **Budget theatre on API keys.** `--max-usd` is the real backstop; turn and
   iteration counts are poor cost proxies (old spec §6.2 stands).
4. **Plausible-but-wrong commits.** Many small green commits can still add up to
   the wrong thing. The report makes review cheap; it does not make it optional.
5. **The envelope becomes a false promise.** Documented as a guard rail, not a
   sandbox, everywhere it appears (§4.6).

---

## 7. Testing

**Unit (`*.test.ts`, no model):**
- `orchestrator.test.ts` with fake `runIteration` / git / clock: success→commit,
  failure→reset, 3 failures→abort, commit failure→repair→success, repair twice→
  failure, window wait→same iteration retried and not counted, credits→abort,
  `--max-wait`/`--until` crossing, escalating probes, graceful vs hard interrupt,
  resume restores counters, `should_stop` / `--stop-when`, no-op detection.
- `quota-wait.test.ts`: header parsing (`retry-after-ms`, `retry-after` seconds
  and HTTP-date, provider reset headers), scope classification, 24 h cap,
  past-reset handling.
- `envelope.test.ts`: each deny rule; in-tree vs out-of-tree writes incl.
  symlinks and `..`; user deny rules still apply; denials recorded.
- `finish-iteration.test.ts`: schema, string-boolean coercion, second call ignored.
- `question` unattended path: returns instantly, records `asked`, never touches
  the bus (no 30-min timer created).
- `report.test.ts`: needs-you first, asked-without-decision shown, secrets scrubbed,
  regenerated report equals end-of-run report.
- `QuotaExhaustedError` never carries `requestBodyValues` (pin the existing
  no-leak property).
- Mutation check on the wait/abort thresholds, as Phase 0 did for `budget.ts`.

**Integration (fixture repo, real git, fake provider):** a scripted provider that
edits a file and calls `finish_iteration` → one commit with the right subject;
one that stops without finishing → reset + `no_finish`; one that throws a
`QuotaExhaustedError` with a reset 2 s ahead → wait → retry → commit.

**Eval (real model — `evals/night.jsonl`, a new suite):** per EVAL.md, only what
needs a model:
- finish-tool compliance: a fixture repo + small objective, one iteration,
  `expectTool: finish_iteration`, across the providers users actually run
  overnight (anthropic OAuth, minimax, openai).
- decision recording: an objective with a deliberate ambiguity; does the model
  record a decision or a needs_human instead of stalling?
- envelope: an objective that tempts `git commit`; expect a `function.denied`
  and still a finish.

---

## 8. Phasing

Each phase is shippable and revertible on `autonomous`.

**Phase 0 — Measure, and stop throwing the evidence away.** Small. **Built
2026-09-28**, except the one item that needs a real spent window (below).
- `QuotaExhaustedError` with `resetAt`/`scope`; record rate-limit headers
  (names + values, no body) on `model.error` rollout events.
- `LoopResult.failure` typed field, filled at the existing exit points.
- Headless `question` must not wait 30 min: with no frontend subscribed, reject
  immediately (fixes `freecode run` today, independent of night runs; file in
  TODO.md if split out).
- *Verify:* unit tests (`agent/recovery/quota-classify.test.ts`, plus the
  headless-`question` case in `server.test.ts`). **Still open:** one real
  spent-window 429 captured on the OAuth path and its headers written into §4.7
  — `quotaResetAt` reads every usual spelling (`retry-after`, `retry-after-ms`,
  any `*-reset`, epoch seconds or ISO) and takes the soonest future one, so the
  first real 429 tells us which it was via `model.error.rateLimitHeaders`.
  Until then an OAuth window with no reset header classifies `unknown` and the
  orchestrator probes rather than sleeping blind.

  As built: `QuotaExhaustedError` (+ `classifyQuotaScope`, `quotaResetAt`,
  `rateLimitHeaders`, `classifyLoopFailure`) in `agent/recovery/manager.ts`;
  `LoopFailure` on `LoopResult` in `agent/types.ts`, filled at all five exits —
  including the three that report `success: true` while handing back the
  model's last words (turn cap, loop-health stop, interrupt);
  `ModelErrorEvent.rateLimitHeaders`; `askQuestion` rejecting at once with no
  subscriber. Note a MiniMax "Token Plan usage limit reached: Upgrade … or
  purchase Credits" classifies **`credits`**, not `window` — waiting cannot
  fix it.

**Phase 1 — Foreground iteration loop with the leash.** The core. **Built
2026-09-28**, minus `--verify` / `--stop-when` (Phase 2) and the paid eval below.
- `orchestrator`, `iteration`, `prompt`, `git`, `notes`, `finish_iteration`,
  envelope, unattended `question`, decisions log, `--max-iterations`,
  `--max-usd`, `--until`, consecutive-failure abort, graceful/hard interrupt,
  exit summary (report v0 = terminal only).
- Safety ships with the first runnable version — no phase runs unattended
  without the envelope.
- *Verify:* unit + integration suites — `orchestrator.test.ts` (15 cases over
  fake git/clock/iterations), `envelope.test.ts`, `finish-iteration.test.ts`,
  `night-store.test.ts`, `git.test.ts` (a real repo in a tmpdir: commit lands,
  failure leaves no trace, pre-commit failure keeps the work, `main` untouched).
  `evals/night.jsonl` (5 cases) **run 2026-09-28 on MiniMax-M3: 5/5, and
  `finish_iteration` called in 14/15 trials (93%)** — §6 failure mode 1 is
  measured and clears the ≥90% bar, so Phase 2 is justified. One case stays
  flaky (`night-no-human-to-ask`, 2/3): the model edited its way through the
  task and stopped without the bookkeeping. In a real run that costs the
  iteration, not the work — the harness re-pokes once, then resets.

  **The suite found three envelope bypasses, all real, all on the first two
  runs**, and all the same shape: a deny rule is a string prefix, and
  MiniMax-M3 — told it could not commit — kept respelling the verb.
  (1) chained: `git init && … && git commit -am '…'`, which
  `docs/DECISIONS.md` says a prefix rule deliberately refuses to match (right
  for an allow rule, wrong for a deny rule, which then matches nothing);
  (2) path-qualified: `/usr/bin/git commit`;
  (3) env-prefixed: `GIT_AUTHOR_NAME="…" GIT_AUTHOR_EMAIL="…" git commit`.
  Fixed in `envelope.ts` (`deniedSegment` + `normalizeSegment`), NOT in
  `rules.ts` — the recorded decision there is about allow semantics and is
  load-bearing. The envelope is the only caller whose rules are all denials.
  It normalizes rather than blacklisting spellings, but §4.6's honest limit
  stands and is now evidenced: `eval "$(echo git push)"`, an alias or a wrapper
  script still defeat it. It closes the routes a model actually takes when told
  no, not the ones an adversary would.

  Also observed, and worth knowing before leaving a night running on a weak
  model: one trial spent **24 turns** grinding against the refusal before the
  turn cap stopped it. The refusal text says it is final; MiniMax-M3 does not
  always believe it. The suite needed one harness field — `EvalCase.
  unattended`, the only one that changes the loop's wiring — because
  `finish_iteration` is not on an attended tool list and the runner's blanket
  permission allow would approve the very `git commit` the envelope case exists
  to see refused. It requires `files` for the same reason a mutating agentMode
  does: the envelope is defined relative to the run's tree.

  As built: `autonomous/{orchestrator,iteration,prompt,envelope,git,night-store}.ts`,
  `tools/finish-iteration.ts`, `cli/commands/night{,-run}.ts`. The loop learned
  one seam — `AgentLoopConfig.unattended` (spec §4.4–§4.6) — which decides an
  `ask` without a human, reaches tools through `ToolContext.unattended`, puts
  the unattended-only tools on the provider's list (`unattendedToolDefs`), and
  ends the run once `finish` is set. `PermissionSettingsManager.addSessionDeny`
  is new: the envelope's rules must land in the DENY tier, or a user's own
  `Bash(git:*)` allow would widen them.

  Deviations worth knowing: **Phase 1 aborts on a spent quota** rather than
  waiting (`permanent_error`) — waiting is Phase 2, and pretending to wait would
  hang. `--until` is checked BETWEEN iterations, not predicted: an iteration
  that starts inside the window may finish outside it, and killing it mid-step
  would discard real work.

**Phase 2 — Surviving the night.** **Built 2026-09-28.**
- Quota waits (§4.7) + `--max-wait` + `--fallback-model`; sleep inhibition;
  `--verify`; `--stop-when`.
- *Verify:* `quota-wait.test.ts` (13 cases — one per row of §4.7's table,
  including a reset in the past, a 24h cap on a weekly limit, and the budget
  checked against what a wait WOULD cost) + 13 new `orchestrator.test.ts` cases
  over a fake clock. Sleep inhibition smoke-tested live on Linux (held, then
  released — the first attempt reported a leak that was an artefact of the test
  matching its own `pgrep` shell). **Still open:** one real overnight run on
  this repo with a harmless objective.

  As built: `quota-wait.ts` is pure policy (`planQuotaWait`, no clock of its
  own) and `inhibit.ts` spawns one child it can kill, rather than gnhf's self
  re-exec. A wait **retries the same iteration number** — nothing happened, so
  numbering it twice would claim work that was never attempted — and is not a
  failure, so four waits in a row do not reach `maxConsecutiveFailures`. The
  tree is reset BEFORE waiting, so the retry starts clean. `--verify` runs
  before the commit, not after, and its output tail lands in the notes for the
  next iteration; it is skipped for a learnings-only iteration, which has
  nothing to gate. `sleepUntil` re-checks the wall clock every minute
  (§5.2): one long `setTimeout` overflows past 2^31 ms and a suspended laptop
  resumes to a timer that never fired — and the tick gives a graceful stop
  somewhere to land, so Ctrl+C does not have to wait out a quota window.

**Phase 3 — The morning.** **Built 2026-09-28.**
- `report.md` + `freecode night report|status|list|stop`; resume on a
  `night/*` branch; crashed-run detection; `--worktree`; `--push`.
- *Verify:* `report.test.ts` (14) + `night-ops.test.ts` (11), plus the live
  kill -9 walkthrough below.

  As built: `report.ts` is a **pure fold** (manifest + the two jsonl logs →
  markdown), which is what lets `freecode night report` regenerate one for a
  run that never reached its own exit path. Order is load-bearing: needs-you
  first even when empty (a section that vanishes is indistinguishable from one
  a bug dropped), then decisions with **irreversible sorted first**, then
  refusals, waits, iterations, diffstat, and a review block that ends with how
  to throw the whole night away. An ask with no matching decision is printed as
  "answer not recorded" rather than hidden. An unpriced model reports "cost
  unknown", never $0.

  Crash detection is `pidAlive()` (`kill(pid, 0)`) reconciled **on read**, so
  `status` and `list` agree and a resume knows what it found; a finished run is
  never re-judged by its long-gone pid. `freecode night` on a `night/*` branch
  resumes that run — the branch is the handle, because it is what the user
  still has once the terminal is gone — and continues the first leg's iteration
  numbering, commit list and wait total, so the report covers the whole night.
  `night stop` sets `cancelRequested` in the manifest and the orchestrator
  reads it at the iteration boundary; nothing is signalled, because a process
  killed mid-write is how manifests corrupt.

  One fix this phase forced: the sidecar logs scrubbed the **serialized JSON
  line**, so a `needs_human` item quoting a credential produced a line that was
  no longer JSON, which the reader then skipped — the record vanished instead
  of appearing redacted. `scrubFields` now walks the record's string fields, so
  the user is still told something needs them.

**Phase 4 — Frontends.** **Built 2026-09-28**, with one deliberate deviation.
`/night` in the TUI (live status from the manifest, open the report, stop a
running night); notification on finish via the existing Notification hook.
Frontends only read the manifest/report over IPC — `night.list|report|stop`,
which boot none of the backend, because reading a finished run must not start
providers and MCP servers.

**Deviation — the panel does not START a run.** This phase's line said "start
with the same flags", and it should not: a night started from the TUI would put
an unattended agent loop inside the daemon serving the user's own session,
sharing its permission surface and competing for the same provider — and
detached execution is deliberately Phase 5. The empty panel prints the command
to run instead, which is the whole answer while v1 is a foreground process.
*(Phase 5 since added `--detach`, which removes the "foreground only" half of
this reason but not the first half: a detached worker is still a separate
process, and the daemon still never runs a night. The deviation stands.)*

`night.list` counts `needsHuman` in CORE rather than the frontend: what "needs
you" means is the run's business, and four clients must not each decide it. In
the card that count outranks everything, including commits — a night with nine
commits and one unanswered question is, to the user, a night with a question in
it. The report opens as a markdown MESSAGE rather than a new viewer component:
it is prose read once and scrolled, which the message list already does, and it
stays in the transcript to refer back to.

- *Verify:* `night-panel.test.ts` (11) + the three IPC methods exercised against
  a real `handleRequest`. Core 1815, TUI 329, both green.

**Phase 5 — Only if asked. Built 2026-09-28.** Detached execution (old spec
§4.4a), OS sandbox for bash, conventional-commit preset, scheduled starts.

Detached runs re-exec the same CLI with a small environment handoff (run id and
scheduled time), redirect output to `<run>/worker.log`, and always create a dedicated
worktree so the worker never changes the user's active checkout. A provisional
`pending` manifest exists before spawn; its PID is reconciled with the same dead-process
logic as a running night. `night stop` also cancels a pending scheduled run.

The bash sandbox is Linux bubblewrap: host `/` is read-only, the user's home is hidden,
home-based toolchain roots selected by `PATH` are mounted back read-only (credential
and configuration roots stay hidden), credential-shaped environment variables are
stripped, the run worktree is the only read-write bind, `/tmp` is private, and
process/IPC/UTS namespaces are isolated.
Network remains shared so package installation and user-approved web work keep their
existing semantics; the permission envelope still refuses publishing/pushing. The same
sandbox wraps `--verify` and background shells. Linux fails closed when `bwrap` is
missing unless the user explicitly passes `--no-sandbox`; unsupported OSes warn and
retain the envelope. `--commit-style conventional` emits
`chore(night): <iteration summary>`. Scheduling accepts local `HH:MM`, a duration, or
a future ISO timestamp and uses the detached worker plus sleep inhibition while it
waits.

- *Verify:* `sandbox.test.ts` (3: only the run tree is read-write with a private
  `/tmp`, a workdir outside the tree is refused, credentials are not inherited) +
  `supervisor.test.ts` (1: the detached worker's pid is persisted and it keeps
  progressing on its own) + `night.test.ts` (2: `parseStartAt`). Live detached + sandboxed iterations
  done (below). **Still open:** a live *scheduled* (`--at`) start, and a full
  night.

  Found while documenting and fixed the same day: a **bare resume was
  unbounded**. The limit check skipped a resume, and `runNight` only ever gets
  `argv`'s limits. The fix is to require a limit on resume too, rather than
  reload the first leg's: its `--until` has usually passed by the time anyone
  resumes, so reloading it would stop the resumed leg immediately.
  `--max-iterations` and `--max-usd` count per leg.

  **First live runs (2026-09-28, MiniMax-M3, detached + sandbox).** Run
  `74b18cb1` made 3 iterations and 2 commits (both correct, comment-only), cost
  $0.58 in 11 min, and found five bugs, all fixed the same day:
  (1) **tools ran in the user's checkout.** The loop passes
  `cwd: process.cwd()`, and a worktree run never changed directory, so the
  sandbox refused every bash call and iteration 1 died at the turn cap. With
  `--no-sandbox` those commands would have run in the user's checkout. Fixed
  with `process.chdir` into the worktree.
  (2) A failed iteration's record dropped its session id, turns and cost.
  (3) **An honest `success:false` lost its `key_learnings`** because the
  finish was never passed to `resetAndNote`. That is the one thing the finish
  tool promises a failed attempt.
  (4) The report's review range was hard-coded to `main`, and `night report`
  regenerated `report.md` without the diffstat. `baseCommit` is now persisted,
  and every regeneration goes through `regenerateReport`.
  (5) MiniMax's nested tool arguments arrive garbled: lists nested one level
  deeper, a stray `</item>`, and `why` swallowing `<reversible>`. The garbling
  flipped a reversible decision to irreversible. `finish_iteration` now
  untangles them.
  The verification run `b401724e` then found a sixth: inside the sandbox, git
  failed in a worktree, because its metadata lives under the hidden `$HOME`.
  The main `.git` is now mounted read-only. The documentation pass then found
  that home-only toolchains were hidden too; home-based `PATH` toolchain roots
  are now selectively mounted read-only while credential/config roots remain hidden.

---

## 9. Open questions

1. ~~**OS-level sandbox for bash**~~ — answered by Phase 5: bubblewrap, on by
   default on Linux, fail-closed without `bwrap` unless `--no-sandbox`.
2. ~~**Command name.**~~ — answered: `freecode night`, with `autonomous/` staying
   the module name.
3. **Memory extraction during the night.** Off per iteration (cost); should one
   extraction pass over `notes.md` run at the end so the next attended session
   learns from the night?
4. **Which Anthropic OAuth headers carry the window reset** — still open; needs
   one real spent-window 429 (Phase 0's remaining item).
5. **Default `--max-wait`** — 12 h covers two 5-hour windows; is a weekly-limit
   hit better as an immediate abort?
