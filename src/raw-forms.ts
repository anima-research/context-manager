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
 */

import type { ContentBlock } from '@animalabs/membrane';

type RawFormCarrier = { rawXml?: unknown; rawItem?: unknown };

function xmlKey(block: ContentBlock): string | undefined {
  const raw = (block as RawFormCarrier).rawXml;
  // The XML formatter replays only a non-empty string.
  return typeof raw === 'string' && raw.length > 0 ? `xml:${raw}` : undefined;
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
 * none of them, so an untouched block keeps its identity.
 */
export function withoutRawForms(block: ContentBlock, keys?: ReadonlySet<string>): ContentBlock {
  const xml = xmlKey(block);
  const item = itemKey(block);
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
  let changed = false;
  const result = after.map((block) => {
    const next = withoutRawForms(block, released);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? result : after;
}

/**
 * A block moved out of `source` (its message's content before the move) gives
 * up the raw forms it shares with any block that stays behind. A raw form it
 * carries alone moves with it.
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
  return shared.size === 0 ? moved : withoutRawForms(moved, shared);
}
