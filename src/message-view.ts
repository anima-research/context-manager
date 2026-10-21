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
 * `mergeMessageStoreViews` presents several message slots as one timeline,
 * ordered by chronicle `sequence` — which is allocated per-branch under a
 * single write lock regardless of state slot, so cross-slot ordering is
 * deterministic, append-only, and stable across invocations.
 */

import type { MessageStoreView, StoredMessage, MessageId } from './types/index.js';

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
