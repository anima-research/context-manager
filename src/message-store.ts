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
   * Get messages from a specific index.
   */
  getFrom(index: number): StoredMessage[] {
    return this.getAll().slice(index);
  }

  /**
   * Get the last N messages.
   */
  getTail(count: number): StoredMessage[] {
    const all = this.getAll();
    return all.slice(Math.max(0, all.length - count));
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

  private estimateBlockTokens(block: ContentBlock): number {
    switch (block.type) {
      case 'text':
        return this.tokenEstimator(block.text);
      case 'thinking':
        return this.tokenEstimator(block.thinking);
      case 'tool_use':
        return this.tokenEstimator(JSON.stringify(block.input)) + 20; // overhead for name, id
      case 'tool_result':
        if (!block.content) return 0;
        if (typeof block.content === 'string') {
          return this.tokenEstimator(block.content);
        }
        if (Array.isArray(block.content)) {
          return block.content.reduce((sum, b) => sum + this.estimateBlockTokens(b), 0);
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
    const state = this.store.getStateJson(this.stateId);
    if (!state || !Array.isArray(state)) {
      return [];
    }
    return state as StoredMessageInternal[];
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
      content: this.blobManager.resolveBlobs(internal.content),
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
function defaultTokenEstimator(text: string): number {
  return Math.ceil(text.length / 4);
}
