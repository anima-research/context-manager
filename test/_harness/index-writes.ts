/**
 * How the window index writes (src/window-index.ts, WindowIndex.write).
 * Where chronicle has `appendManyToStateJsonWithIdentity`, a write of
 * several items (a write-down, one presentRows call's rows, one call's
 * tombstones) is one record, which the store keeps or loses whole. On a
 * chronicle without it each item is one record, and only there is a write
 * cut short partway. The tests that pin what such a write leaves behind run
 * on that path, by hiding the batched form on the store handle.
 */

import { JsStore } from '@animalabs/chronicle';

const BATCHED = 'appendManyToStateJsonWithIdentity';

/**
 * A test's `skip` for what only a chronicle with the batched identity
 * append does: false where the installed one has it.
 */
export const skipWithoutBatches: false | string =
  typeof (JsStore.prototype as unknown as Record<string, unknown>)[BATCHED] === 'function'
    ? false
    : 'installed @animalabs/chronicle has no appendManyToStateJsonWithIdentity (identity-stamped batched append)';

/** Whether `store` appends several identity-stamped items as one record. */
export function batchesIndexWrites(store: JsStore): boolean {
  return typeof (store as unknown as Record<string, unknown>)[BATCHED] === 'function';
}

/**
 * Makes the window index write through `store`'s handle one record per
 * item, as it does on a chronicle without the batched identity append, by
 * hiding that method on the handle; returns the undo. Other handles on the
 * same store, such as a derived manager's view, keep it.
 */
export function perItemIndexWrites(store: JsStore): () => void {
  const handle = store as unknown as Record<string, unknown>;
  const own = Object.prototype.hasOwnProperty.call(handle, BATCHED);
  const was = handle[BATCHED];
  handle[BATCHED] = undefined;
  return () => {
    if (own) handle[BATCHED] = was;
    else delete handle[BATCHED];
  };
}
