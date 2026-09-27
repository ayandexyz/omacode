# Memory efficiency: measure it, prove it, fix what the proof finds

**Date:** 2026-09-25 (rescoped same day)
**Status:** P0 complete · §4 bench built and findings fixed · §6 paired runs done 2026-09-25 (recall pays: 24/24 vs 13/24, −45% cost per task; judge neutral) · §7 first multi-session run done (13/15 vs 4/15, −65% cost per task)
**Audit baseline:** `f7c83321`
**Goal:** Know, with evidence, whether automatic memory makes the agent better or cheaper, and by how much, backed by free tests, a free local bench, and a paid paired eval.

> **Rescoped 2026-09-25.** Earlier drafts also covered a graph-explorer
> redesign, an explorer "why was this injected" view, and open-ended tuning.
> None of that measures or improves memory quality; the explorer is
> presentation. It moved to `ROADMAP.md` ("Memory graph explorer"). The file
> name is kept so existing links resolve.

## 1. The question

Memory is not free. Local retrieval costs no model tokens, but the injected
block rides every provider request, and the judge, extraction, and
consolidation are real model calls. Memory earns its cost only if it avoids
enough re-explanation, re-investigation, mistakes, or turns, or materially
improves the outcome.

Three questions, answered in this order:

1. **Does the model receive the right memories?** Free, local, deterministic (§4).
2. **Does receiving them change task outcomes and cost?** Paid, paired (§6).
3. **Does learning across sessions pay back its own cost?** Paid, multi-session (§7).

```text
runtime cost with memory = main agent + judge + extraction/flush + consolidation
net savings              = runtime cost without memory − runtime cost with memory
```

Injected tokens are already inside main-agent input usage and are never added
again. Background calls count even when they finish after the answer. Unknown
cost never produces a savings verdict (P0 made that mechanical).

## 2. Contracts

- [Architecture v4](2026-05-25-architecture-v4.md): logic in core; frontends render.
- [Memory system reference](../MEMORY_SYSTEM.md), [graph](2026-07-26-memory-knowledge-graph.md), [write path](2026-08-09-memory-write-path.md), [consolidation + judge + recall bench](2026-08-23-memory-consolidation.md).
- [Observability](2026-08-10-agent-observability.md), [`EVAL.md`](../../EVAL.md), [`TRACE.md`](../../TRACE.md).

Invariants: markdown is the source of truth and `.graph/` is rebuildable;
memories ride the ephemeral tail after the cache anchors, never the static
prefix; memory bodies, queries, paths, and names never enter exported
telemetry; free regression checks never become mandatory paid calls; a default
changes only with paired evidence.

## 3. Plan

| # | Work | Deliverable | Cost to run | State |
| - | ---- | ----------- | ----------- | ----- |
| P0 | Measure the whole bill; strict rendering | §5 | free | ✅ done 2026-09-25 |
| P1 | Injection bench | `pnpm bench:inject`: rendered recall, wasted bytes, lifecycle scenarios | free | ✅ built 2026-09-25 |
| P1 | Correctness fixes | one fix per failing bench scenario, each with a regression test | free | ✅ done 2026-09-25 |
| P1 | Recall-off switch + paired eval | memory off vs on, per-case quality and cost deltas | paid | ✅ first run 2026-09-25 (§6.1) |
| P2 | Multi-session savings | capture, consolidation, cumulative cost over N sessions | paid | ✅ first run 2026-09-26 (§7.1); consolidation + long horizon → ROADMAP |

Order matters: the bench finds the bugs, the fixes make the injection correct,
and only then is a paid comparison worth its money. A paired eval of a
retriever that injects deleted memories measures the bug.

## 4. P1: injection bench (`pnpm bench:inject`)

`pnpm bench:recall` scores what `retrieve()` ranks. The model never sees that
list. It sees what `prepareMemories()` returned *for this session at this
moment*, cut by the renderer's byte budget. A match that never reaches the
request is not a successful injection. This bench measures that.

**Constraints.** Calls production code (`MemoryGraphService.prepareMemories`,
`judgeMemories`, `renderRetrievedMemoriesDetailed`), never a reimplementation.
Throwaway temp store, never the developer's. Zero model calls by default: the
judge is off or an explicitly labelled oracle. A paid `--judge=real` mode may be
added later behind an explicit flag; it is not required for P1.

### 4.1 Corpus metrics

Same corpus as `bench:recall` (40 memories, 22 scored + 5 abstention queries),
one fresh session per query, preparation drained before scoring.

| Metric | Meaning |
| --- | --- |
| candidate recall | gold ids present in the prepared set (what retrieval handed over) |
| **rendered recall** | gold ids present in the block the model actually receives |
| full-body recall | gold ids rendered with their body, not degraded to a one-liner |
| rendered precision | gold ÷ rendered entries (not ÷ k; see bench:recall's precision@5 caveat) |
| abstention | off-topic queries that inject nothing |
| block bytes / est. tokens | per request; the recurring cost of the block |
| **wasted bytes** | bytes spent on non-gold entries: pure cost, zero benefit |
| budget drops | gold entries retrieved but cut by the byte cap |
| prepare latency | p50 / max for `prepareMemories` |
| cold misses | first call returned before retrieval landed (`pending`) |

Report both `--judge=none` (as shipped with the judge off) and
`--judge=oracle` (the ceiling). Labels say which.

### 4.2 Lifecycle scenarios

Deterministic scripts over the production service. Each reports pass/fail and
a one-line reason; **a failure is a finding for §4.3, not a crashed bench**.
The bench prints all of them and exits non-zero only on an internal error, so
a known-failing scenario is visible without blocking unrelated work.

| Scenario | Pass means |
| --- | --- |
| first message, fast retrieval | gold injected on the first request |
| judge slower than the 60 ms cold budget | first request carries retrieval's candidates (`unjudged`); the verdict governs the next (changed 2026-09-25, §6.2) |
| same-topic follow-up | set carried, no new judge call |
| abrupt topic switch | old topic's memories are not injected |
| repeated identical prompt | one judge call total |
| memory **edited** mid-session | next injection carries the new text |
| memory **deleted** mid-session | never injected again |
| memory **superseded** | the replacement is injected, the obsolete one is not |
| duplicate memories competing for budget | block stays under cap; the gold entry keeps its body |
| judge outage | fails closed: nothing injected, decision `failed` |
| malformed verdict | fails closed: decision `unparseable` |
| secret-bearing file written outside the normal writers | secret text never appears in any block |

### 4.3 Findings (first run 2026-09-25)

Full tables: `memory/bench/README.md`.

**Metrics, judge off → oracle judge.** Rendered recall 84.1% in both, equal
to candidate recall, so the byte budget costs no recall. With the judge off
the block averages **1962 B (~490 tokens) per request, 62.5% of it on
memories that did not apply**, and abstention is 0/5. A perfect filter cuts the
block to 597 B (−70%) with 100% abstention; the fixed header + footer is then
two thirds of what remains.

**Scenarios: 7/12 on the first run, 12/12 after fixes.**

| Finding | Fix | Regression test |
| --- | --- | --- |
| Edit/delete staleness: `onChange` never touched a session's stash and a resolved query was not re-fetched | `invalidateSessions` patches every session holding the memory synchronously (remove / swap, re-judge), and a store generation makes an in-flight prefetch discard pre-change results | `graph/prepared-memories.test.ts` |
| Supersession: obsolete and replacement both injected | `graph/supersession.ts`: each candidate becomes the newest live record in its chain before judging; mutual/cyclic chains keep both; missing targets change nothing | `graph/supersession.test.ts`, `prepared-memories.test.ts` |
| Secret filter gap: a secret in a hand-written file reached the block via BM25 | `modelSafe` drops secret-bearing entries from every prefetch (so the judge never sees them either) and from the stash patch on an edit | `prepared-memories.test.ts` |
| Cold wait overrun: first `prepareMemories` blocked 110–160 ms vs a 60 ms budget | fastembed padded every input to 512 tokens, synchronously; the embedder disables padding. Query embed ~150 ms → ~4 ms, identical vectors (cosine 1.000000); p50 prepare 134 → 6 ms | `graph/embedder.test.ts` |
| Near-duplicates out-rank a matching fact, which loses its body | Not a bug: ranking of similar memories is retrieval's job and suppression is tuning that needs §6 evidence. Recorded in `docs/DECISIONS.md`; the scenario now checks the renderer contract | the scenario |

Passing from the start, as designed: slow retrieval surfaces on the next
request, same-topic follow-ups and repeated prompts cost one judge call, topic
switches drop the old set, and judge outage / malformed verdicts fail closed.

**What this says about savings, before any paid eval:** the judge is the
component that decides the block's cost. Off, most injected bytes are waste on
every request; the paid eval (§6) should therefore compare against the judge
*on* as well as off, not treat it as an afterthought variant.

### 4.4 Deliverables

- `memory/bench/inject.ts`: pure metric fold (tested like `metrics.ts`).
- `memory/bench/scenarios.ts`: the §4.2 scripts.
- `memory/bench/inject-run.ts`: entrypoint; `--json`, `--verbose`, `--judge=none|oracle`.
- `pnpm bench:inject` in the root `package.json`; results table in `memory/bench/README.md`.

## 5. P0: measure the whole bill (done 2026-09-25)

Summary of what shipped; the code and tests are the reference.

- **Auxiliary calls.** `memory.auxiliary` rollout event per judge, extraction,
  consolidation, and final-flush call: purpose, provider/model, auth mode,
  duration, outcome, usage. One event = one attempt (`PROVIDER_MAX_RETRIES` is
  0). A call that failed or reported no usage prices as **unknown** and marks
  the total partial (`rollout/cost.ts`).
- **Per-request exposure.** `memory.exposure` per provider request: block
  bytes, local token estimate (never added to provider usage), candidate /
  rendered / full / summary counts, preparation state
  (`fresh|carried|pending|empty`), judge decision. No text or identities.
- **Rollups.** Trace, terminal waterfall (`memory`, `memory tokens`,
  `memory context`, `by op`), OTLP, and `TrialResult.costByOperation`. Grader
  spend stays in `judgeCostUsd`.
- **Eval completeness.** Extraction, consolidation, and the judge prefetch are
  tracked background jobs; the runner drains them
  (`FREECODE_EVAL_MEMORY_DRAIN_TIMEOUT_MS`, 10 s). Pending work leaves
  `costUsd` undefined; a partial price sets `costPartial`. Comparisons count
  both as unpriced and refuse a cost delta.
- **Rendering.** Whole serialized block fits the UTF-8 cap; exact rendered
  entries drive notices, exposure, and citation eligibility; episodes render
  their name so `episode/<name>` is citable.
- **Tests.** `cost.test.ts`, `background-jobs.test.ts`,
  `loop-memory-exposure.test.ts` (real loop: one exposure per request that
  carried the block, zero bytes when none), byte-boundary sweep in
  `mem-prompt.test.ts`, unpriced cases in `compare`/`ab` tests.

## 6. P1: paired eval: does memory pay?

**Prerequisite: a recall-off switch.** Today extraction, judge, and
consolidation can be disabled, but automatic recall cannot. Add
`memory.autoRecall` / `FREECODE_DISABLE_MEMORY_RECALL=1`, re-read per request
so `eval ab` accepts it (`VARIABLE_ENV_KEYS`), and have exposure record
`preparation: "disabled"` so an off trial is distinguishable from an empty one.
Static memory guidance and the `memory` tool stay constant on both sides;
record that choice in the experiment.

**Start with two variants, not five:**

| Variant | Recall | Judge | Purpose |
| --- | --- | --- | --- |
| A | off | — | baseline |
| D | as shipped | as shipped | does memory help at all? |

Add B (BM25 only), C (+ vectors), E (± judge) **only if A vs D shows a real
difference**; they answer "which part helps", which is moot until something does.

**Suite.** `evals/memory.jsonl`, 6–10 cases, each with a frozen memory fixture
loaded into an isolated per-trial store (never the real one; extraction and
consolidation off on both sides):

- tasks where a remembered fact decides the right answer (a convention, a
  forbidden command, a past decision), scored by a deterministic checker;
- tasks where memory saves investigation (the answer is findable in the repo
  but costs reads), scored on outcome **and** tool calls/turns;
- 2–3 tasks where memory is irrelevant, to catch negative transfer and pure
  block cost.

**Protocol.** Interleaved pairs (`eval ab` already does this), pinned model and
auth mode, ≥3 trials per case (5 for anything close). Report per case:
pass rate, turns, tool calls, input/cache/output tokens, `costByOperation`,
and cost per successful task, on comparable pairs only. Predeclare with
`--hypothesis` before running.

**Verdict labels:** *saves cost at comparable quality*, *improves quality at
additional cost*, *regresses*, *inconclusive*. A lower token count alone is not
a verdict when cache behaviour or models differ.

### 6.1 Results — first paired run (2026-09-25, MiniMax-M3, 3 trials)

`evals/memory.jsonl`: 6 memory-decides cases + 2 controls, both runs against
the same recall-off baseline. Ledger: `2026-09-24-memory-1` (kept),
`2026-09-24-memory-2` (rejected).

| | recall off | recall on, judge off | recall on, judge on |
| --- | ---: | ---: | ---: |
| tasks passed | 12/24 · 13/24 | **23/24** | 20/24 |
| cases improved vs off | — | 4 of 6 | 2 of 6 |
| controls passed | 6/6 | 6/6 | 6/6 |
| first request carried memory | — | **24/24** | 0/24 |
| memory-case trials with no memory at all | — | 0/18 | 5/18 |
| block per request (all / controls) | 0 | 789 B / 830 B | 207 B / **0 B** |
| suite cost | $0.172 · $0.196 | $0.200 (+16.6%) | $0.215 (+9.6%) |
| **cost per passed task** | $0.0143 · $0.0151 | **$0.0087 (−39%)** | $0.0107 (−29%) |
| judge cost | — | — | ~$0.0002 / trial |

(The two recall-off columns are the two runs' own baselines.)

**Verdict, judge off: improves quality at additional cost, and lowers cost
per passed task.** Recall nearly doubles the pass rate. Total spend rises
16.6% because the block rides every request, but each passed task costs 39%
less, and total tokens fell 11% (fewer turns hunting for what memory says).
No negative transfer: the controls pass on both sides. The cost is the ~830 B
block on tasks it cannot help.

**Verdict, judge on: rejected.** The judge does what it is for on the
controls (0 B injected, a quarter the average block) for almost nothing, but
it costs quality, for two measured reasons:

1. **It makes every first request cold.** The judge is a network call on the
   prefetch, so it never finishes inside the 60 ms cold budget: 0/24 first
   requests carried memory, and many tasks settle their approach on the first
   request.
2. **It drops relevant memories.** It judges descriptions only, and rejected
   "never run npm install" for a module-not-found task (3/3) and the cents
   rule for a pricing task (2/3).

**Implication for the default.** `memory.retrievalJudge` defaults to `true`;
on this suite judge-off is strictly better on quality and per-task cost. Flip
it, or fix both judge problems (serve unjudged candidates on the cold path and
judge on the next request; give the judge a body excerpt) and re-run §6
before deciding. Tracked in `TODO.md`. Caveats: one model, 8 cases, 3 trials,
a hand-written suite; the controls are only two.

### 6.2 Results — judge fixed, second run (2026-09-25, MiniMax-M3, 3 trials)

Both §6.1 judge problems fixed (commit "make the retrieval judge usable on
the first request"): on a cold miss the prefetch serves retrieval's candidates
(`unjudged`) and the verdict governs the next request; the judge sees a
160-char body excerpt and is told that conventions, forbidden commands,
formats, units, and past decisions count. Ledger `2026-09-25-memory-1`
(kept) and `2026-09-25-memory-2` (inconclusive, recorded as rejected).

**Memory vs no memory (fixed judge):**

| | recall off | recall on, fixed judge |
| --- | ---: | ---: |
| tasks passed | 13/24 | **24/24** |
| tokens | 1.99M | 1.61M (**−19%**) |
| turns | 113 | 92 (−19%) |
| suite cost | $0.1778 | $0.1791 (+0.7%) |
| **cost per passed task** | $0.0137 | **$0.0075 (−45%)** |
| first request carried memory | — | 24/24 (was 0/24) |
| memory-case trials with no memory | — | 0/18 (was 5/18) |

**Judge off vs fixed judge, head to head:**

| | judge off | fixed judge |
| --- | ---: | ---: |
| tasks passed | 23/24 | 22/24 (no case changed by majority) |
| tokens / cost | 1.56M / $0.164 | 1.74M / $0.173 |
| block per request (all / controls) | 796 B / 830 B | 619 B / 237 B |
| judge spend | — | $0.0010 |

**Verdicts.** Automatic recall pays: +11 tasks out of 24, 19% fewer tokens
and 45% lower cost per passed task, with no negative transfer on the
controls. It held across four independent runs (12–13/24 off, 23–24/24 on).
The fixed judge is no longer harmful, but it is not measurably better or
cheaper: it trims a few hundred bytes a request, below run-to-run noise at
this block size. It would matter with a larger store, where judge-off fills
the 2 KB cap with memories that do not apply (`bench:inject`: 62.5% of the
block). **Decided 2026-09-25: the judge is off by default**
(`memory.retrievalJudge: true` or `FREECODE_DISABLE_MEMORY_JUDGE=0` enables
it; recorded in `docs/DECISIONS.md`). Revisit with a large-store suite.

## 7. P2: multi-session savings

The paired eval freezes the corpus. This experiment lets memory learn: scripted
histories run as consecutive sessions in one isolated store with extraction and
consolidation on, then later tasks that need earlier context.

Measure durable-fact capture, false memories, duplicate growth, correction of
changed facts, later-task quality, and **cumulative runtime cost vs a no-memory
run of the same sessions** at increasing session counts, the "how much has
memory saved us over N sessions" curve. Consolidation cost is amortized across
the sessions it served. The harness must call `endSession` so the final flush
runs (single-trial evals never do).

An external held-out set (LongMemEval-S, after a licence check) may be added
later and reported separately; never tune on it.

### 7.1 Results — first multi-session run (2026-09-26, MiniMax-M3, 3 trials)

`evals/memory-sessions.jsonl`: 4 learn-then-use cases (one with a mid-way
correction) and a control; each case runs 1–2 teaching sessions, ended with
the daemon's session-end flush, then the scored session. Off = recall and
extraction off; on = both on, judge off (the default). Ledger
`2026-09-25-memory-sessions-1` (kept).

| | memory off | memory learning |
| --- | ---: | ---: |
| final-session tasks passed | 4/15 | **13/15** |
| control passed | 3/3 | 3/3 |
| suite cost (all sessions) | $0.253 | $0.291 (+15%) |
| **cost per passed task** | $0.0632 | **$0.0223 (−65%)** |
| session-end extraction cost | — | $0.0112 (3.9% of spend) |
| memories captured | 2 (model's own tool saves) | 21 |

**Verdict: memory learns, and learning is cheap.** Facts stated in passing in
an earlier session decided later tasks: 3 of 4 learning cases went from
failing to 3/3, including the correction case, which used the corrected value
every time. Capture costs under 4% of spend. `learn-forbidden-install` failed
the turn cap on both sides (1/3 each), a task-difficulty result, not memory's.

**Not measured:** consolidation (it runs at most once per project per day,
after 5 sessions, so never inside a trial), the savings curve over many more
sessions, and an external corpus. Those need a long-horizon harness and are
left in `ROADMAP.md`.

### 7.2 Consolidation comparison harness (2026-09-26)

`evals/memory-consolidation.jsonl` uses identical isolated stores on both
sides, a protected per-project schedule (`1` eligible two-turn session, `0`
hours), and the production scheduler between teaching and the scored task.
`FREECODE_DISABLE_MEMORY_CONSOLIDATION=1` is the off arm. The scheduler result
and auxiliary-call cost are recorded on the final session trace; a skipped pass
is an invalid candidate, not a zero-cost result.

Two fixtures, two different answers (`evals/experiments.jsonl`, MiniMax-M3,
`storeSize`/`costByOperation` now surfaced in the ledger — rendered recall is
still the one unaddressed metric):

- `consolidate-production-endpoint` (near-duplicate merge only, nothing to
  supersede): the 3-trial run (`-4`) read as a 4.7% cost win, but the 5-trial
  replicate (`-5`) reversed it — candidate cost was 10% *higher*
  ($0.0752 vs $0.0683) and pass rate was NOT preserved: one candidate trial
  failed (`localhost` survived unfixed) on a run where consolidation had
  merged and deleted a memory right before the scored prompt. `storeSize` did
  not shrink by a consistent amount (2/3/2/3/3 across candidate trials — two
  were no-ops). **Verdict: rejected.** The earlier small-sample "win" was
  noise, and there is a real, if infrequent, failure mode when a merge lands
  immediately before the store is read for the final task.
- `consolidate-stale-then-corrected` (a stale memory that disagrees with a
  corrected one, plus a same-surface distractor and an unrelated control):
  two independent 3-trial runs (`-6`, `2026-09-26-...-1`) both went 3/3 on
  both arms, six-for-six on the candidate side. Consolidation deleted the
  stale memory in every candidate trial, never touched the distractor or
  control (no failure ever implicated them), and was consistently cheaper —
  tokens -24% to -33%, cost -33% to -40%, fewer turns. **Verdict: kept.**

Net: consolidation reliably fixes a stale-vs-corrected conflict and is worth
its cost there, but merging near-duplicates that had nothing to supersede
shows no proven benefit and one demonstrated regression. That split is the
finding — not "consolidation helps," but "it helps when there is something to
supersede, and needs more evidence (and possibly a guard against
merge-immediately-before-read) when there is only a near-duplicate to fold."

### 7.3 Long-horizon savings-curve results (2026-09-26, MiniMax-M3, 3 trials)

ROADMAP.md's "Savings-curve experiment" (memory-long-horizon #4), run against
`evals/memory-long-horizon.jsonl` (5 cases, up to 12 teaching sessions each,
ending in one scored probe; `evals/experiments.jsonl`
`2026-09-26-memory-long-horizon-{1,2}`). Two paired runs, both `--trials 3`,
judge off (the default), same model on every arm:

**Arm A (recall + extraction off) vs arm C (learning + consolidation on an
explicit per-project schedule, `consolidateMinSessions:1`,
`consolidateMinHours:0`):**

| | memory off | learning + scheduled consolidation |
| --- | ---: | ---: |
| passed | 3/15 | **10/15** |
| total cost | $0.7394 | $0.8433 (+14%) |
| **cost per passed probe** | $0.2465 | **$0.0843 (−66%)** |

Per case (passed/3): `long-repeated-fact` 0→3, `long-gap-survival` 0→3,
`long-late-correction` 0→2, `long-incremental-assembly` 0→0 (unchanged-fail,
see caveat below), `long-irrelevant-chatter-control` 3→2 (one candidate
failure, an unrelated sign-flip bug — `verify exit 1: -6 == 6` — not a memory
symptom).

**Arm B (learning, consolidation off) vs arm C (learning + consolidation on
schedule)**, isolating consolidation's own contribution at this horizon:

| | consolidation off | consolidation on schedule |
| --- | ---: | ---: |
| passed | 8/15 | **11/15** |
| total cost | $0.9409 | $0.7683 (−18%) |
| **cost per passed probe** | $0.1176 | **$0.0698 (−41%)** |

Per case: `long-repeated-fact` 1→3, `long-late-correction` 1→2 (inconclusive
per the CLI's own delta label), `long-gap-survival` 3→3 unchanged-pass but
cheaper, `long-incremental-assembly` 0→0, `long-irrelevant-chatter-control`
3→3 unchanged-pass, no negative transfer this run.

**Savings curve.** `memorySnapshots` on every trial gives cumulative teaching
cost at any session count without re-running. Averaged over the 3 trials of
`long-repeated-fact` (arm A vs arm C):

| session | 1 | 3 | 6 | 9 | 12 |
| --- | ---: | ---: | ---: | ---: | ---: |
| memory off | $0.0046 | $0.0156 | $0.0324 | $0.0429 | $0.0545 |
| learning + consolidation | $0.0045 | $0.0195 | $0.0400 | $0.0564 | $0.0769 |

The pattern held on all five cases: **no break-even in teaching cost itself**
— learning consistently costs 20–50% more by session 12 than memory off,
session over session, because extraction (and later, consolidation) runs on
top of the same teaching turns. The entire return is in the final probe: the
off arm pays for 12 sessions and then fails the task it was there for, so its
effective cost-per-passed-probe is what's actually large. There is no session
count in this suite where cheaper *teaching* offsets that — the win is
"answer correctly at all," not "answer correctly for less."

**Verdicts: both kept** (`evals/experiments.jsonl`). Memory learning across a
long, diluted, corrected, gapped horizon extends the short-horizon
`memory-sessions` result (§7.1, −65% cost/passed-task at 2–3 sessions) to 12
sessions with real distractors and a correction: −66% cost per passed probe.
Scheduled consolidation adds a further, independent win on top of plain
learning at this horizon (−41% cost per passed probe), extending the
single-fixture `consolidate-stale-then-corrected` result (§7.2) rather than
contradicting the rejected `consolidate-production-endpoint` one — the
long-horizon cases have real corrections and dilution to resolve, which is
exactly the condition under which §7.2 found consolidation earns its cost.

**Two caveats, not swept under the rug.** The control case regressed once
(3/3 → 2/3) on a coding mistake unrelated to memory content, which is within
single-run noise at n=3 — the same lesson §7.2 already drew from
`consolidate-production-endpoint` reversing between 3 and 5 trials. And
`long-incremental-assembly` never passed once across all four arms (0/12
total). Part of that was the fixture — `regions.mjs` was immutable although
the teaching says the rate table lives there — fixed in `595b9dd3`. The
re-run on the fixed case (`2026-09-26-memory-long-horizon-3`, rejected) is
still 0/3 vs 0/3, and now it is memory: recall injected 4 memories every
turn, but the fact taught in the last session was never retained, and in 2
of 3 trials the forced consolidation merged/deleted entries and a rate taught
earlier came out wrong or missing. So memory, as built, does **not** reliably
assemble a fact spread across sessions; both mechanisms are filed in
`TODO.md`. **Not measured**: single-trial noise at this
horizon (3 trials, not the 5-trial replicate that reversed §7.2's other
fixture), the external corpus, and a wider consolidation schedule than "every
eligible session."

### 7.4 External corpus: LongMemEval-S, adapted subset (2026-09-26)

**Reported separately from every internal suite, and not a LongMemEval
score.** ROADMAP "Memory: long-horizon evaluation" #5 (adapter) and #6
(run). Reproduce with `pnpm bench:longmemeval run <corpus> <out>` then
`judge <out> <provider> <model> <corpus>` (`scripts/longmemeval.ts`).

**Source.** `xiaowu0162/longmemeval-cleaned`, split `longmemeval_s_cleaned`,
MIT, revision `98d7416c24c7…`, file sha256 `d6f21ea9…c3a442` (verified after
download; pinned in `LONGMEMEVAL_SOURCE`). The `longmemeval_s` split ROADMAP
originally named lives in `xiaowu0162/longmemeval`, which its maintainer
deprecated for noisy history sessions. The 277 MB file is not in the repo.

**Method.** 24 of 500 questions, stratified proportionally over the six
question types (multi-session 6, temporal-reasoning 6, knowledge-update 4,
single-session-user 3, single-session-assistant 3, single-session-preference
2; mulberry32 seed 20260926). Per question, a fresh sandbox store: every
haystack session (38–62 per question, ~8.6 KB of transcript each) is sent
chronologically through the production `extractMemories` — no live agent
turn, since the haystack is fixed dialogue — then the question runs as one
real `explore`-mode turn on MiniMax-M3 with default recall (judge off).

**Deviations from the official protocol**, all deliberate:
- Judge is `anthropic/claude-haiku-4-5` with this repo's own binary prompt,
  not GPT-4o with `evaluate_qa.py` (no OpenAI provider configured). The run
  started on Gemini and exhausted its quota mid-way; every sample was then
  re-graded by one judge so no two verdicts came from different graders.
- 24 questions, not 500.
- `extractMemories` truncates a transcript to its last 12 000 chars; longer
  sessions lose their start. That is production behavior, kept as-is.
- One question (`gpt4_70e84552`, "fixing the fence or trimming the goats'
  hooves?") was excluded by the answer-leak guard. That is a guard false
  positive — binary-choice questions contain their answer by design — so
  23 were scored.

**Results.**

| | correct |
| --- | ---: |
| answerable questions | **1/18** |
| — of which recalled from memory | **0/18** |
| abstention questions (`_abs`, right answer is "I don't know") | 5/5 |

The one answerable hit (`58470ed2`) quoted Borges from general knowledge
after saying it had no access to the prior conversation. Per type,
answerable: multi-session 0/6, temporal-reasoning 0/4, knowledge-update 0/2,
single-session-user 0/1, single-session-preference 0/2,
single-session-assistant 1/3 (the Borges one).

**Why.** Extraction, not retrieval: **4 memories were saved from 1,090
ingested sessions** (0.4%; 2 of 23 questions had any), so there was nothing
to recall. `extractMemories`'s prompt asks for durable facts "from a coding
session" in four types (user, feedback, project, reference), and
LongMemEval's haystack is personal-assistant chat — what someone bought,
when they started a class, who gave them a gift. The model answered
honestly throughout: every miss was "I have no record of that", never an
invented fact.

**Predicted by the adapter's smoke run.** Before the corpus run, a synthetic
4-session haystack (one session: "I just adopted a beagle puppy... I named
him Biscuit") ingested cleanly ($0.00046) but saved **zero** memories, and a
fresh session asked "what is the name of my dog?" answered that it had no
record. One trial, one model, but the same extraction-scope gap the corpus
run then showed at scale.

**Cost.** Ingestion $0.713 (1,090 extraction calls), scored turns $0.080.
The judge ran on an OAuth subscription, so it is unpriced (`undefined`, not
$0).

**Two judge bugs found and fixed along the way**, both of which would have
inflated or blanked the number: at `maxTokens` 16 and 64 the judge's reply
was cut mid-word (`"IN"`, `"INCOR"`) and parsed as no verdict; and a global
"saying you don't know is correct" rule, meant for abstention questions,
graded two answerable "I have no record" replies CORRECT. It is now scoped to
`_abs` questions only, and the final numbers match a hand audit.

**What this does and does not say.** It says the production memory system,
as scoped, does not retain general personal-assistant facts from long chat
histories. It says nothing about retrieval quality or consolidation on this
corpus, because nothing reached them. Widening what extraction keeps is a
product-scope decision (and a cost one: more saves, more injected bytes), not
a fix to make against this benchmark, which this run was deliberately not
tuned on.

## 8. Completion checklist

- [x] Full runtime memory cost is measurable, including background calls.
- [x] The byte cap is strict and exposure attribution matches rendered content.
- [x] `pnpm bench:inject` reports rendered recall, wasted bytes, and every §4.2 scenario.
- [x] Every failing scenario is fixed with a regression test, or recorded in `docs/DECISIONS.md` as intended.
- [x] Recall can be switched off per request, and `eval ab` accepts the switch.
- [x] A recorded A-vs-D experiment in `evals/experiments.jsonl` with a verdict (judge off and on).
- [x] A multi-session report gives cumulative cost with and without memory (§7.1; consolidation and the long-horizon curve are in `ROADMAP.md`).
- [x] `MEMORY_SYSTEM.md`, bench README, `EVAL.md`, `TRACE.md` match shipped behaviour (checked 2026-09-25).
