import type { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import type {
  MessageId,
  ContextEntry,
  ContextEntryInternal,
  SourceRelation,
  ContextLogView,
} from './types/index.js';
import { BlobManager } from './blob-manager.js';

const DEFAULT_CONTEXT_STATE_ID = 'context';

/**
 * Wrapper around Chronicle append_log state for context log storage.
 * The context log is a materialized, editable working set derived from the message store.
 *
 * Supports namespacing for multi-agent scenarios where each agent has its own context log
 * but shares the same message store.
 */
export class ContextLog {
  private blobManager: BlobManager;
  private sourceToIndices: Map<MessageId, Set<number>> = new Map();
  private tokenEstimator: (text: string) => number;
  private stateId: string;

  constructor(
    private store: JsStore,
    options: {
      estimator?: (text: string) => number;
      /** Namespace for multi-agent support. Creates state ID: `{namespace}/context` */
      namespace?: string;
    } = {}
  ) {
    this.stateId = options.namespace
      ? `${options.namespace}/context`
      : DEFAULT_CONTEXT_STATE_ID;
    this.blobManager = new BlobManager(store);
    this.tokenEstimator = options.estimator ?? defaultTokenEstimator;
    this.rebuildSourceIndex();
  }

  /**
   * Register the context log state in Chronicle.
   * Should be called once when setting up the store.
   *
   * @param store The Chronicle store
   * @param namespace Optional namespace for multi-agent support
   */
  static register(store: JsStore, namespace?: string): void {
    const stateId = namespace ? `${namespace}/context` : DEFAULT_CONTEXT_STATE_ID;
    store.registerState({
      id: stateId,
      strategy: 'append_log',
      deltaSnapshotEvery: 50,
      fullSnapshotEvery: 10,
    });
  }

  private rebuildSourceIndex(): void {
    this.sourceToIndices.clear();
    const entries = this.getAllInternal();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.sourceMessageId) {
        const set = this.sourceToIndices.get(entry.sourceMessageId) ?? new Set();
        set.add(i);
        this.sourceToIndices.set(entry.sourceMessageId, set);
      }
    }
  }

  /**
   * Append a new entry to the context log.
   */
  append(
    participant: string,
    content: ContentBlock[],
    sourceMessageId?: MessageId,
    sourceRelation?: SourceRelation,
    cacheMarker?: boolean
  ): ContextEntry {
    const storedContent = this.blobManager.extractBlobs(content);
    const index = this.length();

    const internal: ContextEntryInternal = {
      index,
      sourceMessageId,
      sourceRelation,
      participant,
      content: storedContent,
      cacheMarker,
    };

    this.store.appendToStateJson(this.stateId, internal);

    // Update source index
    if (sourceMessageId) {
      const set = this.sourceToIndices.get(sourceMessageId) ?? new Set();
      set.add(index);
      this.sourceToIndices.set(sourceMessageId, set);
    }

    return {
      index,
      sourceMessageId,
      sourceRelation,
      participant,
      content,
      cacheMarker,
    };
  }

  /**
   * Edit an entry's content at a specific index.
   */
  edit(index: number, content: ContentBlock[]): void {
    const internal = this.getInternal(index);
    if (!internal) {
      throw new Error(`Context entry not found at index: ${index}`);
    }

    const storedContent = this.blobManager.extractBlobs(content);
    const updated: ContextEntryInternal = {
      ...internal,
      content: storedContent,
    };

    this.store.editStateItem(this.stateId, index, Buffer.from(JSON.stringify(updated)));
  }

  /**
   * Remove an entry at a specific index.
   */
  remove(index: number): void {
    const internal = this.getInternal(index);
    if (!internal) {
      throw new Error(`Context entry not found at index: ${index}`);
    }

    this.store.redactStateItems(this.stateId, index, index + 1);
    this.rebuildSourceIndex();
  }

  /**
   * Remove a range of entries.
   */
  removeRange(start: number, end: number): void {
    this.store.redactStateItems(this.stateId, start, end);
    this.rebuildSourceIndex();
  }

  /**
   * Replace the entire context log with new entries.
   * Useful for strategies that rebuild the context.
   */
  replaceAll(entries: Array<{
    participant: string;
    content: ContentBlock[];
    sourceMessageId?: MessageId;
    sourceRelation?: SourceRelation;
    cacheMarker?: boolean;
  }>): ContextEntry[] {
    // Clear existing entries
    const len = this.length();
    if (len > 0) {
      this.store.redactStateItems(this.stateId, 0, len);
    }

    // Add new entries
    const result: ContextEntry[] = [];
    for (const entry of entries) {
      result.push(this.append(
        entry.participant,
        entry.content,
        entry.sourceMessageId,
        entry.sourceRelation,
        entry.cacheMarker
      ));
    }

    return result;
  }

  /**
   * Get an entry by index.
   */
  get(index: number): ContextEntry | null {
    const internal = this.getInternal(index);
    if (!internal) {
      return null;
    }
    return this.internalToEntry(internal);
  }

  /**
   * Get all entries.
   */
  getAll(): ContextEntry[] {
    return this.getAllInternal().map((internal) => this.internalToEntry(internal));
  }

  /**
   * Get entries from a specific index.
   */
  getFrom(index: number): ContextEntry[] {
    return this.getAll().slice(index);
  }

  /**
   * Get the last N entries.
   */
  getTail(count: number): ContextEntry[] {
    const all = this.getAll();
    return all.slice(Math.max(0, all.length - count));
  }

  /**
   * Get the total number of entries.
   */
  length(): number {
    return this.store.getStateLen(this.stateId) ?? 0;
  }

  /**
   * Find all entries that reference a specific source message.
   */
  findBySource(sourceMessageId: MessageId): ContextEntry[] {
    const indices = this.sourceToIndices.get(sourceMessageId);
    if (!indices) {
      return [];
    }

    const entries: ContextEntry[] = [];
    for (const index of indices) {
      const entry = this.get(index);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  }

  /**
   * Get the source relation for entries referencing a message.
   */
  getSourceRelation(sourceMessageId: MessageId): Map<number, SourceRelation | undefined> {
    const result = new Map<number, SourceRelation | undefined>();
    const indices = this.sourceToIndices.get(sourceMessageId);
    if (!indices) {
      return result;
    }

    for (const index of indices) {
      const entry = this.get(index);
      if (entry) {
        result.set(index, entry.sourceRelation);
      }
    }
    return result;
  }

  /**
   * Estimate tokens for an entry.
   */
  estimateTokens(entry: ContextEntry): number {
    let tokens = 0;
    for (const block of entry.content) {
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
        return this.tokenEstimator(JSON.stringify(block.input)) + 20;
      case 'tool_result':
        if (!block.content) return 0;
        if (typeof block.content === 'string') {
          return this.tokenEstimator(block.content);
        }
        return block.content.reduce((sum, b) => sum + this.estimateBlockTokens(b), 0);
      case 'image':
        return block.tokenEstimate ?? 1000;
      case 'document':
      case 'audio':
      case 'video':
        return 1000;
      default:
        return 0;
    }
  }

  /**
   * Create a read-only view of the log for strategies.
   */
  createView(): ContextLogView {
    return {
      getAll: () => this.getAll(),
      getFrom: (index) => this.getFrom(index),
      getTail: (count) => this.getTail(count),
      length: () => this.length(),
      estimateTokens: (entry) => this.estimateTokens(entry),
    };
  }

  private getAllInternal(): ContextEntryInternal[] {
    const state = this.store.getStateJson(this.stateId);
    if (!state || !Array.isArray(state)) {
      return [];
    }
    return state as ContextEntryInternal[];
  }

  private getInternal(index: number): ContextEntryInternal | null {
    const all = this.getAllInternal();
    return all[index] ?? null;
  }

  private internalToEntry(internal: ContextEntryInternal): ContextEntry {
    return {
      index: internal.index,
      sourceMessageId: internal.sourceMessageId,
      sourceRelation: internal.sourceRelation,
      participant: internal.participant,
      content: this.blobManager.resolveBlobs(internal.content),
      cacheMarker: internal.cacheMarker,
    };
  }
}

/**
 * Default token estimator: chars / 4
 */
function defaultTokenEstimator(text: string): number {
  return Math.ceil(text.length / 4);
}
