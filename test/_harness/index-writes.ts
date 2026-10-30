/**
 * How the window index writes (src/window-index.ts, WindowIndex.write).
 * A write of several items (a write-down, one presentRows call's rows, one
 * call's tombstones) is one record, through chronicle's
 * `appendManyToStateJsonWithIdentity`, which the store keeps or loses
 * whole; context-manager requires it (chronicle ^0.6.0) and has no
 * one-record-per-item path. Pre-release builds of the index, before
 * batched writes, wrote each item as one record, and the manager still
 * reads and finishes what those left: a write-down cut short without its
 * header, or a body partly in the window. The tests that pin that build
 * such an index by standing in for the batched append on a store handle
 * with one record per item (perItemIndexWrites).
 */

import type { JsStore } from '@animalabs/chronicle';

const BATCHED = 'appendManyToStateJsonWithIdentity';

/** Whether `store` appends several identity-stamped items as one record. */
export function batchesIndexWrites(store: JsStore): boolean {
  return typeof (store as unknown as Record<string, unknown>)[BATCHED] === 'function';
}

/**
 * Makes the window index write through `store`'s handle one record per
 * item, as pre-release builds of it did before batched writes, by standing
 * in for the handle's batched identity append with the single one, item by
 * item; returns the undo. A failed append partway leaves the items before
 * it written, as it did there, and a crash leaves what the store synced.
 * The stand-in answers with an ordinal no reading ends at, which the index
 * takes as a write it didn't see whole (as another handle's), so it reads
 * the items back from the store, each at its own record's sequence. Other
 * handles on the same store, such as a derived manager's view, keep the
 * batched form.
 */
export function perItemIndexWrites(store: JsStore): () => void {
  const handle = store as unknown as Record<string, unknown>;
  const own = Object.prototype.hasOwnProperty.call(handle, BATCHED);
  const was = handle[BATCHED];
  handle[BATCHED] = function (this: JsStore, stateId: string, items: unknown[], idField: string, sequenceField: string) {
    let record: ReturnType<JsStore['appendToStateJsonWithIdentity']> | undefined;
    for (const item of items) record = this.appendToStateJsonWithIdentity(stateId, item, idField, sequenceField);
    return { record, firstOrdinal: -1 };
  };
  return () => {
    if (own) handle[BATCHED] = was;
    else delete handle[BATCHED];
  };
}
