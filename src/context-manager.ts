import { JsStore } from '@animalabs/chronicle';
import type { Membrane, NormalizedMessage, ContentBlock, ToolDefinition } from '@animalabs/membrane';
import type {
  MessageId,
  Sequence,
  MessageMetadata,
  StoredMessage,
  ContextEntry,
  TokenBudget,
  PendingWork,
  BranchInfo,
  BranchGenerationInfo,
  ContextStrategy,
  StrategyContext,
  MessageQuery,
  MessageQueryResult,
  ContextInjection,
  CompileResult,
  PrimarySummaryContract,
  PrimarySummaryIdentity,
  ProtectedRange,
  PinLevelOptions,
  SearchQuery,
  SearchResult,
  SummaryEntry,
  HotContextSettingsUpdate,
  HotContextSettingsStatus,
} from './types/index.js';
import {
  isResettableStrategy,
  isPinnableStrategy,
  isSearchableStrategy,
  isRenderStatsCapable,
  isHotConfigurableStrategy,
  isPrimarySummaryFallbackCapable,
} from './types/index.js';
import type { RenderStats } from './types/index.js';
import { MessageStore, MessageStoreEvent, MessageStoreListener, MessageWindow, MessageWindowOptions } from './message-store.js';
import { ContextLog } from './context-log.js';
import { PassthroughStrategy } from './strategies/passthrough.js';
import { splitMixedToolMessages } from './normalize-tool-messages.js';
import { markStoreBranchSwitch, observeStoreBranch } from './branch-generation.js';
import type { StoreBranchGeneration } from './branch-generation.js';

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
  /** Namespace passed to strategies for scoping their persistent state slots. */
  private strategyNamespace: string;

  private constructor(
    store: JsStore,
    messageStore: MessageStore,
    contextLog: ContextLog,
    strategy: ContextStrategy,
    ownsStore: boolean,
    strategyNamespace: string,
    membrane?: Membrane,
    debugLogContext = false,
  ) {
    this.store = store;
    this.messageStore = messageStore;
    this.contextLog = contextLog;
    this.strategy = strategy;
    this.ownsStore = ownsStore;
    this.strategyNamespace = strategyNamespace;
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

    // Namespace passed to strategies. Falls back to a stable per-store value
    // so strategies always have something to scope state IDs by, even when
    // the caller didn't supply a namespace.
    const strategyNamespace = config.namespace ?? 'default';

    const manager = new ContextManager(
      store,
      messageStore,
      contextLog,
      strategy,
      ownsStore,
      strategyNamespace,
      config.membrane,
      config.debugLogContext ?? false,
    );

    // Initialize strategy
    const openingBranch = observeStoreBranch(store);
    await manager.initializeStrategy(openingBranch);
    manager.initialized = true;

    return manager;
  }

  // ==========================================================================
  // Message Store Operations
  // ==========================================================================

  /**
   * Add a message to the store.
   *
   * If the configured strategy implements `chunkIngressMessage` and returns
   * a non-null sharding decision, the message is stored as multiple records
   * sharing a `bodyGroupId` (per the adaptive-resolution design §3.6). The
   * returned MessageId is the first shard's id.
   */
  addMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata,
    causedBy?: MessageId[]
  ): MessageId {
    // Optional strategy-driven ingestion-time chunking
    const strategyAny = this.strategy as unknown as {
      chunkIngressMessage?: (
        participant: string,
        content: ContentBlock[]
      ) => { bodyGroupId: string; shards: Array<{ content: ContentBlock[]; shardIndex: number }> } | null;
    };
    if (typeof strategyAny.chunkIngressMessage === 'function') {
      const decision = strategyAny.chunkIngressMessage(participant, content);
      if (decision && decision.shards.length > 1) {
        let firstId: MessageId | null = null;
        for (const shard of decision.shards) {
          const message = this.messageStore.append(
            participant,
            shard.content,
            metadata,
            causedBy,
            {
              bodyGroupId: decision.bodyGroupId,
              shardIndex: shard.shardIndex,
            }
          );
          if (firstId === null) firstId = message.id;
        }
        return firstId!;
      }
    }
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
   * Get the total number of messages — O(1).
   */
  getMessageCount(): number {
    return this.messageStore.length();
  }

  /**
   * Get a window of messages by slot index — O(window), not O(all).
   * See MessageStore.getWindow for options (blob resolution, bodyGroup
   * alignment). Intended for viewers/paginated UIs.
   */
  getMessageWindow(offset: number, limit: number, opts?: MessageWindowOptions): MessageWindow {
    return this.messageStore.getWindow(offset, limit, opts);
  }

  /**
   * Subscribe to message-store mutations (add/edit/remove/removeRange).
   * Returns a detacher. Unlike trace events, this fires for ALL stored
   * messages including assistant turns and tool results.
   */
  onMessage(listener: MessageStoreListener): () => void {
    return this.messageStore.addListener(listener);
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
   *
   * Returns the new branch *name*, which is what `switchBranch` and `forkAt`
   * expect. (Chronicle's branch APIs are name-keyed; the numeric `id` field
   * on JsBranch is an internal identifier and isn't accepted by switchBranch.)
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

    return branch.name;
  }

  /**
   * Switch to a different branch.
   *
   * Re-initializes the strategy after switching so any branch-scoped state
   * stored on Chronicle is reloaded. Strategies that hold derived in-memory
   * caches (e.g. AutobiographicalStrategy.summaries) need this to avoid
   * showing the previous branch's state on the new branch.
   */
  async switchBranch(branchId: string): Promise<void> {
    this.store.switchBranch(branchId);
    const requested = markStoreBranchSwitch(this.store);
    await this.initializeStrategy(requested);
  }

  /**
   * Fork from the current head: create a new branch at the current sequence
   * and switch to it. The new branch starts with all current state (messages,
   * context log, and strategy state) and diverges from there.
   *
   * Use this when an agent wants to explore an alternate timeline from
   * "now" — e.g. trying a different response without committing.
   *
   * For time-travel branching at a specific historical message, use
   * `branchAt(messageId, name?)` instead, then `switchBranch(name)`.
   *
   * Returns the new branch's name. The strategy is re-initialized on the
   * new branch so it picks up the forked state.
   */
  async fork(name?: string): Promise<string> {
    const branchName = name ?? `fork-${Date.now()}`;
    const currentBranch = this.store.currentBranch();
    const currentSeq = this.store.currentSequence();
    const branch = this.store.createBranchAt(branchName, currentBranch.name, currentSeq);
    await this.switchBranch(branch.name);
    return branch.name;
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

  /** Current branch metadata plus the Chronicle generation counter. */
  currentBranchGeneration(): BranchGenerationInfo {
    const branch = this.currentBranch();
    const observed = observeStoreBranch(this.store);
    return { ...branch, generation: observed.generation };
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
    // Don't block the agent's turn on speculative compression — let it
    // run in the background. The strategy renders whatever's available
    // now; the next compile picks up the freshly-formed L1.
    //
    // Old behavior (await pendingWork to fold the latest chunk before
    // the agent responds) added 30+ seconds of latency per turn whenever
    // a chunk was forming, which is unacceptable UX for an agent that
    // streams its responses. We accept "this turn doesn't have the very
    // latest L1" in exchange for non-blocking compile.

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

    // Convert to NormalizedMessage[]. We split each entry individually
    // so we know the output-count per input and can re-attach cache
    // markers to the last output of each (matching the marker's
    // "cache up to here" intent).
    //
    // Splitting handles the claude.ai bundled-tool-cycle artifact: a
    // non-user message containing `tool_result` blocks becomes a sequence
    // of agent/user/agent turns so the API accepts it. Already-API-shape
    // messages pass through untouched. See `src/normalize-tool-messages.ts`.
    const messages: NormalizedMessage[] = [];
    for (const entry of entries) {
      const splitParts = splitMixedToolMessages([
        { participant: entry.participant, content: entry.content },
      ]);
      for (let i = 0; i < splitParts.length; i++) {
        const part = splitParts[i];
        const isLast = i === splitParts.length - 1;
        messages.push({
          participant: part.participant,
          content: part.content,
          ...(entry.cacheMarker && isLast ? { cacheBreakpoint: true } : {}),
        });
      }
    }

    // If no injections, log and return early
    if (!injections || injections.length === 0) {
      const result: CompileResult = { messages, systemInjections: [] };
      if (isPrimarySummaryFallbackCapable(this.strategy)) {
        const projection = this.strategy.capturePrimarySummaryProjection(messages);
        if (projection) result.primarySummaryProjection = projection;
      }
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

    const result: CompileResult = { messages, systemInjections };
    if (isPrimarySummaryFallbackCapable(this.strategy)) {
      const projection = this.strategy.capturePrimarySummaryProjection(messages);
      if (projection) result.primarySummaryProjection = projection;
    }
    if (this.debugLogContext) this.logCompiledContext(result);
    return result;
  }

  /**
   * Log the compiled context to stderr for debugging.
   * Uses stderr so it doesn't pollute the context log (which strategies read).
   */
  private logCompiledContext(result: CompileResult): void {
    const renderedMessages = result.messages.map((m) => {
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

    console.error('[debugLogContext]', JSON.stringify(entry));
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

  /** Read the active strategy's allowlisted live settings, if supported. */
  getHotContextSettings(): HotContextSettingsStatus | null {
    if (!isHotConfigurableStrategy(this.strategy)) return null;
    return this.strategy.getHotContextSettings();
  }

  /** Update only settings the active strategy explicitly declares hot-safe. */
  updateHotContextSettings(update: HotContextSettingsUpdate): HotContextSettingsStatus {
    if (!isHotConfigurableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support live context settings');
    }
    return this.strategy.updateHotContextSettings(update);
  }

  // ==========================================================================
  // Pins / documents (passthrough to the active strategy)
  // ==========================================================================

  /**
   * Pin a range of messages so they aren't compressed and render raw at
   * their original chronological position. Returns the new pin id.
   *
   * Throws if the active strategy doesn't support pins.
   */
  pinRange(firstMessageId: MessageId, lastMessageId: MessageId, opts?: PinLevelOptions): string {
    if (!isPinnableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support pins');
    }
    return this.strategy.pinRange(firstMessageId, lastMessageId, opts);
  }

  /**
   * V2 dynamic pin-at-level-k: fix a range to render at EXACTLY fold level
   * `level` (0 = raw) — the frontier cut passes through that L_k node. Honored
   * only by `foldingStrategy: 'kv-stable'`; other strategies fall back to
   * treating the range as raw. Returns the new pin id.
   */
  pinAtLevel(firstMessageId: MessageId, lastMessageId: MessageId, level: number, opts?: { name?: string }): string {
    return this.pinRange(firstMessageId, lastMessageId, { name: opts?.name, level });
  }

  /**
   * Mark a single message as a "document" (semantically a body of
   * information to retain in full). Same effect as a single-message pin
   * with `kind: 'document'`. Returns the new pin id.
   */
  markDocument(messageId: MessageId, opts?: PinLevelOptions): string {
    if (!isPinnableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support documents');
    }
    return this.strategy.markDocument(messageId, opts);
  }

  /** Remove a pin or document mark. Returns true if removed. */
  unpin(pinId: string): boolean {
    if (!isPinnableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support pins');
    }
    return this.strategy.unpin(pinId);
  }

  /** List all current pins. Returns empty array if strategy is not pinnable. */
  listPins(): ReadonlyArray<ProtectedRange> {
    if (!isPinnableStrategy(this.strategy)) return [];
    return this.strategy.listPins();
  }

  // ==========================================================================
  // Search (passthrough to the active strategy)
  // ==========================================================================

  /**
   * Search the strategy's summary archive (substring or regex over content).
   * Returns empty array if the strategy doesn't support search.
   *
   * Suitable for building memory-search agent tools at the framework layer
   * — see e.g. agent-framework's MCPL host integration.
   */
  searchSummaries(query: SearchQuery): SearchResult[] {
    if (!isSearchableStrategy(this.strategy)) return [];
    return this.strategy.searchSummaries(query);
  }

  /** Look up a single summary by id. Returns null if not found / unsupported. */
  getSummary(id: string): SummaryEntry | null {
    if (!isSearchableStrategy(this.strategy)) return null;
    return this.strategy.getSummary(id);
  }

  /**
   * Per-render stats from the active strategy: head/tail message + token
   * counts, plus per-level summary counts and total tokens. Returns null
   * if the strategy doesn't implement `getRenderStats`.
   *
   * Designed for TUIs / dashboards that want to display "how much of the
   * agent's context is folded vs raw" at a glance.
   */
  getRenderStats(): RenderStats | null {
    if (!isRenderStatsCapable(this.strategy)) return null;
    return this.strategy.getRenderStats(this.messageStore.createView());
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
    if (!isResettableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support head window reset');
    }

    const ctx = this.createStrategyContext();

    // Generate transition summary if not provided
    const summary = transitionText ?? await this.strategy.generateTransitionSummary(ctx);

    // Inject transition message
    const msgId = this.addMessage('Context Manager', [
      { type: 'text', text: `[Topic Transition]\n\n${summary}` },
    ]);

    // Reset head window to start from this message
    this.strategy.resetHeadWindow(msgId);

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

  private async initializeStrategy(
    expectedBranch: StoreBranchGeneration = observeStoreBranch(this.store),
  ): Promise<void> {
    this.initialized = false;
    if (this.strategy.initialize) {
      await this.strategy.initialize(this.createStrategyContext());
    }
    const current = observeStoreBranch(this.store);
    if (
      current.name !== expectedBranch.name ||
      current.generation !== expectedBranch.generation ||
      this.store.currentBranch().name !== expectedBranch.name
    ) {
      throw new Error(
        `Branch changed during strategy initialization: requested ${expectedBranch.name} ` +
        `(generation ${expectedBranch.generation}), now ${current.name} ` +
        `(generation ${current.generation})`,
      );
    }
    this.initialized = true;
  }

  /**
   * Live tool definitions for the owning agent, refreshed by the host on
   * every activation (Agent.buildActivationRequest in agent-framework).
   * Threaded into StrategyContext so compression/summarizer LLM calls can
   * declare the same tools as the live instance — required to avoid
   * reasoning_extraction refusals on transcripts containing tool blocks.
   */
  private toolDefinitions?: ToolDefinition[];
  private primaryLaneContract?: PrimarySummaryContract;

  /** Host hook: record the agent's current tool definitions (see above). */
  setToolDefinitions(tools: ToolDefinition[] | undefined): void {
    if (tools && tools.length > 0) this.toolDefinitions = tools;
  }

  /** Host hook: record the active primary-lane provider contract. */
  setPrimaryLaneContract(contract: PrimarySummaryContract | undefined): void {
    this.primaryLaneContract = contract;
  }

  /** Expand specific rendered autobiographical summaries back to raw source. */
  expandPrimarySummaryProjectionRaw(
    compiled: CompileResult,
    summaries: ReadonlyArray<PrimarySummaryIdentity>,
  ): CompileResult {
    if (!isPrimarySummaryFallbackCapable(this.strategy)) {
      throw new Error('Active strategy does not support primary summary raw expansion');
    }
    return this.strategy.expandPrimarySummaryProjectionRaw(compiled, summaries);
  }

  /** Selected summaries quarantined for the current branch generation + contract. */
  matchingPrimarySummaryQuarantine(
    projection: NonNullable<CompileResult['primarySummaryProjection']>,
    contract?: PrimarySummaryContract,
  ): PrimarySummaryIdentity[] {
    if (!isPrimarySummaryFallbackCapable(this.strategy)) return [];
    const effectiveContract = contract ?? this.primaryLaneContract;
    if (!effectiveContract) return [];
    return this.strategy.matchPrimarySummaryQuarantine(
      projection,
      this.currentBranchGeneration(),
      effectiveContract,
    );
  }

  /** Persist durable primary-lane raw-expansion quarantine for selected summaries. */
  async quarantinePrimarySummaryForPrimaryLane(
    contract: PrimarySummaryContract,
    summaries: ReadonlyArray<PrimarySummaryIdentity>,
  ): Promise<void> {
    if (!isPrimarySummaryFallbackCapable(this.strategy)) {
      throw new Error('Active strategy does not support primary summary quarantine');
    }
    await this.strategy.quarantinePrimarySummaryForPrimaryLane(
      this.currentBranchGeneration(),
      contract,
      summaries,
    );
  }

  private createStrategyContext(): StrategyContext {
    const self = this;
    return {
      messageStore: this.messageStore.createView(),
      contextLog: this.contextLog.createView(),
      membrane: this.membrane,
      currentSequence: this.store.currentSequence(),
      store: this.store,
      namespace: this.strategyNamespace,
      get primaryLaneContract() { return self.primaryLaneContract; },
      // Live getter, not a snapshot: strategies capture a ctx object once and
      // reuse it across a long-running drain (driveSpeculativeDrain recurses
      // with the same ctx). A snapshot taken before the session's first
      // activation would freeze `tools` as undefined for the drain's entire
      // lifetime — the getter always reflects the latest activation.
      get tools() { return self.toolDefinitions; },
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
