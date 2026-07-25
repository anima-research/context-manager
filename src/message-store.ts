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
} from './types/index.js';
import { BlobManager } from './blob-manager.js';

const DEFAULT_MESSAGE_STATE_ID = 'messages';

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
  }

  /**
   * Register the message store state in Chronicle.
   * Should be called once when setting up the store.
   *
   * @param store The Chronicle store
   * @param namespace Optional namespace for multi-agent support
   */
  static register(store: JsStore, namespace?: string): void {
    const stateId = namespace ? `${namespace}/messages` : DEFAULT_MESSAGE_STATE_ID;
    store.registerState({
      id: stateId,
      strategy: 'append_log',
      deltaSnapshotEvery: 50,
      fullSnapshotEvery: 10,
    });
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

  private rebuildIndex(): void {
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
   * Freshness token: chronicle is append-only, so EVERY mutation — this
   * instance's, another MessageStore instance sharing the JsStore
   * (multi-agent shared messages), any state's write — advances
   * `currentSequence()`. Key the memo on (branch name, head sequence) and
   * it can never serve stale data; unrelated-state writes merely cost one
   * extra parse. (An instance-local version counter was tried first and
   * broke multi-instance sharing — integration.test.ts Multi-Agent
   * Namespacing.)
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
    } else {
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
    const index = this.idToIndex.get(messageId);
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
    const index = this.idToIndex.get(messageId);
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
    const index = this.idToIndex.get(messageId);
    if (index === undefined) {
      throw new Error(`Message not found: ${messageId}`);
    }
    const target = this.getInternal(index);
    if (!target?.bodyGroupId) {
      // Not sharded — defer to normal remove path (re-look up via getInternal
      // since the normal `remove` checks bodyGroupId).
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
    const fromIndex = this.idToIndex.get(fromId);
    const toIndex = this.idToIndex.get(toId);

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

    this.store.redactStateItems(this.stateId, fromIndex, toIndex + 1);
    this.allCache = null; // rare path: plain invalidation
    this.rebuildIndex();

    this.emit({ type: 'removeRange', fromId, toId });
  }

  /**
   * Get a message by ID.
   */
  get(messageId: MessageId): StoredMessage | null {
    const index = this.idToIndex.get(messageId);
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
    return internals.map((internal, i) =>
      this.internalToStored(internal, internal.id, i)
    );
  }

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

  private estimateBlockTokens(block: ContentBlock): number {
    return Math.round(this.estimateBlockTokensRaw(block) * this.tokenCalibration);
  }

  private estimateBlockTokensRaw(block: ContentBlock): number {
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
    if (this.allCache && this.allCache.branch === branch) {
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
      }
    }
    const state = this.store.getStateJson(this.stateId);
    const internals =
      !state || !Array.isArray(state) ? [] : (state as StoredMessageInternal[]);
    this.allCache = { branch, sequence, internals };
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
