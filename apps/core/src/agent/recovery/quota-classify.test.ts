// =============================================================================
// Typed quota/failure classification — what an unattended run acts on.
// Spec: docs/specs/2026-09-28-overnight-runs.md §4.7
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import {
  QuotaExhaustedError,
  classifyLoopFailure,
  classifyQuotaScope,
  quotaResetAt,
  rateLimitHeaders,
} from "./manager.js";

function apiError(
  message: string,
  statusCode = 429,
  responseHeaders?: Record<string, string>,
) {
  return Object.assign(new Error(message), { statusCode, responseHeaders });
}

test("rateLimitHeaders keeps only limit headers, lowercased", () => {
  const err = apiError("slow down", 429, {
    "Retry-After": "60",
    "anthropic-ratelimit-unified-reset": "1700000000",
    "set-cookie": "session=secret",
    "x-request-id": "req_123",
  });
  assert.deepEqual(rateLimitHeaders(err), {
    "retry-after": "60",
    "anthropic-ratelimit-unified-reset": "1700000000",
  });
});

test("rateLimitHeaders is undefined when the provider sent none", () => {
  assert.equal(rateLimitHeaders(apiError("nope")), undefined);
  assert.equal(rateLimitHeaders(apiError("nope", 429, { "x-id": "1" })), undefined);
});

test("quotaResetAt: retry-after-ms wins, then retry-after, then a reset header", () => {
  const now = 1_000_000;
  assert.equal(
    quotaResetAt(apiError("x", 429, { "retry-after-ms": "5000" }), now),
    now + 5000,
  );
  assert.equal(
    quotaResetAt(apiError("x", 429, { "retry-after": "60" }), now),
    now + 60_000,
  );
  // Absolute epoch seconds, not a delay.
  assert.equal(
    quotaResetAt(apiError("x", 429, { "ratelimit-reset": "2000" }), now),
    2_000_000,
  );
});

test("quotaResetAt takes the soonest future reset and ignores stale ones", () => {
  const now = 1_000_000;
  const err = apiError("x", 429, {
    "anthropic-ratelimit-requests-reset": "1500", // 1_500_000 ms
    "anthropic-ratelimit-tokens-reset": "3000",
    "anthropic-ratelimit-input-tokens-reset": "500", // already past
  });
  assert.equal(quotaResetAt(err, now), 1_500_000);
});

test("quotaResetAt parses an ISO reset", () => {
  const at = quotaResetAt(
    apiError("x", 429, { "ratelimit-reset": "2026-09-28T04:13:00.000Z" }),
    Date.parse("2026-09-28T00:00:00.000Z"),
  );
  assert.equal(at, Date.parse("2026-09-28T04:13:00.000Z"));
});

test("classifyQuotaScope: credits is never waited out", () => {
  assert.equal(classifyQuotaScope(apiError("Your credit balance is too low")), "credits");
  assert.equal(
    classifyQuotaScope(apiError("You exceeded your current quota", 429)),
    "credits",
  );
  assert.equal(classifyQuotaScope(apiError("Payment Required", 402)), "credits");
});

test("classifyQuotaScope: a known reset means a window", () => {
  assert.equal(
    classifyQuotaScope(apiError("rate limit", 429, { "retry-after": "60" })),
    "window",
  );
  // Bare "usage limit reached", with no upgrade/credits wording, is a window.
  assert.equal(
    classifyQuotaScope(apiError("Daily usage limit reached")),
    "window",
  );
});

test("classifyQuotaScope: unlabelled and header-less is unknown, so it gets probed", () => {
  assert.equal(classifyQuotaScope(apiError("too many requests")), "unknown");
});

test("classifyLoopFailure reads a QuotaExhaustedError without re-parsing", () => {
  const failure = classifyLoopFailure(
    new QuotaExhaustedError("spent", {
      provider: "anthropic",
      scope: "window",
      resetAt: 42,
    }),
  );
  assert.deepEqual(failure, {
    kind: "quota",
    scope: "window",
    resetAt: 42,
    provider: "anthropic",
  });
});

test("classifyLoopFailure separates auth, interrupt, timeout and the rest", () => {
  assert.deepEqual(classifyLoopFailure(apiError("no key", 401)), { kind: "auth" });
  assert.deepEqual(classifyLoopFailure(apiError("forbidden", 403)), { kind: "auth" });
  assert.deepEqual(
    classifyLoopFailure(Object.assign(new Error("stop"), { name: "AbortError" })),
    { kind: "interrupted" },
  );
  assert.deepEqual(
    classifyLoopFailure(new Error("The operation timed out.")),
    { kind: "timeout" },
  );
  assert.deepEqual(classifyLoopFailure(apiError("boom", 500)), {
    kind: "provider",
    message: "500: boom",
  });
});

test("a quota 429 with headers becomes a waitable failure", () => {
  const failure = classifyLoopFailure(
    apiError("usage limit reached", 429, { "retry-after": "120" }),
  );
  assert.equal(failure.kind, "quota");
  assert.equal(failure.kind === "quota" && failure.scope, "window");
  assert.ok(failure.kind === "quota" && failure.resetAt! > Date.now());
});
