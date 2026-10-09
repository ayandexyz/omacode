# Deferred Tool Loading

**Status:** Draft — not built. Branch `feat/deferred-tool-loading`.
**Date:** 2026-10-10
**Prior art:** pi (`earendil-works/pi`) — `packages/coding-agent/src/extensions/tool-search/`
and `packages/ai/src/api/anthropic-messages.ts` (native tool changes).
**Touches:** `tools/defs-cache.ts`, `agent/loop.ts` (`callProviderOnce`), `providers/generic-provider.ts`,
`providers/cache-miss.ts`, `session/store.ts`, a new `tools/tool-search.ts`.

---

## 1. Problem

Every model call sends every tool definition. Built-ins are fixed, but MCP tools
(including everything imported from Claude Code's `~/.claude.json` / `.mcp.json`)
are unbounded — one server can add 20–40 schemas. They cost:

1. **Context window** — tool schemas sit in front of the system prompt for the
   whole session, compaction cannot touch them.
2. **Money** — on a cold cache (first call, after a TTL expiry, after a provider
   or model switch) they are billed at full input price; on a warm cache at the
   read rate, every call.
3. **Tool choice quality** — a model offered 70 tools picks worse than one
   offered 25.

## 2. Will it save tokens? (measured 2026-10-10)

**Built-in tools** (`getToolDefs("build")`, chars/4, same estimator as `/context`):
21 tools, **~6.8K tokens**. Largest: `bash` 861, `agent` 840, `todowrite` 759,
`grep` 493, `monitor` 493.

**What sessions actually send** — `toolCount` on `model.request` across the last
30 days of `~/.freecode/rollout` (~22K requests):

| tools offered | requests | meaning |
| --- | --- | --- |
| 12–13 | ~9.4K | read-only modes (plan/explore/review) |
| 18–29 | ~11.9K | build mode, built-ins + a few MCP tools |
| **69** | **33** | an MCP-heavy session (figma + agentmemory connected) |

Provider mix over the same window: MiniMax ~20.5K, Anthropic ~1.1K, Gemini ~1.1K.

**Verdict.**

- **For the owner's current traffic: small.** 99.8% of requests carry ≤29 tools,
  which is ~7–9K tokens and mostly cache-read. Deferring nothing but MCP tools
  saves near zero on those sessions.
- **For MCP-heavy sessions: real.** The 69-tool session carried ~40 MCP schemas,
  roughly **15–25K tokens** of definitions (MCP schemas are verbose; exact figure
  to be measured in Phase 0). Deferring them reclaims that context for the whole
  session and cuts the per-call cost by that amount × the cache-read rate, plus
  the full price on every cold call.
- **Deferring built-ins is not worth it.** ~6.8K tokens, almost always cached,
  and every built-in is used in a normal coding turn — searching for `edit`
  would cost a round trip to save ~350 tokens.

So this is a **scaling feature**, not a quick win: it caps the cost of
connecting MCP servers rather than shrinking today's typical request. Phase 0
exists to confirm the number before anything else is built.

## 3. How pi does it

Two independent layers:

1. **`tool_search` tool (provider-agnostic).** Each tool has an `exposure`
   (`direct` | `deferred` | …). Deferred tools are registered but not declared.
   `tool_search(query, limit=8)` ranks the not-yet-active deferred tools with
   BM25 over name, name-with-spaces, description, schema property names and
   descriptions, and the MCP server's description; matches are added to the
   **active set**, so the *next* call declares them. Activation is written to the
   transcript as a tool change, so it survives resume, fork and `/tree`. Its
   description never lists the deferred tools (stays byte-stable as MCP servers
   connect); servers are listed in a separate `mcp_servers` prompt section.
2. **Cache-preserving native tool changes (Anthropic).** Changing `tools`
   mid-session invalidates the entire prefix. pi keeps the request-level list
   fixed at the session's *initial* tools and adds later ones inline as
   `tool_addition` / `tool_removal` blocks (`inline-tools-2026-09-15` beta). It
   also declares a never-active `defer_loading: true` placeholder from request
   one, because the first tool change otherwise caused a measured full miss.
   OpenAI Responses uses `additional_tools` / `defer_loading` the same way.

Known bug they hit (CHANGELOG): loaded MCP tools were dropped on resume because
the session restored its active set before MCP servers reconnected.

## 4. Design for FreeCode

### 4.1 Exposure

- Built-in tools: always `direct`. Never deferred (§2).
- MCP tools: `deferred` **when deferral is active** (§4.5), else `direct` as today.
- `tool_search` itself is `direct`, and only offered when at least one tool is deferred.

### 4.2 Two paths, chosen by SDK package (same rule as `requestShape`)

**A. `@ai-sdk/anthropic` → Anthropic server-side tool search.**
The installed `@ai-sdk/anthropic` 3.0.80 already ships
`anthropic.tools.toolSearchBm25_20251119()` and per-tool
`providerOptions: { anthropic: { deferLoading: true } }`. Every tool is sent
from request one; deferred ones carry `defer_loading: true` and are not loaded
into context until Anthropic's own search returns a `tool_reference`. The
`tools` array never changes during the session, so **the cache prefix is
untouched** — RC8 holds with no new machinery. Model support must be checked
per model (SDK doc lists Opus 4.5 / Sonnet 4.5); unsupported model → path B.
MiniMax and Z.ai also route through `@ai-sdk/anthropic` but almost certainly
reject the server tool, so path A is gated on `provider === "anthropic"`, not on
the package alone.

**B. Everything else → client-side `tool_search`.**
A normal FreeCode tool (`tools/tool-search.ts`) ranking with the existing
`memory/bm25.ts`, search document built as pi's `createToolSearchDocument`.
Matches go into the session's active set; `getToolDefs` returns
`direct ∪ active`. Cost: **one cache miss per load** on providers with explicit
caching, because the tool list precedes everything. Mitigations:
- loads are batched (one search returns up to 8),
- the active set only grows within a session (no removal → at most a handful of misses),
- `cache-miss.ts` classifies a miss whose tool list grew since the last request
  as `tool_load`, not `harness:*`, so it does not alarm.

pi's inline-tools approach (keeping misses at zero on Anthropic without server
search) is **out of scope**: the AI SDK does not model `tool_addition` blocks,
and path A already covers Anthropic.

### 4.3 State: the active set

- Stored per session in the session store meta (beside `leafId`), keyed by tool
  name, written on change only.
- Restored on `session.resume`, `fork`, `/tree` navigation and `/rewind` —
  per-branch, like pi, since a branch that never searched should not inherit
  the load.
- Restored names are applied **after** MCP servers reconnect; a name whose tool
  no longer exists is dropped silently (pi's resume bug, §3).
- Subagents start with an empty active set (they get the same `tool_search`).

### 4.4 Execution guard

Calling a deferred tool that is not active is refused with a model-readable
error telling it to run `tool_search` first, through the existing
`denyToolCall()` exit (so it lands in `Trace.deniedSpans`). Permission rules,
`PATH_TOOLS`/`URL_TOOLS`, hooks and the role allowlist are unchanged — they act
on the call, not on how the tool was declared.

### 4.5 When deferral turns on

Off by default (`tools.deferral.enabled`, `FREECODE_DEFER_TOOLS=1|0`, env beats
files — the loop-gate convention). When enabled, it only defers if the MCP
tools' estimated schema size exceeds `tools.deferral.minTokens` (default
**4000**) — below that, the misses of path B cost more than they save.

### 4.6 Prompt surface

- `tool_search` description is static and never lists tools (byte-stable).
- One line per connected MCP server (name + description, no tool list) goes into
  the static system segments so the model knows what is searchable. It changes
  only when the server set changes — documented as a prefix invalidation, like
  a compaction summary.

### 4.7 Observability

- `tool.search` rollout event: query length, match count, names loaded (names
  are not secret; query text is not logged — same rule as todo text).
- `model.request.toolCount` already exists; add `deferredCount`.
- `/context` shows "deferred: N tools (~X tokens)" so the saving is visible.

## 5. Phases

| Phase | Deliverable | Exit criterion |
| --- | --- | --- |
| 0 | Measure: per-server MCP schema tokens for figma + agentmemory (and a 3rd common server); add `deferredCount` to `model.request` | A real number for §2's "15–25K" |
| 1 | Exposure flag, active set in session store, `getToolDefs(mode, active)`, execution guard, unit tests | `defs-cache.test.ts` + store round-trip incl. `/tree` + resume-after-reconnect |
| 2 | Path B: `tool_search` + BM25 + `tool_load` miss classification | Tool works on MiniMax end-to-end; no D2 alarm on a load |
| 3 | Path A: Anthropic server tool search + `deferLoading` | Cache read ratio unchanged vs. deferral-off on an MCP-heavy session |
| 4 | `eval ab` (deferral on vs. off) on an MCP-heavy case set | Pass rate not worse; input tokens/turn down; then decide the default |

Phase 4 is required by the eval-driven rule in `CLAUDE.md`: this changes what
the model sees, so the default does not flip without an A/B.

## 6. Registration checklist (new tool)

`tool_search` is read-only: `tools/index.ts`, `READONLY_TOOLS` in
`permission/mode-policy.ts`, `DISPLAY_NAMES` in `permission/suggest.ts`.
Not a path or URL tool.

## 7. Open questions

1. Does Anthropic's server tool search work on the Claude 5 models and through
   the OAuth (subscription) path? Phase 3 must test both before shipping path A.
2. Does MiniMax's implicit cache survive a grown tool list, or is every load a
   full miss there too? (Its traffic is ~90% of requests.)
3. Should read-only modes defer MCP tools that are read-only (`readOnlyHint`)?
   Today read-only modes already drop non-read-only tools.
4. Should the active set ever shrink (e.g. on compaction)? pi never removes;
   start the same and revisit with data.
