/**
 * The per-message token cap (`maxMessageTokens`) that the autobiographical
 * and windowed-passthrough strategies both apply. One cut serves both, so a
 * message is cut alike by either, and the marker's offsets index the same
 * measured text a reader pages (`capMeasuredTextOf`). Each strategy passes
 * its own estimate.
 */
import type { ContentBlock } from '@animalabs/membrane';
import { isEmptyTextBlock, releaseVanishedRawForms } from '../raw-forms.js';
import type { CapReadHint, MessageStoreView, StoredMessage } from '../types/index.js';

/** A text block that holds nothing, the one rule the cap and the raw-form
 *  release share (raw-forms.ts). */
export { isEmptyTextBlock };

/** The combined recall answer of the autobiographical strategy when every
 *  summary's own cut left nothing of it that holds anything, so the answer
 *  isn't empty. */
export const CAP_OMISSION_TEXT = '[content omitted: this message reached its token limit]';

/** Where the whole of a message the cap cuts is kept, as its marker names
 *  it: a stored message, or a summary, by id. */
export interface CapWhole {
  kind: 'message' | 'summary';
  id: string;
}

/** The clause a marker ends with: the host's `capReadHint`'s, or none. */
export type CapClause = (at: Parameters<CapReadHint>[0]) => string | undefined;

export interface CapOptions {
  whole?: CapWhole;
  hint?: CapClause;
}

/** What a strategy says, once, when the host's `capReadHint` throws. */
export const CAP_HINT_THREW =
  '[cap] capReadHint threw, so a marker it threw for names the stored message or summary by id alone (said once)';

/**
 * The host's `capReadHint`, read at each call through `hint`, as a clause
 * that is none where there's no hint or where it throws: the marker then
 * names the whole by id alone, as with no hint, so a host's bug in its hint
 * fails no compile. `warn` hears the first throw, and one that throws
 * itself is ignored.
 */
export function guardedHint(hint: () => CapReadHint | undefined, warn: (line: string, thrown: unknown) => void): CapClause {
  let said = false;
  return (at) => {
    const read = hint();
    if (!read) return undefined;
    try {
      return read(at);
    } catch (thrown) {
      if (!said) {
        said = true;
        try { warn(CAP_HINT_THREW, thrown); } catch {}
      }
      return undefined;
    }
  };
}

/** The marker blocks capContent wrote, so a reader of its output can tell
 *  the cap's own marker from a block whose text looks like one. A marker
 *  carries no raw form, so none is copied there. */
const capMarkers = new WeakSet<ContentBlock>();

function capMarker(text: string): ContentBlock {
  const block: ContentBlock = { type: 'text', text };
  capMarkers.add(block);
  return block;
}

/** Whether `block` is a marker capContent wrote, rather than a block whose
 *  text reads as one. */
export function isCapMarker(block: ContentBlock): boolean {
  return capMarkers.has(block);
}

/** Whether `capped`, what `capContent` made of `content`, lost nothing of it
 *  that holds anything: every block of `content` is in `capped` as it was,
 *  or is a text block that holds nothing. */
export function cappedWhole(content: readonly ContentBlock[], capped: readonly ContentBlock[]): boolean {
  if (capped === content) return true;
  const kept = new Set<ContentBlock>(capped);
  return content.every((block) => kept.has(block) || isEmptyTextBlock(block));
}

/** The text of `block` the cap measures: a text block's text (none for a
 *  text that isn't a string) or a string tool result's content; null for
 *  any other block, which the cap passes through. */
function measuredText(block: ContentBlock): string | null {
  if (block.type === 'text') {
    const text = (block as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 0) return block.content;
  return null;
}

/** The text the cap measures in `content`: its text blocks and string tool
 *  results in order, joined with no separator. The marker's offsets index
 *  this text. */
export function capMeasuredTextOf(content: readonly ContentBlock[]): string {
  let text = '';
  for (const block of content) text += measuredText(block) ?? '';
  return text;
}

function resultNotice(startOnly: boolean, opts: CapOptions): string {
  const where = opts.whole ? `; the whole is stored ${opts.whole.kind} ${opts.whole.id}` : '';
  return `[truncated — this result${startOnly ? "'s start" : ''} is elided${where}]`;
}

function markerText(head: number, tailStart: number, total: number, opts: CapOptions): string {
  const { whole, hint } = opts;
  const where = whole ? `; the whole is stored ${whole.kind} ${whole.id}` : '';
  const clause = whole && hint ? hint({ id: whole.id, offsetChars: head }) : undefined;
  const read = clause === undefined ? '' : `; ${clause}`;
  return `[truncated — chars ${head} to ${tailStart} of ${total} elided here${where}${read}]`;
}

/** The stub's `_whole` for a call's input the input cap leaves out: how long
 *  it is, where its whole is stored, and the host's clause for reading it. */
export function cutInputText(chars: number, messageId: string, toolUseId: string, hint?: CapClause): string {
  const clause = hint ? hint({ id: messageId, toolUseId }) : undefined;
  const read = clause === undefined ? '' : `; ${clause}`;
  return `[truncated — this call's input, ${chars} chars, is elided; the whole is stored message ${messageId}, call ${toolUseId}${read}]`;
}

function isLowSurrogate(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return code >= 0xDC00 && code <= 0xDFFF;
}

/** Where the head ends and the tail starts in the measured text, for `kept`
 *  characters: Hands' shape, the head 60% and the tail the rest, each end
 *  moved to a line break that falls within half its share, neither inside
 *  a surrogate pair. */
function ends(text: string, kept: number): { headEnd: number; tailStart: number } {
  const headShare = Math.floor(kept * 0.6);
  const tailShare = kept - headShare;
  let headEnd = headShare > 0 && isLowSurrogate(text, headShare) ? headShare - 1 : headShare;
  const lineEnd = headEnd > 0 ? text.lastIndexOf('\n', headEnd - 1) : -1;
  if (lineEnd > headShare / 2) headEnd = lineEnd + 1;
  let tailStart = text.length - tailShare;
  if (isLowSurrogate(text, tailStart)) tailStart++;
  const lineStart = text.indexOf('\n', tailStart);
  if (lineStart !== -1 && lineStart - tailStart < tailShare / 2) tailStart = lineStart + 1;
  return { headEnd, tailStart };
}

/** The content cut to keep the measured text before `headEnd` and from
 *  `tailStart`, with the marker where the middle starts, and the offsets
 *  of what it kept: a block that holds nothing, or a kept piece that holds
 *  nothing, is left out where an end falls in it, so its characters count
 *  as elided. */
function cutAt(content: readonly ContentBlock[], headEnd: number, tailStart: number, total: number, opts: CapOptions):
  { blocks: ContentBlock[]; head: number; tailStart: number } {
  type Piece = { block: ContentBlock; start: number; text: string | null };
  const pieces: Piece[] = [];
  let at = 0;
  for (const block of content) {
    const text = measuredText(block);
    pieces.push({ block, start: at, text });
    if (text !== null) at += text.length;
  }
  let head = headEnd;
  let tail = tailStart;
  for (const { start, text, block } of pieces) {
    if (text === null || block.type !== 'text') continue;
    const end = start + text.length;
    if (start < headEnd && end > headEnd && (isEmptyTextBlock(block) || text.slice(0, headEnd - start).trim() === '')) head = start;
    if (start < tailStart && end > tailStart && (isEmptyTextBlock(block) || text.slice(tailStart - start).trim() === '')) tail = end;
  }
  const marker = markerText(head, tail, total, opts);
  const blocks: ContentBlock[] = [];
  let marked = false;
  for (const { block, start, text } of pieces) {
    if (text === null) {
      blocks.push(block);
      continue;
    }
    const end = start + text.length;
    const inHead = text.length === 0 ? start < headEnd : end <= headEnd;
    if (inHead || start >= tailStart) {
      blocks.push(block);
      continue;
    }
    const before = start < head ? text.slice(0, head - start) : '';
    const after = end > tail ? text.slice(tail - start) : '';
    if (block.type === 'text') {
      if (before) blocks.push({ type: 'text', text: before });
      if (!marked) blocks.push(capMarker(marker));
      marked = true;
      if (after) blocks.push({ type: 'text', text: after });
    } else {
      const middle = !marked ? marker : resultNotice(Boolean(after) && !before, opts);
      marked = true;
      blocks.push({ ...block, content: [before, middle, after].filter((part) => part !== '').join('\n\n') } as ContentBlock);
    }
  }
  return { blocks, head, tailStart: tail };
}

/**
 * Cut a message's text and string tool-result content to `maxTokens` by
 * `estimate`, the strategy's own estimate, when the content's estimate is
 * over it, keeping its head and its tail around one marker.
 *
 * - The text measured is the message's text blocks and string tool results
 *   in order (`capMeasuredTextOf`). Content whose measured blocks alone fit
 *   comes back as it is, so a block the cut doesn't shorten, such as
 *   thinking, never shrinks the text kept. Content whose measured blocks
 *   fit once its text blocks that hold nothing (`isEmptyTextBlock`) are
 *   left out comes back without them, which loses nothing.
 * - Otherwise it keeps the largest head and tail whose kept blocks and
 *   marker, estimated alone, fit `maxTokens`: the head 60% of what it keeps
 *   and the tail 40%, each end moved to a line break within half its share,
 *   neither inside a surrogate pair. A cap the least cut, the marker and a
 *   notice for each later string tool result, passes keeps neither, and
 *   where that cut estimates at least as much as the measured blocks
 *   it stands for, the content comes back whole: the cut is never longer
 *   than the whole.
 * - The marker says which characters of the measured text it elided, and,
 *   with `opts.whole`, where the whole is stored, then the clause
 *   `opts.hint` gives, if any (`guardedHint`): `[truncated — chars H to T of M elided here; the
 *   whole is stored message ID; …]`. It stands where the middle starts: a
 *   block of its own where that's in a text block, told apart by identity
 *   (`isCapMarker`), and in a string tool result's own content where that's
 *   in one, since a result keeps its pairing.
 * - A text block wholly in the middle is dropped. A string tool result
 *   wholly in the middle says so in its content, and one the tail starts in
 *   says its start is elided, each naming the stored whole too. A text block that holds nothing, kept whole at
 *   either end, is left out where an end falls in it, as is a kept piece
 *   that would hold nothing, and the marker counts its characters as elided.
 * - Every other block passes through in place.
 *
 * A cut or dropped block gives up its raw replay form, along with every
 * block sharing it (`releaseVanishedRawForms`). A `maxTokens` that isn't a
 * positive number, such as 0, a negative, NaN or undefined, means no cap,
 * as `maxMessageTokens` does. The cut is a pure function of its arguments,
 * so every compile sends a message alike, given a pure `opts.hint`.
 */
export function capContent(
  content: ContentBlock[],
  maxTokens: number,
  estimate: (content: ContentBlock[]) => number,
  opts: CapOptions = {},
): ContentBlock[] {
  if (!(maxTokens > 0)) return content;
  if (estimate(content) <= maxTokens) return content;
  const measured = content.filter((block) => measuredText(block) !== null);
  if (estimate(measured) <= maxTokens) return content;
  const unblank = content.filter((block) => !isEmptyTextBlock(block));
  if (unblank.length > 0 && unblank.length < content.length
    && estimate(unblank.filter((block) => measuredText(block) !== null)) <= maxTokens) {
    return releaseVanishedRawForms(content, unblank);
  }

  const text = capMeasuredTextOf(content);
  const cut = (kept: number) => {
    const { headEnd, tailStart } = ends(text, kept);
    return cutAt(content, headEnd, tailStart, text.length, opts);
  };
  const fits = (kept: number): boolean =>
    estimate(cut(kept).blocks.filter((block) => measuredText(block) !== null)) <= maxTokens;
  let low = 0;
  let high = text.length;
  if (fits(low)) {
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle;
    }
  }
  const blocks = cut(low).blocks;
  if (estimate(blocks.filter((block) => measuredText(block) !== null)) >= estimate(measured)) return content;
  return releaseVanishedRawForms(content, blocks);
}

/**
 * What sending `capped`, which the cap made of `message`'s content (with
 * `capContent`, or a strategy's override of its cut), adds to the message's
 * price: the store's estimate of `capped`, less its estimate
 * of the message as stored, and 0 where the cap left the content whole. Both
 * strategies price a capped message at its uncapped price plus this, so the
 * cut is priced as it renders (#223). The cap measures what it keeps by the
 * strategy's estimate, and the store prices it at its own rates. It cuts text
 * blocks and string tool results alone and passes every other block through,
 * as it was or as a copy that gave up a raw form it shared with a cut block,
 * so the difference holds the kept and cut text, the marker and what a
 * result in the middle says, and an image or a tool call keeps
 * whatever price the site's uncapped price gives it. A block the cut makes
 * give up its raw form estimates as it did, so it adds nothing.
 */
export function cappedPriceExtra(store: MessageStoreView, message: StoredMessage, capped: ContentBlock[]): number {
  // Content the cap left whole is the message's own array, whose two
  // estimates would sum the same blocks, so this returns 0 without taking
  // either: with no cap set, every raw message comes through here at every
  // site that prices it.
  if (capped === message.content) return 0;
  return store.estimateTokens({ content: capped } as StoredMessage) - store.estimateTokens(message);
}
