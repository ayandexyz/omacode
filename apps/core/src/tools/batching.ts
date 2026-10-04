// =============================================================================
// Tool batching plan
// Groups a sequence of tool calls into batches that can run in parallel.
// A batch is parallel iff every call in it is concurrency-safe: the tool's
// behavior.isConcurrencySafe, or its per-call `concurrencySafeFor(args)`.
// Sequential tools (or tools whose behavior is unknown) always occupy their own
// batch so ordering guarantees around writes/edits/shell are preserved.
// =============================================================================

import { getTool } from "./index.js";

export interface ToolBatch {
  start: number;
  end: number;
  parallel: boolean;
}

export type IsConcurrencySafeFn = (call: { tool: string; args?: unknown }) => boolean;

export const isConcurrencySafeCall: IsConcurrencySafeFn = ({ tool, args }) => {
  const behavior = getTool(tool)?.behavior;
  if (!behavior) return false;
  return behavior.concurrencySafeFor
    ? behavior.concurrencySafeFor(args)
    : behavior.isConcurrencySafe === true;
};

export function planToolBatches<T extends { tool: string; args?: unknown }>(
  toolCalls: readonly T[],
  isSafe: IsConcurrencySafeFn = isConcurrencySafeCall,
): ToolBatch[] {
  const batches: ToolBatch[] = [];
  let i = 0;
  while (i < toolCalls.length) {
    const startSafe = isSafe(toolCalls[i]);
    let j = i + 1;
    if (startSafe) {
      while (j < toolCalls.length && isSafe(toolCalls[j])) j++;
    }
    batches.push({ start: i, end: j, parallel: startSafe && j - i > 1 });
    i = j;
  }
  return batches;
}
