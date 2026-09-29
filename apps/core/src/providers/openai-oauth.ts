// =============================================================================
// OpenAI OAuth — ChatGPT subscription via the Codex backend.
// Spec: `docs/specs/2026-09-29-openai-codex-oauth-provider.md`.
//
// Mirrors `anthropic-oauth.ts`: a fetch wrapper composed onto the timeout
// fetch, per-request token refresh, and nothing else in the loop knows the
// subscription exists. Unlike the Claude path there is no prompt injection —
// the Codex client id and `originator` header are the whole disguise.
// =============================================================================

import {
  AUTH_FILE,
  type StoredOpenAIOAuth,
  readOpenAIOAuth,
  saveOpenAIOAuth,
} from "./auth-store.js";
import { foldCodexStream, rewriteCodexBody } from "./openai-oauth-body.js";

export const OPENAI_OAUTH = {
  /** The Codex CLI's public client — the only one that can reach the backend. */
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  /** Fixed: the client has exactly this redirect registered. */
  callbackPort: 1455,
  callbackPath: "/auth/callback",
  scopes: "openid profile email offline_access",
  endpoint: "https://chatgpt.com/backend-api/codex/responses",
  originator: "codex_cli_rs",
} as const;

export interface OpenAIOAuthOptions {
  tokenUrl?: string;
  authFile?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The `chatgpt-account-id` a token belongs to, from the
 * `https://api.openai.com/auth` claim. Undefined for anything that is not a
 * JWT carrying it — the caller decides whether that is fatal.
 */
export function chatgptAccountId(jwt: string | undefined): string | undefined {
  const payload = jwt?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export interface OpenAITokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

/** Token-endpoint JSON → stored login. Shared by exchange and refresh. */
export function toStoredOpenAIOAuth(
  body: OpenAITokenResponse,
  previous?: StoredOpenAIOAuth,
): StoredOpenAIOAuth {
  const accountId =
    chatgptAccountId(body.id_token) ??
    chatgptAccountId(body.access_token) ??
    previous?.account_id;
  if (!accountId) {
    throw new Error(
      "OpenAI returned a token with no ChatGPT account id — this login cannot " +
        "reach the Codex backend. Log in with a ChatGPT Plus/Pro account.",
    );
  }
  const refreshToken = body.refresh_token || previous?.refresh_token;
  if (!refreshToken) throw new Error("OpenAI returned no refresh token.");
  return {
    type: "oauth",
    access_token: body.access_token,
    refresh_token: refreshToken,
    expires_at: Date.now() + body.expires_in * 1000,
    account_id: accountId,
  };
}

// -----------------------------------------------------------------------------
// Refresh — same three guards as the Anthropic path (its spec §3.3): OpenAI
// rotates refresh tokens too, so a lost race persists a dead one.
// -----------------------------------------------------------------------------

const refreshFlights = new Map<string, Promise<StoredOpenAIOAuth>>();
const terminalRejections = new Map<string, string>();

async function doRefresh(
  observedRefreshToken: string,
  opts: OpenAIOAuthOptions,
): Promise<StoredOpenAIOAuth> {
  const authFile = opts.authFile ?? AUTH_FILE;
  const stored = readOpenAIOAuth(authFile);
  if (
    stored &&
    stored.refresh_token !== observedRefreshToken &&
    stored.expires_at - Date.now() > 60_000
  ) {
    return stored;
  }
  const refreshToken = stored?.refresh_token || observedRefreshToken;
  const terminal = terminalRejections.get(refreshToken);
  if (terminal) throw new Error(terminal);

  const fetchImpl = opts.fetchImpl ?? fetch;
  const resp = await fetchImpl(opts.tokenUrl ?? OPENAI_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OPENAI_OAUTH.clientId,
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    const message =
      `OpenAI OAuth token refresh failed (HTTP ${resp.status}): ${text}. ` +
      "Run `freecode auth login openai` to log in again.";
    if ([400, 401, 403].includes(resp.status)) {
      terminalRejections.set(refreshToken, message);
    }
    throw new Error(message);
  }
  const next = toStoredOpenAIOAuth(
    (await resp.json()) as OpenAITokenResponse,
    stored ?? { ...emptyLogin(), refresh_token: refreshToken },
  );
  saveOpenAIOAuth(next, authFile);
  return next;
}

function emptyLogin(): StoredOpenAIOAuth {
  return { type: "oauth", access_token: "", refresh_token: "", expires_at: 0, account_id: "" };
}

export function refreshOpenAITokens(
  observedRefreshToken: string,
  opts: OpenAIOAuthOptions = {},
): Promise<StoredOpenAIOAuth> {
  const authFile = opts.authFile ?? AUTH_FILE;
  const inFlight = refreshFlights.get(authFile);
  if (inFlight) return inFlight;
  const flight = doRefresh(observedRefreshToken, opts).finally(() =>
    refreshFlights.delete(authFile),
  );
  refreshFlights.set(authFile, flight);
  return flight;
}

const REFRESH_MARGIN_MS = 5 * 60_000;

/** A valid login (stored → refreshed). No import from `~/.codex` — spec §1. */
export async function getOpenAILogin(
  opts: OpenAIOAuthOptions = {},
): Promise<StoredOpenAIOAuth> {
  const stored = readOpenAIOAuth(opts.authFile ?? AUTH_FILE);
  if (!stored) {
    throw new Error(
      "No OpenAI OAuth login found. Run `freecode auth login openai`, or set " +
        'an API key and providers.openai.authMode: "api-key".',
    );
  }
  if (stored.expires_at - Date.now() > REFRESH_MARGIN_MS) return stored;
  return refreshOpenAITokens(stored.refresh_token, opts);
}

/**
 * The OAuth request seam: every Responses API call the SDK makes is sent to
 * the Codex backend instead, with bearer auth, the account header and a body
 * the backend accepts. A caller that did not ask to stream (`generateText`)
 * gets the SSE folded back into one JSON response, since the backend only
 * streams.
 */
export function createOpenAIOAuthFetch(
  baseFetch: typeof fetch,
  getLogin: () => Promise<StoredOpenAIOAuth> = () => getOpenAILogin(),
): typeof fetch {
  return async function oauthFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!new URL(url).pathname.endsWith("/responses") || typeof init?.body !== "string") {
      return baseFetch(input, init);
    }
    const login = await getLogin();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${login.access_token}`);
    headers.set("chatgpt-account-id", login.account_id);
    headers.set("originator", OPENAI_OAUTH.originator);
    headers.set("accept", "text/event-stream");
    const { body, callerStreams } = rewriteCodexBody(init.body);

    const resp = await baseFetch(OPENAI_OAUTH.endpoint, { ...init, headers, body });
    if (!resp.ok) return resp;
    if (callerStreams) {
      // The backend sends no content-type; the SDK's SSE parser is told here.
      const streamHeaders = new Headers(resp.headers);
      streamHeaders.set("content-type", "text/event-stream");
      return new Response(resp.body, { status: resp.status, headers: streamHeaders });
    }
    const folded = foldCodexStream(await resp.text());
    return new Response(folded.body, {
      status: folded.status,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Test-only: forget single-flight and terminal-rejection state. */
export function resetOpenAIOAuthState(): void {
  refreshFlights.clear();
  terminalRejections.clear();
}
