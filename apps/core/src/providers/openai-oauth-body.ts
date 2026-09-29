// =============================================================================
// Request/response shaping for the ChatGPT Codex backend — pure, no network.
// Spec `docs/specs/2026-09-29-openai-codex-oauth-provider.md` §2.2: every rule
// here is a probe result, not a guess, and each one has a test.
// =============================================================================

/** Fields the Codex backend 400s on ("Unsupported parameter"). */
const UNSUPPORTED_FIELDS = ["max_output_tokens", "temperature", "top_p"];

export interface RewrittenBody {
  body: string;
  /** Whether the CALLER asked to stream; the wire request always streams. */
  callerStreams: boolean;
}

/**
 * The SDK's Responses API body, made acceptable to the Codex backend:
 * streaming forced on (it refuses anything else), stateless (`store: false`,
 * with encrypted reasoning carried in the items instead), and the fields it
 * rejects removed.
 */
export function rewriteCodexBody(raw: string): RewrittenBody {
  const body = JSON.parse(raw) as Record<string, unknown>;
  const callerStreams = body.stream === true;
  for (const field of UNSUPPORTED_FIELDS) delete body[field];
  body.stream = true;
  body.store = false;
  const include = Array.isArray(body.include) ? (body.include as string[]) : [];
  if (!include.includes("reasoning.encrypted_content")) {
    body.include = [...include, "reasoning.encrypted_content"];
  }
  return { body: JSON.stringify(body), callerStreams };
}

type SseEvent = { type?: string; [key: string]: unknown };

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as SseEvent);
    } catch {
      // A malformed frame is skipped; the completion event decides the result.
    }
  }
  return events;
}

export interface FoldedResponse {
  status: number;
  body: string;
}

/**
 * A whole SSE stream folded into the single JSON body a non-streaming
 * Responses API call returns.
 *
 * With `store: false` the backend's `response.completed` carries an EMPTY
 * `output` — the items only ever arrive as `response.output_item.done` events
 * — so the output is rebuilt from those, in `output_index` order.
 */
export function foldCodexStream(text: string): FoldedResponse {
  const events = parseSse(text);
  const items: Array<{ index: number; item: unknown }> = [];
  for (const event of events) {
    if (event.type === "response.output_item.done") {
      items.push({
        index: typeof event.output_index === "number" ? event.output_index : items.length,
        item: event.item,
      });
    }
    if (event.type === "response.failed" || event.type === "error") {
      // The SDK's error handler reads `{ error: { message } }`.
      const error =
        event.type === "error"
          ? { message: event.message, code: event.code }
          : (event.response as { error?: unknown } | undefined)?.error;
      return {
        status: 502,
        body: JSON.stringify({ error: error ?? { message: "Codex response failed." } }),
      };
    }
  }
  const completed = events.find(
    (e) => e.type === "response.completed" || e.type === "response.incomplete",
  );
  if (!completed || typeof completed.response !== "object" || !completed.response) {
    return {
      status: 502,
      body: JSON.stringify({
        error: { message: "Codex stream ended without a response.completed event." },
      }),
    };
  }
  const response = completed.response as Record<string, unknown>;
  const output = Array.isArray(response.output) ? response.output : [];
  if (output.length === 0) {
    response.output = items.sort((a, b) => a.index - b.index).map((i) => i.item);
  }
  return { status: 200, body: JSON.stringify(response) };
}
