import type { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import type {
  MessageId,
  Sequence,
  MessageMetadata,
  StoredMessage,
  StoredMessageInternal,
  MessageStoreView,
  MessageQuery,
  MessageQueryResult,
  TimeRangeQueryOptions,
  ChannelQueryOptions,
  TimeAndChannelQueryOptions,
  IndexedMessageQueryResult,
  ChannelCount,
  ChannelTokenStats,
  ChannelTokenStatsOptions,
} from './types/index.js';
import { BlobManager } from './blob-manager.js';

const DEFAULT_MESSAGE_STATE_ID = 'messages';

/**
 * JSON-pointer field paths registered as native chronicle secondary indexes
 * on the message slot (see MessageStore.registerHistoryIndexes). Shared
 * constants so registration and every query call agree on the exact path.
 */
const TIMESTAMP_FIELD = '/timestamp';
const CHANNEL_FIELD = '/metadata/external/channelId';

/**
 * Thrown by the query-by-time/channel methods when the underlying chronicle
 * build predates the field-index capability (registerHistoryIndexes will
 * have silently skipped registration at construction in that case — see its
 * doc for why that's a silent skip rather than a throw). Unlike the
 * point-lookup/slice feature-detects elsewhere in this file, there is no
 * slow-scan fallback to degrade to here: a best-effort O(n)
 * re-implementation would defeat the entire point of this API (callers
 * reach for it specifically to avoid materializing/scanning the whole
 * store), so callers need to know up front they can't rely on it.
 */
const HISTORY_INDEX_UNSUPPORTED_MSG = 'Chronicle history index unsupported — update @animalabs/chronicle';

/**
 * Thrown when a native index query returns `null` twice in a row — once on
 * the original call, once again after a self-heal re-registration retry
 * (see queryIndexOrHeal). Distinct from HISTORY_INDEX_UNSUPPORTED_MSG:
 * that one means this chronicle build doesn't have the capability at all
 * (checked once, up front, by each call site's own typeof guard); this one
 * means the capability exists and the index WAS registered (at
 * construction, via registerHistoryIndexes) but chronicle is reporting it
 * as currently unqueryable — e.g. a cross-branch write on the same
 * `stateId` poisoned it (chronicle drops an index rather than mix two
 * branches' ordinals — see registerStateFieldIndex's doc in
 * node_modules/@animalabs/chronicle/index.d.ts), or a parse failure. A
 * single re-register-and-retry is chronicle's documented recovery path
 * (registerStateFieldIndex is idempotent/cheap-when-fresh and does a full
 * rebuild when needed); still-null after that means something is actually
 * wrong and callers need to know they can't rely on the fast path right
 * now, rather than silently getting an empty/degraded result.
 */
const HISTORY_INDEX_UNAVAILABLE_MSG = 'Chronicle history index unavailable (registered but not queryable — see logs)';

/**
 * Local mirrors of chronicle's JsIndexRangeQuery/JsIndexEqQuery (index.d.ts)
 * — a plain inline object type can't be self-referenced via `typeof` inside
 * a capability-checked method signature (TS2502), so these are named
 * separately instead of importing the chronicle types directly (this
 * package's chronicle dependency range doesn't guarantee they exist on
 * every install — see HISTORY_INDEX_UNSUPPORTED_MSG).
 */
interface NativeIndexRangeOpts {
  gte?: number;
  lte?: number;
  limit?: number;
  offset?: number;
  reverse?: boolean;
}
interface NativeIndexEqOpts {
  limit?: number;
  offset?: number;
}

/**
 * Cross-instance write versions, keyed by the shared JsStore object and
 * state id. Multiple MessageStore instances can share one JsStore (same
 * process only — the store LOCK forbids cross-process sharing), and the
 * cheap `getAllInternal` revalidation (item count + tail identity) cannot
 * see an EDIT of an earlier item made through a sibling instance: count
 * and tail are unchanged, so the first instance would serve stale content
 * (2026-07-25 review finding on the mythos-wedge ingest fix). Every
 * mutator bumps the shared version; the cache stores the version it was
 * built at and revalidates against it — O(1), and the quadratic-ingest fix
 * stays intact. WeakMap so stores never leak.
 */
const sharedWriteVersions = new WeakMap<object, Map<string, number>>();

function bumpWriteVersion(store: object, stateId: string): number {
  let m = sharedWriteVersions.get(store);
  if (!m) {
    m = new Map();
    sharedWriteVersions.set(store, m);
  }
  const next = (m.get(stateId) ?? 0) + 1;
  m.set(stateId, next);
  if (typeof process !== 'undefined' && process.env?.CM_CACHE_DIAG) {
    const site = (new Error().stack ?? '').split('\n')[2]?.trim();
    console.error(`[cm-cache] writeVersion bump ${stateId} → ${next} at ${site}`);
  }
  return next;
}

function currentWriteVersion(store: object, stateId: string): number {
  return sharedWriteVersions.get(store)?.get(stateId) ?? 0;
}

/** CM_CACHE_DIAG=1: log every materialization-cache miss with its REASON and
 *  cost, every invalidating mutation, and every write-through fallback. The
 *  full rebuild is ~20s of CPU on a large store on production hardware —
 *  a silent cache miss IS the latency incident (mythos, 2026-07-26). */
const CACHE_DIAG = typeof process !== 'undefined' && !!process.env?.CM_CACHE_DIAG;
function cacheDiag(msg: string): void {
  if (CACHE_DIAG) console.error(`[cm-cache] ${msg}`);
}

/**
 * Event emitted when the message store changes.
 */
export type MessageStoreEvent =
  | { type: 'add'; message: StoredMessage }
  | { type: 'edit'; messageId: MessageId; oldContent: ContentBlock[]; newContent: ContentBlock[] }
  | { type: 'remove'; messageId: MessageId }
  | { type: 'removeRange'; fromId: MessageId; toId: MessageId };

/**
 * Listener for message store events.
 */
export type MessageStoreListener = (event: MessageStoreEvent) => void;

/**
 * Options for windowed message reads.
 */
export interface MessageWindowOptions {
  /**
   * Re-inline blob media (images/documents) into content blocks, matching
   * the behavior of get()/getAll(). Default true. Viewers that only need
   * text/thinking/tool blocks should pass false to avoid inflating large
   * base64 payloads.
   */
  resolveBlobs?: boolean;
  /**
   * Extend the window edges outward so that no bodyGroup (shard run of a
   * single large message) is split across the window boundary. Default
   * false (exact offset/limit semantics).
   */
  alignToBodyGroups?: boolean;
}

/**
 * A window of messages plus enough metadata to page through the store.
 */
export interface MessageWindow {
  messages: StoredMessage[];
  /**
   * Actual first slot index of the returned window. May be lower than the
   * requested offset when alignToBodyGroups extended the window backward.
   */
  startIndex: number;
  /** Total number of messages in the store at read time. */
  totalCount: number;
}

/**
 * Options for token estimation.
 */
export interface TokenEstimatorOptions {
  /** Custom token estimator function */
  estimator?: (text: string) => number;
}

/**
 * Wrapper around Chronicle append_log state for message storage.
 * Handles blob extraction and provides a clean interface for message operations.
 */
export class MessageStore {
  private blobManager: BlobManager;
  private listeners: Set<MessageStoreListener> = new Set();
  private idToIndex: Map<MessageId, number> = new Map();
  private tokenEstimator: (text: string) => number;
  private stateId: string;

  constructor(
    private store: JsStore,
    options: TokenEstimatorOptions & {
      /** Namespace for multi-agent support. Creates state ID: `{namespace}/messages` */
      namespace?: string;
    } = {}
  ) {
    this.stateId = options.namespace
      ? `${options.namespace}/messages`
      : DEFAULT_MESSAGE_STATE_ID;
    this.blobManager = new BlobManager(store);
    this.tokenEstimator = options.estimator ?? defaultTokenEstimator;
    this.rebuildIndex();
    this.registerHistoryIndexes();
  }

  /**
   * Register the native chronicle secondary indexes that back
   * queryByTime/queryByChannel/queryByTimeAndChannel/getChannelCounts/
   * getChannelTokenStats: `/timestamp` (numeric) and
   * `/metadata/external/channelId` (string) on this store's message slot.
   *
   * Best-effort: `registerStateFieldIndex` is a NEW chronicle capability
   * (2026-09) that may not exist on an older `@animalabs/chronicle` install
   * — e.g. a resident whose native module hasn't been rebuilt/updated yet.
   * Feature-detected exactly like getStateItemJson/getStateSlice elsewhere
   * in this file: skip silently rather than throw, since registration is
   * purely a setup step. The query methods above throw a clear, specific
   * error if called against a store that never got indexes registered
   * (HISTORY_INDEX_UNSUPPORTED_MSG) — callers need to know they can't rely
   * on the fast path rather than have it silently degrade into a full scan
   * that would defeat the reason for calling it.
   *
   * Safe to call unconditionally on every construction (including every
   * sibling MessageStore sharing this JsStore): registration is idempotent
   * and cheap once the persisted index is fresh — chronicle checks the
   * slot's item count before doing any rebuild work.
   */
  private registerHistoryIndexes(): void {
    const s = this.store as {
      registerStateFieldIndex?: (stateId: string, field: string, kind: string) => void;
    };
    if (typeof s.registerStateFieldIndex !== 'function') return;
    s.registerStateFieldIndex(this.stateId, TIMESTAMP_FIELD, 'number');
    s.registerStateFieldIndex(this.stateId, CHANNEL_FIELD, 'string');
  }

  /**
   * Register the message store state in Chronicle.
   * Should be called once when setting up the store.
   *
   * @param store The Chronicle store
   * @param namespace Optional namespace for multi-agent support
   */
  static register(store: JsStore, namespace?: string): void {
    // fullSnapshotEvery counts DELTA snapshots, so a full snapshot fires
    // every deltaSnapshotEvery x fullSnapshotEvery appends — and for an
    // AppendLog it copies the ENTIRE history into the log. At the old
    // 50x10=500 cadence, a long-lived store spends most of its disk on
    // these copies (2026-08-01 Mythos: 5 full snapshots = 57% of the last
    // GB, 114 MB each). 50x100=5000 keeps reconstruction bounded while
    // cutting that dominant growth term 10x.
    //
    // NOTE: registrations persist in the store; changing these numbers
    // does nothing for existing stores by itself. ContextManager.open
    // catches the StateExists error and applies the same values via
    // updateStateStrategy (using registrationFor below).
    store.registerState(MessageStore.registrationFor(namespace));
  }

  /** Registration constants, shared with the update-on-existing-store path. */
  static registrationFor(namespace?: string): {
    id: string; strategy: 'append_log'; deltaSnapshotEvery: number; fullSnapshotEvery: number;
  } {
    return {
      id: namespace ? `${namespace}/messages` : DEFAULT_MESSAGE_STATE_ID,
      strategy: 'append_log',
      deltaSnapshotEvery: 50,
      fullSnapshotEvery: 100,
    };
  }

  /**
   * Add a listener for store events.
   */
  addListener(listener: MessageStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MessageStoreEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }


  private indexWriteVersion = -1;
  private indexBranch = '';

  /**
   * Id→index lookup that survives both sibling-instance writes and Chronicle
   * branch switches. Same-instance mutators maintain the index themselves and
   * stamp indexWriteVersion at their bump; a version the stamp hasn't seen
   * means a SIBLING MessageStore on this JsStore wrote. Branches can expose
   * different append-log shapes without changing that process-local version,
   * so branch name is an independent freshness key. Rebuild once, then
   * resolve. O(1) on every same-instance, same-branch path (2026-07-25 review
   * class: a stale index previously threw "Message not found" or, after
   * shifts, would have mutated or branched from the wrong item).
   */
  private lookupIndex(messageId: MessageId): number | undefined {
    if (
      this.indexBranch !== this.store.currentBranch().name ||
      this.indexWriteVersion !== currentWriteVersion(this.store, this.stateId)
    ) {
      this.rebuildIndex();
    }
    return this.idToIndex.get(messageId);
  }

  private rebuildIndex(): void {
    this.indexBranch = this.store.currentBranch().name;
    this.indexWriteVersion = currentWriteVersion(this.store, this.stateId);
    this.idToIndex.clear();
    const messages = this.getAllInternal();
    for (let i = 0; i < messages.length; i++) {
      this.idToIndex.set(messages[i].id, i);
    }
  }

  /**
   * Memo of the fully-materialized internal state (2026-07-18, sonn5 OOM /
   * CPU-churn class, companion to the BlobManager resolve cache).
   *
   * `getAllInternal()` is a full chronicle `getStateJson` — serde
   * serialize + JS parse of the ENTIRE message state. Compile calls it
   * ~6× per pass (postStripEstimates, getRecentWindowStart,
   * getHeadWindowEnd, getCompressibleMessages, selectAdaptive,
   * rebuildChunks), and compression catch-up repeats those passes
   * continuously: on a 19.5k-message store, perf showed the agent pinning
   * a full core in serde_json between LLM calls.
   *
   * Freshness tokens: (branch, head sequence) — with a cheap same-slot
   * revalidation for foreign-state writes — PLUS the process-wide
   * per-(store, stateId) write version (sharedWriteVersions above), which
   * makes edits/removals through SIBLING MessageStore instances visible:
   * count+tail revalidation alone cannot see an in-place edit of an
   * earlier item. (An instance-local counter was tried first and broke
   * multi-instance sharing — integration.test.ts Multi-Agent Namespacing;
   * the shared-map version is cross-instance by construction.)
   *
   * The cached array and its objects MUST be treated as immutable by all
   * callers. Strategy code copies before mutating (verified 2026-07-18:
   * window entries own their `content` pointers; collapseConsecutive
   * spreads; image cap/strip replace blocks rather than mutating).
   */
  private allCache: {
    branch: string;
    sequence: number;
    internals: StoredMessageInternal[];
    writeVersion: number;
  } | null = null;

  /**
   * Optional extra fields for `append`, used by callers that need to set
   * adaptive-resolution metadata (bodyGroupId for shards, initial
   * resolution state, etc.) at ingestion time.
   */
  static readonly _appendExtraKeys = ['bodyGroupId', 'shardIndex', 'currentResolution', 'lockedByAgent'] as const;

  /**
   * Append a new message to the store.
   *
   * `extra` is an optional bag of adaptive-resolution metadata
   * (bodyGroupId / shardIndex / currentResolution / lockedByAgent) that
   * callers may set at ingestion. Field semantics match StoredMessage.
   */
  append(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata,
    causedBy?: MessageId[],
    extra?: {
      bodyGroupId?: string;
      shardIndex?: number;
      currentResolution?: number;
      lockedByAgent?: boolean;
    }
  ): StoredMessage {
    // Extract blobs from content
    const storedContent = this.blobManager.extractBlobs(content);

    const partialInternal = {
      participant,
      content: storedContent,
      metadata,
      timestamp: Date.now(),
      causedBy,
      ...(extra ?? {}),
    };

    // Single atomic op: chronicle peeks the next record id+sequence under its
    // write lock, splices them into the payload as `id` and `sequence`, and
    // writes one record. The reconstructed state sees a fully-populated
    // StoredMessageInternal, and `branchAt(messageId)` forks at this
    // message's own sequence — exactly the post-fork-visible point.
    this.indexWriteVersion = bumpWriteVersion(this.store, this.stateId);
    const record = this.store.appendToStateJsonWithIdentity(
      this.stateId,
      partialInternal,
      'id',
      'sequence',
    );
    const index = this.length() - 1;

    const message: StoredMessage = {
      id: record.id,
      sequence: record.sequence,
      participant,
      content, // Original content with inline data
      metadata,
      timestamp: new Date(partialInternal.timestamp),
      causedBy,
      ...(extra ?? {}),
    };

    // Write-through: keep the materialized cache hot across appends.
    // Ingest-time rebuilds (rebuildChunks in the autobiographical strategy)
    // call getAll() on every new message; without write-through each append
    // invalidates the cache and forces a full state-slot re-materialization
    // — quadratic ingest (2026-07-25 mythos "wedge": ~10s/message at 13.5k
    // messages, event loop starved for hours by ambient traffic + backfill).
    //
    // The cached entry MUST be the chronicle round-trip (serde) form, not a
    // hand-built object: serde reorders keys and drops undefined fields, and
    // downstream request hashing stringifies message content — a shape that
    // differs between a warm cache and a fresh rebuild breaks hash-keyed
    // dedup (compression in-flight registry, quarantine keys). Fetch the
    // just-written record back through the point lookup; on chronicle
    // versions without it, fall back to plain invalidation (old behavior).
    const canPointLookup =
      typeof (this.store as { getStateItemJson?: unknown }).getStateItemJson === 'function';
    const canonical = canPointLookup ? this.getInternal(index) : null;
    if (
      canonical &&
      this.allCache &&
      this.allCache.branch === this.store.currentBranch().name &&
      this.allCache.internals.length === index
    ) {
      this.allCache.internals.push(canonical);
      this.allCache.sequence = this.store.currentSequence();
      // Stamp the post-append write version: this instance made the write,
      // and the cache now reflects it. Without this, the next getAllInternal
      // sees a version mismatch and full-rebuilds on EVERY append — the
      // quadratic ingest this write-through exists to prevent.
      this.allCache.writeVersion = currentWriteVersion(this.store, this.stateId);
    } else {
      if (this.allCache) {
        cacheDiag(
          `append write-through FAILED (${!canPointLookup ? 'no point lookup' : !canonical ? 'canonical null' : this.allCache.branch !== this.store.currentBranch().name ? 'branch mismatch' : `length mismatch cache=${this.allCache.internals.length} index=${index}`}) — cache dropped`,
        );
      }
      this.allCache = null;
    }

    this.idToIndex.set(message.id, index);
    this.emit({ type: 'add', message });
    return message;
  }

  /**
   * Edit a message's content.
   *
   * Throws if `messageId` belongs to a bodyGroup (i.e., is a shard of a
   * larger sharded message). Editing one shard would silently corrupt the
   * bodyGroup's byte-faithful reassembly invariant. To replace a sharded
   * message, remove the whole bodyGroup and re-append.
   */
  edit(messageId: MessageId, newContent: ContentBlock[]): void {
    const index = this.lookupIndex(messageId);
    if (index === undefined) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const oldMessage = this.getInternal(index);
    if (!oldMessage) {
      throw new Error(`Message not found at index: ${index}`);
    }

    if (oldMessage.bodyGroupId) {
      throw new Error(
        `Cannot edit shard ${messageId}: it is part of bodyGroup ${oldMessage.bodyGroupId}. ` +
          `Sharded messages are immutable — remove the whole bodyGroup and re-append instead.`,
      );
    }

    const oldContent = this.blobManager.resolveBlobs(oldMessage.content);
    const storedContent = this.blobManager.extractBlobs(newContent);

    // Update the stored message
    const updated: StoredMessageInternal = {
      ...oldMessage,
      content: storedContent,
    };

    this.indexWriteVersion = bumpWriteVersion(this.store, this.stateId);
    this.store.editStateItem(this.stateId, index, Buffer.from(JSON.stringify(updated)));

    // Write-through the materialized cache (see append — the cached entry
    // must be the chronicle round-trip form, so re-fetch it canonically).
    const canonicalEdit =
      typeof (this.store as { getStateItemJson?: unknown }).getStateItemJson === 'function'
        ? this.getInternal(index)
        : null;
    if (
      canonicalEdit &&
      this.allCache &&
      this.allCache.branch === this.store.currentBranch().name &&
      this.allCache.internals[index]
    ) {
      this.allCache.internals[index] = canonicalEdit;
      this.allCache.sequence = this.store.currentSequence();
    } else {
      this.allCache = null;
    }

    this.emit({ type: 'edit', messageId, oldContent, newContent });
  }

  /**
   * Remove a message from the store.
   *
   * For a sharded message (one shard of a bodyGroup), the caller MUST
   * remove all shards in the group together — removing one shard would
   * orphan the rest and break byte-faithful reassembly. Use
   * `removeBodyGroup(id)` for that case.
   */
  remove(messageId: MessageId): void {
    const index = this.lookupIndex(messageId);
    if (index === undefined) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const target = this.getInternal(index);
    if (target?.bodyGroupId) {
      throw new Error(
        `Cannot remove shard ${messageId} in isolation: it is part of bodyGroup ${target.bodyGroupId}. ` +
          `Use removeBodyGroup(${messageId}) to remove all shards atomically.`,
      );
    }

    this.indexWriteVersion = bumpWriteVersion(this.store, this.stateId);
    this.store.redactStateItems(this.stateId, index, index + 1);
    // Write-through the materialized cache (see append); fall back to
    // invalidation if the cache wasn't current.
    if (
      this.allCache &&
      this.allCache.branch === this.store.currentBranch().name &&
      this.allCache.internals.length === this.length() + 1
    ) {
      this.allCache.internals.splice(index, 1);
      this.allCache.sequence = this.store.currentSequence();
    } else {
      this.allCache = null;
    }
    this.rebuildIndex();

    this.emit({ type: 'remove', messageId });
  }

  /**
   * Remove every shard of the bodyGroup containing `messageId`. If the
   * message is not part of a bodyGroup, falls back to single-message
   * remove. Atomic from the caller's perspective.
   */
  removeBodyGroup(messageId: MessageId): void {
    const index = this.lookupIndex(messageId);
    if (index === undefined) {
      throw new Error(`Message not found: ${messageId}`);
    }
    const target = this.getInternal(index);
    if (!target?.bodyGroupId) {
      // Not sharded — defer to normal remove path (re-look up via getInternal
      // since the normal `remove` checks bodyGroupId).
      this.indexWriteVersion = bumpWriteVersion(this.store, this.stateId);
    this.store.redactStateItems(this.stateId, index, index + 1);
      this.allCache = null; // rare path: plain invalidation
      this.rebuildIndex();
      this.emit({ type: 'remove', messageId });
      return;
    }
    // Find the contiguous run of shards with this bodyGroupId. Shards are
    // stored consecutively (they're appended one after the other at
    // ingestion), so we can scan outward from `index`.
    const groupId = target.bodyGroupId;
    const all = this.getAllInternal();
    let from = index;
    while (from > 0 && all[from - 1].bodyGroupId === groupId) from--;
    let to = index;
    while (to + 1 < all.length && all[to + 1].bodyGroupId === groupId) to++;
    const firstId = all[from].id;
    const lastId = all[to].id;
    this.indexWriteVersion = bumpWriteVersion(this.store, this.stateId);
    this.store.redactStateItems(this.stateId, from, to + 1);
    this.allCache = null; // rare path: plain invalidation
    this.rebuildIndex();
    this.emit({ type: 'removeRange', fromId: firstId, toId: lastId });
  }

  /**
   * Remove a range of messages from the store.
   *
   * If the range starts or ends in the middle of a bodyGroup, throws —
   * removeRange must align to bodyGroup boundaries. (Use `removeBodyGroup`
   * to remove an entire group, then call `removeRange` over plain messages.)
   */
  removeRange(fromId: MessageId, toId: MessageId): void {
    const fromIndex = this.lookupIndex(fromId);
    const toIndex = this.lookupIndex(toId);

    if (fromIndex === undefined) {
      throw new Error(`Message not found: ${fromId}`);
    }
    if (toIndex === undefined) {
      throw new Error(`Message not found: ${toId}`);
    }

    // Verify the range doesn't bisect a bodyGroup.
    const all = this.getAllInternal();
    const startGroup = all[fromIndex].bodyGroupId;
    const endGroup = all[toIndex].bodyGroupId;
    if (startGroup && fromIndex > 0 && all[fromIndex - 1].bodyGroupId === startGroup) {
      throw new Error(
        `removeRange would bisect bodyGroup ${startGroup} at start. Use removeBodyGroup(${fromId}) first.`,
      );
    }
    if (endGroup && toIndex + 1 < all.length && all[toIndex + 1].bodyGroupId === endGroup) {
      throw new Error(
        `removeRange would bisect bodyGroup ${endGroup} at end. Use removeBodyGroup(${toId}) first.`,
      );
    }

    this.indexWriteVersion = bumpWriteVersion(this.store, this.stateId);
    this.store.redactStateItems(this.stateId, fromIndex, toIndex + 1);
    this.allCache = null; // rare path: plain invalidation
    this.rebuildIndex();

    this.emit({ type: 'removeRange', fromId, toId });
  }

  /**
   * Get a message by ID.
   */
  get(messageId: MessageId): StoredMessage | null {
    const index = this.lookupIndex(messageId);
    if (index === undefined) {
      return null;
    }

    const internal = this.getInternal(index);
    if (!internal) {
      return null;
    }

    return this.internalToStored(internal, messageId, index);
  }

  /**
   * Get a message as it was at a specific sequence (time travel).
   */
  getAt(messageId: MessageId, atSequence: Sequence): StoredMessage | null {
    // Get historical state
    const historicalState = this.store.getStateJsonAt(this.stateId, atSequence);
    if (!historicalState || !Array.isArray(historicalState)) {
      return null;
    }

    // Find the message in historical state
    for (let i = 0; i < historicalState.length; i++) {
      const internal = historicalState[i] as StoredMessageInternal;
      if (internal.id === messageId) {
        return this.internalToStored(internal, messageId, i);
      }
    }

    return null;
  }

  /**
   * Get all messages.
   */
  getAll(): StoredMessage[] {
    const internals = this.getAllInternal();
    // Reuse the mapped StoredMessage[] view when the store is unchanged. A
    // compile calls getAll() ~10-14x with no writes in between; rebuilding the
    // view (internalToStored + resolveBlobs + new Date() per message) each time
    // dominated large moves:0 compiles (Sol, 2026-07-31). Key on the same
    // freshness tokens as allCache: appends bump sequence, edits/redacts bump
    // the shared writeVersion, branch switches change branch — any of which
    // misses and rebuilds. The mapped array is immutable to callers, same as
    // getAllInternal's contract.
    const branch = this.store.currentBranch().name;
    const sequence = this.store.currentSequence();
    const writeVersion = currentWriteVersion(this.store, this.stateId);
    const c = this.allStoredCache;
    if (
      c &&
      c.branch === branch &&
      c.sequence === sequence &&
      c.writeVersion === writeVersion &&
      c.stored.length === internals.length
    ) {
      return c.stored;
    }
    const stored = internals.map((internal, i) =>
      this.internalToStored(internal, internal.id, i)
    );
    this.allStoredCache = { branch, sequence, writeVersion, stored };
    return stored;
  }

  /** Cached mapped view for getAll(), invalidated by the same freshness tokens
   *  as allCache (see getAll). */
  private allStoredCache: {
    branch: string;
    sequence: number;
    writeVersion: number;
    stored: StoredMessage[];
  } | null = null;

  /**
   * Get a window of messages by slot index — O(window), not O(all).
   *
   * Backed by chronicle's `getStateSlice` (0.2.2+) with a
   * full-materialization fallback for older chronicle copies, mirroring
   * the feature-detect in getInternal().
   */
  getWindow(offset: number, limit: number, opts: MessageWindowOptions = {}): MessageWindow {
    const totalCount = this.length();
    let start = Math.max(0, Math.min(offset, totalCount));
    let end = Math.min(start + Math.max(0, limit), totalCount);

    if (start >= end) {
      return { messages: [], startIndex: Math.min(start, totalCount), totalCount };
    }

    if (opts.alignToBodyGroups) {
      // Shards of a bodyGroup are contiguous by construction (removeRange
      // refuses to bisect a group). Walk edges outward with O(item) point
      // lookups until the group boundary.
      const first = this.getInternal(start);
      if (first?.bodyGroupId !== undefined) {
        while (start > 0) {
          const prev = this.getInternal(start - 1);
          if (prev?.bodyGroupId !== first.bodyGroupId) break;
          start--;
        }
      }
      const last = this.getInternal(end - 1);
      if (last?.bodyGroupId !== undefined) {
        while (end < totalCount) {
          const next = this.getInternal(end);
          if (next?.bodyGroupId !== last.bodyGroupId) break;
          end++;
        }
      }
    }

    const internals = this.getSliceInternal(start, end - start);
    const resolveBlobs = opts.resolveBlobs !== false;
    return {
      messages: internals.map((internal, i) =>
        this.internalToStored(internal, internal.id, start + i, resolveBlobs)
      ),
      startIndex: start,
      totalCount,
    };
  }

  /**
   * Get messages from a specific index.
   * Negative indices count from the end, matching Array.prototype.slice.
   */
  getFrom(index: number): StoredMessage[] {
    const len = this.length();
    const start = index < 0 ? Math.max(0, len + index) : Math.min(index, len);
    return this.getWindow(start, len - start).messages;
  }

  /**
   * Get the last N messages.
   */
  getTail(count: number): StoredMessage[] {
    const len = this.length();
    const n = Math.max(0, Math.min(count, len));
    return this.getWindow(len - n, n).messages;
  }

  /**
   * Get the total number of messages.
   */
  length(): number {
    return this.store.getStateLen(this.stateId) ?? 0;
  }

  /**
   * Estimate tokens for a message.
   */
  estimateTokens(message: StoredMessage): number {
    let tokens = 0;
    for (const block of message.content) {
      tokens += this.estimateBlockTokens(block);
    }
    return tokens;
  }

  /**
   * Closed-loop calibration multiplier applied to every estimate (default 1).
   * Owned by the strategy: it compares real `usage` totals against the
   * compile-time estimate and feeds the EMA back here, so the store's
   * numbers track the live model/content mix instead of a fixed heuristic.
   */
  private tokenCalibration = 1;

  setTokenCalibration(factor: number): void {
    if (Number.isFinite(factor) && factor > 0.25 && factor < 4) this.tokenCalibration = factor;
  }

  getTokenCalibration(): number {
    return this.tokenCalibration;
  }

  /**
   * Hidden-CoT price for a signed thinking block whose text was summarized/
   * redacted away (2026-07-12): the block estimates as EMPTY client-side, but
   * signed replay bills the FULL original chain of thought. Measured on
   * mythos production turns: median ~608 tokens/block, mean ~590, p90 ~1210.
   * A per-block `tokenEstimate` stamped at creation (from usage residuals)
   * takes precedence; this constant is the fallback for unstamped history.
   */
  static readonly HIDDEN_THINKING_TOKENS_DEFAULT = 600;

  /**
   * Billed-token rate for encrypted reasoning carriers (`redacted_thinking`
   * blocks round-tripped to OpenAI Responses as `reasoning.encrypted_content`).
   * The ciphertext is base64 over an encrypted serialization of the CoT, so
   * blob length tracks billed tokens at a higher chars/token rate than prose.
   * Measured on Sol (gpt-5.6, 2026-07-18) by regressing real `input_tokens`
   * against request content across 12 production calls: residual attributable
   * to carriers = blob_chars / 5.4..8.6, median ~6. With this rate the total
   * estimate lands within ±5% of billed input on every sampled call; with the
   * previous behavior (carriers priced at 0) estimates missed by 23k-75k
   * tokens per call and drove the calibration EMA into a 0.7↔1.5 limit cycle.
   */
  static readonly ENCRYPTED_CARRIER_CHARS_PER_TOKEN = 6;

  /** Per-block cache of the raw (calibration-independent) estimate. */
  private _rawBlockTokens = new WeakMap<ContentBlock, number>();

  private estimateBlockTokens(block: ContentBlock): number {
    return Math.round(this.estimateBlockTokensRaw(block) * this.tokenCalibration);
  }

  /** Cached wrapper for the raw per-block estimate. Keyed on the block object:
   *  blocks are immutable once stored (callers copy before mutating — see the
   *  allCache immutability note), so the same block reused across a compile's
   *  3-4 estimation passes is computed once; edits/redacts produce new block
   *  objects, so the WeakMap auto-invalidates. Calibration is applied on top in
   *  estimateBlockTokens, so cached raw values survive calibration changes.
   *  Removes the repeated JSON.stringify(tool_use.input) / tool_result content
   *  walks that dominated moves:0 compiles at scale (Sol, 2026-07-31). */
  private estimateBlockTokensRaw(block: ContentBlock): number {
    const cached = this._rawBlockTokens.get(block);
    if (cached !== undefined) return cached;
    const raw = this.computeBlockTokensRaw(block);
    this._rawBlockTokens.set(block, raw);
    return raw;
  }

  private computeBlockTokensRaw(block: ContentBlock): number {
    switch (block.type) {
      case 'text':
        return this.tokenEstimator(block.text);
      case 'thinking': {
        // Stamped price wins; a signed-but-empty block is a HIDDEN full CoT
        // (never "no thinking") — price it at the measured default.
        const stamped = (block as { tokenEstimate?: number }).tokenEstimate;
        if (typeof stamped === 'number') return stamped;
        const hasSignature =
          typeof (block as { signature?: string }).signature === 'string' &&
          ((block as { signature?: string }).signature as string).length > 0;
        if (hasSignature && (!block.thinking || block.thinking.length === 0)) {
          return MessageStore.HIDDEN_THINKING_TOKENS_DEFAULT;
        }
        return this.tokenEstimator(block.thinking);
      }
      case 'redacted_thinking': {
        // Encrypted reasoning carrier: billed in full when replayed. A per-
        // block `tokenEstimate` stamped from usage residuals wins; otherwise
        // price the ciphertext at the measured carrier rate. NEVER 0 — an
        // unpriced carrier population made real/est bimodal and see-sawed the
        // calibration multiplier (see ENCRYPTED_CARRIER_CHARS_PER_TOKEN).
        const stamped = (block as { tokenEstimate?: number }).tokenEstimate;
        if (typeof stamped === 'number') return stamped;
        const data = (block as { data?: string }).data;
        if (typeof data === 'string' && data.length > 0) {
          return Math.round(data.length / MessageStore.ENCRYPTED_CARRIER_CHARS_PER_TOKEN);
        }
        return MessageStore.HIDDEN_THINKING_TOKENS_DEFAULT;
      }
      case 'tool_use':
        return jsonTokenEstimator(JSON.stringify(block.input)) + 20; // overhead for name, id
      case 'tool_result':
        if (!block.content) return 0;
        if (typeof block.content === 'string') {
          return jsonTokenEstimator(block.content);
        }
        if (Array.isArray(block.content)) {
          return block.content.reduce((sum, b) => sum + this.estimateBlockTokensRaw(b), 0);
        }
        return 0;
      case 'image':
        return block.tokenEstimate ?? 1600; // ~1568px image ≈ 1600 tokens (Anthropic)
      case 'document':
      case 'audio':
      case 'video':
        return 1000; // Default estimate for media
      default:
        return 0;
    }
  }

  /**
   * Create a read-only view of the store for strategies.
   */
  createView(): MessageStoreView {
    return {
      getAll: () => this.getAll(),
      get: (id) => this.get(id),
      getFrom: (index) => this.getFrom(index),
      getTail: (count) => this.getTail(count),
      length: () => this.length(),
      setTokenCalibration: (f: number) => this.setTokenCalibration(f),
      getTokenCalibration: () => this.getTokenCalibration(),
      estimateTokens: (msg) => this.estimateTokens(msg),
    };
  }

  /**
   * Query messages by filter criteria.
   * Useful for finding messages from external sources, by participant, etc.
   */
  query(filter: MessageQuery): MessageQueryResult {
    let messages = this.getAll();
    let totalCount = 0;

    // Apply filters
    const filtered: StoredMessage[] = [];
    for (const msg of messages) {
      if (this.matchesFilter(msg, filter)) {
        filtered.push(msg);
      }
    }

    totalCount = filtered.length;

    // Apply reverse if requested
    let result = filter.reverse ? filtered.reverse() : filtered;

    // Apply limit if specified
    if (filter.limit !== undefined && filter.limit < result.length) {
      result = result.slice(0, filter.limit);
    }

    return { messages: result, totalCount };
  }

  /**
   * Find a message by external source and ID.
   * Convenience method for common lookup pattern.
   */
  findByExternalId(source: string, externalId: string): StoredMessage | null {
    const result = this.query({
      source,
      externalIds: [externalId],
      limit: 1,
    });
    return result.messages[0] ?? null;
  }

  /**
   * Re-register a single field index — the self-heal step `queryIndexOrHeal`
   * takes on a `null` result, after `registerHistoryIndexes` already
   * registered both indexes at construction. `registerStateFieldIndex` is
   * documented idempotent/cheap when the persisted index is already fresh,
   * and does a full rebuild when it isn't (e.g. after the cross-branch
   * poisoning `queryStateIndexRange`'s doc describes) — so re-calling it
   * with the exact same `(stateId, field, kind)` is chronicle's own
   * prescribed recovery path, not a guess. No-ops defensively if the
   * capability has vanished entirely, same as registerHistoryIndexes
   * (shouldn't happen — queryIndexOrHeal is only reached after the caller's
   * own typeof guard on the sibling query method already passed, and the
   * two capabilities land together in one chronicle release).
   */
  private reregisterHistoryIndex(field: string, kind: 'number' | 'string'): void {
    const s = this.store as {
      registerStateFieldIndex?: (stateId: string, field: string, kind: string) => void;
    };
    if (typeof s.registerStateFieldIndex !== 'function') return;
    s.registerStateFieldIndex(this.stateId, field, kind);
  }

  /**
   * Run a native index query that can report `null` — "no such index
   * currently registered" (unregistered, wrong kind, or poisoned by a
   * cross-branch write / parse failure — see queryStateIndexRange's doc) —
   * distinct from an empty array, which is a real "no matches" result and
   * must pass through untouched.
   *
   * Since `registerHistoryIndexes` already registered this index at
   * construction, a `null` here means something disturbed it since. Self-
   * heal: re-register (reregisterHistoryIndex) and retry the query exactly
   * once. If it's STILL `null`, the index is unusable right now — throw
   * HISTORY_INDEX_UNAVAILABLE_MSG rather than let a `null` silently reach
   * `.map()`/`.length` downstream (the bug this helper exists to prevent).
   */
  private queryIndexOrHeal<T>(query: () => T | null, field: string, kind: 'number' | 'string'): T {
    const first = query();
    if (first !== null) return first;
    this.reregisterHistoryIndex(field, kind);
    const second = query();
    if (second !== null) return second;
    throw new Error(HISTORY_INDEX_UNAVAILABLE_MSG);
  }

  /**
   * Capability-checked wrapper over the native numeric-range query call
   * against the `/timestamp` field index. Throws HISTORY_INDEX_UNSUPPORTED_MSG
   * if this chronicle build never has the capability at all (see
   * registerHistoryIndexes); throws HISTORY_INDEX_UNAVAILABLE_MSG if the
   * capability exists but the specific index can't be queried right now
   * even after a self-heal retry (see queryIndexOrHeal). Returns ordinals
   * only — content is fetched separately via ordinalsToMessages.
   */
  private queryTimestampOrdinals(opts: NativeIndexRangeOpts): number[] {
    const s = this.store as {
      queryStateIndexRange?: (stateId: string, field: string, opts: NativeIndexRangeOpts) => number[] | null;
    };
    if (typeof s.queryStateIndexRange !== 'function') {
      throw new Error(HISTORY_INDEX_UNSUPPORTED_MSG);
    }
    return this.queryIndexOrHeal(
      () => s.queryStateIndexRange!(this.stateId, TIMESTAMP_FIELD, opts),
      TIMESTAMP_FIELD,
      'number',
    );
  }

  /**
   * Capability-checked wrapper over the native equality query call against
   * the `/metadata/external/channelId` field index. Same throw/ordinal-only
   * contract as queryTimestampOrdinals (including the UNSUPPORTED vs
   * UNAVAILABLE distinction and the self-heal retry).
   */
  private queryChannelOrdinals(channelId: string, opts: NativeIndexEqOpts): number[] {
    const s = this.store as {
      queryStateIndexEq?: (stateId: string, field: string, value: string, opts: NativeIndexEqOpts) => number[] | null;
    };
    if (typeof s.queryStateIndexEq !== 'function') {
      throw new Error(HISTORY_INDEX_UNSUPPORTED_MSG);
    }
    return this.queryIndexOrHeal(
      () => s.queryStateIndexEq!(this.stateId, CHANNEL_FIELD, channelId, opts),
      CHANNEL_FIELD,
      'string',
    );
  }

  /**
   * Fetch content for a set of slot ordinals (as returned by the native
   * index queries above) via point lookups — never materializes the whole
   * slot for this. Preserves the input order. An ordinal that no longer
   * resolves (e.g. a redact raced this read) is skipped rather than
   * thrown, matching this file's other defensive-read behavior.
   */
  private ordinalsToMessages(ordinals: number[]): StoredMessage[] {
    const out: StoredMessage[] = [];
    for (const ordinal of ordinals) {
      const internal = this.getInternal(ordinal);
      if (!internal) continue;
      out.push(this.internalToStored(internal, internal.id, ordinal));
    }
    return out;
  }

  /**
   * Query messages by timestamp range — O(log n + k) via the native
   * `/timestamp` index, not a full scan. Both bounds are inclusive; either
   * (or both) may be omitted for an open-ended range.
   *
   * `matchedCount` here is just the returned page's size (`limit`/`offset`
   * are applied natively, inside chronicle, before the ordinals ever cross
   * the NAPI boundary) — NOT a store-wide total match count. Getting a true
   * total would require a second, unbounded native call; queryByTime
   * intentionally avoids that extra cost since most callers page through
   * results and don't need it. Contrast with queryByTimeAndChannel, which
   * already has the full matched set in hand and reports a true total.
   */
  queryByTime(opts: TimeRangeQueryOptions): IndexedMessageQueryResult {
    const ordinals = this.queryTimestampOrdinals({
      gte: opts.fromMs,
      lte: opts.toMs,
      limit: opts.limit,
      offset: opts.offset,
      reverse: opts.reverse,
    });
    return { messages: this.ordinalsToMessages(ordinals), matchedCount: ordinals.length };
  }

  /**
   * Query messages by exact channel id — O(1) hash lookup + O(k) via the
   * native `/metadata/external/channelId` index. A message with no
   * channelId (system/autobio-injected messages, etc.) is never indexed
   * for this field (see field_index.rs's `extract_indexed_value`: a
   * missing/wrong-type field extracts to `None`, not the string
   * `"undefined"`), so it can never match here.
   *
   * Same `matchedCount`-is-page-size caveat as queryByTime.
   */
  queryByChannel(channelId: string, opts: ChannelQueryOptions = {}): IndexedMessageQueryResult {
    const ordinals = this.queryChannelOrdinals(channelId, opts);
    return { messages: this.ordinalsToMessages(ordinals), matchedCount: ordinals.length };
  }

  /**
   * Query messages matching BOTH a timestamp range and a channel. With only
   * one filter given, delegates to queryByTime/queryByChannel above
   * (including their page-size-only `matchedCount`).
   *
   * With BOTH given, this can NOT just pass limit/offset into either native
   * call and filter the resulting page by the other criterion — that
   * paginates against the wrong universe. (Example: page 2 of "channel X in
   * the last hour" needs page 2 of the INTERSECTION of the two filters; a
   * channel-only page 2 filtered down to the last hour would both drop
   * legitimate matches that landed outside that page's channel-only
   * position and include none of the matches that landed on channel-only
   * pages 3+.) The only correct approach is to fetch the FULL, uncapped
   * ordinal set from BOTH native queries — cheap, since these are plain
   * integer arrays, not content — intersect them, and only THEN apply
   * limit/offset to the intersection. This also means, unlike
   * queryByTime/queryByChannel, we already hold the true total match count
   * before slicing, so `matchedCount` here is exact, not page-size-only.
   */
  queryByTimeAndChannel(opts: TimeAndChannelQueryOptions): IndexedMessageQueryResult {
    const hasTime = opts.fromMs !== undefined || opts.toMs !== undefined;
    const hasChannel = opts.channelId !== undefined;

    if (hasChannel && !hasTime) {
      return this.queryByChannel(opts.channelId as string, { limit: opts.limit, offset: opts.offset });
    }
    if (hasTime && !hasChannel) {
      return this.queryByTime({ fromMs: opts.fromMs, toMs: opts.toMs, limit: opts.limit, offset: opts.offset });
    }
    if (!hasTime && !hasChannel) {
      // No filters at all: degenerate case, same shape as an unbounded
      // queryByTime.
      return this.queryByTime({ limit: opts.limit, offset: opts.offset });
    }

    const rangeOrdinals = this.queryTimestampOrdinals({ gte: opts.fromMs, lte: opts.toMs });
    const channelOrdinalSet = new Set(this.queryChannelOrdinals(opts.channelId as string, {}));
    // Intersect, then re-sort ascending: rangeOrdinals comes back sorted by
    // TIMESTAMP VALUE (not necessarily ordinal, if two messages ever share a
    // timestamp or a timestamp were edited out of append order), so a plain
    // filter() would inherit that value order instead of a stable,
    // index-ascending page order. Sorting here keeps pagination
    // deterministic and matches queryByTime/queryByChannel's default
    // (non-reverse) ordinal-ascending order.
    const intersected = rangeOrdinals.filter((o) => channelOrdinalSet.has(o)).sort((a, b) => a - b);

    const start = Math.max(0, Math.min(opts.offset ?? 0, intersected.length));
    const end =
      opts.limit !== undefined
        ? Math.min(start + Math.max(0, opts.limit), intersected.length)
        : intersected.length;

    return { messages: this.ordinalsToMessages(intersected.slice(start, end)), matchedCount: intersected.length };
  }

  /**
   * Distinct channel ids and their message counts — thin wrapper over the
   * native `/metadata/external/channelId` value-count index.
   * O(index size), no content decoding. Messages with no channelId are
   * unindexed for this field (see queryByChannel's doc) and so never
   * appear here — they are excluded, not folded into some `"undefined"`
   * bucket.
   */
  getChannelCounts(): ChannelCount[] {
    const s = this.store as {
      getStateIndexValueCounts?: (stateId: string, field: string) => Array<{ value: string; count: number }> | null;
    };
    if (typeof s.getStateIndexValueCounts !== 'function') {
      throw new Error(HISTORY_INDEX_UNSUPPORTED_MSG);
    }
    const counts = this.queryIndexOrHeal(
      () => s.getStateIndexValueCounts!(this.stateId, CHANNEL_FIELD),
      CHANNEL_FIELD,
      'string',
    );
    return counts.map((vc) => ({ channelId: vc.value, messages: vc.count }));
  }

  /**
   * Per-ordinal cache for getChannelTokenStats, keyed by ordinal (branch
   * identity is tracked separately — see tokenStatsCacheBranch — rather
   * than folded into the key, since this cache is cheap enough to just
   * wipe wholesale on a branch change instead of carrying dead entries for
   * branches no longer in use).
   *
   * Caches the RAW (calibration-independent) token estimate — mirroring
   * the estimateBlockTokensRaw/estimateBlockTokens split above — NOT the
   * calibrated one. `estimateTokens` bakes in the mutable
   * `tokenCalibration` multiplier (see setTokenCalibration), and caching
   * ITS output would freeze each entry at whatever calibration was in
   * effect when first computed — silently mixing calibration generations
   * within one aggregate response, since `setTokenCalibration` is called
   * during normal operation (the autobiographical strategy's closed-loop
   * calibration), not just in synthetic tests. Calibration is applied at
   * READ time instead (see getChannelTokenStats), so every entry always
   * reflects the CURRENT calibration with no invalidation needed when it
   * changes.
   *
   * `channelId: undefined` means "looked up, has no (valid string)
   * channel" (still cached, so a range full of unchanneled messages
   * doesn't get re-decoded every call) as distinct from "not yet looked
   * up" (absent from the map). A non-string channelId value (`null`, a
   * number, …) is normalized to `undefined` here too — see
   * extractChannelId — matching chronicle's native String-kind field
   * index, which silently excludes non-string values rather than exposing
   * them as their own bucket (so byChannel never disagrees with
   * getChannelCounts about which messages are "channeled").
   *
   * There is no native token-estimate index — token estimation isn't a
   * field that exists on stored messages (see the design plan's "Scope
   * decision": indexing it natively would mean either rewriting every
   * historical message to stamp a field that predates the feature, or
   * leaving the index blank for all existing history; neither is
   * acceptable). This cache amortizes the one genuinely expensive part —
   * decoding content (blob resolution) and running raw token estimation —
   * across repeated getChannelTokenStats calls over overlapping ranges,
   * filled lazily only for ordinals actually requested.
   *
   * KNOWN SIMPLIFICATION, not a bug: entries are never evicted or
   * write-through'd on edit/remove within a branch — each entry is two
   * tiny scalars, not message content, so this stays cheap even at
   * hundreds of thousands of messages, nothing like the content-bearing
   * allCache this file guards so carefully elsewhere. Acceptable for a
   * stats/reporting API; revisit if a caller ever needs exactness across
   * live edits.
   */
  private tokenStatsCache = new Map<number, { channelId: string | undefined; rawTokenEstimate: number }>();

  /**
   * Branch this cache was last warmed on — checked and enforced at the top
   * of getChannelTokenStats. Ordinals are branch-relative (chronicle's
   * native `/timestamp`/`/metadata/external/channelId` field indexes are
   * branch-aware and self-heal across a `switchBranch` as of chronicle
   * 0.4.0), so a cached ordinal→message mapping from one branch isn't just
   * STALE on another, it's WRONG: a diverged branch can reuse the exact
   * same ordinal for a completely different message. Wholesale-cleared on
   * any detected branch change, mirroring lookupIndex/rebuildIndex's
   * existing indexBranch pattern elsewhere in this file (comparing a
   * tracked branch name against `store.currentBranch().name`) rather than
   * keying every cache entry by branch.
   */
  private tokenStatsCacheBranch = '';

  /**
   * Runtime-validated channelId extraction for the token-stats cache: the
   * TS cast on `metadata.external` only asserts a shape at compile time,
   * it never checks the actual runtime value, so a `null`/number/etc.
   * channelId would otherwise leak through as a truthy-looking
   * `!== undefined` bucket key in getChannelTokenStats.byChannel — a
   * result the exported `{ channelId: string }` type doesn't even allow.
   * Chronicle's native `/metadata/external/channelId` index is
   * String-kind and silently excludes non-string values (see
   * field_index.rs's `extract_indexed_value`); this matches that so
   * getChannelTokenStats never disagrees with getChannelCounts about
   * which messages are "channeled".
   */
  private extractChannelId(internal: StoredMessageInternal): string | undefined {
    const external = internal.metadata?.external as { channelId?: unknown } | undefined;
    return typeof external?.channelId === 'string' ? external.channelId : undefined;
  }

  /**
   * Aggregate message counts and token estimates by channel, optionally
   * restricted to a timestamp range. `totalMessages`/`totalTokensEstimate`
   * cover EVERY message in range, channeled or not; `byChannel` breaks down
   * only the ones that have a valid string channelId (so its entries'
   * `messages` sum to <= totalMessages when unchanneled or non-string-
   * channel messages exist in range).
   *
   * Structural filtering rides the native `/timestamp` index (same call as
   * queryByTime, unbounded — every matching ordinal is relevant to the
   * aggregate, so no limit/offset here). Token estimates are computed
   * client-side via the existing raw block-estimation machinery (no native
   * token index — see tokenStatsCache's doc) and cached per-ordinal RAW
   * across calls, with the CURRENT calibration multiplier applied here at
   * read time — see tokenStatsCache's doc for why.
   */
  getChannelTokenStats(opts: ChannelTokenStatsOptions = {}): ChannelTokenStats {
    // Branch-scope the cache before touching it (see tokenStatsCacheBranch):
    // a stale-branch cache is not just outdated but wrong (ordinal reuse
    // across diverged branches), so this must be a hard wipe, not a lazy
    // per-entry revalidation.
    const currentBranch = this.store.currentBranch().name;
    if (currentBranch !== this.tokenStatsCacheBranch) {
      this.tokenStatsCache.clear();
      this.tokenStatsCacheBranch = currentBranch;
    }

    const ordinals = this.queryTimestampOrdinals({ gte: opts.fromMs, lte: opts.toMs });

    const byChannel = new Map<string, { messages: number; tokensEstimate: number }>();
    let totalMessages = 0;
    let totalTokensEstimate = 0;

    for (const ordinal of ordinals) {
      let cached = this.tokenStatsCache.get(ordinal);
      if (!cached) {
        const internal = this.getInternal(ordinal);
        if (!internal) continue; // stale ordinal (e.g. raced a redact); skip rather than throw
        const channelId = this.extractChannelId(internal);
        // Resolve blobs: an un-resolved blob_ref block has no raw estimate
        // of its own and would silently price as 0, undercounting any
        // message carrying inline media — resolveBlobs:true matches how
        // estimateTokens is used everywhere else in this file (getAll()'s
        // default).
        const stored = this.internalToStored(internal, internal.id, ordinal, true);
        const rawTokenEstimate = stored.content.reduce(
          (sum, block) => sum + this.estimateBlockTokensRaw(block),
          0,
        );
        cached = { channelId, rawTokenEstimate };
        this.tokenStatsCache.set(ordinal, cached);
      }
      // Calibration applied HERE, every call, from the cached raw value —
      // never baked into the cached number itself (see tokenStatsCache's
      // doc). Matches estimateBlockTokens' own round(raw * calibration).
      const tokenEstimate = Math.round(cached.rawTokenEstimate * this.tokenCalibration);
      totalMessages++;
      totalTokensEstimate += tokenEstimate;
      if (cached.channelId !== undefined) {
        const agg = byChannel.get(cached.channelId) ?? { messages: 0, tokensEstimate: 0 };
        agg.messages++;
        agg.tokensEstimate += tokenEstimate;
        byChannel.set(cached.channelId, agg);
      }
    }

    return {
      totalMessages,
      totalTokensEstimate,
      byChannel: Array.from(byChannel.entries()).map(([channelId, agg]) => ({
        channelId,
        messages: agg.messages,
        tokensEstimate: agg.tokensEstimate,
      })),
    };
  }

  /**
   * Check if a message matches the query filter.
   */
  private matchesFilter(msg: StoredMessage, filter: MessageQuery): boolean {
    // Filter by source
    if (filter.source !== undefined) {
      const external = msg.metadata?.external as { source?: string } | undefined;
      if (external?.source !== filter.source) {
        return false;
      }
    }

    // Filter by external IDs
    if (filter.externalIds !== undefined && filter.externalIds.length > 0) {
      const external = msg.metadata?.external as { id?: string } | undefined;
      if (!external?.id || !filter.externalIds.includes(external.id)) {
        return false;
      }
    }

    // Filter by participant
    if (filter.participant !== undefined) {
      if (msg.participant !== filter.participant) {
        return false;
      }
    }

    // Filter by metadata fields
    if (filter.metadata !== undefined) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        const actual = this.getNestedValue(msg.metadata, key);
        if (actual !== value) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Get a nested value from an object using dot notation.
   * e.g., getNestedValue(obj, 'external.channelId')
   */
  private getNestedValue(obj: unknown, path: string): unknown {
    if (obj === undefined || obj === null) {
      return undefined;
    }

    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === undefined || current === null || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  private getAllInternal(): StoredMessageInternal[] {
    const branch = this.store.currentBranch().name;
    const sequence = this.store.currentSequence();
    const writeVersion = currentWriteVersion(this.store, this.stateId);
    let missReason = 'no-cache';
    if (this.allCache) {
      missReason =
        this.allCache.branch !== branch
          ? `branch ${this.allCache.branch}→${branch}`
          : this.allCache.writeVersion !== writeVersion
            ? `writeVersion ${this.allCache.writeVersion}→${writeVersion}`
            : 'revalidate-fail';
    }
    if (this.allCache && this.allCache.branch === branch && this.allCache.writeVersion === writeVersion) {
      if (this.allCache.sequence === sequence) {
        return this.allCache.internals;
      }
      // The store-global sequence moved, but that may be writes to OTHER
      // state slots (summaries, autobio resolutions, framework/state, …).
      // All in-process mutations of THIS state flow through the mutators
      // above, which write through or invalidate the cache explicitly — so
      // if the messages slot still has the same item count and the same
      // last record id, the cached array is current: re-stamp, don't
      // re-materialize. (A full re-materialization here on every foreign
      // append made ingest quadratic — 2026-07-25 mythos wedge.)
      // Feature-detect getStateItemJson (chronicle >= 0.2.2): the fallback
      // inside getInternal() is getAllInternal() itself — calling it here
      // on an older chronicle would recurse. No point lookup → no cheap
      // revalidation → keep the old full-rebuild behavior.
      const canPointLookup =
        typeof (this.store as { getStateItemJson?: unknown }).getStateItemJson === 'function';
      const count = canPointLookup ? this.length() : -1;
      if (count === this.allCache.internals.length) {
        if (count === 0) {
          this.allCache.sequence = sequence;
          return this.allCache.internals;
        }
        const lastCached = this.allCache.internals[count - 1];
        const lastLive = this.getInternal(count - 1);
        if (
          lastCached &&
          lastLive &&
          lastLive.id === lastCached.id &&
          lastLive.sequence === lastCached.sequence
        ) {
          this.allCache.sequence = sequence;
          return this.allCache.internals;
        }
        missReason = `revalidate-fail last-item (cached ${lastCached?.id}/${lastCached?.sequence} live ${lastLive?.id}/${lastLive?.sequence})`;
      } else {
        missReason = `revalidate-fail count (cached ${this.allCache.internals.length} live ${count}${canPointLookup ? '' : ', no point lookup'})`;
      }
    }
    const _t = CACHE_DIAG ? Date.now() : 0;
    const state = this.store.getStateJson(this.stateId);
    const internals =
      !state || !Array.isArray(state) ? [] : (state as StoredMessageInternal[]);
    this.allCache = { branch, sequence, internals, writeVersion };
    cacheDiag(`getAllInternal MISS (${missReason}) stateId=${this.stateId} rebuilt ${internals.length} in ${Date.now() - _t}ms`);
    return internals;
  }

  private getSliceInternal(offset: number, limit: number): StoredMessageInternal[] {
    // Windowed read — O(window) JSON conversion instead of materializing
    // the entire state slot. getStateSlice landed in chronicle 0.2.2 and
    // returns the window as a JSON-array Buffer; feature-detect so boxes
    // on <= 0.2.1 fall back to full materialization (same pattern as
    // getInternal below).
    const s = this.store as { getStateSlice?: (id: string, offset: number, limit: number) => Buffer | null };
    if (typeof s.getStateSlice === 'function') {
      const buf = s.getStateSlice(this.stateId, offset, limit);
      if (!buf) return [];
      return JSON.parse(buf.toString('utf-8')) as StoredMessageInternal[];
    }
    return this.getAllInternal().slice(offset, offset + limit);
  }

  private getInternal(index: number): StoredMessageInternal | null {
    // Point lookup through chronicle's per-item cache — O(item size).
    // Never fetch the full state for a single index: with a 4.6k-message
    // session, each full `getStateJson` materialization cost ~15ms, and
    // per-entry get() loops turned renders into minutes (observed on
    // Lena, 2026-07-02, /debug/context at 51–108s).
    //
    // Feature-detect: getStateItemJson landed in chronicle 0.2.2; boxes
    // still on <= 0.2.1 (npm copies) fall back to the full-materialization
    // path so a routine `git pull` of this package can never crash them.
    if (typeof (this.store as { getStateItemJson?: unknown }).getStateItemJson === 'function') {
      const item = this.store.getStateItemJson(this.stateId, index);
      return (item as StoredMessageInternal | null) ?? null;
    }
    const all = this.getAllInternal();
    return all[index] ?? null;
  }

  private internalToStored(
    internal: StoredMessageInternal,
    id: MessageId,
    _index: number,
    resolveBlobs: boolean = true,
  ): StoredMessage {
    const stored: StoredMessage = {
      id,
      // chronicle record sequence captured when the message was appended
      // (see `add()` line 131: `sequence: record.sequence`). The previous
      // implementation returned the slot index ("// Use index as sequence
      // for now"), which silently corrupted any downstream code that
      // forwarded this number to chronicle APIs expecting a real sequence
      // — most notably `ContextManager.branchAt`, which would fork the
      // chronicle at the index-mistaken-for-sequence and lose every
      // record between the intended fork point and the actual one. For
      // typical autobio sessions the index-vs-sequence ratio is ~1:2
      // (each message append is accompanied by ~1 autobio state update),
      // so /undo of a 800-message conversation forked ~400 messages back.
      sequence: internal.sequence,
      participant: internal.participant,
      // When resolveBlobs is false, blob_ref placeholder blocks are passed
      // through un-inflated (StoredContentBlock ⊂ wire-safe superset of
      // ContentBlock for viewer purposes).
      content: resolveBlobs
        ? this.blobManager.resolveBlobs(internal.content)
        : (internal.content as unknown as ContentBlock[]),
      metadata: internal.metadata,
      timestamp: new Date(internal.timestamp),
      causedBy: internal.causedBy,
    };
    // Carry adaptive-resolution fields through unchanged.
    if (internal.bodyGroupId !== undefined) stored.bodyGroupId = internal.bodyGroupId;
    if (internal.shardIndex !== undefined) stored.shardIndex = internal.shardIndex;
    if (internal.currentResolution !== undefined) stored.currentResolution = internal.currentResolution;
    if (internal.lockedByAgent !== undefined) stored.lockedByAgent = internal.lockedByAgent;
    return stored;
  }
}

/**
 * Default token estimator: chars / 4
 */
/**
 * Content-class token rates (2026-07-12, measured on mythos production
 * requests by reconciling real `usage` against per-class char counts):
 *   - prose (Discord multiparty, markdown, emoji)  ≈ 2.9 chars/token
 *   - JSON / tool i/o / code                        ≈ 2.3 chars/token
 * The old flat chars/4 under-priced real windows by ~1.7-1.9x (a 183.6k
 * "hard budget" compiled to a 344k request — straight into the refusal
 * band). Rates are deliberately slightly conservative; the closed-loop
 * calibration multiplier trims the residual per agent.
 */
const PROSE_CHARS_PER_TOKEN = 2.9;
const DENSE_CHARS_PER_TOKEN = 2.3;

function defaultTokenEstimator(text: string): number {
  if (!text) return 0;
  // Cheap density probe: JSON/code punctuation and non-ASCII share.
  let dense = 0;
  const n = Math.min(text.length, 2000);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c > 126) { dense++; continue; } // non-ASCII (emoji, accents, CJK)
    const ch = text[i];
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === '"' || ch === ':' || ch === '_' || ch === '/' || ch === '=' || ch === '`') dense++;
  }
  const rate = dense / n > 0.12 ? DENSE_CHARS_PER_TOKEN : PROSE_CHARS_PER_TOKEN;
  return Math.ceil(text.length / rate);
}

/** JSON-ish payloads (tool inputs/results) always use the dense rate. */
function jsonTokenEstimator(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / DENSE_CHARS_PER_TOKEN);
}
