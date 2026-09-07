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
export function filterMessageStoreView(
  view: MessageStoreView,
  keep: (message: StoredMessage) => boolean,
): MessageStoreView {
  const all = () => view.getAll().filter(keep);
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

/**
 * Merge one primary view with any number of auxiliary views into a single
 * timeline ordered by `sequence`.
 *
 * Cost: every `getAll` / `getFrom` / `getTail` re-concatenates and re-sorts
 * (O(n log n) per read). Only managers configured with auxiliary views pay
 * it, and their strategies read once per select; do not hang a hot path
 * (per-message bookkeeping, tight loops) off a merged view.
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
    const merged = primary.getAll().concat(...auxiliary.map((v) => v.getAll()));
    merged.sort((a, b) => a.sequence - b.sequence);
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
