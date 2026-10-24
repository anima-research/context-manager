/**
 * System changes: membrane's `system_change` block (SystemChangeContent), a
 * change to the tools and system text the model is offered from its place in
 * the conversation on. One stands alone in its message
 * (well-formed-content.ts), and membrane sends such a message as a system
 * message of its own, at the first point at or after its place that follows
 * a user turn, so always before the reply the request asks for. So one
 * stored between a tool call and its result would go out after the result,
 * and the store refuses that write where a write can see it
 * (MessageStore.refuseToolPairSplit): kept raw there, it would part the call
 * from its result.
 *
 * Every strategy compiles such a message unaltered, in its place among the
 * raw messages. A fold or a window that left one out would take its change
 * out of everything after it, so the autobiographical strategy keeps it raw
 * as a pin keeps a message, and the passthrough strategies keep it when
 * their window starts after it. Under the autobiographical strategy's
 * positionedRecallPairs: false, the middle's summaries go ahead of its raw
 * messages, so there a change keeps its place among raw messages only. The
 * one move is after a head-window reset, when the changes stored before the
 * head become part of the head, ahead of the head window, so that they keep
 * their order (AutobiographicalStrategy.headPositions).
 *
 * None is dropped, so they're carried until the caller consolidates them.
 * When they alone exceed the budget (beyond the autobiographical strategy's
 * grace, and on its hierarchical path only where enforceBudget is on), every
 * strategy refuses with OverBudgetError, its clearedBy empty, since
 * no newer message or compression shrinks them; a dry compile reports where
 * the strategy's other refusals do (the passthrough strategies refuse none
 * on a dry compile). While they fit, the passthrough strategies refuse when
 * the newest conversation message doesn't fit beside them (OverBudgetError,
 * naming a newer message while they leave room for one)
 * and otherwise drop the oldest messages as they do without changes, and
 * the autobiographical strategy refuses a loss as it refuses any: the
 * hierarchical path's recent window refuses an eviction with
 * UncoveredDropError. What compression reads
 * leaves them out: a change alters the request, not the conversation, and a
 * summarizer's request would apply it, or be refused for it.
 */

import type { ContentBlock } from '@animalabs/membrane';

/** Whether a block is a system change. */
export function isSystemChange(block: ContentBlock | { type?: unknown }): boolean {
  return (block as { type?: unknown }).type === 'system_change';
}

/** Whether a message's content holds a system change, and so, as written, nothing else. */
export function holdsSystemChange(content: readonly ContentBlock[]): boolean {
  for (let i = 0; i < content.length; i++) if (isSystemChange(content[i]!)) return true;
  return false;
}

const positionsOf = new WeakMap<object, readonly number[]>();

/**
 * The positions in a listing of the messages that hold a system change, in
 * order. A select reads them several times, so they're found once per
 * listing: a listing is the store's, which callers never change
 * (MessageStore.getAll), and a write makes a new one.
 */
export function systemChangePositions(messages: readonly { content: readonly ContentBlock[] }[]): readonly number[] {
  const known = positionsOf.get(messages);
  if (known) return known;
  const positions: number[] = [];
  for (let i = 0; i < messages.length; i++) if (holdsSystemChange(messages[i]!.content)) positions.push(i);
  positionsOf.set(messages, positions);
  return positions;
}
