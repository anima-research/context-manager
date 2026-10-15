/**
 * Raw replay forms on content blocks, kept honest across the context
 * manager's edits.
 *
 * Some of membrane's formatters replay a block from a raw form instead of
 * rendering its fields:
 *   - the Anthropic XML (prefill) formatter replays `rawXml` on `tool_use` and
 *     `tool_result` blocks: the original `<function_calls>` or
 *     `<function_results>` text, shared by every block parsed from it, written
 *     once per run of blocks that carry it;
 *   - the OpenAI Responses formatter emits `rawItem`, the provider-native item,
 *     from any block that carries one. A message item with several text parts
 *     gives each part's block the same item, written once per message, keyed
 *     by `type:id`.
 *
 * So a block edited by spreading it (`{ ...block, content }`) keeps its raw
 * form and the edit never ships: the wire carries the original. Dropping or
 * moving a block while a sibling keeps their shared raw form does the same,
 * since the sibling's replay still carries the dropped block. A raw form is
 * only true while every block that shares it stays unedited, together, in its
 * message.
 *
 * {@link releaseEditedRawForms} restores that after an edit: every block of
 * the edited message that shares a raw form with an edited, dropped or moved
 * block gives it up, and the formatter renders those blocks from their fields.
 * A raw form no edited block carried is untouched, so verbatim replay
 * survives wherever it is still true.
 *
 * A Responses reasoning item and the item it leads to (the next non-reasoning
 * item in the same message) are one pairing: the provider ties them together
 * by id, and a reasoning item replayed with its id but without that follower,
 * or a follower replayed with its id but without its reasoning, is a pairing
 * the provider didn't produce. So releasing either releases both. Released,
 * both are rendered from their fields without ids, which is the shape membrane
 * already sends for any history without raw items. For the reasoning, that
 * depends on what it carried: with encrypted content it is a
 * `redacted_thinking` block, which membrane's converter sends as an id-less
 * reasoning item with that content; without, it is a plain `thinking` block,
 * which membrane's converter has no form for, so a released one is not sent
 * at all: without its id and without encrypted content, there is nothing to
 * resolve it from.
 *
 * An opaque item (a Responses item membrane has no block for: an encrypted
 * compaction item, a hosted tool's call such as a web search, a custom tool
 * call) rides on a zero-width text block whose raw item is its whole content:
 * no field can render it. So an opaque carrier is never released. In a
 * pairing it is an item like any other, so a hosted tool's call is the
 * follower of the reasoning that led to it. A pairing released through one
 * leaves it whole, with its id. So where its reasoning is stripped and it
 * stays, it ships with its id and no reasoning, as main sends it: that is the
 * live-strip recall answer (see liveWindowAnswerProse). Compression input
 * strips the reasoning too, but drops every carrier with the other empty text
 * (stripEmptyTextBlocks), so there it doesn't ship at all.
 */

import type { ContentBlock } from '@animalabs/membrane';

type RawFormCarrier = { rawXml?: unknown; rawItem?: unknown };

function xmlKey(block: ContentBlock): string | undefined {
  // The XML formatter replays `rawXml` only for runs of tool_use and
  // tool_result blocks. On any other block it is not a replay form, and
  // releasing it would leave the block with nothing to render: the
  // `tool_attempt` block proposed in membrane#101 (a `<function_calls>` block
  // that dispatched nothing) carries its whole text there, which can be
  // byte-identical to a dispatched block's `rawXml` in the same message.
  if (block.type !== 'tool_use' && block.type !== 'tool_result') return undefined;
  const raw = (block as RawFormCarrier).rawXml;
  // The XML formatter replays only a non-empty string.
  return typeof raw === 'string' && raw.length > 0 ? `xml:${raw}` : undefined;
}

function isReasoningItem(block: ContentBlock): boolean {
  const raw = (block as RawFormCarrier).rawItem;
  return !!raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'reasoning';
}

/**
 * A text block carrying an opaque Responses item: membrane's zero-width carrier
 * for an item it has no block for (see membrane's parseProviderContent). A text
 * block from a message item's part carries that message item instead.
 */
export function isOpaqueCarrier(block: ContentBlock): boolean {
  if (block.type !== 'text') return false;
  const raw = (block as RawFormCarrier).rawItem;
  return !!raw && typeof raw === 'object' && (raw as { type?: unknown }).type !== 'message';
}

function itemKey(block: ContentBlock): string | undefined {
  const raw = (block as RawFormCarrier).rawItem;
  // The Responses formatter emits only an object, deduplicated per message by
  // `type:id`, or by its JSON when it has no string id.
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as { type?: unknown; id?: unknown };
  return typeof item.id === 'string'
    ? `item:${String(item.type ?? '')}:${item.id}`
    : `item:${JSON.stringify(raw)}`;
}

/** The keys of the raw forms a block carries, as membrane's formatters tell them apart. */
export function rawFormKeys(block: ContentBlock): string[] {
  const keys: string[] = [];
  const xml = xmlKey(block);
  if (xml) keys.push(xml);
  const item = itemKey(block);
  if (item) keys.push(item);
  return keys;
}

/**
 * The block without the raw forms whose keys are in `keys`, or without any
 * raw form when `keys` is omitted. Returns the block itself when it carries
 * none of them, so an untouched block keeps its identity. An opaque carrier
 * keeps its raw item, which is its whole content.
 */
export function withoutRawForms(block: ContentBlock, keys?: ReadonlySet<string>): ContentBlock {
  const xml = xmlKey(block);
  const item = isOpaqueCarrier(block) ? undefined : itemKey(block);
  const dropXml = xml !== undefined && (!keys || keys.has(xml));
  const dropItem = item !== undefined && (!keys || keys.has(item));
  if (!dropXml && !dropItem) return block;
  const copy = { ...block } as ContentBlock & RawFormCarrier;
  if (dropXml) delete copy.rawXml;
  if (dropItem) delete copy.rawItem;
  return copy as ContentBlock;
}

/**
 * Reconcile one message's content after an edit.
 *
 * `before` is the content as it was. `after` is the content the edit produced
 * from it, in which every unchanged block is the same object. Each block of
 * `before` that `after` no longer holds by identity was edited, dropped or
 * moved away. Every raw form such a block carried is given up by every block
 * of `after` that carries it, the edited copies included.
 *
 * Returns `after` itself when nothing has to change.
 */
export function releaseEditedRawForms(
  before: readonly ContentBlock[],
  after: ContentBlock[],
): ContentBlock[] {
  const kept = new Set<ContentBlock>(after);
  const released = new Set<string>();
  for (const block of before) {
    if (kept.has(block)) continue;
    for (const key of rawFormKeys(block)) released.add(key);
  }
  if (released.size === 0) return after;
  releasePairings(before, released);
  let changed = false;
  const result = after.map((block) => {
    const next = withoutRawForms(block, released);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? result : after;
}

/**
 * The keys of a message's reasoning pairings, read from its content as it was:
 * each run of reasoning items pairs with the next item that isn't reasoning,
 * an opaque one included. Reasoning with no such item after it in the message
 * pairs with nothing here.
 */
function pairingsOf(before: readonly ContentBlock[]): string[][] {
  const pairings: string[][] = [];
  let pending: string[] = [];
  for (const block of before) {
    const key = itemKey(block);
    if (!key) continue;
    if (isReasoningItem(block)) {
      if (!pending.includes(key)) pending.push(key);
      continue;
    }
    if (pending.length > 0) pairings.push([...pending, key]);
    pending = [];
  }
  return pairings;
}

/**
 * Widen `released` to whole reasoning pairings, read from the message's
 * content as it was: a pairing with any member released is released whole.
 */
function releasePairings(before: readonly ContentBlock[], released: Set<string>): void {
  const pairings = pairingsOf(before);
  let widened = true;
  while (widened) {
    widened = false;
    for (const pairing of pairings) {
      if (!pairing.some((key) => released.has(key))) continue;
      for (const key of pairing) {
        if (!released.has(key)) {
          released.add(key);
          widened = true;
        }
      }
    }
  }
}

/**
 * Reconcile a message's content after blocks were dropped from it. A dropped
 * block with content gives up its raw forms in every block that shares them,
 * as an edit does, since a sibling's replay would still carry it. An empty
 * text part is narrower: while a surviving sibling still carries its item,
 * nothing changes, since only whitespace rides along inside that item; an
 * item none of whose parts survive releases the reasoning that led to it.
 *
 * `after` must keep each surviving block by identity, as a filter does.
 * Returns `after` itself when nothing has to change.
 */
export function releaseVanishedRawForms(
  before: readonly ContentBlock[],
  after: ContentBlock[],
): ContentBlock[] {
  const kept = new Set<ContentBlock>(after);
  const surviving = new Set<string>(after.flatMap(rawFormKeys));
  const released = new Set<string>();
  for (const block of before) {
    if (kept.has(block)) continue;
    const empty = isEmptyTextPart(block);
    for (const key of rawFormKeys(block)) if (!empty || !surviving.has(key)) released.add(key);
  }
  if (released.size === 0) return after;
  releasePairings(before, released);
  let changed = false;
  const result = after.map((block) => {
    const next = withoutRawForms(block, released);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? result : after;
}

/** A text part with nothing but whitespace: not an opaque carrier, whose raw item is its content. */
function isEmptyTextPart(block: ContentBlock): boolean {
  if (block.type !== 'text' || isOpaqueCarrier(block)) return false;
  const text = (block as { text?: unknown }).text;
  return typeof text !== 'string' || text.trim().length === 0;
}

/**
 * The content, for a block about to be appended after it: the reasoning items
 * at its end, which no item follows in this message, are released, since the
 * appended block would follow them on the wire as an item the provider never
 * produced. Everything else keeps its identity.
 */
export function releaseTrailingReasoning(content: ContentBlock[]): ContentBlock[] {
  const trailing = new Set<string>();
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    const key = itemKey(block);
    if (!key) continue;
    if (!isReasoningItem(block)) break;
    trailing.add(key);
  }
  if (trailing.size === 0) return content;
  let changed = false;
  const result = content.map((block) => {
    const next = withoutRawForms(block, trailing);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? result : content;
}

/**
 * A block moved out of `source` (its message's content before the move) gives
 * up the raw forms it shares with any block that stays behind. A raw form it
 * carries alone moves with it, unless it belongs to a reasoning pairing: moved
 * alone, a reasoning item or the item it led to would keep the id that ties it
 * to a partner it no longer sits with, so it gives that item up too, as an
 * edit does. An opaque carrier keeps its item, as everywhere (see above). The
 * blocks left behind are reconciled with releaseEditedRawForms, which
 * releases the rest of the pairing.
 */
export function releaseSharedRawFormsOnMove(
  moved: ContentBlock,
  source: readonly ContentBlock[],
): ContentBlock {
  const own = rawFormKeys(moved);
  if (own.length === 0) return moved;
  const shared = new Set<string>();
  for (const block of source) {
    if (block === moved) continue;
    for (const key of rawFormKeys(block)) if (own.includes(key)) shared.add(key);
  }
  const item = itemKey(moved);
  if (item && pairingsOf(source).some((pairing) => pairing.includes(item))) shared.add(item);
  return shared.size === 0 ? moved : withoutRawForms(moved, shared);
}
