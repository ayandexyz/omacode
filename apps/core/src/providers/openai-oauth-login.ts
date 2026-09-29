// =============================================================================
// OpenAI OAuth login (PKCE) — spec `2026-09-29-openai-codex-oauth-provider.md`.
//
// Protocol only; `cli/commands/auth.ts` owns the prompting. PKCE, pasted-code
// parsing and the callback server are shared with the Anthropic login — what
// differs is the authorize URL's parameters, a random `state` (OpenAI does not
// require it to be the verifier), and a form-encoded exchange.
// =============================================================================

import * as crypto from "crypto";
import { AUTH_FILE, type StoredOpenAIOAuth, saveOpenAIOAuth } from "./auth-store.js";
import { parseAuthCodeInput } from "./anthropic-oauth-login.js";
import {
  OPENAI_OAUTH,
  toStoredOpenAIOAuth,
  type OpenAIOAuthOptions,
  type OpenAITokenResponse,
} from "./openai-oauth.js";

export const OPENAI_REDIRECT_URI = `http://localhost:${OPENAI_OAUTH.callbackPort}${OPENAI_OAUTH.callbackPath}`;

export function generateOpenAIState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** The Codex CLI's authorize URL, parameter for parameter (jcode `openai_auth_url`). */
export function buildOpenAIAuthorizeUrl(challenge: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH.clientId,
    redirect_uri: OPENAI_REDIRECT_URI,
    scope: OPENAI_OAUTH.scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: OPENAI_OAUTH.originator,
    prompt: "login",
  });
  return `${OPENAI_OAUTH.authorizeUrl}?${q.toString()}`;
}

export interface OpenAIExchangeOptions extends OpenAIOAuthOptions {
  verifier: string;
  state: string;
  /** Raw code or pasted callback URL / query string. */
  input: string;
}

export async function exchangeOpenAICode(
  opts: OpenAIExchangeOptions,
): Promise<StoredOpenAIOAuth> {
  const { code, state } = parseAuthCodeInput(opts.input);
  if (state && state !== opts.state) {
    throw new Error(
      "OAuth state mismatch. Start the login again and use the newest callback URL.",
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resp = await fetchImpl(opts.tokenUrl ?? OPENAI_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_OAUTH.clientId,
      code,
      code_verifier: opts.verifier,
      redirect_uri: OPENAI_REDIRECT_URI,
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error(
      `Token exchange failed (HTTP ${resp.status}): ${await resp.text()}`,
    );
  }
  const tokens = toStoredOpenAIOAuth((await resp.json()) as OpenAITokenResponse);
  saveOpenAIOAuth(tokens, opts.authFile ?? AUTH_FILE);
  return tokens;
}
