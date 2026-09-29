import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// config.ts resolves CONFIG_FILE / AUTH_FILE from os.homedir() at module load.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-openai-oauth-"));
process.env.HOME = home;

const {
  OPENAI_OAUTH,
  chatgptAccountId,
  createOpenAIOAuthFetch,
  getOpenAILogin,
  refreshOpenAITokens,
  resetOpenAIOAuthState,
} = await import("./openai-oauth.js");
const { foldCodexStream, rewriteCodexBody } = await import("./openai-oauth-body.js");
const { buildOpenAIAuthorizeUrl, exchangeOpenAICode, OPENAI_REDIRECT_URI } =
  await import("./openai-oauth-login.js");
const { readOpenAIOAuth, saveOpenAIOAuth } = await import("./auth-store.js");
const { openaiAuthMode, subscriptionAuth } = await import("./config.js");
const { buildGenerateOptions } = await import("./generic-provider.js");
const { resolveCatalogue } = await import("./catalogue.js");

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

const ACCESS = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });

function authFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "freecode-oa-")), "auth.json");
}

function login(overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth" as const,
    access_token: ACCESS,
    refresh_token: "rt-1",
    expires_at: Date.now() + 3_600_000,
    account_id: "acct-1",
    ...overrides,
  };
}

function sse(events: unknown[]): string {
  return events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

test("chatgptAccountId reads the auth claim, undefined for anything else", () => {
  assert.equal(chatgptAccountId(ACCESS), "acct-1");
  assert.equal(chatgptAccountId(jwt({ sub: "x" })), undefined);
  assert.equal(chatgptAccountId("not-a-jwt"), undefined);
  assert.equal(chatgptAccountId(undefined), undefined);
});

test("rewriteCodexBody: forces stream/store, strips what the backend 400s on", () => {
  const { body, callerStreams } = rewriteCodexBody(
    JSON.stringify({
      model: "gpt-5.5",
      max_output_tokens: 100,
      temperature: 0.2,
      top_p: 0.9,
      include: ["file_search_call.results"],
      input: [],
    }),
  );
  const parsed = JSON.parse(body);
  assert.equal(callerStreams, false);
  assert.equal(parsed.stream, true);
  assert.equal(parsed.store, false);
  assert.equal("max_output_tokens" in parsed, false);
  assert.equal("temperature" in parsed, false);
  assert.equal("top_p" in parsed, false);
  assert.deepEqual(parsed.include, ["file_search_call.results", "reasoning.encrypted_content"]);
  assert.equal(rewriteCodexBody(JSON.stringify({ stream: true })).callerStreams, true);
});

test("foldCodexStream rebuilds the empty completed output from output_item.done", () => {
  const folded = foldCodexStream(
    sse([
      { type: "response.created", response: { id: "r" } },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", name: "read" } },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m" } },
      { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 3 } } },
    ]),
  );
  assert.equal(folded.status, 200);
  const body = JSON.parse(folded.body);
  assert.deepEqual(body.output.map((o: { type: string }) => o.type), ["message", "function_call"]);
  assert.equal(body.usage.input_tokens, 3);
});

test("foldCodexStream: a failed or truncated stream is a non-2xx with a message", () => {
  const failed = foldCodexStream(
    sse([{ type: "response.failed", response: { error: { message: "usage limit" } } }]),
  );
  assert.equal(failed.status, 502);
  assert.equal(JSON.parse(failed.body).error.message, "usage limit");
  const cut = foldCodexStream(sse([{ type: "response.created", response: {} }]));
  assert.equal(cut.status, 502);
  assert.match(JSON.parse(cut.body).error.message, /without a response\.completed/);
});

test("oauth fetch: rewrites URL, headers and body; folds a non-streaming call", async () => {
  let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  const base = (async (url: string, init: RequestInit) => {
    seen = { url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) };
    return new Response(
      sse([
        { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
        { type: "response.completed", response: { id: "r", output: [] } },
      ]),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const oauthFetch = createOpenAIOAuthFetch(base, async () => login());

  const resp = await oauthFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer oauth-subscription" },
    body: JSON.stringify({ model: "gpt-5.5", max_output_tokens: 10 }),
  });
  assert.equal(seen!.url, OPENAI_OAUTH.endpoint);
  assert.equal(seen!.headers.get("authorization"), `Bearer ${ACCESS}`);
  assert.equal(seen!.headers.get("chatgpt-account-id"), "acct-1");
  assert.equal(seen!.headers.get("originator"), "codex_cli_rs");
  assert.equal(seen!.body.stream, true);
  assert.equal(resp.headers.get("content-type"), "application/json");
  assert.equal((await resp.json()).output.length, 1);
});

test("oauth fetch: a streaming call passes through with an SSE content-type", async () => {
  const base = (async () =>
    new Response("data: {}\n\n", { status: 200 })) as unknown as typeof fetch;
  const oauthFetch = createOpenAIOAuthFetch(base, async () => login());
  const resp = await oauthFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    body: JSON.stringify({ stream: true }),
  });
  assert.equal(resp.headers.get("content-type"), "text/event-stream");
  assert.equal(await resp.text(), "data: {}\n\n");
});

test("refresh: rotates and persists, concurrent callers share one call", async () => {
  resetOpenAIOAuthState();
  const file = authFile();
  saveOpenAIOAuth(login({ expires_at: 0 }), file);
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++;
    assert.match(String(init.body), /grant_type=refresh_token/);
    return Response.json({ access_token: ACCESS, refresh_token: "rt-2", expires_in: 3600 });
  }) as unknown as typeof fetch;
  const [a, b] = await Promise.all([
    refreshOpenAITokens("rt-1", { authFile: file, fetchImpl }),
    refreshOpenAITokens("rt-1", { authFile: file, fetchImpl }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.refresh_token, "rt-2");
  assert.equal(b, a);
  assert.equal(readOpenAIOAuth(file)!.refresh_token, "rt-2");
});

test("refresh: a permanent rejection is terminal — no second round-trip", async () => {
  resetOpenAIOAuthState();
  const file = authFile();
  saveOpenAIOAuth(login({ expires_at: 0 }), file);
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("invalid_grant", { status: 400 });
  }) as unknown as typeof fetch;
  await assert.rejects(refreshOpenAITokens("rt-1", { authFile: file, fetchImpl }), /login openai/);
  await assert.rejects(refreshOpenAITokens("rt-1", { authFile: file, fetchImpl }), /login openai/);
  assert.equal(calls, 1);
});

test("getOpenAILogin: no login is a clear error, a fresh one is returned as-is", async () => {
  await assert.rejects(getOpenAILogin({ authFile: authFile() }), /freecode auth login openai/);
  const file = authFile();
  saveOpenAIOAuth(login(), file);
  assert.equal((await getOpenAILogin({ authFile: file })).access_token, ACCESS);
});

test("exchange: form-encoded, fixed redirect, state checked, account id stored", async () => {
  const file = authFile();
  let body = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = String(init.body);
    return Response.json({ access_token: ACCESS, refresh_token: "rt", id_token: ACCESS, expires_in: 60 });
  }) as unknown as typeof fetch;
  await assert.rejects(
    exchangeOpenAICode({ verifier: "v", state: "s", input: `${OPENAI_REDIRECT_URI}?code=c&state=other`, authFile: file, fetchImpl }),
    /state mismatch/,
  );
  const tokens = await exchangeOpenAICode({
    verifier: "v",
    state: "s",
    input: `${OPENAI_REDIRECT_URI}?code=c&state=s`,
    authFile: file,
    fetchImpl,
  });
  const params = new URLSearchParams(body);
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(params.get("code_verifier"), "v");
  assert.equal(tokens.account_id, "acct-1");
  assert.equal(readOpenAIOAuth(file)!.account_id, "acct-1");
});

test("authorize URL carries the Codex CLI's parameters", () => {
  const url = new URL(buildOpenAIAuthorizeUrl("chal", "st"));
  assert.equal(url.origin + url.pathname, OPENAI_OAUTH.authorizeUrl);
  assert.equal(url.searchParams.get("client_id"), OPENAI_OAUTH.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), OPENAI_REDIRECT_URI);
  assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(url.searchParams.get("originator"), "codex_cli_rs");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("auth mode: env pin wins, cost is stamped as subscription, store:false set", () => {
  const openaiEntry = resolveCatalogue().find((e) => e.id === "openai")!;
  assert.equal(openaiAuthMode(), "api-key");
  assert.equal(subscriptionAuth("openai"), undefined);
  process.env.FREECODE_OPENAI_AUTH = "oauth";
  try {
    assert.equal(openaiAuthMode(), "oauth");
    assert.equal(subscriptionAuth("openai"), "oauth");
    const opts = buildGenerateOptions(openaiEntry, {}, { prompt: "hi", sessionId: "s1" });
    assert.deepEqual(opts.providerOptions.openai, { promptCacheKey: "s1", store: false });
  } finally {
    delete process.env.FREECODE_OPENAI_AUTH;
  }
  // API-key mode never carries the subscription's store override.
  const keyed = buildGenerateOptions(openaiEntry, {}, { prompt: "hi", sessionId: "s1" });
  assert.deepEqual(keyed.providerOptions.openai, { promptCacheKey: "s1" });
});
