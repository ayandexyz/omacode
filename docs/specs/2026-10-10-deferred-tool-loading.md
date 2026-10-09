# Deferred Tool Loading

**Status:** Paths A and B built 2026-10-10 on `feat/deferred-tool-loading`
(§4.1–4.5, `deferredCount`); path A live-verified (§4.2.1). Off by default.
Not built: the MCP server prompt line (§4.6), `/context` deferred row,
`tool.search` event (§4.7), the Phase 0 measurement and the Phase 4 `eval ab`.
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

**A. Anthropic → custom tool search with `defer_loading` + `tool_reference`.**
*Built differently from the draft*, which used Anthropic's server-side
`toolSearchBm25_20251119` tool. That would put provider-executed
`server_tool_use` / `tool_search_tool_result` blocks into history, which
FreeCode's `Message` cannot store or round-trip. Anthropic also supports a
**custom** search: any client tool may return `tool_reference` blocks, and the
SDK emits one from a `custom` tool-result part
(`providerOptions.anthropic.type: "tool-reference"`). So path A keeps FreeCode's
own `tool_search` and changes only the wire:

- every tool is sent from request one; deferred ones are sent last with
  `providerOptions.anthropic.deferLoading` → `defer_loading: true`, loaded or
  not, so the `tools` array never changes (`applyDeferral(…, native)`);
- the cache anchor goes on the last non-deferred tool (`buildToolsParam`);
- `convertToCoreMessages(messages, deferredTools)` turns a `tool_search`
  result into `tool_reference` blocks for the names this request declares
  deferred (an undeclared name is dropped — referencing one is a 400);
- `tool_search` results are exempt from old-result pruning, since replacing
  one would unload its tools.

Same ranking, guard and derived loaded set as path B. Gated by
`supportsNativeDeferral(provider, model)`: provider id `anthropic` (MiniMax
and Z.ai share the SDK, not the feature) and Sonnet/Opus ≥ 4.5 or any 5-family
model; anything else falls back to path B. `tools.deferral.native` /
`FREECODE_DEFER_TOOLS_NATIVE=0` forces path B, e.g. for an A/B.

#### 4.2.1 Live verification (2026-10-10, OAuth subscription)

- **References only.** A tool result mixing `tool_reference` with text is
  rejected: *"Tool definitions/code execution functions cannot be mixed with
  other content"*. The result therefore carries the references alone.
- **Works** on `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-sonnet-5`
  through the subscription path, with no extra beta header: the model calls
  the referenced tool with correct arguments and never sees an unreferenced
  deferred one.
- **Cache holds across a load.** Same tools on both requests, 31 deferred:

  | model | request | input | cache read | cache write |
  | --- | --- | --- | --- | --- |
  | sonnet-4-5 | before load | 4,141 | 0 | 4,138 |
  | sonnet-4-5 | after load | 4,276 | **4,138** | 131 |
  | sonnet-5 | before load | 5,141 | 0 | 5,139 |
  | sonnet-5 | after load | 5,284 | **5,139** | 143 |

  The whole prior prefix is read back; only the new turn is written. The 31
  deferred definitions (~4K tokens) do not count toward input at all. On the
  first request the model chose `tool_search` by itself.

**B. Everything else → client-side `tool_search`.**
A normal FreeCode tool (`tools/tool-search.ts`) ranking with the existing
`memory/bm25.ts`, search document built as pi's `createToolSearchDocument`.
Matches go into the session's active set; `getToolDefs` returns
`direct ∪ active`. Cost: **one cache miss per load** on providers with explicit
caching, because the tool list precedes everything. Mitigations:
- loads are batched (one search returns up to 8),
- the active set only grows within a session (no removal → at most a handful of misses),
- the loop records a `"tool load"` entry in the cache-invalidation journal
  (`recordInvalidation`) when the loaded set grows, so D2 attributes the miss
  instead of alarming — no change to `cache-miss.ts` was needed.

pi's inline-tools approach (`tool_addition` blocks) is **out of scope**: the
AI SDK does not model them, and path A already keeps misses at zero on
Anthropic.

### 4.3 State: the active set

**Built differently from the draft: derived, not stored.** The loaded set is
read off the conversation on every request (`loadedFromHistory`): a
`tool_search` result names what it loaded (`formatSearchResult` /
`parseLoadedNames` live side by side). No session-store field, so:

- resume, `fork`, `/tree` and `/rewind` carry the right per-branch set for
  free — they all hand the loop the active path;
- a name whose MCP server is gone falls out (it is no longer deferred), so
  pi's resume-before-reconnect bug cannot happen;
- compaction drops old loads. It already invalidates the prefix, and a dropped
  tool is one search away.

A *call* to a deferred tool is deliberately not evidence of a load: a call made
before loading is refused, and that refusal sits in history too (the loop test
caught this).

- Subagents start with an empty active set (their own history).
- A role with a tool allowlist skips deferral entirely (its list is short and
  explicit, and `tool_search` would sit outside it).

### 4.4 Execution guard

Calling a deferred tool that is not active is refused with a model-readable
error telling it to run `tool_search` first, through the existing
`denyToolCall()` exit with the new `DenySource` `"deferred"` (so it lands in
`Trace.deniedSpans`). Permission rules,
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
| 3 | Path A: `deferLoading` + `tool_reference` from our `tool_search` | Cache read across a load = prior prefix — **met live, §4.2.1** |
| 4 | `eval ab` (deferral on vs. off) on an MCP-heavy case set | Pass rate not worse; input tokens/turn down; then decide the default |

Phase 4 is required by the eval-driven rule in `CLAUDE.md`: this changes what
the model sees, so the default does not flip without an A/B.

## 6. Registration checklist (new tool)

`tool_search` is read-only: `tools/index.ts`, `READONLY_TOOLS` in
`permission/mode-policy.ts`, `DISPLAY_NAMES` in `permission/suggest.ts`.
Not a path or URL tool.

## 7. Open questions

1. ~~Does path A work on Claude 5 and through OAuth?~~ Yes — §4.2.1. Haiku 4.5
   is untested and gated off.
2. Does MiniMax's implicit cache survive a grown tool list, or is every load a
   full miss there too? (Its traffic is ~90% of requests.)
3. Should read-only modes defer MCP tools that are read-only (`readOnlyHint`)?
   Today read-only modes already drop non-read-only tools.
4. Should the active set ever shrink (e.g. on compaction)? pi never removes;
   start the same and revisit with data.
