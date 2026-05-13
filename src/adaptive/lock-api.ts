/**
 * Set-only programmatic API for chunk locks.
 *
 * V1 ships no agent-facing tool, but strategy hosts (module developers
 * experimenting with content-aware policies) can lock/unlock chunks
 * programmatically via this API.
 *
 * See `docs/adaptive-resolution-design.md` §7 settled decisions #3.
 */

import type { ChunkId } from './folding-strategy.js';

/**
 * Minimal abstraction over a mutable chunk store.
 *
 * Real callers wire this to their `MessageStore` or to a chronicle slot;
 * tests can use a plain Map.
 */
export interface ChunkLockStore {
  setLocked(id: ChunkId, locked: boolean): void;
  isLocked(id: ChunkId): boolean;
}

/**
 * Lock a chunk so the picker won't change its resolution.
 * Set-only — there is no read API yet (use ChunkLockStore.isLocked directly).
 */
export function lockChunk(store: ChunkLockStore, id: ChunkId): void {
  store.setLocked(id, true);
}

/**
 * Unlock a chunk so the picker may again change its resolution on
 * subsequent compiles.
 */
export function unlockChunk(store: ChunkLockStore, id: ChunkId): void {
  store.setLocked(id, false);
}

/**
 * Simple in-memory ChunkLockStore for testing or for strategy hosts that
 * don't have their own persistence layer wired yet.
 */
export class InMemoryLockStore implements ChunkLockStore {
  private locks = new Set<ChunkId>();

  setLocked(id: ChunkId, locked: boolean): void {
    if (locked) this.locks.add(id);
    else this.locks.delete(id);
  }

  isLocked(id: ChunkId): boolean {
    return this.locks.has(id);
  }

  /** Snapshot of currently locked ids. Useful for tests. */
  snapshot(): readonly ChunkId[] {
    return Array.from(this.locks);
  }
}
