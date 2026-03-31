import { JsStore } from 'chronicle';
import type { Membrane, NormalizedMessage, ContentBlock } from 'membrane';
import type {
  MessageId,
  Sequence,
  MessageMetadata,
  StoredMessage,
  ContextEntry,
  TokenBudget,
  PendingWork,
  BranchInfo,
  ContextStrategy,
  StrategyContext,
  MessageQuery,
  MessageQueryResult,
  ContextInjection,
  CompileResult,
} from './types/index.js';
import { MessageStore, MessageStoreEvent } from './message-store.js';
import { ContextLog } from './context-log.js';
import { PassthroughStrategy } from './strategies/passthrough.js';

/**
 * Base configuration for ContextManager.
 */
interface ContextManagerBaseConfig {
  /** Initial strategy (default: PassthroughStrategy) */
  strategy?: ContextStrategy;
  /** Membrane instance for compression strategies */
  membrane?: Membrane;
  /** Token estimator function */
  tokenEstimator?: (text: string) => number;
  /**
   * Namespace for multi-agent support.
   * When set, the context log uses state ID `{namespace}/context`.
   * Messages remain shared (no namespace) unless `isolate` is true.
   */
  namespace?: string;
  /**
   * When true, the namespace applies to messages as well as the context log,
   * giving fully isolated state: `{namespace}/messages` + `{namespace}/context`.
   * Use for subagents that should not share message state with the parent.
   * Requires `namespace` to be set.
   */
  isolate?: boolean;
  /**
   * When true, log the compiled context to stderr for debugging.
   */
  debugLogContext?: boolean;
}

/**
 * Configuration when ContextManager creates and owns the store.
 */
interface ContextManagerPathConfig extends ContextManagerBaseConfig {
  /** Path to Chronicle store */
  path: string;
  /** Blob cache size (default: 1000) */
  blobCacheSize?: number;
  store?: never;
}

/**
 * Configuration when app provides an existing store.
 * App retains ownership and is responsible for closing the store.
 */
interface ContextManagerStoreConfig extends ContextManagerBaseConfig {
  /** Existing Chronicle store (app-owned) */
  store: JsStore;
  path?: never;
  blobCacheSize?: never;
}

/**
 * Configuration for ContextManager.
 */
export type ContextManagerConfig = ContextManagerPathConfig | ContextManagerStoreConfig;

/**
 * Context Manager - the main interface for managing conversation context.
 *
 * Sits between the application/agent layer and Membrane, managing what goes
 * into the context window. Uses Chronicle for persistent storage.
 */
export class ContextManager {
  private store: JsStore;
  private messageStore: MessageStore;
  private contextLog: ContextLog;
  private strategy: ContextStrategy;
  private membrane?: Membrane;
  private initialized = false;
  /** Whether we own the store (created it) vs app owns it (passed in) */
  private ownsStore: boolean;
  private debugLogContext: boolean;

  private constructor(
    store: JsStore,
    messageStore: MessageStore,
    contextLog: ContextLog,
    strategy: ContextStrategy,
    ownsStore: boolean,
    membrane?: Membrane,
    debugLogContext = false,
  ) {
    this.store = store;
    this.messageStore = messageStore;
    this.contextLog = contextLog;
    this.strategy = strategy;
    this.ownsStore = ownsStore;
    this.membrane = membrane;
    this.debugLogContext = debugLogContext;

    // Set up edit propagation
    this.messageStore.addListener((event) => this.handleMessageStoreEvent(event));
  }

  /**
   * Open or create a context manager.
   *
   * Can be called with either:
   * - `{ path: string }` - Creates and owns a new store
   * - `{ store: JsStore }` - Uses an existing app-owned store
   *
   * When using an app-owned store, the app is responsible for closing it.
   * The app can register additional states on the store before passing it.
   */
  static async open(config: ContextManagerConfig): Promise<ContextManager> {
    let store: JsStore;
    let ownsStore: boolean;

    if ('store' in config && config.store) {
      // App provides existing store - app owns it
      store = config.store;
      ownsStore = false;
    } else if ('path' in config && config.path) {
      // Create new store - we own it
      store = JsStore.openOrCreate({
        path: config.path,
        blobCacheSize: config.blobCacheSize ?? 1000,
      });
      ownsStore = true;
    } else {
      throw new Error('ContextManagerConfig must have either "path" or "store"');
    }

    // Namespace for messages: only when `isolate` is true
    if (config.isolate && !config.namespace) {
      throw new Error('ContextManagerConfig: "isolate" requires "namespace" to be set');
    }
    const messageNamespace = config.isolate ? config.namespace : undefined;

    // Register states if needed (idempotent)
    try {
      MessageStore.register(store, messageNamespace);
    } catch {
      // State already registered
    }

    try {
      ContextLog.register(store, config.namespace);
    } catch {
      // State already registered
    }

    const messageStore = new MessageStore(store, {
      estimator: config.tokenEstimator,
      namespace: messageNamespace,
    });
    const contextLog = new ContextLog(store, {
      estimator: config.tokenEstimator,
      namespace: config.namespace,
    });
    const strategy = config.strategy ?? new PassthroughStrategy();

    const manager = new ContextManager(
      store,
      messageStore,
      contextLog,
      strategy,
      ownsStore,
      config.membrane,
      config.debugLogContext ?? false,
    );

    // Initialize strategy
    await manager.initializeStrategy();
    manager.initialized = true;

    return manager;
  }

  // ==========================================================================
  // Message Store Operations
  // ==========================================================================

  /**
   * Add a message to the store.
   */
  addMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata,
    causedBy?: MessageId[]
  ): MessageId {
    const message = this.messageStore.append(participant, content, metadata, causedBy);
    return message.id;
  }

  /**
   * Edit a message in the store. Propagates to context log based on source relation.
   */
  editMessage(messageId: MessageId, content: ContentBlock[]): void {
    this.messageStore.edit(messageId, content);
    // Propagation handled by event listener
  }

  /**
   * Remove a message from the store. Propagates to context log.
   */
  removeMessage(messageId: MessageId): void {
    this.messageStore.remove(messageId);
    // Propagation handled by event listener
  }

  /**
   * Remove a range of messages from the store.
   */
  removeMessages(fromId: MessageId, toId: MessageId): void {
    this.messageStore.removeRange(fromId, toId);
    // Propagation handled by event listener
  }

  /**
   * Get a message by ID.
   */
  getMessage(messageId: MessageId): StoredMessage | null {
    return this.messageStore.get(messageId);
  }

  /**
   * Get a message as it was at a specific sequence (time travel).
   */
  getMessageAt(messageId: MessageId, atSequence: Sequence): StoredMessage | null {
    return this.messageStore.getAt(messageId, atSequence);
  }

  /**
   * Get all messages in the store.
   */
  getAllMessages(): StoredMessage[] {
    return this.messageStore.getAll();
  }

  /**
   * Query messages by filter criteria.
   * Useful for finding messages from external sources, by participant, etc.
   *
   * @example
   * // Find all messages from Discord
   * const { messages } = manager.queryMessages({ source: 'discord' });
   *
   * @example
   * // Find messages from a specific channel
   * const { messages } = manager.queryMessages({
   *   source: 'discord',
   *   metadata: { 'external.channelId': '123456' }
   * });
   *
   * @example
   * // Find specific messages by external ID
   * const { messages } = manager.queryMessages({
   *   source: 'discord',
   *   externalIds: ['msg1', 'msg2', 'msg3']
   * });
   */
  queryMessages(filter: MessageQuery): MessageQueryResult {
    return this.messageStore.query(filter);
  }

  /**
   * Find a message by its external source and ID.
   * Returns the internal message ID, or null if not found.
   */
  findMessageByExternalId(source: string, externalId: string): MessageId | null {
    const msg = this.messageStore.findByExternalId(source, externalId);
    return msg?.id ?? null;
  }

  // ==========================================================================
  // Branching
  // ==========================================================================

  /**
   * Create a branch from a specific message.
   * The new branch will have state as of that message's sequence (time-travel branching).
   */
  branchAt(messageId: MessageId, name?: string): string {
    const message = this.messageStore.get(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }

    // Create branch name if not provided
    const branchName = name ?? `branch-${Date.now()}`;
    
    // Get current branch name to branch from
    const currentBranch = this.store.currentBranch();
    
    // Use createBranchAt to branch at the message's sequence (time-travel)
    const branch = this.store.createBranchAt(branchName, currentBranch.name, message.sequence);

    return branch.id;
  }

  /**
   * Switch to a different branch.
   */
  switchBranch(branchId: string): void {
    this.store.switchBranch(branchId);
  }

  /**
   * Get current branch.
   */
  currentBranch(): BranchInfo {
    const branch = this.store.currentBranch();
    return {
      id: branch.id,
      name: branch.name,
      head: branch.head,
      parentId: branch.parentId ?? undefined,
      branchPoint: branch.branchPoint ?? undefined,
      created: new Date(branch.created),
    };
  }

  /**
   * List all branches.
   */
  listBranches(): BranchInfo[] {
    return this.store.listBranches().map((b) => ({
      id: b.id,
      name: b.name,
      head: b.head,
      parentId: b.parentId ?? undefined,
      branchPoint: b.branchPoint ?? undefined,
      created: new Date(b.created),
    }));
  }

  // ==========================================================================
  // Context Compilation
  // ==========================================================================

  /**
   * Check if compile() will block waiting for background work.
   */
  isReady(): boolean {
    return this.strategy.checkReadiness().ready;
  }

  /**
   * Get info about pending background work.
   */
  getPendingWork(): PendingWork | null {
    const state = this.strategy.checkReadiness();
    if (state.ready) {
      return null;
    }

    return {
      description: state.description ?? 'Background work pending',
      started: new Date(),
    };
  }

  /**
   * Compile context for Membrane.
   *
   * Accepts optional context injections (e.g., from MCPL servers) and merges
   * them into the compiled output by position:
   * - "system": returned separately in `systemInjections` (caller appends to system prompt)
   * - "beforeUser": inserted before the last user message
   * - "afterUser": inserted after the last user message
   *
   * May block if strategy has pending work.
   */
  async compile(
    budget?: TokenBudget,
    injections?: ContextInjection[]
  ): Promise<CompileResult> {
    // Check readiness and wait if needed
    const readiness = this.strategy.checkReadiness();
    if (!readiness.ready && readiness.pendingWork) {
      await readiness.pendingWork;
    }

    // Default budget
    const effectiveBudget: TokenBudget = budget ?? {
      maxTokens: 100000,
      reserveForResponse: 4000,
    };

    // Get selected entries from strategy
    const entries = this.strategy.select(
      this.messageStore.createView(),
      this.contextLog.createView(),
      effectiveBudget
    );

    // Convert to NormalizedMessage[]
    const messages: NormalizedMessage[] = entries.map((entry) => ({
      participant: entry.participant,
      content: entry.content,
    }));

    // If no injections, log and return early
    if (!injections || injections.length === 0) {
      const result = { messages, systemInjections: [] };
      if (this.debugLogContext) this.logCompiledContext(result);
      return result;
    }

    // Separate injections by position
    const systemInjections: ContentBlock[] = [];
    const beforeUser: ContextInjection[] = [];
    const afterUser: ContextInjection[] = [];

    for (const injection of injections) {
      switch (injection.position) {
        case 'system':
          systemInjections.push(...injection.content);
          break;
        case 'beforeUser':
          beforeUser.push(injection);
          break;
        case 'afterUser':
          afterUser.push(injection);
          break;
      }
    }

    // Find last user message index (participant is typically 'user' or 'User')
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].participant.toLowerCase() === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    // Insert beforeUser injections before last user message
    if (beforeUser.length > 0 && lastUserIdx >= 0) {
      const injectedMessages: NormalizedMessage[] = beforeUser.map((inj) => ({
        participant: `injection:${inj.namespace}`,
        content: inj.content,
      }));
      messages.splice(lastUserIdx, 0, ...injectedMessages);
      // Adjust lastUserIdx to account for inserted messages
      lastUserIdx += injectedMessages.length;
    }

    // Insert afterUser injections after last user message
    if (afterUser.length > 0) {
      const insertIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : messages.length;
      const injectedMessages: NormalizedMessage[] = afterUser.map((inj) => ({
        participant: `injection:${inj.namespace}`,
        content: inj.content,
      }));
      messages.splice(insertIdx, 0, ...injectedMessages);
    }

    const result = { messages, systemInjections };
    if (this.debugLogContext) this.logCompiledContext(result);
    return result;
  }

  /**
   * Append a snapshot of the compiled context to the context log.
   * Each entry captures the full rendered messages (including injections)
   * as sent to the LLM, for post-hoc debugging.
   */
  private logCompiledContext(result: CompileResult): void {
    const renderedMessages = result.messages.map((m) => {
      // Flatten content blocks into a single text for readability
      const text = m.content
        .map((b) => {
          switch (b.type) {
            case 'text': return b.text;
            case 'thinking': return `[thinking] ${b.thinking}`;
            case 'tool_use': return `[tool_use:${b.name}] ${JSON.stringify(b.input)}`;
            case 'tool_result': return `[tool_result:${b.toolUseId}] ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}`;
            default: return `[${b.type}]`;
          }
        })
        .join('\n');
      return { participant: m.participant, text };
    });

    const entry = {
      timestamp: Date.now(),
      type: 'compiled_context',
      messageCount: result.messages.length,
      systemInjectionCount: result.systemInjections.length,
      messages: renderedMessages,
    };

    this.contextLog.append(
      'debug',
      [{ type: 'text', text: JSON.stringify(entry) }],
    );
  }

  // ==========================================================================
  // Strategy
  // ==========================================================================

  /**
   * Set the context management strategy.
   */
  async setStrategy(strategy: ContextStrategy): Promise<void> {
    this.strategy = strategy;
    await this.initializeStrategy();
  }

  /**
   * Get the current strategy.
   */
  getStrategy(): ContextStrategy {
    return this.strategy;
  }

  /**
   * Reset the head window to start from a new position.
   * Old head window messages become compressible.
   *
   * If transitionText is provided, it's used as the transition summary.
   * If omitted, an LLM call auto-generates a transition summary.
   *
   * Returns the transition summary text used.
   */
  async resetHeadWindow(transitionText?: string): Promise<string> {
    const strategy = this.strategy as { resetHeadWindow?: (id: string | null) => void; generateTransitionSummary?: (ctx: unknown) => Promise<string> };
    if (!strategy.resetHeadWindow) {
      throw new Error('Active strategy does not support head window reset');
    }

    const ctx = this.createStrategyContext();

    // Generate transition summary if not provided
    const summary = transitionText ?? (
      strategy.generateTransitionSummary
        ? await strategy.generateTransitionSummary(ctx)
        : 'Topic transition.'
    );

    // Inject transition message
    const msgId = this.addMessage('Context Manager', [
      { type: 'text', text: `[Topic Transition]\n\n${summary}` },
    ]);

    // Reset head window to start from this message
    strategy.resetHeadWindow(msgId);

    return summary;
  }

  /**
   * Trigger background maintenance work.
   * Call this periodically to allow strategies to do compression, etc.
   */
  async tick(): Promise<void> {
    if (this.strategy.tick) {
      await this.strategy.tick(this.createStrategyContext());
    }
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private async initializeStrategy(): Promise<void> {
    if (this.strategy.initialize) {
      await this.strategy.initialize(this.createStrategyContext());
    }
  }

  private createStrategyContext(): StrategyContext {
    return {
      messageStore: this.messageStore.createView(),
      contextLog: this.contextLog.createView(),
      membrane: this.membrane,
      currentSequence: this.store.currentSequence(),
    };
  }

  /**
   * Handle message store events for edit propagation.
   */
  private handleMessageStoreEvent(event: MessageStoreEvent): void {
    switch (event.type) {
      case 'add':
        this.handleMessageAdd(event.message);
        break;
      case 'edit':
        this.handleMessageEdit(event.messageId, event.newContent);
        break;
      case 'remove':
        this.handleMessageRemove(event.messageId);
        break;
      case 'removeRange':
        // For range removes, we need to check all affected messages
        // This is a simplification - in practice we'd need to track the IDs
        break;
    }
  }

  private handleMessageAdd(message: StoredMessage): void {
    // Notify strategy of new message
    if (this.strategy.onNewMessage) {
      // Fire and forget - don't block on strategy processing
      this.strategy.onNewMessage(message, this.createStrategyContext()).catch((err) => {
        console.error('Strategy onNewMessage failed:', err);
      });
    }
  }

  private handleMessageEdit(messageId: MessageId, newContent: ContentBlock[]): void {
    // Find context entries that reference this message
    const entries = this.contextLog.findBySource(messageId);

    for (const entry of entries) {
      // Check source relation to decide whether to propagate
      switch (entry.sourceRelation) {
        case 'copy':
          // Must propagate
          this.contextLog.edit(entry.index, newContent);
          break;
        case 'derived':
          // May ignore (stale is acceptable)
          // Do nothing
          break;
        case 'referenced':
          // Don't propagate
          // Do nothing
          break;
        default:
          // No relation specified, treat as copy for safety
          this.contextLog.edit(entry.index, newContent);
      }
    }
  }

  private handleMessageRemove(messageId: MessageId): void {
    // Find context entries that reference this message
    const entries = this.contextLog.findBySource(messageId);

    // Collect indices to remove (in reverse order to maintain indices)
    const indicesToRemove: number[] = [];

    for (const entry of entries) {
      switch (entry.sourceRelation) {
        case 'copy':
          // Must remove
          indicesToRemove.push(entry.index);
          break;
        case 'derived':
          // Ignore (it's a snapshot)
          break;
        case 'referenced':
          // Don't propagate
          break;
        default:
          // No relation specified, treat as copy
          indicesToRemove.push(entry.index);
      }
    }

    // Remove in reverse order to maintain indices
    indicesToRemove.sort((a, b) => b - a);
    for (const index of indicesToRemove) {
      this.contextLog.remove(index);
    }
  }

  /**
   * Get the underlying Chronicle store.
   * Useful for registering additional states or accessing store-level features.
   */
  getStore(): JsStore {
    return this.store;
  }

  /**
   * Sync to disk.
   */
  sync(): void {
    this.store.sync();
  }

  /**
   * Close the context manager.
   *
   * If the manager owns the store (created via path config), this closes the store.
   * If the app owns the store (passed via store config), this is a no-op;
   * the app is responsible for closing the store when done.
   */
  close(): void {
    if (this.ownsStore) {
      this.store.close();
    }
  }

  /**
   * Check if the store has been closed.
   */
  isClosed(): boolean {
    return this.store.isClosed();
  }

  /**
   * Get store stats.
   */
  stats(): {
    messageCount: number;
    contextEntryCount: number;
    branches: number;
  } {
    return {
      messageCount: this.messageStore.length(),
      contextEntryCount: this.contextLog.length(),
      branches: this.listBranches().length,
    };
  }
}
