# OpenAI OAuth (ChatGPT Plus/Pro subscription via the Codex backend) as an auth mode for the `openai` provider

**Status:** Built 2026-09-29 — `providers/openai-oauth.ts` (constants, refresh,
request rewrite, SSE→JSON fold), `providers/openai-oauth-login.ts` (PKCE,
authorize URL, exchange), OpenAI entries in `providers/auth-store.ts`,
`openaiAuthMode()` in `config.ts`, OAuth branch in `generic-provider.ts`,
`freecode auth login|status|logout openai`. Tests in `openai-oauth.test.ts`.
**Date:** 2026-09-29
**Prior art:** jcode (`~/Projects/githubProjects/agents/jcode`, `origin/HEAD`
76df6464b) — `crates/jcode-base/src/auth/oauth.rs` (`mod openai`, login,
exchange, refresh), `crates/jcode-base/src/auth/codex.rs` (account-id claim),
`crates/jcode-provider-openai-runtime/src/lib.rs` (request body in ChatGPT mode),
`OAUTH.md` §"OpenAI / Codex OAuth".
**Extends:** `2026-09-05-anthropic-oauth-provider.md` — same shape (an auth mode
on an existing catalogue entry, not a new provider), same §0.1 risk framing.
Read that spec first; this one only records where OpenAI differs.

---

## 0. Read this first

A ChatGPT Plus/Pro subscription includes Codex usage. That allowance is reached
at `https://chatgpt.com/backend-api/codex/responses` with a ChatGPT OAuth token,
not at `api.openai.com` with a key. The official Codex CLI does exactly this;
jcode, OpenCode and pi reuse its public OAuth client id.

### 0.1 The risk

Same as the Anthropic spec §0.1, one notch milder: freecode presents Codex's
client id and `originator: codex_cli_rs`, but — unlike the Claude path — no
identity text is injected into the prompt. Using a subscription through a
non-official client is still outside what OpenAI documents. The login prints a
disclosure, the mode is opt-in (explicit login, `providers.openai.authMode`, or
`FREECODE_OPENAI_AUTH=oauth`), and an API key on the machine never silently
switches to the subscription.

## 1. Goals / non-goals

**Goals:** `freecode auth login openai` mints freecode's own ChatGPT login; the
`openai` provider then serves every turn (streaming and non-streaming) from the
subscription with no loop, tool or streaming changes; subscription calls cost
`undefined`, never a fake per-token price.

**Non-goals:**
- **Importing `~/.codex/auth.json`.** OpenAI rotates refresh tokens. A copied
  login shares one refresh chain with the Codex CLI, and whichever program
  refreshes second is logged out. This is the "have to log in again every few
  days" failure mode, so freecode only uses its own login.
- The WebSocket transport jcode uses. HTTPS SSE is sufficient.
- Multiple accounts.

## 2. The protocol (observed 2026-09-29, live probe with a Plus/Pro token)

### 2.1 Constants

| | |
|---|---|
| Client id | `app_EMoamEEZ73f0CkXaXp7hrann` (Codex CLI's public client) |
| Authorize | `https://auth.openai.com/oauth/authorize` |
| Token | `https://auth.openai.com/oauth/token` (form-encoded) |
| Redirect | `http://localhost:1455/auth/callback` — **fixed**; the client only has this URI registered, so the port cannot be ephemeral |
| Scopes | `openid profile email offline_access` |
| Extra authorize params | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=codex_cli_rs`, `prompt=login` |
| Endpoint | `https://chatgpt.com/backend-api/codex/responses` |
| Headers | `authorization: Bearer <access>`, `chatgpt-account-id: <id>`, `originator: codex_cli_rs` |

The account id is the `https://api.openai.com/auth` → `chatgpt_account_id`
claim of the access (or id) token JWT. Access tokens live ~10 days.

### 2.2 What the endpoint accepts (probe results)

| Field | Result |
|---|---|
| `stream: false` / absent | **400** "Stream must be set to true" |
| `max_output_tokens` | **400** "Unsupported parameter" |
| `temperature` | **400** "Unsupported parameter" (`top_p` treated the same) |
| `instructions` absent | 200 |
| `system` / `developer` items in `input` | 200 |
| `tools` (function) + `tool_choice` | 200 |
| `prompt_cache_key` | 200 |
| `reasoning.effort` | 200 |
| `store: false` + `include: ["reasoning.encrypted_content"]` | 200 (what Codex sends) |

Two response quirks:
1. The SSE response carries **no `content-type`** header.
2. With `store: false`, the `response.completed` event's `response.output` is
   **empty**; the items only arrive as `response.output_item.done` events.

## 3. Where it wires into freecode

- **`auth-store.ts`** — an `openai` key in `~/.freecode/auth.json` beside
  `anthropic` (`access_token`, `refresh_token`, `expires_at`, `account_id`).
- **`openai-oauth.ts`** — `getOpenAIAccessToken()` (stored → refreshed,
  single-flight per file, rotation guard, terminal-rejection memory, as in
  Anthropic §3.3) and `createOpenAIOAuthFetch(inner)`, which for every request:
  rewrites any `…/responses` URL to the Codex endpoint; sets the three headers
  and drops the SDK's placeholder key; rewrites the JSON body — `stream: true`,
  `store: false`, adds the `include`, deletes `max_output_tokens`, `temperature`,
  `top_p`. When the caller had **not** asked to stream (`generateText`), it reads
  the SSE and returns one JSON response: the `response.completed` object with
  `output` rebuilt from the `output_item.done` events, or the `response.failed` /
  `error` payload as a non-2xx. Streaming responses pass through with
  `content-type: text/event-stream` set.
- **`openai-oauth-login.ts`** — authorize URL, code exchange (reuses the
  Anthropic module's `generatePkce` / `parseAuthCodeInput` / callback server,
  which gains an optional fixed port + path).
- **`config.ts`** — `openaiAuthMode()`: `FREECODE_OPENAI_AUTH` → config
  `providers.openai.authMode` → API key if one exists → OAuth if a login is
  stored → API key. `subscriptionAuth("openai")` returns `"oauth"` in OAuth
  mode, so cost stamping, trace and eval baselines need no further change.
- **`generic-provider.ts`** — `usesOpenAIOAuth(entry)` (`entry.id === "openai"`)
  swaps the key for a placeholder and the fetch for the OAuth wrapper, and sets
  `providerOptions.openai.store = false` so the SDK sends full items instead of
  `item_reference`s the stateless backend cannot resolve.
- **`cli/commands/auth.ts`** — `login|status|logout` accept `openai`.

There is no API-key fallback on refusal (unlike Anthropic Phase 2): there is no
observed "OAuth not allowed for this organization" response to key it on.

## 4. Testing

Unit (`openai-oauth.test.ts`, no network): account-id extraction; body rewrite
strips/sets the fields in §2.2; URL rewrite; non-streaming fold rebuilds
`output`; a `response.failed` fold becomes a non-2xx; refresh single-flight and
rotation guard; `subscriptionAuth("openai")`; login URL carries the fixed
redirect and Codex params. Live: one real `freecode run` turn with a tool call,
recorded as the exit criterion.

## 5. Open questions

1. Which models the subscription serves changes with the account's plan; the
   Codex CLI's `~/.codex/models_cache.json` lists them. freecode passes any id
   through, so nothing is hard-coded.
2. Rate-limit (usage window) responses have not been observed yet. Whether
   `isQuotaExhaustedError`'s message patterns catch them is unverified (TODO.md).
