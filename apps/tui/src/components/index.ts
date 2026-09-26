import type { Component } from "@earendil-works/pi-tui";
import type { SerializedMessage } from "@thisisayande/freecode-shared";
import {
  addMessage,
  removeMessage,
  getInProgress,
  subscribeToMessages,
  clearMessages,
  updateMessage,
  getMessages,
  getMessageByQueueId,
  messageStore,
} from "../state/message-store.js";
import {
  createMessageComponent,
  createQueuedUserMessageComponent,
} from "./message-row.js";
import type { MessageType, MessageInstance } from "./message-types.js";
import { Transcript } from "./transcript.js";
import type { ToolProgressMessage } from "./tool-progress-message.js";

/**
 * Add a user message to the store and return the message instance
 */
export function createUserMessage(content: string): MessageInstance {
  sealToolGroups();
  const component = createMessageComponent("user", content);
  return addMessage("user", content, component);
}

/**
 * Add a queued user message to the store (spec 2026-08-05). `queueId` is the
 * server-assigned id from the `message_queued` stream event; the TUI keeps it
 * on the message so `session.dequeue` and Ctrl+Backspace can target the right
 * row even after the local store id has rotated.
 */
export function createQueuedUserMessage(
  content: string,
  queueId: string,
  kind: "steer" | "followUp" = "followUp",
): MessageInstance {
  const component = createQueuedUserMessageComponent(content, kind);
  return addMessage("queued_user", content, component, queueId);
}

/**
 * Promote a queued_user row to a normal user message in place — used when
 * the queued prompt transitions from "waiting" to "in flight". The local
 * store id stays the same so the virtual list does not reflow, and the
 * component swap is what the renderer picks up on the next paint.
 */
export function promoteQueuedToUser(queueId: string): MessageInstance | undefined {
  const existing = getMessageByQueueId(queueId);
  if (!existing || existing.type !== "queued_user") return existing;
  const component = createMessageComponent("user", existing.content);
  return updateMessage(existing.id, existing.content, component);
}

export const createAssistantMessage = (content: string): MessageInstance =>
  mainTranscript.createAssistantMessage(content);

/** The main conversation's transcript, over the singleton store. */
export const mainTranscript = new Transcript(messageStore);

export const appendAssistantDelta = (delta: string): MessageInstance =>
  mainTranscript.appendAssistantDelta(delta);
export const finalizeAssistantText = (content?: string): MessageInstance | null =>
  mainTranscript.finalizeAssistantText(content);
export const appendThinkingDelta = (delta: string, startTime?: number): MessageInstance =>
  mainTranscript.appendThinkingDelta(delta, startTime);

/**
 * Add a system message to the store and return the message instance.
 * Consecutive "[Recovery] ..." lines (retry attempts, fallback notices)
 * update the previous recovery line in place instead of stacking a new
 * message per attempt.
 */
export function createSystemMessage(content: string): MessageInstance {
  if (content.startsWith("[Recovery]")) {
    const messages = getMessages();
    const lastMessage = messages[messages.length - 1];
    if (
      lastMessage &&
      lastMessage.type === "system" &&
      lastMessage.content.startsWith("[Recovery]")
    ) {
      const component = createMessageComponent("system", content);
      const updated = updateMessage(lastMessage.id, content, component);
      if (updated) return updated;
    }
  }
  const component = createMessageComponent("system", content);
  return addMessage("system", content, component);
}

/**
 * Add an in-progress message to the store and return the message instance
 */
export function createInProgressMessage(
  phrase: string,
  inputTokens = 0,
  outputTokens = 0,
  contextLimit = 0,
  turns = 1,
  contextTokens?: number,
): MessageInstance {
  const startTime = Date.now();
  const component = createMessageComponent(
    "in_progress",
    phrase,
    startTime,
    inputTokens,
    outputTokens,
    contextLimit,
    turns,
    0,
    contextTokens,
  );
  return addMessage("in_progress", phrase, component);
}

/**
 * Remove a message by ID from the store
 */
export function removeMessageById(id: number): MessageInstance | undefined {
  return removeMessage(id);
}

/**
 * Update an in-progress message with new token counts
 */
export function updateInProgressMessage(
  id: number,
  phrase: string,
  inputTokens: number,
  outputTokens: number,
  contextLimit: number,
  startTime: number,
  turns: number,
  cachedTokens = 0,
  contextTokens?: number,
): MessageInstance | undefined {
  const component = createMessageComponent(
    "in_progress",
    phrase,
    startTime,
    inputTokens,
    outputTokens,
    contextLimit,
    turns,
    cachedTokens,
    contextTokens,
  );
  return updateMessage(id, phrase, component);
}

export const createToolProgressMessage = (
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): { message: MessageInstance; progress: ToolProgressMessage } =>
  mainTranscript.createToolProgressMessage(toolCallId, toolName, args);
/** Undoes createToolProgressMessage once the call's result arrives. */
export const removeToolProgressMessage = (
  message: MessageInstance,
  progress: ToolProgressMessage,
): void => mainTranscript.removeToolProgressMessage(message, progress);
export const sealToolGroups = (): void => mainTranscript.sealToolGroups();
export const createToolResultMessage = (
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: string | undefined,
  success: boolean,
  duration_ms?: number,
): MessageInstance =>
  mainTranscript.createToolResultMessage(
    toolCallId,
    toolName,
    args,
    result,
    success,
    duration_ms,
  );
export const createThinkingMessage = (content: string, startTime?: number): MessageInstance =>
  mainTranscript.createThinkingMessage(content, startTime);

/**
 * Get the current in-progress message, if any
 */
export function getPendingInProgress(): MessageInstance | undefined {
  return getInProgress();
}

/**
 * Subscribe to message store changes
 */
export function onMessagesChange(
  callback: (messages: MessageInstance[]) => void,
): () => void {
  return subscribeToMessages(callback);
}

export { subscribeToMessages };

/**
 * Clear all messages from the store
 */
export function clearAllMessages(): void {
  mainTranscript.reset();
  clearMessages();
}

/**
 * Load messages from a resumed session into the UI
 */
export function loadSessionMessages(messages: SerializedMessage[]): void {
  for (const msg of messages) {
    // A poke the harness wrote. The text is for the model; the user gets the
    // same one-liner they saw live.
    if (msg.synthetic === "auto_poke") {
      createSystemMessage("*Auto-poke: the agent stopped with todos open and was sent back.*");
      continue;
    }
    // The condensed abandoned branch. The body is for the model; the user
    // gets a marker where the rewind happened.
    if (msg.synthetic === "branch_summary") {
      createSystemMessage("*Rewound here — the branch that followed was summarized for the agent.*");
      continue;
    }
    // A background task's result handed to the agent. The XML is for the
    // model; the agent's reply that follows is what the user reads.
    if (msg.synthetic === "task_notification") {
      createSystemMessage("*A background task finished and was reported to the agent.*");
      continue;
    }
    let content = "";
    if (msg.role === "user") {
      content = msg.parts
        .map((p) => (p.type === "text" ? p.content || "" : ""))
        .join("");
    } else {
      // assistant message - extract text content
      const textParts = msg.parts.filter((p) => p.type === "text");
      content = textParts.map((p) => p.content || "").join("\n");
    }
    if (content) {
      const label = msg.role === "user" ? "**You:**" : "**FreeCode:**";
      addMessage(
        msg.role,
        content,
        createMessageComponent(msg.role as MessageType, `${label} ${content}`),
      );
    }
  }
}

// Re-export types for convenience
export type { MessageInstance, MessageType } from "./message-types.js";

// Re-export tool message components
export {
  ToolProgressMessage,
  type ToolProgressMessageOptions,
} from "./tool-progress-message.js";
export {
  ToolResultMessage,
  type ToolResultMessageOptions,
} from "./tool-result-message.js";
export { ToolGroupMessage } from "./tool-group-message.js";
