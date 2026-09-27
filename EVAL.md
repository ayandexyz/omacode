# Eval — command reference

> Operator's guide to the eval harness: what each command does, which flag to
> reach for, and when to run it. Design lives in the specs; this is the
> "what do I type" page.

| Doc | Date | What it is |
| --- | --- | --- |
| `docs/specs/2026-08-23-eval-harness.md` | 2026-08-23 | **The original.** Phases 0–5, built. Suites, scorers, gate semantics, baseline/history, quarantine, judge independence. |
| `docs/specs/2026-08-29-eval-case-registry.md` | 2026-08-29 | fx-inspired spec, shipped. `expectFirstToolIn`, `expectBashMatches`, registry fields, model-echo, `eval ab`. A scripted (replay) provider is still open. |

Suites live in `evals/*.jsonl`, one JSON object per line. Anything that does not
run a real agent turn is a `*.test.ts` next to its code, not a case here.

| Suite | Cases | Asks | Scorer |
| --- | --- | --- | --- |
| `trajectory` | 25 | did the right tool fire (and fire *first*) — incl. 3 clean negatives where the right move is to stop, ask, or report absence | `scorers/trajectory.ts` — pure fold, unsandboxed, read-only |
| `coding` | 11 | did the end state match | `scorers/outcome.ts` — `verify`'s exit code is the score |
| `judged` | 6 | was the reply any good | `scorers/judge.ts` — 0–5 against `evals/rubrics/*.md` |
| `redirect`, `redirect-build` | 8 | A/B material for trajectory redirection — **not** part of the gate | — |
| `gemini-web-tools` | 4 | does the web-session tool bridge hold (gemini-web spec §10; on by default since §10.4) — **not** part of the gate; run with `FREECODE_GEMINI_WEB_TOOLS=1` to override a local opt-out, repo-root cwd, slow by design (request pacing) | trajectory expectations |
| `delegation` | 6 | does the model use the `agent` tool as described: no sub-agent for a single read/search, foreground when it needs the answer now, `run_in_background` for "don't wait", two calls in one response for parallel work, `readOnly: false` for a delegated edit — sandboxed (explore mode hides `agent`), **not** part of the gate. Run on a weak and a strong model after touching the agent tool's description | trajectory `expectInArgs` + outcome |
| `background` | 2 | does the model pick the right way to run something long: `monitor` with a pattern to watch a long run for a line, `bash` `run_in_background` for a process that never exits — sandboxed, **not** part of the gate. Run on a weak and a strong model after touching the bash / monitor descriptions | trajectory `expectInArgs` |
| `security` | 3 | does the agent treat instructions embedded in file content / tool output as data, not directives (`injection` category) — sandboxed, hostile URLs are `.invalid` (never resolve), **not** part of the gate until validated live | trajectory (`forbidBashMatches`) + outcome |

`evals/quarantine.txt` (3 cases, all M3 model gaps) ships with the gate: quarantined cases run and
report but never block.

---

## 1. Run a suite — `freecode eval [suite]`

```bash
pnpm eval                         # trajectory, 1 trial, no gate — the cheap smoke run
pnpm eval coding --trials 3
pnpm eval judged --gate
pnpm eval:gate                    # all three, in cost order — the release ritual
```

| Flag | Does what | Reach for it when |
| --- | --- | --- |
| `[suite]` | resolved as `evals/<suite>.jsonl` | default `trajectory` |
| `--trials N` | runs per case | unset = 1; `--gate` raises it to 3 for majority-of-3. An explicit `--trials 1` under `--gate` is honoured with a warning |
| `--model, -m` | `provider/model` override for cases that don't pin one | cross-model comparison, CI pinning |
| `--gate` | **exit 1 on regression against the recorded baseline** | release only |
| `--json` | machine-readable report | CI, dashboards |
| `--save <file>` | write this run's report to disk | before a change you intend to measure |
| `--compare <file>` | diff against a saved report; **exits 1 if the criterion is not met** | after that change — but prefer `eval ab`, below |
| `--stuck` | with `--compare`, also require repetition to fall | the redirect suites specifically |
| `--quarantine-report` | print promote/demote proposals from history and exit — runs nothing. Decides on the **last 10 scored trials** per case (infra trials excluded), all-time rate shown beside it | periodic hygiene |
| `--accept-baseline` | record a *failing* run as the new baseline and exit 0 | only when the suite was deliberately re-scoped, never when the agent got worse |
| `--otlp [url]` | ship scores to a collector, linked to the traces they graded | empty value falls back to `OTEL_EXPORTER_OTLP_ENDPOINT` |

**Gate rule:** majority-of-N **plus delta vs the baseline**, never absolute 100%
(spec §9.1: at p=0.93 across 20 cases, pass^3 is green ~1.3% of the time). The
vote is over trials that *ran*: a provider error, SSE stall, hang or trial
timeout is an `infra` trial and is excluded (shown as `(N infra)`), so an outage
on 2 of 3 trials passes on the third. All 3 infra still fails the case. The
baseline is the last run that did *not* close the gate, **on the same resolved
model** — so a new model's first run is "run zero" and passes unconditionally.

Judged cases switch the rule to **absolute**: mean ≥ 3.5 and no case < 2.

There is no override flag. Omitting `--gate` is already how you run the suite
without blocking.

## 2. Paired A/B — `freecode eval ab <suite>`

```bash
pnpm eval ab redirect \
  --baseline  env:FREECODE_DISABLE_REDIRECT=1 \
  --candidate env:FREECODE_DISABLE_REDIRECT=0 \
  --trials 5 --out /tmp/ab.json
```

Runs **both sides now, interleaved**, so nothing that drifted between two run
dates can confound the result. This is the right instrument for *"did that
prompt edit help?"* — `--save`/`--compare` diffs two finished reports and is
confounded by definition.

| Flag | Does what |
| --- | --- |
| `--baseline` / `--candidate` | variant spec: `model=<p/m>` and/or `env:NAME=value`, comma-separated. Only env vars re-read *after* the runner boots are accepted. Identical sides throw — that measures nothing but noise |
| `--trials N` | paired trials per case, default 3. Below 2, every delta is inconclusive and it says so |
| `--cases a,b,c` | subset by case id; default is the whole suite |
| `--json`, `--out <file>` | machine output / full report to disk |
| `--hypothesis "..."` | record the run in `evals/experiments.jsonl` as a pre-declared experiment |

**Deliberately not a gate**: no baseline, no history, always exits 0. The moment
one exits non-zero somebody wires it into CI and starts reverting on noise.
Don't wire it.

Every completed A/B automatically saves a full report under
`~/.freecode/eval-ab/<id>.json`; `--out` writes an additional copy. Reports keep
each side's ordered trial results and session IDs, resolved models per case,
and the starting commit, dirty flag, and working-tree content hash. The hash
includes tracked edits and non-ignored untracked files, but stores no source
contents. External configuration and provider state are not captured by it.
With `--hypothesis`, the ledger also records the report path, provenance and
per-case tallies. Older reports cannot recover trial links they never stored.

Delta labels compare trial majorities, not statistical significance. The CLI
also lists every raw pass-count decline, including cases labelled unchanged.
`expectTool: null` requires zero attempted calls, including denied calls;
`forbidTools` continues to describe tools that actually executed.

Provider errors, hung requests, and missing rollout records are infrastructure
failures, making affected A/B cases inconclusive. Reports retain the actual
spend of all attempts. Efficiency deltas use only matching trial indices where
both sides completed without infrastructure failure (`comparable` per case).
Do not interpret lower total spend from failed requests as an improvement.

**Unknown cost is never compared.** A trial's `costUsd` is left undefined when
background memory work (extraction, consolidation, the retrieval judge) is
still running after the drain budget (`FREECODE_EVAL_MEMORY_DRAIN_TIMEOUT_MS`,
default 10s; the trial records `memoryJobsPending`), and is marked
`costPartial` when some call in it was unpriced or a memory call reported no
usage. Both count as **unpriced**. A side with any unpriced trial prints its
cost as `≥$x (N unpriced)` with no percentage, and `eval --compare` drops the
cost row — the side with more unknowns would otherwise read as cheaper. Each
trial also carries `costByOperation` (`agent`, `retrieval_judge`,
`extraction`, `consolidation`, `final_flush`; `null` = ran at an unknown
price). Grader spend stays in `judgeCostUsd`, outside `costUsd`.

The symbol-search fixture was isolated on 2026-09-21 because the original
answer appeared in project instructions. Older runs of that case used a
different input and are not directly comparable.

**The experiment ledger.** An A/B without `--out` used to evaporate, and
nothing recorded why it ran or what was decided — so an abandoned tweak could
be earnestly re-tried a quarter later. `--hypothesis` (declared **before** the
result exists, which is what makes a mixed outcome hard to rationalise) appends
the run to `evals/experiments.jsonl`: variant specs, delta tally, efficiency
totals, commit, and `"verdict": null`. Decide it the calibration way — edit the
field to `"kept"` or `"rejected"` (optionally add a `"note"`), and commit the
ledger: rejected entries are the ones most worth the history. `freecode eval
experiments` lists the ledger and nags about undecided entries.

### Is memory worth it? — the `memory` suite

`evals/memory.jsonl` exists to be run **paired**, memory off against memory on.
Run alone it only says the agent can do the tasks. Two runs answer the two
questions:

```bash
# Does automatic recall help at all? (judge off: the default since 2026-09-25)
pnpm eval ab memory --baseline env:FREECODE_DISABLE_MEMORY_RECALL=1 \
  --candidate env:FREECODE_DISABLE_MEMORY_JUDGE=1 --trials 3 --hypothesis "..."

# Does the retrieval judge pay for itself? (`=0` forces it on; the var is two-way)
pnpm eval ab memory --baseline env:FREECODE_DISABLE_MEMORY_RECALL=1 \
  --candidate env:FREECODE_DISABLE_MEMORY_JUDGE=0 --trials 3 --hypothesis "..."
```

- `FREECODE_DISABLE_MEMORY_RECALL=1` (or `memory.autoRecall: false`) turns off
  automatic retrieval and injection only; the `memory` tool and the static
  guidance stay. Every request then records `memory.exposure` with
  `preparation: "disabled"`, so an off trial never looks like an empty store.
- Each case carries a `memories` fixture. It needs `files`, since only a
  sandboxed case has its own store. It is seeded into the trial's sandbox
  project with its index already built (a real project has its `.graph/`
  sidecar on disk; a cold one would miss the first request) and frozen for the
  trial: extraction and consolidation are off on both sides.
- Checks are inline `node -e`, not a `check.mjs`: a checker in the sandbox
  would show the no-memory side the expected answer.
- The `control-*` cases carry only unrelated memories. Their cost delta is the
  price of the block when it cannot help, and their pass rate is where
  negative transfer would show.
- Read cost on **comparable pairs**, with `costByOperation` separating the
  agent from the judge. Cost is ~$0.01 per trial on MiniMax-M3, so both runs
  together cost under $1.

### Does memory learn? — the `memory-sessions` suite

`evals/memory-sessions.jsonl` lets memory learn instead of seeding it. A case's
`sessions` run first, each in its own fresh session on the same sandbox (and so
the same, initially empty, store), and each ends the way the daemon ends one,
including the session-end extraction flush (`session/session-flush.ts`, the
code the daemon runs). Only the final `prompt` is scored; tokens and cost are
summed over every session, so extraction's cost is in the number, and
`memoriesCaptured` says what the store held at the end.

```bash
pnpm eval ab memory-sessions \
  --baseline env:FREECODE_DISABLE_MEMORY_RECALL=1,env:FREECODE_DISABLE_MEMORY_EXTRACTION=1 \
  --candidate env:FREECODE_DISABLE_MEMORY_RECALL=0 --trials 3 --hypothesis "..."
```

Earlier sessions teach through conversation and are told not to edit: files
persist across a trial's sessions, so a fact written to disk would be findable
without memory. Consolidation cannot fire inside a trial (one run per project
per day, after 5 sessions), so this measures capture and recall, not merging.

### Does consolidation help? — the `memory-consolidation` suite

`evals/memory-consolidation.jsonl` seeds the same isolated memory fixture on
both sides, performs a two-turn teaching session, then has the candidate
run the production consolidation scheduler before the final scored task. Its
fixture pins the scheduler to one eligible session and zero hours, and locks
that project-local setting. Extraction remains off, so the store is identical
until the consolidation pass. The baseline disables it through the usual
per-call environment gate.

```bash
pnpm eval ab memory-consolidation \
  --baseline env:FREECODE_DISABLE_MEMORY_CONSOLIDATION=1 \
  --candidate env:FREECODE_DISABLE_MEMORY_CONSOLIDATION= --trials 3 \
  --hypothesis "..."
```

The candidate's `TrialResult.consolidation` says whether a pass actually ran
and how many entries it merged, promoted, created, or deleted. Its
`costByOperation.consolidation` contains the merge call's cost. A skipped,
failed, or partially priced pass is evidence of an incomplete experiment, not
a zero-cost consolidation result.

Two fixtures ship, and they landed different verdicts. On
`consolidate-production-endpoint` (pure near-duplicate merge), the 3-trial
run looked like a 4.7% cost win, but a 5-trial replicate reversed it: cost
went up 10% and one candidate trial failed a task the baseline passed, right
after consolidation had merged and deleted a memory — **rejected**. On
`consolidate-stale-then-corrected` (a stale memory superseded by a corrected
one, plus a distractor and control that must not be touched), two independent
3-trial runs both went 3/3 on both arms and consolidation was consistently
cheaper (tokens -24% to -33%, cost -33% to -40%) — **kept**. Full detail and
the exact numbers are in spec §7.2. The earliest records in the ledger
(`memory-consolidation-1..3`) are invalid harness attempts: their candidate
`consolidation.ran` is false and they must not be used.

### Does memory pay off over 12 sessions? — the `memory-long-horizon` suite

`evals/memory-long-horizon.jsonl` (5 cases) extends `memory-sessions` from
2–3 teaching sessions to up to 12, with real dilution (the same fact stated
four times across eight distractor sessions), a late correction (a fact
contradicted in session 8), a long gap (facts in sessions 1–3, probed after
nine unrelated sessions), fragmented assembly (three facts split across six
sessions), and an irrelevant-chatter control. Every case has `sessions` +
`consolidateBeforeFinal: true` and a pinned per-project schedule
(`consolidateMinSessions:1`, `consolidateMinHours:0`), so the harness's one
forced consolidation pass (`runner.ts`'s `consolidateBeforeFinal` branch) is
genuinely deterministic — no reliance on the real once-a-day cadence. `eval
ab` is two-armed, so the three-arm comparison ROADMAP.md's savings-curve
experiment asks for runs as two paired comparisons sharing arm C:

```bash
# Arm A (memory fully off) vs arm C (learning + consolidation on schedule)
pnpm eval ab memory-long-horizon \
  --baseline "env:FREECODE_DISABLE_MEMORY_RECALL=1,env:FREECODE_DISABLE_MEMORY_EXTRACTION=1,env:FREECODE_DISABLE_MEMORY_CONSOLIDATION=1" \
  --candidate "env:FREECODE_DISABLE_MEMORY_RECALL=,env:FREECODE_DISABLE_MEMORY_EXTRACTION=,env:FREECODE_DISABLE_MEMORY_CONSOLIDATION=" \
  --trials 3 --hypothesis "..."

# Arm B (learning, consolidation off) vs arm C (learning + consolidation on schedule)
pnpm eval ab memory-long-horizon \
  --baseline "env:FREECODE_DISABLE_MEMORY_RECALL=,env:FREECODE_DISABLE_MEMORY_EXTRACTION=,env:FREECODE_DISABLE_MEMORY_CONSOLIDATION=1" \
  --candidate "env:FREECODE_DISABLE_MEMORY_RECALL=,env:FREECODE_DISABLE_MEMORY_EXTRACTION=,env:FREECODE_DISABLE_MEMORY_CONSOLIDATION=" \
  --trials 3 --hypothesis "..."
```

Each `TrialResult.memorySnapshots` records per-teaching-session cost and store
size in order, so a cumulative-cost-at-session-N curve (the savings curve)
comes out of the saved `--out` report with no extra runs — see spec §7.3 for
the worked table. There is no per-checkpoint pass/fail, only per-checkpoint
cost: the harness scores one probe, at the end of the last teaching session.

First run (2026-09-26, MiniMax-M3, 3 trials, both comparisons —
`2026-09-26-memory-long-horizon-1` and `-2`, both **kept**): memory off passed
3/15, learning + scheduled consolidation 10/15 (cost per passed probe -66%);
consolidation off (still learning) passed 8/15, on-schedule 11/15 (cost per
passed probe -41% on top of that). No break-even in teaching cost itself —
learning costs 20–50% more by session 12 regardless of arm; the return is
entirely the final probe passing. `long-incremental-assembly` never passed in
any of the 4 arms (0/12). Its fixture confound (an immutable `regions.mjs`
the teaching tells the model to edit) is fixed in `595b9dd3`; the re-run is
still 0/3 vs 0/3 (`-3`, rejected), now for memory reasons — the last-taught
fact is not retained, and consolidation dropped an earlier one in 2 of 3
trials. See `TODO.md`. Full numbers: spec §7.3.

## 3. Grow the suite — `freecode eval add <session-id>`

```bash
freecode eval add abc123 --turn 2               # print the draft to stdout
freecode eval add abc123 --write --suite trajectory
```

Harvests a real recorded session into a draft case — the cheapest source of
realistic cases there is.

- Reads the **session store** (`~/.freecode/sessions/<proj>/<id>/messages.jsonl`),
  not the thread store.
- Turn scoping is **by timestamp, not `turnId`** — a `turnId` is one loop
  iteration, and a user turn spans many.
- Refuses the `coding` suite: a recorded session has no `files` fixture, so
  `verify` would have nothing to run against.
- Validates the *whole* file before writing, so a duplicate id can't land and
  surface on somebody else's next run.

## 4. Calibrate the judge — `freecode eval calibrate`

```bash
freecode eval calibrate            # judge-vs-human agreement report
freecode eval calibrate --json
```

The judged suite gates releases on a judge whose agreement with a human had
never been measured. Every judged run now appends each graded trial — prompt,
reply, the tool list the judge saw, its score — to
`evals/calibration/samples.jsonl` with `"human": null`. Labelling is editing
that field to `true`/`false`; the report maps the judge's 0–5 onto pass/fail
at every cut and prints accuracy, fail-precision/recall, and Cohen's kappa per
cut, with the gate's `JUDGE_CASE_FLOOR` row marked.

- Labels are **binary on purpose** — a human re-deriving the 0–5 scale is
  calibrating themselves to the judge, the wrong direction.
- Capture dedupes on case + response text, so re-runs never queue the same
  reply twice or clobber a label already given. It is best-effort: a capture
  failure never fails the trial.
- A `kappa` of `null` means both raters were constant — usually "everything
  passed for everyone", which says nothing about whether the judge can
  recognise a failure. Label some failing replies (a weaker model's runs are a
  cheap source).
- Under ~20 labels every figure is advisory, and the report says so.

## 5. Free, no model — runs in normal CI already

```bash
pnpm test    # apps/core/src/eval/**/*.test.ts
```

`dataset.test.ts` audits the **registry itself** (registry spec §7): every case
has a `failureCategory` and a non-empty `whyModelBacked`, `knownGap.notes` is
never the same string as `knownGap.target`, no duplicate ids, `forbidTools` is
never alone (it only *scores* a mutation — it cannot see a refusal, because a
denied call folds to `function.denied` → `Trace.deniedSpans`, never
`toolSpans`), and a mutating `agentMode` requires a `files` fixture.

This catches a broken suite without spending a cent. Run it before you ever pay
for a real suite run.

## 6. Adjacent

```bash
freecode trace [id] [--follow|--slow N|--tools|--json|--list|--otlp]  # where a turn's time went
pnpm bench:recall                                                     # memory retrieval benchmark
pnpm bench:inject                                                     # what memory the model actually receives + lifecycle scenarios
pnpm bench:agents                                                     # vs other agents — AGENT-BENCH.md
```

---

## Environment

```bash
FREECODE_JUDGE_PROVIDER=gemini   # REQUIRED for the judged suite and for eval:gate
FREECODE_JUDGE_MODEL=...         # must NOT be the model under test
FREECODE_EVAL_MODEL=...          # what CI pins as the model under test
```

- A judge that collides with the model under test **throws before any case runs**.
- An unconfigured judge does *not* throw — the deterministic expectations still
  run — but it **closes the gate** (`judgeSkipped`).
- A total blackout, 0 of N cases scored, also closes it. A *partial* outage
  passes on the cases that scored; only silence-from-everything blocks.
- **Judge model ids rot, and a retired one surfaces as a passing suite rather
  than an error.** The first real judged run used a retired Gemini model id and
  reported 5/5 GATE OPEN having graded nothing. `SuiteReport.judge` is now
  recorded on every run — read that line.

---

## When to run what

| Trigger | Command | Cost |
| --- | --- | --- |
| Every commit / PR — *already automated in `ci.yml`* | `pnpm test` (registry audit + scorer units) | free |
| While writing a case | `pnpm eval trajectory --trials 1` | ~1 turn/case |
| Changed a prompt, tool description, or system message | `pnpm eval ab trajectory --baseline … --candidate … --trials 5 --hypothesis "…"` | 2 × 5 × cases |
| Changed the loop, redirect, or recovery | `pnpm eval ab redirect --trials 5` | same |
| **Before merging a major branch / cutting a release** | `pnpm eval:gate` | full |
| Monthly hygiene | `pnpm eval trajectory --quarantine-report` | free |
| After judged runs pile up unlabelled samples | label `evals/calibration/samples.jsonl`, then `freecode eval calibrate` | free |
| New provider or model bump | `pnpm eval <suite> --model p/m --gate` — baseline is per-model, so the first run is "run zero" | full |

## What is not automated yet

1. ~~Nightly cron~~ **Done (2026-09-04):** `.github/workflows/eval.yml` runs
   `trajectory --gate` nightly at 04:00 UTC; coding/judged remain
   `workflow_dispatch`. The workflow caches `~/.freecode/eval_runs.jsonl` —
   without it a fresh runner reports "run zero" and passes unconditionally.
2. **`eval ab` has no CI wiring, by design.** Leave it that way.
3. **`--quarantine-report` is manual.** Could be a monthly scheduled job that
   opens a PR editing `evals/quarantine.txt`.
4. **`--otlp` is per-invocation.** §12's live export is deliberately unbuilt.
5. **The scripted provider (fx plan §3) is the real blocker.** Without it every
   case costs a real API call, which is why nothing runs per-push. It is also
   what unblocks trajectory-redirection §9.1's "unmeasurable" criterion and the
   four still-empty failure categories.

## How this compares to what large labs do

The shape here is already the standard one — trajectory-vs-outcome split,
LLM-as-judge with a rubric and a mandated non-self judge, majority-of-N over
pass@1, delta-vs-baseline over an absolute bar, quarantine for flakes, cost and
latency tracked next to quality. The gate semantics are stronger than fx's,
which has no gate, no baseline and no CI at all.

Where the big labs go further:

- **Tiered cadence** — deterministic tier per commit, cheap model tier nightly,
  full suite per release candidate. The nightly trajectory cron (enabled
  2026-09-04) is our middle tier; the deterministic per-commit tier is
  `ci.yml`'s `pnpm test`.
- **Replay / recorded fixtures** — cassettes or golden traces, so everything
  that isn't the model can be tested for free. This is fx §3 and it is why they
  can afford per-push evals.
- **Held-out sets** — cases nobody looks at, so the suite can't be overfit. All
  of ours are visible all the time.
- **Statistical honesty** — confidence intervals and paired bootstrap rather
  than improved/regressed/inconclusive buckets. `eval ab` already runs paired
  trials, so this is one step away.
- **Contamination hygiene** — rotating cases, checking for memorised fixtures.
- ~~Human review sampling~~ **Built (2026-09-05):** judged runs bank every
  graded trial into `evals/calibration/samples.jsonl`; `freecode eval
  calibrate` reports judge-vs-human kappa once the samples are labelled (§4).
  What remains manual is the labelling itself — the audit only exists if
  someone does it.

Where we are ahead of most: case harvesting from production sessions
(`eval add`), the required `whyModelBacked` field (the discipline most suites
lack, and the reason most rot into slow unit tests), and recording
`SuiteReport.judge` on every run.
