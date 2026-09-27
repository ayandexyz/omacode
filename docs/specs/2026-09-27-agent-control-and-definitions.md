# Agent control, definitions, stall notices and continuation

**Status:** Phases 1, 2 and 4 built 2026-09-27 (`tools/agent-control.ts`; `agent/definitions/`; `tools/agent-continue.ts`). Phase 3 dropped after its §3.2 check found no stalls (§3.0).
**Branch:** `feat/background-subagents` (PR #38).
**Source:** a read of `pi-herdsman` (a Pi extension for asynchronous subagents,
`~/Projects/githubProjects/pi-herdsman`). Most of it coordinates separate Pi
processes in herdr panes (durable mailboxes, `lost`/`unknown` physical states,
chief supervision) and does not apply to FreeCode's in-process subagents. Four
ideas do, and this spec covers them.

| Phase | What | Size | Why |
| --- | --- | --- | --- |
| 1 | The model can message and stop an agent it started | small | Today only the user can stop one (`/agents`); the model that spawned it can neither correct nor cancel it |
| 2 | Agent definitions from `.md` files | medium | ROADMAP Extensibility item 3; `agentType` is really a provider override and the five `SubagentType` roles are hard-coded |
| 3 | Stall notice for a background agent | small | A background agent that stops making progress is silent until it finishes |
| 4 | Continue a finished agent with a new task | small | A follow-up question to an agent re-does its whole investigation |

Order is 1 → 2 → 4 → 3: Phase 1 is the real gap, 2 is the largest payoff, 4 is
cheap once 1 exists, and 3 is the least proven need (see §3.2).

Non-goals, taken from pi-herdsman and deliberately left: nested delegation
(`MAX_AGENT_DEPTH` stays 1), chief supervision, `ask_owner` (a subagent asking its
parent instead of the user), result references passed between agents, and
agents that survive a core restart (the background ledger already reports them
as stopped).

---

## 1. Phase 1 — `agent_send` and `agent_stop`

### 1.1 Today

- `AgentRegistry.stop(id)` (`agent/registry/registry.ts:207`) interrupts a
  subagent's loop. Its only callers are the `/agents` panel (`agents.stop` IPC)
  and session teardown.
- `AgentLoop.steer(text)` (`agent/loop.ts:3373`) queues a message that
  `drainSteers()` delivers between one tool batch and the next model call. The
  server uses it for user steering and task notifications. Nothing can reach a
  subagent's loop.
- The parent learns the agent's id from the `agent` tool result
  (`metadata.subagentId`) and from its `<task-notification>`.

### 1.2 Design

Two tools, shaped like `bashoutput`/`killbash` for shells:

```
agent_send({ agent_id, message })   // steer a running agent
agent_stop({ agent_id })            // interrupt it
```

- **Ownership:** only the agent's direct parent (`record.parentId === ctx.sessionId`)
  may send or stop. Anything else is a model-readable error, not a throw. A
  subagent can never reach its parent or a sibling.
- **Running only:** a settled agent returns
  `"<id> has already ended (<status>); its result was sent as a task notification."`
- **Steer plumbing:** the registry gets `attachSteer(id, fn)` beside the existing
  `attachInterrupt` (`tools/agent.ts:306`), bound to `subAgentLoop.steer(text)`
  with `synthetic: "steer"`. A message sent before the loop exists is queued on
  the record and flushed on attach, the same way `pendingStop` works today.
- **Undelivered messages:** if the agent finishes before its next drain point,
  `takeUndeliveredSteers()` returns the message. The completion notification
  then says so ("1 message you sent was not delivered: the agent had already
  finished") rather than dropping it silently.
- **Stop by the model:** it gets the `killbash(…, byModel)` treatment. The
  record is marked `modelKnowsEnd`, and the completion notification is skipped
  because the model asked for this. A stop from `/agents` still notifies,
  unchanged.
- **Foreground agents:** a foreground `agent` call holds the parent's turn, so
  the parent cannot call these tools while it runs. That is correct: they apply
  to background agents in practice, and the error for a foreground one never
  arises.
- **No `agent_list`:** ids are in the spawn result and in every notification.
  Revisit only if compaction is seen dropping them. The compaction summary
  already keeps tool results, so this is a guess, not a known failure.
- **No herdsman-style `interrupt` that also replaces the task:** stop, then a
  fresh `agent` call, covers it.

### 1.3 Registration checklist (CLAUDE.md "Adding a tool")

1. `tools/agent-send.ts`, `tools/agent-stop.ts` via `buildTool`, with a `type` on
   every property.
2. `tools/index.ts`.
3. `permission/mode-policy.ts`: **not** `READONLY_TOOLS`. The `agent` tool is
   already hidden in explore mode, and a read-only session cannot have spawned
   anything to control.
4. `permission/rules.ts`: neither a path nor a URL tool, so no entry.
5. `permission/suggest.ts`: `DISPLAY_NAMES`.
6. Frontends: nothing required; both TUIs have fallbacks.

### 1.4 Tests and evals

- **Unit (`tools/agent-control.test.ts`), with the fake provider `agent-background.test.ts` already uses:**
  - a send reaches the loop as a steer;
  - a send before attach is flushed;
  - a send after settle is refused;
  - a stop by the model suppresses the notification;
  - a stop by a non-parent is refused;
  - an undelivered send is reported in the notification.
- **Eval:** add a `delegation.jsonl` case in which the user changes their mind
  about a background agent's task mid-run ("actually only look at `src/api`"),
  with `expectTool: "agent_send"`. It is model-backed because choosing between
  steering, stopping and re-spawning is a judgement call. Run the delegation
  suite on MiniMax-M3 and Opus 5, per EVAL.md's rule for agent-tool
  description changes.

---

## 2. Phase 2 — agent definitions from files

### 2.0 As built — where it differs from the plan below

- **Built-ins are code, not bundled `.md` files** (`agent/definitions/builtin.ts`),
  so the bun release binary needs no extra asset. There are three, not five:
  `general` (today's behaviour), `explorer` and `reviewer`. `SUBAGENT_DEFINITIONS`
  still drives only the loop's verifier (`agent/subagent.ts`) and is untouched.
- **The roster is in the system prompt, not the tool description** (§2.4 said
  tool description). Tool definitions are process-wide (`tools/defs-cache.ts`)
  while definitions are per project, and a daemon can serve several projects.
  It is a `PromptCompiler` segment (`agent-types`, shown in `/context`),
  byte-stable until a file changes, like `CLAUDE.md`.
- **`mode` is inferred when absent:** `build` if `tools` lists `write`, `edit`
  or `bash`, else `explore`. Claude Code files have no `mode`, and
  `tools: Edit, Write` would otherwise be dead in explore.
- **The `agentType` alias is read both ways:** a definition name if one
  matches, else a registered provider, else ignored as before. Models do pass
  role names in it.
- **A role's tool allowlist is enforced twice:** the tool list the model is
  offered is filtered, and a call to anything else is refused with
  `function.denied` source `role` (`DenySource`).
- **Not built:** the `/agents` row showing the definition name (§2.6). The
  registry records it as `agentType`, but the TUI does not render that field.
  Also not built: `eval ab` (§2.7). Nothing can switch the roster off, so the
  check was `trajectory --gate` against the pre-change baseline.

### 2.1 Today

- `agent({ agentType })` is documented as "AI provider to use" and resolved as a
  provider id (`tools/agent.ts:144-153`). The name suggests a role, and models
  pass role names that are silently ignored.
- `SubagentType` (`agent/types.ts:41`) is a closed union of five roles with
  descriptions in `SUBAGENT_DEFINITIONS`. Only `agent/subagent.ts` (the loop's
  verifier path) uses them; the `agent` tool does not.
- There is no loader. `commands/loader.ts` (user slash commands) and
  `skills/loader.ts` already parse frontmatter markdown from the same scopes.

### 2.2 File format

Claude Code's `.claude/agents/*.md` format, so existing definitions load
unchanged:

```markdown
---
name: scout
description: Read-only reconnaissance; finds entry points, flows and constraints before anyone edits.
tools: read, ls, glob, grep        # optional allowlist; omitted = the mode's full set
model: inherit                     # optional: inherit | provider/model
mode: explore                      # optional FreeCode extension: explore | build; default explore
---
System prompt for the agent.
```

### 2.3 Scopes, in increasing precedence (same-name later wins)

1. **Built-in:** the five existing `SUBAGENT_DEFINITIONS` roles, moved to bundled
   `.md` files, plus a `general` default equal to today's behaviour.
2. `~/.claude/agents/*.md`: imported read-only, like `~/.claude/skills`
   (`skills/loader.ts`) and Claude Code's MCP servers
   (`mcp/claude-code-config.ts`). `FREECODE_CLAUDE_CODE_AGENTS=0` disables.
3. `~/.freecode/agents/*.md`.
4. `<project>/.claude/agents/*.md`, then `<project>/.freecode/agents/*.md`.

### 2.4 How a definition is applied

- **Parameter:** `agent` gains `subagent_type` (Claude Code's name). The
  provider override moves to `model` (`provider/model`). `agentType` stays
  accepted for one release as an alias for `model` and is removed from the
  schema.
- **Roster:** the tool description lists the enabled definitions (name + one
  line). It is regenerated only when the roster changes, so the cached tool
  block stays stable turn to turn. That matters for the RC8 prompt-cache
  invariant: a per-turn change there would re-send the whole prompt.
- **System prompt:** the definition body **replaces** the subagent's
  role-specific prompt text. Project instructions (`CLAUDE.md`/`AGENTS.md`) are
  still injected as for any session. A definition cannot switch them off in v1.
- **Tools:** an allowlist is **intersected** with what the subagent's mode
  already allows. A definition can narrow the tool set but never widen it, so a
  project file cannot grant `bash` to a read-only spawn. The filter goes where
  explore mode already filters (`tools/defs-cache.ts`).
- **Mode:** `mode: build` is the file's equivalent of today's `readOnly: false`
  and still inherits the parent's mode (`ToolContext.agentMode`). An explicit
  `readOnly` on the call wins over the file.
- **Model:** an unknown `provider/model` fails the spawn with a readable error
  before any session is created. It does not fall back silently: a silent
  fallback is how a MiniMax-M3 session once delegated to M2 (see
  `tools/agent.ts:156`).
- **Unknown `subagent_type`:** an error listing the valid names. Silently
  ignoring it is today's bug.

### 2.5 Trust

Project definitions only shape a prompt and narrow tools. They cannot run code
or widen permissions, so unlike extensions (`extensions.trustedProjects`) they
load without a trust step. That matches Claude Code. It is flagged as §5 Q2,
because a cloned repo can still steer a subagent's behaviour through its
prompt.

### 2.6 Surfaces

- `/agents` shows the definition name on each row. That means an
  `AgentSummary.definition` field and a shared-protocol change.
- `freecode agents list` prints the resolved roster with each entry's scope and
  any shadowed definitions (a thin CLI, like `freecode mcp list`).
- `ROADMAP.md` item 3 is deleted when this ships.

### 2.7 Tests and evals

- **Loader unit tests:**
  - frontmatter parsing, including Claude Code's comma-separated `tools`;
  - scope precedence;
  - a malformed file is skipped with one warning.
- **Application unit tests:** the allowlist is intersected, never widened; an
  unknown type or model is refused.
- **Eval:** a delegation case with a project `.freecode/agents/reviewer.md`
  fixture, where the prompt says "have the reviewer check …", with
  `expectInArgs: { subagent_type: "reviewer" }`. The trajectory suite also
  runs, because the `agent` tool description changes in every session. EVAL.md
  says to run `eval ab trajectory` for a tool-description change, so budget one.

---

## 3. Phase 3 — stall notice for a background agent

### 3.0 Outcome: dropped (2026-09-27)

§3.2's check was run before building. It folded every `subagent.start` /
`subagent.stop` pair in `~/.freecode/rollout/sessions` against each subagent's
own event log, and measured the longest gap between consecutive events.

| | |
| --- | --- |
| subagent runs | 248 (246 with their own log; 1 never recorded a stop) |
| longest silence | 66 s, in a 78 s run |
| silences > 60 s | 1 |
| silences > 180 s | 0 |
| silences > 600 s (`STALL_MS`) | 0 |

Most of those runs are eval trials of short delegations, so the sample is
biased toward quick tasks. Even so, nothing came within a factor of nine of the
threshold. The fetch-layer timeouts and the 50-iteration cap already end what a
stall notice would have reported. A notice that never fires is only code to
maintain, so none was built. Rerun this fold if long-running background agents
become common. The design below stays as the starting point if it ever finds
one.

### 3.1 Design

- **Tracking:** `AgentRecord.lastActivityAt` is updated in `append()`
  (`registry.ts:292`). Activity is whole events (`tool_start`, `tool_complete`,
  `text`, `thinking`, `error`; `agent/registry/activity.ts`), not deltas.
- **Trigger:** a background agent whose `lastActivityAt` is older than
  `STALL_MS` (10 min, herdsman's number) gets one `<task-notification>` to its
  parent. It uses `kind: "agent"` and `status: "stalled"`, and carries the last
  ~2k of its activity buffer plus the elapsed time. The parent's options are
  `agent_send` (Phase 1), `agent_stop`, or leaving it running.
- **Frequency:** once per episode. New activity re-arms it, and it is never
  repeated for the same silence. Herdsman repeats on a `5m → 1m` backoff, but
  every notification to an idle session is a paid turn.
- **Scope:** foreground agents are excluded, because the parent is blocked on
  them and the user sees the spinner.
- **Checking:** one `setInterval(…, 60s).unref()` per registry, running only
  while a background agent is running. It does not use per-agent timers.
- **Configuration:** `tasks.stallNoticeMs` (0 disables) and
  `FREECODE_AGENT_STALL_MS`.

### 3.2 Why it is last

A subagent's model calls already have fetch-layer timeouts (300s to headers,
180s of stream silence), and its loop is capped at 50 iterations. What remains
is a long tool call inside the agent, such as a foreground `bash` of up to 600s
that is then adopted into the background. So a 10-minute stall is rare. Before
building, fold existing rollout logs for background agents whose longest gap
between activity events exceeded 10 minutes. If there are none, record that
here and drop the phase.

### 3.3 Tests

Fake clock: the notice fires once past `STALL_MS`, re-arms after activity, and
never fires for a foreground agent or with the setting at 0.

---

## 4. Phase 4 — continue a finished agent

### 4.0 As built

As designed below, with one difference. The original's settings are kept in the
in-process registry (`AgentSpawnConfig`, set at spawn), not on the session meta
§4.2 names. So a continuation works until the session ends or core restarts,
even though the old session is still on disk. That matches how long the id is
useful to the model anyway. Open question 4 (hiding subagent sessions from
`session.list`) is still open.

The first eval found a bug the design had missed: the model never saw an agent's
id. It lived only in the result's `metadata`, which does not reach the model.
Opus then passed `continue: "explorer"` (the type) in 2 of 3 trials. Every
result now leads with an `Agent id:` line, and a miss explains where the id is.

### 4.1 Today

A subagent's session survives it: the `finally` in `tools/agent.ts` disposes its
shells, not its session. The history is on disk under the subagent id.

### 4.2 Design

- **Call:** `agent({ continue: "<agent_id>", prompt, task, run_in_background? })`.
- **Refusals:**
  - the target is not a settled agent whose direct parent is the caller;
  - the target is still running (use `agent_send`);
  - the target was stopped by the model (it asked for it to end).
- **New generation, not a revival:** `sessionStore.fork(<old id>)` mints a new
  id holding the old history, and the new `prompt` is appended as its next user
  turn. Every other path is the normal spawn: the registry, both caps, the
  background ledger and notifications. This mirrors herdsman's "one assignment
  per generation". It also keeps registry records immutable once settled,
  which `/agents`, `remove()` and the ledger all assume.
- **Settings carried over:** the definition, mode and model are those of the
  original spawn, recorded on the session meta at spawn time. An explicit
  `readOnly` or `subagent_type` on the continue call is refused, because
  changing role mid-history is a new agent.
- **Compaction:** the forked history compacts like any session, so a long
  investigation cannot exceed the context window on its second assignment.

### 4.3 Tests and eval

- **Unit:** a continued agent sees its prior history; the refusals above;
  the notification carries the new id.
- **Eval:** a delegation case with a follow-up question about a finished
  background agent's findings, with `expectInArgs: { continue: { $regex: "subagent-" } }`.

---

## 5. Open questions

1. ~~**Phase 1.** Should `agent_stop` report what the agent had done so far?~~
   **Decided: yes**, the last 2k of its activity.
2. **Phase 2.** Should project agent definitions need a trust step despite §2.5?
3. **Phase 2.** Should a definition be able to opt out of project instructions
   (herdsman's `inheritProjectContext: false`)? Proposed: no, until someone
   needs it.
4. **Phase 4.** Should subagent sessions be hidden from `session.list`?
   Continuation makes them worth keeping on disk, but they clutter the resume
   picker today. Check the picker before building.
5. ~~**Phase 3.** Drop it outright if §3.2's log fold finds no stalls?~~ **Dropped**: 0 of 248 runs had a gap over 180 s (§3.0).
