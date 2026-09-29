# Commit Reconstruction Bench — BuffBench's method on this repo's own commits

**Status:** Phases 0–2 code built (2026-09-29); Phase 2 not yet *run*. Built: `pnpm bench:commits`,
`pnpm bench:tasks generate|list|approve`, `pnpm bench:agents --set freecode-commits [--isolate]`
(judged trials: contamination check, setup, 60-minute timeout, final checks; in the agent's image
when isolated), `pnpm bench:judge` (audit mode or `--panel`, §5's metrics, publishability =
isolated ∧ judging verified ∧ contamination checked). The in-container install (§4.7) is
unit-tested but **not yet run live**. Not built: §6.5 (per-agent `CLAUDE.md` detection needs a
proxy change; the proxy logs no bodies) and §6.7 (no detection rule defined). Operator page:
`AGENT-BENCH.md` §3d
**Date:** 2026-09-29
**Prior art:** freebuff's BuffBench (`~/Project/githubprojects/freebuff/evals/buffbench/`,
Apache-2.0, read for this spec on 2026-09-29). It has about 500 tasks rebuilt from real
commits in 4 repos (codebuff, manifold, plane, saleor). Each task is an LLM-written prompt
over a real `parentSha → sha` diff, judged by a **GPT + Sonnet panel** (ours: Gemini + GPT, §3) against the
ground-truth diff, with `finalCheckCommands` (`typecheck`, `test`) output shown to the judges.
**This spec adopts that method as-is.** §3 lists every place it differs and why.
**Extends:** `2026-09-03-agent-comparison-benchmark.md` — this is its **Phase 5** ("held-out
set from this repo's own commits", §6.1, §10.2). It reuses that spec's runner, container,
proxy and metering unchanged. **It overrides that spec's §6.5 for this task set only:** the
verdict comes from two LLM judges, not an external test harness (owner decision,
2026-09-29).
**Related docs:** `AGENT-BENCH.md` (operator page this will add a section to), `EVAL.md`.

---

## 0. Read this first (plain language)

`pnpm bench:agents` runs freecode against Claude Code and OpenCode on 10 Django bugs from
SWE-bench Lite. That set has two holes the parent spec already names: **contamination**
(every fix is public and older than every model's training cutoff) and **shape** (every
task is a small Python bug fix, while freecode is a TypeScript tool whose real work is
multi-file features).

BuffBench's answer, taken whole: pick real commits from the repo, check out each one's
parent, have an LLM describe the change as a user request, let each agent attempt it, then
have **two judges from different model families** score the agent's diff against the real
one on three 0–10 scales. Ours are Gemini and GPT-5.5. The judges' scores are averaged. The median judge's written
analysis is kept, and so is each judge's own score.

## 1. Motivation

- **The parent spec promised a contamination control and has none.** Phase 5 of
  `2026-09-03` is a table row with no design.
- **The raw material exists.** Since 2026-07-01 this repo has 1054 non-merge commits.
  **457 pass BuffBench's basic filter** (§4.2 steps 1–3, restricted to commits touching
  `apps/core/src` or `apps/tui/src`; measured 2026-09-29). BuffBench's LLM screen (step 4)
  keeps "HARD" commits only, so expect a fraction of that. Its hard sets hold 34–88 tasks
  per repo.
- **Judged grading means commits need no tests.** A test-graded set could only use commits
  that shipped tests, and only those whose tests fail at the parent. A judged set can use
  any substantial commit, which is most of the feature work.

## 2. Goals / non-goals

**Goals.** A second agent-bench task set (feature-sized TypeScript changes from
`apps/core` and `apps/tui`, newer than the pinned model), run under agent-bench's isolation
and metering and scored the way BuffBench scores. Reported **next to** the SWE-bench number,
never instead of it (parent §6.1).

**Non-goals.**
- A replacement for `pnpm eval` or its single judge (§4.6 last paragraph).
- BuffBench's trace analyzer, meta analyzer and lessons extractor. Candidates for a later
  spec. They analyse process and do not change scores.
- Other repositories' tasks. That is Phase 4 (§7).

## 3. Differences from BuffBench, all of them

| BuffBench | Here | Why |
| --- | --- | --- |
| 1 trial per (agent, task) | **3** | Parent §6.6. BuffBench's own `main-flash-harness.ts` runs arms as separate sweeps to control variance. N=3 addresses variance directly |
| Any commit date | **Only commits after the pinned model's release** (§4.8) | The repo is public since its first commit. The date window is the only contamination control |
| Prompts go in unreviewed | **The repo owner reviews every prompt** (§4.3) | Owner decision |
| Single score per agent | **Reported separately for `core` and `tui`** (§5) | A TUI change is judged on code alone and nobody looks at the screen. Pooling hides that |
| Runs in a temp clone on the host | **Container per trial, recording proxy** (parent §6.3–6.4) | Unchanged agent-bench rule. Needed for the cost column and the isolation audit |
| Judges via Codebuff's hosted agents | Calls through core's provider layer (§4.6) | We have no Codebuff backend. Same prompt, same schema |
| Both judges score every task | **Audit mode (default):** Gemini scores every trial; GPT re-judges a deterministic 20% sample to measure agreement, and scores a trial only when Gemini fails (§4.6). The full panel stays available | Owner decision 2026-09-29, option (a). A GPT call here is ~118K input tokens (median over the 10 pilot tasks, mostly context files), so the full panel costs ~14M Codex tokens for Phase 2 against ~3M for the audit |
| Panel: GPT + Sonnet | **Gemini 3.5 Flash + GPT-5.5**, GPT reached through `codex exec` on the owner's **Codex subscription** | Owner decision 2026-09-29. No OpenAI or Anthropic API key exists. Sonnet via the Claude subscription was tried and refused by Anthropic ("OAuth authentication is currently not allowed for this organization"). MiniMax was rejected because it is the model under test (§4.6) |
| `judge-gemini` defined but disabled | Not defined | It was their dead judge |

Everything else is BuffBench's behaviour: commit filters, HARD screen prompt, task generator
(id, spec, prompt, supplementalFiles), supplemental-file validation, judge prompt and schema,
panel arithmetic, aggregate metrics, and exclusion of errored tasks.

## 4. Design

### 4.1 Task record

`bench/agent-bench/instances/freecode-commits.json`, BuffBench's `EvalDataV2` shape (so
their tooling reads it) with five added fields marked `+`:

```jsonc
{
  "repoUrl": "https://github.com/ayandexyz/omacode",   // public name; code and ids say freecode
  "generationDate": "2026-…",
  "initCommand": "pnpm install --frozen-lockfile --offline",
  "finalCheckCommands": [],                             // per task instead, see + below
  "evalCommits": [{
    "id": "add-steer-queue",                            // generator's 2–3 word id
    "sha": "<fixCommit>", "parentSha": "<baseCommit>",
    "spec": "…", "prompt": "…",
    "supplementalFiles": ["…"],
    "fileDiffs": [{ "path": "…", "status": "modified", "diff": "…" }],
    "app": "core" | "tui",                             // + the app the change lives in
    "finalCheckCommands": ["pnpm --filter <app> exec tsc --noEmit", "pnpm --filter <app> test"], // +
    "promptReview": { "by": "<owner>", "at": "2026-…" }, // +
    "coAuthoredByClaude": true,                         // + from the commit trailer (§6.3)
    "screen": { "reason": "…", "shortDescription": "…" } // + why the screen kept it, shown at review
  }]
}
```

`fileDiffs` **is** the answer key, as in BuffBench. The runner reads only `id`, `parentSha`
and `prompt` into a trial. `fileDiffs`, `spec` and `sha` reach only the judge. `Instance` in
`runner/types.ts` gains `grader: "swebench" | "judged"` (default `swebench`), and the
`judged` loader maps `parentSha → baseCommit` and `prompt → problemStatement` and drops the
rest before anything touches the trial dir. This is the same rule `instances.ts` applies to
SWE-bench's `patch`.

### 4.2 Commit selection (`runner/commits.ts` + the screen in `gen-tasks.ts`, port of theirs)

1. `git log` over the date window (§4.8).
2. **Their `basicFilter`, unchanged:** drop messages matching dependency bumps, "auto-generated" /
   "generated by", `ci:`, `build:`, formatting/lint/prettier, merges, reverts,
   docs-only (`readme` on ≤1 file, `docs:` on ≤2). Drop stats of 0 files, ≤1 file with
   <5 changed lines, >50 files, or >2000 changed lines.
3. **Ours, for scope:** the commit must touch non-test `.ts` under `apps/core/src/` or
   `apps/tui/src/`. A commit touching both apps is assigned to whichever has more changed
   lines and is judged whole (the judge sees the full diff either way).
4. **Their HARD screen, unchanged:** their `COMMIT_SCREENING_PROMPT` verbatim, with its
   instruction to be "VERY selective" and REJECT when in doubt, over each commit's
   stats and diff, run as a structured call returning `{sha, reason, shortDescription}`
   for keepers. Screening model: the GPT judge's model, through the same `codex exec` transport (§4.6). Never the model under test.
   Their screen input is kept too, including its positional "Line N: - / +" comparison,
   which is not a real diff and prints most of a changed file after the first inserted
   line. Ours adds one thing, a 150K-character cap, because theirs has none and a large
   commit would overflow the context and kill the call. Verdicts are cached per sha
   (`.cache/screen.json`), so no commit is screened twice.

### 4.3 Task generation (`runner/gen-tasks.ts`, port of theirs)

1. **Their `eval-task-generator` prompt, verbatim.** Input: diff, edited paths, commit
   message. It may explore the parent tree. Output: `id`, `reasoning`, `spec`, `prompt`,
   `supplementalFiles`. Generator model: same as the screen (GPT-5.5 via `codex exec`),
   run in a detached throwaway worktree at `parentSha` with a read-only sandbox. Their
   generator explores with Codebuff's file-picker and code-searcher subagents. Ours
   explores with Codex's read-only shell, which does the same job. Their instruction
   step 2 is reworded to say so, and their two Codebuff template placeholders (file
   tree, knowledge files) are dropped because Codex reads the tree and `AGENTS.md` /
   `CLAUDE.md` itself. Both edits are recorded in `runner/buffbench-prompts.ts`, whose
   prompts are extracted from BuffBench's source by script, not retyped.
2. **Their `filterSupplementalFiles`**: drop supplemental paths that do not exist at
   `parentSha`.
3. **Owner review:** every `prompt` is read and approved (or edited) by the repo owner
   before the record is written. Drafts land in `instances/freecode-commits.draft.json`
   (`pnpm bench:tasks list` prints them). `pnpm bench:tasks approve --by <name>` moves
   them into `instances/freecode-commits.json`, the only file the runner reads. `promptReview.by` is required and the writer refuses a
   record without it. The owner wrote most of these commits and knows the answer while
   reading, so the review question is "would a user plausibly type this?", not "is it
   solvable?".

The per-trial prompt handed to every agent is `prompt`, wrapped by a second template in
`runner/prompt.ts`, identical for every agent (parent §10.3):

> You are working in a checkout of the freecode repository. Implement the change described
> below. When you are done, stop — do not commit.

### 4.4 A trial

As BuffBench's `runAgentOnCommit`, inside agent-bench's container:

1. Prep step (§4.7), then check out `parentSha`.
2. Agent runs `prompt`. 60-minute ceiling, as theirs.
3. `extractPatch` (existing: staged diff, so new files count).
4. Run the task's `finalCheckCommands` in the same workspace, after the patch is taken.
   Capture command, exit code, stdout and stderr (theirs: `FinalCheckOutput`). Ours: each
   stream is cut to its last 20K characters, because a full core test run prints thousands
   of lines into a judge prompt that is already ~118K tokens, and the verdict is at the tail.
5. Collect **context files** for the judge: `supplementalFiles` ∪ the paths in `fileDiffs`,
   minus paths whose status is `added`, each read with `git show <parentSha>:<path>`.

### 4.5 The judge input (`runner/judge.ts`)

Their judge prompt, verbatim in structure:

```
## User Prompt (What the agent was asked to do)
<prompt>
## Context Files (from parent commit)
### <path> ```…```  (or "(No context files)")
## Ground Truth Changes (One valid implementation)
### <path> ```diff …```
## Agent's Changes (What the agent actually did)
```diff <agent diff or "(No changes made)"> ```
## Error Encountered            (only if the trial errored)
## Final Check Command Outputs  (only if any ran)
```

Their **system prompt, verbatim** ("You are an expert software engineer evaluating
AI-generated code changes with empathy for the task given… The ground truth shows ONE
valid implementation, but it's not the only correct answer"). It is copied into
`runner/judge-prompt.ts` with an Apache-2.0 attribution header, and the NOTICE entry is
added to the repo.

Their **output schema, verbatim**: `analysis`, `strengths[]`, `weaknesses[]`,
`completionScore` 0–10, `codeQualityScore` 0–10, `overallScore` 0–10.

### 4.6 The panel (their arithmetic, exactly)

- **Two judges, run in parallel** (`runner/judge.ts` `JUDGES`, pinned 2026-09-29):
  - **`judge-gemini`: `gemini-3.5-flash`**, through core's providers, using the key already
    in `~/.freecode/config.json`. It is the strongest Gemini this key can call:
    `gemini-3.1-pro-preview` returns a quota error, and `gemini-2.5-pro` and
    `gemini-3-pro-preview` are retired for new users (probed 2026-09-29). A Flash judge is
    weaker than BuffBench's, so a key with Pro quota is the first upgrade.
  - **`judge-gpt`: `gpt-5.5`**, through `codex exec` on the owner's Codex (ChatGPT)
    subscription (`runner/codex-complete.ts`). This is OpenAI's own client in its documented
    headless mode, not freecode presenting itself as another client, which is why it was
    acceptable where the Claude-subscription route was not.
  - **Not MiniMax**, while MiniMax-M3 is the pinned model under test. It would grade its own
    output, and freecode's prompts and evals have been tuned on M3, so a MiniMax judge is
    the one most likely to prefer freecode. `assertNoCollision` refuses any judge from the
    model under test's **family** (the `codex` transport counts as `openai`), so pinning the
    agents to an OpenAI model would also retire the GPT judge.
  - Both ids are written into every judged report. A retired id is how a judge dies quietly
    (`EVAL.md`'s retired-Gemini incident, BuffBench's dead Gemini judge).
- **Transport** (`core-complete.ts` `judgeComplete` routes by `provider`):
  - Gemini goes through `apps/core/src/providers/` (`getProvider`), the same path
    `eval/scorers/judge.ts` uses. This deliberately differs from `proxy/price.ts`, which
    copies its rate table rather than importing core: that rule protects a *published
    number*, and a judge's transport is not one. Core returns text, so the §4.5 schema is
    stated in the prompt and `parseJudging` validates the reply.
  - GPT goes through `codex exec -m gpt-5.5 --output-schema <schema>`, which makes Codex
    enforce the reply shape, the same guarantee BuffBench's `set_output` tool gave. The call
    runs in an empty scratch dir with a read-only sandbox, `--ephemeral`,
    `--ignore-user-config --ignore-rules`, and hooks, plugins, apps, multi-agent, browser,
    computer-use and skill search disabled. **The owner's own Codex hooks, plugins and
    skills must not run inside a judgement.** Before those flags, a judge call fired the
    owner's SessionEnd hook. `codex exec` has no system-prompt flag, so BuffBench's system
    prompt leads the message.
  - Both paths go through `parseJudging`. A reply that fails the schema counts as that judge
    failing, which is BuffBench's `structuredOutput` check. So does a reply on the **wrong
    scale**: every score ≤1 with one of them fractional. GPT-5.5 answered 0.88 for a correct
    patch when a test prompt left out the 0–10 instruction, and the bounds check alone would
    have scored that as 0.88/10. The schema's score fields also say "0 to 10 scale (not 0 to 1)".
- **20-minute timeout** per judge, as theirs.
- **Audit mode, the default (`runner/judge-audit.ts`).** Owner decision 2026-09-29.
  - **Gemini scores every trial.** GPT is called only for a **20% sample** and as a
    **fallback**.
  - **The score is always the scoring judge's own**, never a mean, so an audited trial
    and an unaudited one are scored the same way. On an audited trial, GPT's verdict is
    recorded in `judgeScores` and used only for agreement.
  - **The sample is `sha256(task|agent|trial)` < 0.2**, so it is deterministic.
    Re-judging a run audits the same trials, and two runs' agreement numbers are
    comparable.
  - **Gemini dead → GPT scores that trial** (`fallback: true`, `scoredBy` records it),
    so a Gemini outage is a flagged row, not a row of zeros. Both dead → BuffBench's
    zeros + `judgeFailed`.
  - **Agreement gate:** mean |Gemini − GPT| over audited trials where both answered. A
    run may be reported as "scored by Gemini, audited by GPT" only with **≥5 two-sided
    audits and a mean gap ≤ 1.5 points**. Below 5 it is *unmeasured*, above 1.5 it is
    *failed*, and either way a published number needs the full panel.
  - **Gemini is retried twice (20 s, 60 s) before GPT takes over.** Every fallback puts
    GPT's scale into a Gemini-scored run. The first live smoke fell back on both trials
    over a transient "model is experiencing high demand".
  - Why: a GPT call on these tasks is ~118K input tokens (median of the 10 pilot tasks,
    ~80% context files). For Phase 2's 120 trials that is ~14M Codex tokens for a GPT
    verdict on every trial, against ~3M for the sample.
- **Full-panel mode** (`judgePanel`, BuffBench's arithmetic exactly, below) is kept for a
  run that will be published and whose audit failed or was unmeasured.
- **Full panel — scores = the mean of the judges that answered**, for all three scales.
- **Analysis, strengths, weaknesses = the median judge's**, sorted by `overallScore` and
  taking index `floor(n/2)`. With two judges that is the higher-scoring one, which is
  their behaviour and is kept.
- **`judgeScores[]`** records each judge's own three scores or `{failed: true}`.
- **One judge failed:** print `⚠️ Judge panel degraded for <task>: <judge> failed. Scoring
  from 1/2 judges.` and score from the survivor.
- **Both failed:** all three scores are `0`, with analysis "Error running judge agent - all
  judges failed", exactly theirs. We add one field, `judgeFailed: true`, which changes no
  number. It lets the report show that a 0 was a judge blackout and not a bad patch.

**Scope of the panel.** It is agent-bench only, living in `bench/agent-bench/runner/`,
like everything else there, and sharing nothing with `apps/core/src/eval/`. `pnpm eval`'s
judged suite keeps its **single** judge (`FREECODE_JUDGE_PROVIDER`/`_MODEL`). Moving that
suite to a panel is a separate change to the eval harness spec.

### 4.7 Dependencies and isolation

Agent containers are on `--internal` with no registry access (parent §6.3). A **prep step**
runs before each trial in the same image, on the external network: `pnpm install
--frozen-lockfile --prefer-offline` (not `--offline`: a parent commit may pin a version the
store no longer holds) against a named-volume pnpm store, warmed once per lockfile
hash. It runs in the image and not on the host, because native modules must match the
container's Node ABI (host v26, image `node:22`). Commits that change dependencies are
already dropped by §4.2 step 2's dependency-bump rule where the message says so. Any other
lockfile change just gets its own store warm-up.

**As built (`runner/judged-trial.ts`, `isolate/docker.ts` `setupArgv` / `checkArgv`).**
- **Without `--isolate`:** setup and checks run on the host. The run is `isolation: none`
  and unpublishable.
- **With `--isolate`:** setup runs as a container of the agent's image on the egress
  network (install scripts fetch prebuilt binaries — sharp does), as the operator's uid,
  with the pnpm store a **host directory** (`.cache/pnpm-store`) passed as
  `npm_config_store_dir`. The store is not a named volume, because docker creates volumes
  root-owned and the install runs as the operator. The agent then runs on the internal
  network against that tree. Final checks run in the same image with `--network none`.
- **One store, not one per lockfile hash.** pnpm's store is content-addressed, so a single
  directory serves every lockfile; per-hash stores would only duplicate it.
- **The image carries the repo's pinned pnpm** (`PNPM_VERSION`, matching
  `packageManager`), and an isolated judged run refuses an image built before that
  (`imageHasPnpm`), with the rebuild command.
- **Workspaces clone from the local repo**, so unpushed commits work.
- Why the container at all: this repo has native modules (tree-sitter, sharp, onnxruntime),
  and a tree installed on the host's Node fails to load on the image's.

**Home-field advantage, removed explicitly.** freecode was developed in this repo, and a
developer's `~/.freecode/memory` holds project memories about it. The container's
throwaway `HOME` handles that. Running this set without `--isolate` makes a run
unpublishable, and the report says `isolation: none`.

### 4.8 Contamination

The repo is public as `ayandexyz/omacode` **since its first commit (2026-05-07)**, so the
date window is the whole control. As built (`runner/contamination.ts`):

- **Release dates** live in `instances/model-releases.json`: `{ released, source }` per
  bare lowercased model id, so `minimax/MiniMax-M3` and `MiniMax-M3` are one entry.
  `null` is unknown, and **unknown fails the check**.
- **The window travels with the tasks.** `bench:commits --out` writes
  `{ window: { since, until }, candidates }`. The draft and approved task files carry the
  window, and tasks from two windows are refused in one file (`mergeWindow`).
- **The rule: every agent's pinned model was released *before* the window's first day.**
  This is stricter than this section's first draft ("refuse a model released after the
  window's end"), which would pass a model released mid-window, one that may have trained
  on the window's early tasks.
- **`bench:agents --set freecode-commits` checks before any spend** and stops on failure.
  `--contamination-unchecked` runs anyway, for smoke tests, and the report is then
  unpublishable.
- **Every judged report records** the window, each model's release date and the problems
  found (`Report.contamination`), side by side. `bench:judge` requires a passed check for
  `publishable`.

## 5. Metrics

**BuffBench's, exactly**, computed per agent after dropping every run where **any** agent
errored (their `commitShasWithErrors` rule — a run one agent crashed on is removed for all,
so nobody is scored on a different set). They run one trial, so their "run" is a commit;
with 3 trials ours is a (task, trial) pair, so one crashed trial does not discard the other
two. "Errored" = harness error or timeout:

| Metric | Definition |
| --- | --- |
| `averageScore` | mean `overallScore` |
| `averageScoreExcludingFailures` | mean `overallScore` over runs scoring **> 1.0** |
| `averageCost` | mean USD — **off the proxy**, not self-reported (parent §6.4) |
| `averageDuration` | mean wall time |

Also reported, because the parent spec requires them:

- **Per app** (`core` / `tui`), never pooled into one headline.
- **Spread across the 3 trials** per task. Tasks whose trials disagree by ≥3 points are listed.
- **Audit agreement** (`auditAgreement`): n two-sided audits, mean |Gemini − GPT|,
  each judge's mean over those trials, and pass / fail / unmeasured (§4.6). In
  full-panel mode, the same numbers over every trial. A panel that splits 8 vs 4 on
  the same diff is worth knowing about, as BuffBench's own code comment says.
- **Fallback / degraded / blackout counts**: trials GPT scored because Gemini failed,
  full-panel trials scored by one judge, and trials with `judgeFailed`.
- **Saturation** (their `analyze-task-scores.ts`, threshold 7.5): tasks every agent scores
  above 7.5 in every trial are retirement candidates.
- **Split by `coAuthoredByClaude`** (§6.3).

Cost on the intersection (parent §7.2) needs a "solved" set, which BuffBench does not
define. We use **overallScore ≥ 7.5**, their own "hard" threshold from
`analyze-task-scores.ts`. This is the only number here that is ours rather than theirs.

## 6. Confounds, to publish rather than manage

1. **We wrote the code and the prompts, and we are in the table.** It is only ever shown
   beside the SWE-bench number. Countermeasures: their selection prompt verbatim, owner
   review committed before any run, and the loss-in-the-headline rule.
2. **The grade is an opinion.** Two LLMs comparing against one valid implementation, told
   to be lenient on vague prompts. This is BuffBench's accepted trade-off, disclosed on the
   page. The judge gap and degraded counts (§5) are the evidence of how much to trust it.
3. **Half the ground truth was co-written by Claude.** 527 of the 1054 commits since
   2026-07-01 carry a `Co-Authored-By: Claude` trailer. A diff that resembles the ground
   truth scores higher, so an agent that writes code the way Claude Code writes code has an
   edge that is not correctness. Scores are therefore split by `coAuthoredByClaude`. If
   Claude Code's lead exists only on co-authored tasks, that is the finding.
4. **A GPT judge on Codex's own client, scoring a table that will include Codex.** The model
   axis is fine: every agent runs pinned MiniMax-M3. Whether a GPT judge prefers Codex's
   *harness* style (file layout, test habits) is unknown, as is whether Gemini prefers any
   harness. The per-judge means show it if it is there.
5. **freecode's own `CLAUDE.md` describes freecode.** freecode and Claude Code read it.
   Whether OpenCode does (it prefers `AGENTS.md`) is unverified for the pinned version.
   Record per agent whether the file's content appears in its first request (proxy log).
6. **The GPT judge runs on the owner's Codex subscription**, through `codex exec`.
   - It is OpenAI's own client in its documented non-interactive mode, so it carries none
     of the impersonation risk that ruled out the Claude-subscription route. Judge calls
     count against the owner's Codex usage limits. A limit hit mid-run is a dead judge,
     warned per task like any other.
   - **Codex's built-in instructions precede the judge's prompt**: about 10K input tokens
     that cannot be turned off (measured 2026-09-29, after the `--ignore-user-config` and
     `--disable` flags removed ~1.8K of the owner's own setup). The GPT judge therefore
     reads a preamble BuffBench's judges did not. Disclosed, not fixed.
   - In audit mode the headline is Gemini's, and the audit is what makes it checkable
     (§4.6 agreement gate). In full-panel mode, if more than 10% of trials were scored by
     fewer than two judges (one dead = `degraded`, both dead = blackout), the run is **not
     publishable as a two-judge run** (`panelVerdict`, `MAX_ONE_JUDGE_SHARE`). Either way
     the report says which in its first line.
   - Judge cost is not in USD. The report lists judge tokens per judge. The Codex judge has
     no per-token price, and a dollar figure would pretend the subscription is free.
7. **Specs in `docs/specs/` may describe a change before it was built.** That is legitimate
   context a developer would have. It is not stripped, and those tasks are counted.

## 7. Phases

| Phase | Deliverable | Done when |
| --- | --- | --- |
| **0** | `commits.ts` basic filter + scope filter, dry run | candidate count per app. No model spend |
| **1** | HARD screen + task generator + supplemental-file filter; owner reviews the output; judge panel pinned and wired | ≥20 reviewed tasks; `judge.test.ts` pins the arithmetic (mean, median-analysis, one-dead, all-dead → 0 + `judgeFailed`) with stubbed judges |
| **2** | 20 tasks × 3 trials × freecode + Claude Code on MiniMax-M3, isolated | `report.json` with §5's metrics, per app |
| **3** | OpenCode + Codex adapters on the same set | four-agent table |
| **4** | Import BuffBench's own `codebuff` / `manifold` task files (Apache-2.0; NOTICE) and run them through the same runner and panel | tasks someone else authored |

Phase 0 costs nothing. Phase 1's cost is the screen, generator and judge calls, which are
measured and written into this spec before Phase 2 starts.

## 8. Open questions

1. **A Pro-tier Gemini.** The panel runs on `gemini-3.5-flash` because this key has no Pro
   quota. A key that does is the first judge upgrade.

**Answered 2026-09-29 (owner), later the same day:** audit mode (§4.6) is the default:
Gemini scores, GPT audits 20% and falls back, and the full panel is reserved for publishing.
Screen only as many commits as the task target needs (the screen keeps ~60% here, so ~40
screens for 20 tasks, ~2M tokens, against ~24M to screen all ~540).

**Answered 2026-09-29 (owner):** the repo is public as `ayandexyz/omacode` since its first
commit, so the date window (§4.8) is the whole contamination control. Scope is `apps/core`
and `apps/tui`, reported separately (§5). The owner reviews every prompt (§4.3). Grading is
BuffBench's two-judge panel (§4.5–4.6), replacing the hidden-test grader of this
spec's first draft. The panel is **Gemini 3.5 Flash + GPT-5.5 via `codex exec` on the
owner's Codex subscription** (§4.6). Sonnet via the Claude subscription was chosen first and
refused by Anthropic on the first call. MiniMax is excluded while it is the model under test. Public name `omacode`; code, ids and paths keep `freecode`.
