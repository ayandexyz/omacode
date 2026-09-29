// =============================================================================
// `freecode auth login|status|logout` — Phase 1 of the Anthropic OAuth spec
// (`docs/specs/2026-09-05-anthropic-oauth-provider.md`), and the OpenAI/Codex
// login (`docs/specs/2026-09-29-openai-codex-oauth-provider.md`).
//
// Presentation only: the protocol lives in `providers/{anthropic,openai}-oauth*.ts`.
// Login prints the §0.1 disclosure once, per that spec — this feature
// impersonates Claude Code against the user's own account and says so.
// =============================================================================

import type { CommandModule } from "yargs";
import * as readline from "readline";
import { spawn } from "child_process";
import {
  anthropicAuthMode,
  openaiAuthMode,
  setProviderAuthMode,
} from "../../providers/config.js";
import {
  deleteAnthropicOAuth,
  deleteOpenAIOAuth,
  hasImportableClaudeCodeLogin,
  readAnthropicOAuth,
  readOpenAIOAuth,
} from "../../providers/auth-store.js";
import {
  buildOpenAIAuthorizeUrl,
  exchangeOpenAICode,
  generateOpenAIState,
  OPENAI_REDIRECT_URI,
} from "../../providers/openai-oauth-login.js";
import { OPENAI_OAUTH } from "../../providers/openai-oauth.js";
import {
  buildAuthorizeUrl,
  exchangeAnthropicCode,
  generatePkce,
  redirectUriForInput,
  startCallbackServer,
  ANTHROPIC_OAUTH_LOGIN,
} from "../../providers/anthropic-oauth-login.js";

const CALLBACK_TIMEOUT_MS = 120_000;

const DISCLOSURE = `
This logs in with your Claude Pro/Max subscription instead of an API key.

To reach subscription inference, freecode sends Claude Code's OAuth client id,
its User-Agent and beta headers, and its identity line as the first system
block — it presents itself to Anthropic as Claude Code. Anthropic reserves
subscription inference for its official surfaces, so this is against the spirit
(and arguably the letter) of the terms, and they have blocked tools doing it.
The account at risk is yours.

Your API-key setup is untouched: run \`freecode auth logout anthropic\` to go back.
`;

const OPENAI_DISCLOSURE = `
This logs in with your ChatGPT Plus/Pro subscription instead of an API key.

To reach subscription inference, freecode uses the Codex CLI's OAuth client id
and sends requests to the Codex backend as \`codex_cli_rs\` — it presents itself
to OpenAI as the Codex CLI. Using a subscription through a third-party client is
outside what OpenAI documents. The account at risk is yours.

Your API-key setup is untouched: run \`freecode auth logout openai\` to go back.
`;

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

/** Best-effort; a machine with no browser just uses the printed URL. */
function openBrowser(url: string): boolean {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function assertOAuthProvider(provider: string): void {
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error(
      `Only "anthropic" and "openai" support OAuth login (got "${provider}").`,
    );
  }
}

interface LoginArgs {
  provider: string;
  browser: boolean;
}

const loginCommand: CommandModule<object, LoginArgs> = {
  command: "login [provider]",
  describe: "log in to a provider with your subscription (OAuth)",
  builder: (yargs) =>
    yargs
      .positional("provider", {
        type: "string",
        default: "anthropic",
        describe: "provider to log in to",
      })
      .option("browser", {
        type: "boolean",
        default: true,
        describe: "open the authorize URL in a browser (--no-browser to skip)",
      }) as never,
  handler: async (argv) => {
    assertOAuthProvider(argv.provider);
    if (argv.provider === "openai") return loginOpenAI(argv.browser);
    console.error(DISCLOSURE);

    const { verifier, challenge } = generatePkce();

    const server = await startCallbackServer();
    const redirectUri = server?.redirectUri ?? ANTHROPIC_OAUTH_LOGIN.manualRedirectUri;
    const authUrl = buildAuthorizeUrl(redirectUri, challenge, verifier);
    const manualUrl = buildAuthorizeUrl(
      ANTHROPIC_OAUTH_LOGIN.manualRedirectUri,
      challenge,
      verifier,
    );

    console.error("Open this URL to authorize freecode:\n");
    console.error(`  ${authUrl}\n`);
    if (server && argv.browser) openBrowser(authUrl);

    try {
      if (server && argv.browser) {
        console.error(
          `Waiting up to ${CALLBACK_TIMEOUT_MS / 1000}s for the callback on ${redirectUri} ...`,
        );
        try {
          const code = await server.waitForCode(verifier, CALLBACK_TIMEOUT_MS);
          const tokens = await exchangeAnthropicCode({
            verifier,
            input: code,
            redirectUri,
          });
          finishLogin(tokens.expires_at);
          return;
        } catch (e) {
          console.error(
            `${e instanceof Error ? e.message : String(e)} Falling back to pasting the code.\n`,
          );
        }
      }

      if (!server || !argv.browser) {
        console.error(
          "No local callback listener — finish in a browser (this or another " +
            "device) using the URL above, then paste the result here.\n",
        );
        if (!server) console.error(`  (manual URL: ${manualUrl})\n`);
      }

      const input = (
        await prompt("Paste the callback URL or authorization code: ")
      ).trim();
      if (!input) throw new Error("No authorization code entered.");
      const tokens = await exchangeAnthropicCode({
        verifier,
        input,
        redirectUri: redirectUriForInput(input, redirectUri),
      });
      finishLogin(tokens.expires_at);
    } finally {
      server?.close();
    }
  },
};

function finishLogin(expiresAt: number, provider = "anthropic"): void {
  // An explicit login is an explicit opt-in (spec §0.1), so pin the mode
  // rather than leaving it to the "no API key configured" fallback.
  setProviderAuthMode(provider, "oauth");
  console.error(
    `\nLogged in. ${provider} now uses your subscription; the token expires ${new Date(
      expiresAt,
    ).toLocaleString()} and refreshes automatically.`,
  );
}

/**
 * The OpenAI flow differs from Anthropic's in one way that shapes this: the
 * redirect is FIXED at localhost:1455, so there is no manual-callback page to
 * fall back to. If the port is busy (the Codex CLI mid-login), the browser
 * still lands on that URL — it just fails to load — and the user pastes it.
 */
async function loginOpenAI(browser: boolean): Promise<void> {
  console.error(OPENAI_DISCLOSURE);
  const { verifier, challenge } = generatePkce();
  const state = generateOpenAIState();
  const authUrl = buildOpenAIAuthorizeUrl(challenge, state);
  const server = await startCallbackServer({
    port: OPENAI_OAUTH.callbackPort,
    path: OPENAI_OAUTH.callbackPath,
  });

  console.error("Open this URL to authorize freecode:\n");
  console.error(`  ${authUrl}\n`);
  if (server && browser) openBrowser(authUrl);

  try {
    if (server && browser) {
      console.error(
        `Waiting up to ${CALLBACK_TIMEOUT_MS / 1000}s for the callback on ${OPENAI_REDIRECT_URI} ...`,
      );
      try {
        const code = await server.waitForCode(state, CALLBACK_TIMEOUT_MS);
        const tokens = await exchangeOpenAICode({ verifier, state, input: code });
        finishLogin(tokens.expires_at, "openai");
        return;
      } catch (e) {
        console.error(
          `${e instanceof Error ? e.message : String(e)} Falling back to pasting the URL.\n`,
        );
      }
    }
    if (!server) {
      console.error(
        `Port ${OPENAI_OAUTH.callbackPort} is busy, so the browser will land on a page ` +
          "that fails to load — that is expected. Copy its full URL from the address bar.\n",
      );
    }
    const input = (await prompt("Paste the callback URL: ")).trim();
    if (!input) throw new Error("No callback URL entered.");
    const tokens = await exchangeOpenAICode({ verifier, state, input });
    finishLogin(tokens.expires_at, "openai");
  } finally {
    server?.close();
  }
}

const statusCommand: CommandModule = {
  command: "status",
  describe: "show how each provider authenticates",
  handler: () => {
    const mode = anthropicAuthMode();
    const stored = readAnthropicOAuth();
    console.log(`anthropic  auth mode: ${mode}`);
    if (stored) {
      const expires = new Date(stored.expires_at);
      const state = stored.expires_at > Date.now() ? "valid until" : "expired";
      console.log(`           oauth token: ${state} ${expires.toLocaleString()}`);
      console.log(
        `           scopes: ${stored.scopes.length ? stored.scopes.join(" ") : "(none reported)"}`,
      );
    } else {
      console.log("           oauth token: none stored");
      if (hasImportableClaudeCodeLogin()) {
        console.log(
          "           an official Claude Code login is importable on this machine",
        );
      }
    }
    if (mode === "oauth" && !stored) {
      console.log("           run `freecode auth login anthropic`");
    }

    const openaiMode = openaiAuthMode();
    const openai = readOpenAIOAuth();
    console.log(`openai     auth mode: ${openaiMode}`);
    if (openai) {
      const state = openai.expires_at > Date.now() ? "valid until" : "expired";
      console.log(
        `           oauth token: ${state} ${new Date(openai.expires_at).toLocaleString()} (refreshes automatically)`,
      );
    } else {
      console.log("           oauth token: none stored");
      if (openaiMode === "oauth") console.log("           run `freecode auth login openai`");
    }
  },
};

const logoutCommand: CommandModule<object, { provider: string }> = {
  command: "logout [provider]",
  describe: "forget stored OAuth credentials and revert to API-key auth",
  builder: (yargs) =>
    yargs.positional("provider", {
      type: "string",
      default: "anthropic",
      describe: "provider to log out of",
    }) as never,
  handler: (argv) => {
    assertOAuthProvider(argv.provider);
    const removed =
      argv.provider === "openai" ? deleteOpenAIOAuth() : deleteAnthropicOAuth();
    setProviderAuthMode(argv.provider, undefined);
    console.log(
      removed
        ? `Logged out of ${argv.provider}; auth mode reverts to your API key.`
        : `No stored ${argv.provider} OAuth credentials.`,
    );
  },
};

export const authCommand: CommandModule = {
  command: "auth",
  describe: "manage provider authentication",
  builder: (yargs) =>
    yargs
      .command(loginCommand as CommandModule)
      .command(statusCommand)
      .command(logoutCommand as CommandModule)
      .demandCommand(1, "Specify a subcommand"),
  handler: () => {},
};
