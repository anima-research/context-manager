/**
 * MessageStoreView compositors — pure wrappers over the strategy-facing
 * read surface.
 *
 * `filterMessageStoreView` hides a subset of messages from a view. Because
 * both `compile()` and the strategy tick path obtain their views from one
 * choke point (ContextManager), a filter installed there is seen
 * consistently by chunking, selection, emission, and the coverage
 * invariants — an excluded message is simply not part of the strategy's
 * world, on both sides of every assertion. The messages remain in the
 * store: direct accessors (getMessage/getAllMessages/query) are unaffected.
 *
 * `audienceMessageStoreView` shows a view's reader only the content blocks
 * meant for it: a block that declares an `audience` is that audience's
 * alone.
 *
 * `mergeMessageStoreViews` presents several message slots as one timeline,
 * ordered by chronicle `sequence` — which is allocated per-branch under a
 * single write lock regardless of state slot, so cross-slot ordering is
 * deterministic, append-only, and stable across invocations.
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { MessageStoreView, StoredMessage, MessageId } from './types/index.js';
import { releaseEditedRawForms } from './raw-forms.js';

/**
 * Wrap a view so that only messages passing `keep` are visible.
 * All read methods (including `get` by id) see the filtered world — note
 * that `getFrom(index)` therefore indexes the FILTERED sequence of
 * messages, not raw-store positions.
 */
const filteredListings = new WeakMap<
  readonly StoredMessage[],
  WeakMap<(message: StoredMessage) => boolean, StoredMessage[]>
>();

export function filterMessageStoreView(
  view: MessageStoreView,
  keep: (message: StoredMessage) => boolean,
): MessageStoreView {
  // The underlying listing is the store's cached array while nothing was
  // written, and `keep` is a pure function of the message, so one filtered
  // array per (listing, predicate) serves every getAll/length/getTail of a
  // compile — across view instances too: the host builds a fresh view for
  // every strategy call over the same listing and the same predicate.
  const all = () => {
    const source = view.getAll();
    let byKeep = filteredListings.get(source);
    if (!byKeep) {
      byKeep = new WeakMap();
      filteredListings.set(source, byKeep);
    }
    let out = byKeep.get(keep);
    if (!out) {
      out = source.filter(keep);
      byKeep.set(keep, out);
    }
    return out;
  };
  return {
    getAll: all,
    get: (id: MessageId) => {
      const msg = view.get(id);
      return msg && keep(msg) ? msg : null;
    },
    getFrom: (index: number) => all().slice(index),
    getTail: (count: number) => {
      const messages = all();
      return count >= messages.length ? messages : messages.slice(messages.length - count);
    },
    length: () => all().length,
    estimateTokens: (msg: StoredMessage) => view.estimateTokens(msg),
    setTokenCalibration: view.setTokenCalibration
      ? (f: number) => view.setTokenCalibration!(f)
      : undefined,
    getTokenCalibration: view.getTokenCalibration
      ? () => view.getTokenCalibration!()
      : undefined,
  };
}

function audienceOf(block: object): readonly string[] | undefined {
  const audience = (block as { audience?: unknown }).audience;
  if (audience === undefined) return undefined;
  return Array.isArray(audience) && [...audience].every((reader) => typeof reader === 'string') ? audience : [];
}

/**
 * The content `reader` sees: every block without an `audience`, and every
 * block whose `audience` names `reader`, without its `audience` field.
 * Undefined `reader` sees no block that has an `audience`. Null when it
 * sees none of the blocks; `content` itself when no block has an
 * `audience`. A block it doesn't see gives up its raw replay forms on
 * every block that shares them (releaseEditedRawForms), so a replay
 * can't carry it.
 */
export function contentForReader(content: readonly ContentBlock[], reader: string | undefined): ContentBlock[] | null {
  if (!content.some((block) => audienceOf(block) !== undefined)) return content as ContentBlock[];
  const seen: ContentBlock[] = [];
  const compared: ContentBlock[] = [];
  for (const block of content) {
    const audience = audienceOf(block);
    if (audience === undefined) {
      seen.push(block);
      compared.push(block);
    } else if (reader !== undefined && audience.includes(reader)) {
      const { audience: _audience, ...rest } = block as ContentBlock & { audience?: unknown };
      seen.push(rest as ContentBlock);
      compared.push(rest as ContentBlock);
    } else {
      compared.push(block);
    }
  }
  return seen.length > 0 ? releaseEditedRawForms(compared, seen) : null;
}

/** A content block with the readers it's for (`audience`), as a host may write one on a message's own blocks other than tool calls, tool results, system changes and inline media. */
export type ContentBlockWithAudience = ContentBlock & { audience?: string[] };

export function hasAudience(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => block !== null && typeof block === 'object' && audienceOf(block) !== undefined);
}

const forReaders = new WeakMap<StoredMessage, Map<string | undefined, { blocks: readonly ContentBlock[]; seen: StoredMessage | null }>>();
const emptied = new WeakMap<StoredMessage, StoredMessage>();
const emptiedForms = new WeakSet<StoredMessage>();

export function isEmptiedForReader(message: StoredMessage): boolean {
  return emptiedForms.has(message);
}
const readerListings = new WeakMap<readonly StoredMessage[], Map<string, StoredMessage[]>>();

export function messageForReader(message: StoredMessage, reader: string | undefined): StoredMessage | null {
  const content = message.content;
  if (!content.some((block) => audienceOf(block) !== undefined)) return message;
  let byReader = forReaders.get(message);
  if (!byReader) {
    byReader = new Map();
    forReaders.set(message, byReader);
  }
  const hit = byReader.get(reader);
  if (hit && hit.blocks.length === content.length && hit.blocks.every((block, i) => block === content[i])) return hit.seen;
  const visible = contentForReader(content, reader);
  const seen = visible ? { ...message, content: visible } : null;
  byReader.set(reader, { blocks: content.slice(), seen });
  return seen;
}

/**
 * Wrap a view so that `reader` sees only the blocks meant for it
 * (contentForReader), and none of a message whose every block is someone
 * else's; with `keepEmptied`, such a message stays, with no content, so
 * its identity and its place in a body stay the stored ones. A message
 * with no `audience` block is the view's own object, and a listing with
 * none is the view's own array, so a store that never declares an
 * audience reads exactly as through `view`. A message that has one is one
 * object per reader while its stored object lives, so the estimate cache
 * and the strategy's per-listing memos hold across compiles. `getTail`
 * reads `view`'s window, as `getFrom(0)` does; `getFrom` past 0 reads the
 * listing, since a message left out before it moves its index. With
 * `mayHold`, each listing read (getAll, getFrom, getTail, length) and
 * sequenceOf asks it first and, while it's false, answers as `view` does;
 * get is decided by the message's own blocks. Both are decided at
 * each read, so a holder that keeps the view sees the reader's view
 * whenever it reads.
 */
export function audienceMessageStoreView(
  view: MessageStoreView,
  reader: string | undefined,
  opts: { keepEmptied?: boolean; mayHold?: () => boolean } = {},
): MessageStoreView {
  const plain = () => opts.mayHold !== undefined && !opts.mayHold();
  const form = (message: StoredMessage): StoredMessage | null => {
    const seen = messageForReader(message, reader);
    if (seen || !opts.keepEmptied) return seen;
    let empty = emptied.get(message);
    if (!empty) {
      empty = { ...message, content: [] };
      emptied.set(message, empty);
      emptiedForms.add(empty);
    }
    return empty;
  };
  const key = `${opts.keepEmptied ? 'k' : 'd'}:${reader ?? ''}:${reader === undefined ? 'none' : 'one'}`;
  const mapped = (messages: StoredMessage[]): { out: StoredMessage[]; dropped: boolean } => {
    let changed = false;
    let dropped = false;
    const out: StoredMessage[] = [];
    for (const message of messages) {
      const seen = form(message);
      if (seen !== message) changed = true;
      if (seen) out.push(seen);
      else dropped = true;
    }
    return { out: changed ? out : messages, dropped };
  };
  const all = () => {
    const source = view.getAll();
    let byReader = readerListings.get(source);
    if (!byReader) {
      byReader = new Map();
      readerListings.set(source, byReader);
    }
    let out = byReader.get(key);
    if (!out) {
      out = mapped(source as StoredMessage[]).out;
      byReader.set(key, out);
    }
    return out;
  };
  return {
    getAll: () => (plain() ? view.getAll() : all()),
    get: (id: MessageId) => {
      const message = view.get(id);
      return message ? form(message) : null;
    },
    ...(view.sequenceOf
      ? {
          sequenceOf: (id: MessageId) => {
            if (plain()) return view.sequenceOf!(id);
            const message = view.get(id);
            return message && form(message) ? view.sequenceOf!(id) : undefined;
          },
        }
      : {}),
    getFrom: (index: number) => {
      if (plain()) return view.getFrom(index);
      if (index !== 0) return all().slice(index);
      return mapped(view.getFrom(0)).out;
    },
    getTail: (count: number) => {
      if (plain()) return view.getTail(count);
      const window = mapped(view.getTail(count));
      if (!window.dropped) return window.out;
      const messages = all();
      return count >= messages.length ? messages : messages.slice(messages.length - count);
    },
    length: () => (plain() ? view.length() : all().length),
    estimateTokens: (msg: StoredMessage) => view.estimateTokens(msg),
    setTokenCalibration: view.setTokenCalibration
      ? (f: number) => view.setTokenCalibration!(f)
      : undefined,
    getTokenCalibration: view.getTokenCalibration
      ? () => view.getTokenCalibration!()
      : undefined,
  };
}

/** Merged listings keyed by the chain of source listings they were merged
 * from (primary first, then each auxiliary, compared by identity). Every
 * link is a WeakMap, so a combination lives only while all of its source
 * arrays do: a store that keeps appending while another stays put leaves
 * no trail of obsolete merges behind the unchanged listing. */
interface MergedListingNode {
  merged?: StoredMessage[];
  next: WeakMap<readonly StoredMessage[], MergedListingNode>;
}
const mergedListings: MergedListingNode = { next: new WeakMap() };

/**
 * Merge one primary view with any number of auxiliary views into a single
 * timeline ordered by `sequence`.
 *
 * Cost: the merged listing is built once per combination of source
 * listings and served from a memo while every source returns the same
 * array. The sources are the stores' own cached listings (MessageStore
 * memoizes getAll on branch and write version), so a compile's reads
 * (two getAll/getFrom/getTail calls for the windowed strategy, ten-odd for
 * the autobiographical one), across the fresh view objects the host
 * builds for each strategy call, share one O(n log n) merge; the next
 * append misses on the changed source and merges again. The memo also
 * keeps the listing's identity stable, which the strategy's per-listing
 * memos (post-strip estimates, the chunk index) key on.
 *
 * Token estimation and calibration delegate to the primary view (estimators
 * are store-level and identical across slots of one chronicle store).
 * Auxiliary views are read-only by construction — MessageStoreView carries
 * no write surface.
 */
export function mergeMessageStoreViews(
  primary: MessageStoreView,
  auxiliary: MessageStoreView[],
): MessageStoreView {
  if (auxiliary.length === 0) return primary;

  const all = () => {
    const source = primary.getAll();
    const sources = auxiliary.map((v) => v.getAll());
    let node = mergedListings;
    for (const listing of [source, ...sources]) {
      let next = node.next.get(listing);
      if (!next) {
        next = { next: new WeakMap() };
        node.next.set(listing, next);
      }
      node = next;
    }
    if (node.merged) return node.merged;
    const merged = source.concat(...sources);
    merged.sort((a, b) => a.sequence - b.sequence);
    node.merged = merged;
    return merged;
  };
  return {
    getAll: all,
    get: (id: MessageId) => {
      const own = primary.get(id);
      if (own) return own;
      for (const view of auxiliary) {
        const msg = view.get(id);
        if (msg) return msg;
      }
      return null;
    },
    sequenceOf: (id: MessageId) => {
      for (const view of [primary, ...auxiliary]) {
        const sequence = view.sequenceOf ? view.sequenceOf(id) : view.get(id)?.sequence;
        if (sequence !== undefined) return sequence;
      }
      return undefined;
    },
    getFrom: (index: number) => all().slice(index),
    getTail: (count: number) => {
      const messages = all();
      return count >= messages.length ? messages : messages.slice(messages.length - count);
    },
    length: () => auxiliary.reduce((n, v) => n + v.length(), primary.length()),
    estimateTokens: (msg: StoredMessage) => primary.estimateTokens(msg),
    setTokenCalibration: primary.setTokenCalibration
      ? (f: number) => primary.setTokenCalibration!(f)
      : undefined,
    getTokenCalibration: primary.getTokenCalibration
      ? () => primary.getTokenCalibration!()
      : undefined,
  };
}
