import { JsStore } from '@animalabs/chronicle';
import type { Membrane, NormalizedMessage, ContentBlock, ToolDefinition } from '@animalabs/membrane';
import type {
  MessageId,
  Sequence,
  MessageMetadata,
  AddMessageOptions,
  CompressionHoldOptions,
  CompressionHoldInfo,
  StoredMessage,
  ContextEntry,
  TokenBudget,
  PendingWork,
  BranchInfo,
  ContextStrategy,
  StrategyContext,
  MessageQuery,
  MessageQueryResult,
  TimeRangeQueryOptions,
  ChannelQueryOptions,
  TimeAndChannelQueryOptions,
  IndexedMessageQueryResult,
  ChannelCount,
  ChannelTokenStats,
  ChannelTokenStatsOptions,
  ContextInjection,
  CompileResult,
  ProtectedRange,
  PinLevelOptions,
  SearchQuery,
  SearchResult,
  SummaryEntry,
  TimeRangeSummaryEntry,
  HotContextSettingsUpdate,
  RequestIdentity,
  ThinkingBinding,
  SelectOptions,
  PreviewResult,
  HotContextSettingsStatus,
} from './types/index.js';
import {
  isResettableStrategy,
  isPinnableStrategy,
  isSearchableStrategy,
  isSummaryOverviewStrategy,
  isRenderStatsCapable,
  isHotConfigurableStrategy,
} from './types/index.js';
import { isStateExistsFor } from './state-registration.js';
import type { RenderStats } from './types/index.js';
import { MessageStore, MessageStoreEvent, MessageStoreListener, MessageWindow, MessageWindowOptions } from './message-store.js';
import { ContextLog } from './context-log.js';
import { MalformedContentError, contentForWrite, malformedContentPlaces } from './well-formed-content.js';
import { filterMessageStoreView, mergeMessageStoreViews } from './message-view.js';
import { PassthroughStrategy } from './strategies/passthrough.js';
import { splitMixedToolMessages } from './normalize-tool-messages.js';
import { markStoreBranchSwitch, observeStoreBranch } from './branch-generation.js';
import type { StoreBranchGeneration } from './branch-generation.js';
import { randomUUID } from 'node:crypto';
import { attributeEntries, buildRenderedLayout, rawBodiesOf } from './compile-provenance.js';
import { FoldJournal, branchRefOf, cachedStoreIdentity, existingStoreIdentity } from './fold-journal.js';
import { describeThrown, logThrown } from './describe-thrown.js';
import {
  UNVOUCHED, bindThinking, continueRecord, isThinkingBlock, markThinkingLeftOut, messageDigest, readBindingRecord,
  refuseUnboundBinding, refuseUnreadableIdentity, registerBindingState, thinkingAsSent, thinkingSent, withoutThinking, writeBindingRecord,
  type BindOutcome, type BindingRecord,
} from './thinking-binding.js';
import { type Diagnostics, namespaceDiagnostics } from './diagnostics.js';
import type { FoldQuery, FoldQueryResult, FoldReceipt, Presentation, ReceiptSource, RoundUsage } from './fold-journal.js';
import type {
  BranchRef,
  CompiledMessageSources,
  CompileProvenance,
  MessageStoreView,
  RenderedLayout,
  RenderedSummaryInfo,
} from './types/index.js';

type InitializationStamp = StoreBranchGeneration & { id: string; attempt: number };

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
  /**
   * Clock for compression-hold timeouts (ms). Defaults to Date.now; tests
   * inject a fake clock.
   */
  now?: () => number;
  /**
   * Strategy-facing exclusion predicate: return true to keep a message
   * visible. When set, the view handed to the strategy — for compile,
   * preview, ticks, and onNewMessage context alike — contains only kept
   * messages, so chunking, selection, emission, and coverage invariants
   * all see the same excluded-free world. Excluded messages remain in the
   * store: direct accessors (getMessage/getAllMessages/query) and the raw
   * chronicle state are unaffected.
   *
   * The predicate MUST be deterministic per message (e.g. keyed on
   * ingestion-stamped metadata, not wall-clock or external state):
   * flapping visibility re-busts compiled-prefix stability and can
   * confuse strategies that persist per-message bookkeeping.
   *
   * NOT retroactive, and NOT a confidentiality boundary. The filter governs
   * what the strategy sees from now on. Derived state a strategy persisted
   * earlier — autobiographical summaries written while a message was still
   * visible — is neither invalidated nor re-filtered when a predicate is
   * introduced on an existing store or tightened later; a summary whose
   * sources are now hidden stays loadable and selectable. `removeMessage`
   * has the same property. To excise content that may already have been
   * folded into memory, branch the chronicle before it entered (strategy
   * state follows the branch); do not reach for a filter. Predicates keyed
   * on ingestion-time stamps that never change (tune-out's
   * `metadata.tuneOut`) are unaffected by this caveat: such a message is
   * hidden from its first instant and can never have been summarized.
   */
  viewFilter?: (message: StoredMessage) => boolean;
  /**
   * Additional message slots merged (read-only) into the strategy-facing
   * view, ordered with this manager's own messages by chronicle sequence —
   * which is branch-global across slots, so the interleaving is
   * deterministic and append-only. `namespace` follows MessageStore
   * conventions: omitted = the shared un-namespaced `messages` slot.
   *
   * Writes (`addMessage`) always target this manager's own slot; auxiliary
   * slots are someone else's to write (e.g. a side-process agent reading
   * the main agent's timeline alongside its own — issue #77).
   * `viewFilter`, when also set, applies to the merged view.
   */
  auxiliaryMessageViews?: Array<{ namespace?: string }>;
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
 * Rejection of a strategy initialization that a newer one superseded.
 *
 * From switchBranch() or fork(), the call's branch selection, and a fork's
 * branch creation, had already happened: `branch` names the branch, and
 * `created` says whether this call created it. A caller never needs to retry
 * a fork to learn whether it happened. From setStrategy(), `branch` is
 * undefined.
 */
export class InitializationSupersededError extends Error {
  readonly branch: string | undefined;
  readonly created: boolean;

  constructor(selection?: { branch: string; created: boolean }) {
    super(
      selection
        ? `ContextManager.${selection.created ? 'fork created and selected' : 'switchBranch selected'} ` +
          `branch "${selection.branch}", but its strategy initialization was superseded by a newer initialization`
        : 'Strategy initialization was superseded by a newer initialization',
    );
    this.name = 'InitializationSupersededError';
    this.branch = selection?.branch;
    this.created = selection?.created ?? false;
  }
}

/**
 * Context Manager - the main interface for managing conversation context.
 *
 * Sits between the application/agent layer and Membrane, managing what goes
 * into the context window. Uses Chronicle for persistent storage.
 *
 * Mutations and strategy operations require a completed initialization attempt.
 * Pending or failed attempts refuse that work. They also refuse the
 * strategy-state queries, whose answers could then belong to another branch or
 * be partial: isReady, getPendingWork, getHotContextSettings, previewContext,
 * listPins, searchSummaries, getSummary, getSummariesInRange,
 * getMaxSummaryLevel and getRenderStats. Raw message reads and branch
 * inspection remain available for recovery with switchBranch() or
 * setStrategy(). So do compression holds (holdCompression,
 * releaseCompression) and request settings (setToolDefinitions,
 * setSystemPrompt): they live in memory, and the strategy hears of a released
 * hold only once an attempt succeeds.
 *
 * The fence governs operations that start while an attempt is pending or
 * failed. Work already in flight when a transition begins, and a superseded
 * initializer's own writes before it returns, are the strategy's to guard;
 * transitions do not roll back earlier writes. Direct Chronicle switches retain
 * their existing strategy-specific semantics; this fence does not pin a manager
 * to a branch.
 */
export class ContextManager {
  private store: JsStore;
  private messageStore: MessageStore;
  private contextLog: ContextLog;
  private strategy: ContextStrategy;
  private membrane?: Membrane;
  private initializationAttempt = 0;
  private initializedAttempt: number | null = null;
  /** Whether we own the store (created it) vs app owns it (passed in) */
  private ownsStore: boolean;
  /** close() has run: the strategy is detached, and the manager refuses its operations (requireOpen). */
  private closed = false;
  /** Writes running (write()): their listeners can call close(). */
  private writeDepth = 0;
  /** A close() came from inside a write: the owned store closes when that write returns. */
  private storeCloseAfterWrite = false;
  private debugLogContext: boolean;
  /** Namespace passed to strategies for scoping their persistent state slots. */
  private strategyNamespace: string;
  /** stderr lines about this manager's work, each naming its namespace (#239). */
  private readonly diag: Diagnostics = namespaceDiagnostics(() => this.strategyNamespace);
  /** Strategy-facing exclusion predicate (see ContextManagerBaseConfig.viewFilter). */
  private viewFilter?: (message: StoredMessage) => boolean;
  /**
   * Compression holds (see holdCompression). Transient by design: never
   * persisted, so a restart can never leave compression permanently stalled.
   */
  private compressionHolds = new Set<MessageId>();
  /** Summaries the strategy rendered but couldn't describe, already reported. */
  private undescribedSummariesReported = new Set<string>();
  /** Sharded adds held on ingress: first-shard id -> every shard id. */
  private compressionHoldGroups = new Map<MessageId, MessageId[]>();
  /** heldAt / expiresAt per held id (expiresAt absent = no timeout). */
  private compressionHoldInfo = new Map<MessageId, CompressionHoldInfo>();
  private now: () => number = Date.now;
  /** Hold options + shared heldAt for the addMessage currently appending. */
  private holdingAddOptions: CompressionHoldOptions | undefined;
  private holdingAddAt = 0;
  /** Set while addMessage(..., { holdCompression: true }) appends. */
  private holdingAdds: MessageId[] | null = null;
  /** Read-only auxiliary stores merged into the strategy-facing view. */
  private auxiliaryStores: MessageStore[];
  /** Fold receipts for this manager's namespace (see fold-journal.ts). */
  private foldJournal: FoldJournal;

  private constructor(
    store: JsStore,
    messageStore: MessageStore,
    contextLog: ContextLog,
    strategy: ContextStrategy,
    ownsStore: boolean,
    strategyNamespace: string,
    membrane?: Membrane,
    debugLogContext = false,
    viewFilter?: (message: StoredMessage) => boolean,
    auxiliaryStores: MessageStore[] = [],
  ) {
    this.store = store;
    this.messageStore = messageStore;
    this.contextLog = contextLog;
    this.strategy = strategy;
    this.ownsStore = ownsStore;
    this.strategyNamespace = strategyNamespace;
    this.membrane = membrane;
    this.debugLogContext = debugLogContext;
    this.viewFilter = viewFilter;
    this.auxiliaryStores = auxiliaryStores;
    this.foldJournal = new FoldJournal(store, strategyNamespace);

    // Set up edit propagation
    this.messageStore.addListener((event) => this.handleMessageStoreEvent(event));
  }

  /**
   * The strategy-facing message view — the single choke point through which
   * every strategy read passes (compile, preview, render stats, and the
   * tick/onNewMessage StrategyContext). Composition order: merge auxiliary
   * slots into the timeline first, then apply the exclusion filter, so a
   * filter sees (and can exclude from) the merged world.
   */
  private strategyMessageView() {
    let view = this.mergedMessageView();
    if (this.viewFilter) {
      view = filterMessageStoreView(view, this.viewFilter);
    }
    // Live predicate (strategies capture views across long drains). Every
    // view built above is a fresh object, so this never leaks into a store.
    const holds = this.compressionHolds;
    view.isCompressionHeld = (id: MessageId) => holds.has(id);
    view.hasCompressionHolds = () => holds.size > 0;
    return view;
  }

  /** This manager's messages merged with its auxiliary slots, before the view filter. */
  private mergedMessageView(): MessageStoreView {
    return mergeMessageStoreViews(
      this.messageStore.createView(),
      this.auxiliaryStores.map((s) => s.createView()),
    );
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

    // Opening can fail from here on: a registration Chronicle refuses, a
    // configuration error, or a strategy that refuses the store (e.g.
    // StoreTopologyError). A store we opened must not stay locked behind a
    // rejected promise: release it, then rethrow.
    try {
      return await ContextManager.openOn(store, ownsStore, config);
    } catch (error) {
      if (ownsStore) {
        try { store.close(); } catch { /* the open error is the one to report */ }
      }
      throw error;
    }
  }

  private static async openOn(
    store: JsStore,
    ownsStore: boolean,
    config: ContextManagerConfig,
  ): Promise<ContextManager> {
    // Namespace for messages: only when `isolate` is true
    if (config.isolate && !config.namespace) {
      throw new Error('ContextManagerConfig: "isolate" requires "namespace" to be set');
    }
    const messageNamespace = config.isolate ? config.namespace : undefined;
    const messageSlot = MessageStore.registrationFor(messageNamespace).id;
    // The slot's lines name its namespace where it has one, as the store's own
    // do: an isolated slot is one agent's, and the shared slot no one's (#239).
    const slotLines: Diagnostics = messageNamespace
      ? namespaceDiagnostics(() => messageNamespace)
      : console;

    // Register states if needed. A slot that already exists is kept; any
    // other registration failure propagates (see isStateExistsFor).
    try {
      MessageStore.register(store, messageNamespace);
    } catch (error) {
      if (!isStateExistsFor(error, messageSlot)) throw error;
      // State already registered. Registrations persist in the store, so
      // on existing stores the snapshot cadence stays pinned to whatever
      // the FIRST registration said — retune it to the current constants
      // (chronicle >= 0.3.0; older builds lack the method, and for them
      // the old pinned cadence simply remains, as before).
      const upsert = (store as unknown as {
        updateStateStrategy?: (r: ReturnType<typeof MessageStore.registrationFor>) => void;
      }).updateStateStrategy;
      if (upsert) {
        try {
          const reg = MessageStore.registrationFor(messageNamespace);
          upsert.call(store, reg);
          // One line per boot — the rollout verification signal that the
          // retune actually applied to this (pre-existing) store.
          slotLines.error(
            `[message-store] snapshot cadence retuned: ${reg.id} -> ` +
            `delta ${reg.deltaSnapshotEvery} x full ${reg.fullSnapshotEvery}`,
          );
        } catch (err) {
          // Never fatal: a strategy-kind mismatch or transient store error
          // must not block opening the context manager. Like the line above,
          // it names the slot (#239). Console reads the message as a format
          // string when the error follows it, so a '%' in the slot is doubled
          // to print as itself.
          slotLines.error(`[message-store] snapshot-cadence retune failed for ${messageSlot.replaceAll('%', '%%')}:`, err);
        }
      }
    }

    try {
      ContextLog.register(store, config.namespace);
    } catch (error) {
      if (!isStateExistsFor(error, ContextLog.stateIdFor(config.namespace))) throw error;
    }

    // Namespace passed to strategies. Falls back to a stable per-store value
    // so strategies always have something to scope state IDs by, even when
    // the caller didn't supply a namespace.
    const strategyNamespace = config.namespace ?? 'default';
    registerBindingState(store, strategyNamespace);
    const messageStore = new MessageStore(store, {
      estimator: config.tokenEstimator,
      namespace: messageNamespace,
    });
    const contextLog = new ContextLog(store, {
      estimator: config.tokenEstimator,
      namespace: config.namespace,
    });
    const strategy = config.strategy ?? new PassthroughStrategy();

    // Auxiliary read-only slots for the strategy-facing merged view.
    // Registration is idempotent and harmless when the slot's writer has
    // not opened yet — an empty slot merges as nothing.
    //
    // Guard rails: an auxiliary entry that resolves to this manager's OWN
    // slot would merge every message twice (doubling token accounting,
    // silently), so it is refused; a slot listed twice is merged once.
    const ownSlotId = MessageStore.registrationFor(messageNamespace).id;
    const seenAuxSlots = new Set<string>();
    const auxiliaryStores = (config.auxiliaryMessageViews ?? []).flatMap((aux) => {
      const slotId = MessageStore.registrationFor(aux.namespace).id;
      if (slotId === ownSlotId) {
        throw new Error(
          `ContextManagerConfig.auxiliaryMessageViews: "${slotId}" is this manager's own ` +
          `message slot (namespace ${JSON.stringify(aux.namespace ?? null)}); merging it ` +
          `would duplicate every message. Auxiliary views must name other writers' slots.`,
        );
      }
      if (seenAuxSlots.has(slotId)) return [];
      seenAuxSlots.add(slotId);
      try {
        MessageStore.register(store, aux.namespace);
      } catch (error) {
        if (!isStateExistsFor(error, slotId)) throw error;
      }
      return [new MessageStore(store, {
        estimator: config.tokenEstimator,
        namespace: aux.namespace,
      })];
    });

    const manager = new ContextManager(
      store,
      messageStore,
      contextLog,
      strategy,
      ownsStore,
      strategyNamespace,
      config.membrane,
      config.debugLogContext ?? false,
      config.viewFilter,
      auxiliaryStores,
    );
    if (config.now) manager.now = config.now;

    try {
      await manager.initializeStrategy();
    } catch (error) {
      // open() fails with the manager unreturned, so nothing could close()
      // it: the strategy is let go of here, as close() would.
      manager.detachStrategy(manager.strategy);
      throw error;
    }
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
   *
   * `options.holdCompression` places a compression hold (see
   * holdCompression) on the new message BEFORE the strategy's onNewMessage
   * fires, so not even the ingress chunk rebuild can fold it. Release it
   * with releaseCompression([returnedId]) (releases every shard).
   */
  addMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata,
    causedBy?: MessageId[],
    options?: AddMessageOptions
  ): MessageId {
    // A closed manager refuses the add by name, before its content or hold
    // options are read.
    this.requireOpen('addMessage');
    // First, so a message refused here changes nothing: no hold expires, no
    // hold is placed, and the strategy's ingress chunking never reads it.
    // What a write mends is mended here, so the strategy chunks what is
    // stored (well-formed-content.ts). A shard of that chunking is checked
    // later (appendMessage), once expired holds have been released, as at
    // any add.
    content = contentForWrite(content, 'Message refused');
    return this.write(() => {
      this.expireCompressionHolds();
      if (!options?.holdCompression) {
        return this.appendMessage(participant, content, metadata, causedBy);
      }
      const holdOptions = options.holdCompression === true ? {} : options.holdCompression;
      this.validateHoldOptions(holdOptions);
      const held: MessageId[] = [];
      this.holdingAdds = held;
      this.holdingAddOptions = holdOptions;
      // One clock read per add: every shard shares heldAt and expiresAt.
      this.holdingAddAt = this.now();
      let id: MessageId;
      try {
        id = this.appendMessage(participant, content, metadata, causedBy);
      } finally {
        this.holdingAdds = null;
        this.holdingAddOptions = undefined;
      }
      if (held.length > 1) this.compressionHoldGroups.set(id, held);
      return id;
    });
  }

  private appendMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata,
    causedBy?: MessageId[]
  ): MessageId {
    this.requireInitialized('addMessage');
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
        // Every shard declares its group's size, so a group an interrupted
        // write left short reads as partial, not whole (compile provenance).
        // That needs indices exactly 0..n-1: refuse anything else before
        // writing a shard.
        const shardCount = decision.shards.length;
        const indices = new Set(decision.shards.map((s) => s.shardIndex));
        if (indices.size !== shardCount || ![...indices].every((i) => Number.isInteger(i) && i >= 0 && i < shardCount)) {
          throw new Error(
            `chunkIngressMessage returned shard indices ${JSON.stringify(decision.shards.map((s) => s.shardIndex))}; ` +
              `a group of ${shardCount} shards needs each index 0..${shardCount - 1} exactly once`,
          );
        }
        // Shards are written in index order, so the id returned (the first
        // written) is shard 0's: the body's identity in compile provenance.
        const ordered = [...decision.shards].sort((a, b) => a.shardIndex - b.shardIndex);
        // A shard that doesn't match is refused before any shard is stored,
        // as the message was: the store's own refusal would meet it only once
        // the shards before it were stored. The error names the shard, since
        // the message as given was refused by nothing.
        for (const shard of decision.shards) {
          const places = malformedContentPlaces(shard.content);
          if (places.length > 0) {
            throw new MalformedContentError(`Shard ${shard.shardIndex} of the message, as the strategy chunked it, refused`, places);
          }
        }
        let firstId: MessageId | null = null;
        const lengthBefore = this.messageStore.length();
        // These appends must stay synchronous: one body's shards in one loop, in
        // shard order, with no await between them. The body-runs rule (body-runs.ts)
        // reads a body as consecutive messages of one group id whose shard indices
        // rise, so a body's shards must land together: a message appended between
        // them would split the body. Nothing in context-manager appends a message
        // anywhere but here and below, so nothing of its own can. A host's
        // onMessage listener runs inside each append, and its contract rules out
        // adding a message from there synchronously.
        try {
          for (const shard of ordered) {
            const message = this.messageStore.append(
              participant,
              shard.content,
              metadata,
              causedBy,
              {
                bodyGroupId: decision.bodyGroupId,
                shardIndex: shard.shardIndex,
                shardCount,
              }
            );
            if (firstId === null) firstId = message.id;
          }
        } catch (err) {
          // A write that fails partway leaves no part of the body in the
          // store: remove what it wrote (the failing shard too, if it
          // landed), so a retry writes one body. If that fails as well, the
          // shards may stay, and shardCount marks the body short. The first
          // shard's own append can throw after it landed: then it's the
          // store's last. Nothing here replaces the write's own error.
          let landed = firstId;
          try {
            if (landed === null && this.messageStore.length() > lengthBefore) {
              const last = this.messageStore.getTail(1)[0];
              if (last?.bodyGroupId === decision.bodyGroupId) landed = last.id;
            }
            if (landed !== null) this.messageStore.removeBodyGroup(landed);
          } catch (removal) {
            this.diag.error(
              `[context-manager] a sharded addMessage failed partway, and removing what it wrote threw, so body group ` +
                `${decision.bodyGroupId}${landed !== null ? ` (first shard ${landed})` : ''} may be left short: ` +
                describeThrown(removal),
            );
          }
          throw err;
        }
        return firstId!;
      }
    }
    const message = this.messageStore.append(participant, content, metadata, causedBy);
    return message.id;
  }

  /**
   * Edit a message in the store. Propagates to context log based on source relation.
   *
   * Edits do not reach `derived` entries and do not notify the strategy: a
   * summary already built from the old content keeps it. To replace content
   * that must reach compressed memory, hold the message (holdCompression /
   * addMessage `holdCompression`) until after the edit.
   */
  editMessage(messageId: MessageId, content: ContentBlock[]): void {
    this.requireInitialized('editMessage');
    this.write(() => this.messageStore.edit(messageId, content));
    // Propagation handled by event listener
  }

  // ==========================================================================
  // Compression holds
  // ==========================================================================

  /**
   * Keep messages out of compression until released.
   *
   * While any message is held, strategies that compress (Autobiographical and
   * subclasses) treat the earliest held message as the start of the protected
   * recent window: it, everything after it, and the tool_use it answers stay
   * raw and are never cut into a compressible chunk. History before it
   * compresses normally. Rendering is unaffected apart from that longer raw
   * tail.
   *
   * Intended for content that is provisional and will be replaced with
   * editMessage (e.g. a tool_result staged with a placeholder): edits never
   * reach `derived` context entries or summaries, so an edit is only safe
   * while the message is held — edit first, then release.
   *
   * Holds are in-memory only and are not persisted; a reopened manager starts
   * with none. Unknown ids are ignored. Removing a message drops its hold.
   * A hold that is never released stalls compression of everything after it,
   * so callers must release on every settle path — or pass `timeoutMs`.
   *
   * `options.timeoutMs`: the hold is released automatically once it has been
   * in place that long (checked lazily on tick(), compile() and hold queries;
   * no timer is armed). Expiry releases exactly like releaseCompression —
   * the strategy is notified — and logs a warning naming the ids and how
   * long they were held. Without `timeoutMs` a hold never expires.
   *
   * Deadlines are per message id. One call (or one sharded addMessage) reads
   * the clock once, so every id it holds shares one deadline; expiry releases
   * only the ids whose own deadline passed (it never expands to a shard
   * group, unlike an explicit releaseCompression of the add's id).
   *
   * Re-holding an already-held id REPLACES its hold: `heldAt` resets to now
   * and the new options apply — a timeout restarts (refresh/extend/shorten),
   * and re-holding without `timeoutMs` makes it indefinite.
   */
  holdCompression(messageIds: Iterable<MessageId>, options?: CompressionHoldOptions): void {
    this.validateHoldOptions(options);
    const heldAt = this.now(); // one deadline per call
    for (const id of messageIds) {
      if (this.messageStore.get(id)) this.placeHold(id, options, heldAt);
    }
  }

  private validateHoldOptions(options?: CompressionHoldOptions): void {
    const t = options?.timeoutMs;
    if (t !== undefined && !(Number.isFinite(t) && t > 0)) {
      throw new Error(`holdCompression: timeoutMs must be a positive finite number (got ${t})`);
    }
  }

  private placeHold(id: MessageId, options: CompressionHoldOptions | undefined, heldAt: number): void {
    this.compressionHolds.add(id);
    this.compressionHoldInfo.set(id, options?.timeoutMs !== undefined
      ? { heldAt, expiresAt: heldAt + options.timeoutMs }
      : { heldAt });
  }

  /**
   * Release holds whose timeout has passed (lazy; called from tick, compile
   * and hold queries). Also drops bookkeeping for holds removed elsewhere.
   */
  private expireCompressionHolds(): void {
    if (this.compressionHoldInfo.size === 0) return;
    const now = this.now();
    const expired: Array<{ id: MessageId; heldFor: number }> = [];
    for (const [id, info] of this.compressionHoldInfo) {
      if (!this.compressionHolds.has(id)) { this.compressionHoldInfo.delete(id); continue; }
      if (info.expiresAt !== undefined && now >= info.expiresAt) {
        expired.push({ id, heldFor: now - info.heldAt });
      }
    }
    if (expired.length === 0) return;
    this.diag.warn(
      `[context-manager] compression hold timeout: releasing ${expired.length} hold(s) — ` +
        expired.map((e) => `${e.id} (held ${e.heldFor}ms)`).join(', '),
    );
    // Per-id deadlines: release exactly the expired ids. Unlike an explicit
    // releaseCompression of a sharded add's id, this does NOT expand to the
    // whole shard group — a shard whose hold was re-placed (extended) keeps
    // it. Shards of one add share a deadline, so they expire together.
    for (const { id } of expired) {
      this.compressionHolds.delete(id);
      this.compressionHoldInfo.delete(id);
    }
    for (const [key, members] of [...this.compressionHoldGroups]) {
      if (!members.some((mid) => this.compressionHolds.has(mid))) this.compressionHoldGroups.delete(key);
    }
    this.notifyHoldsReleased();
  }

  /**
   * Release compression holds. Idempotent; unknown ids are ignored. Releasing
   * the id returned by a sharded addMessage releases every shard. Releasing
   * notifies the strategy (onCompressionHoldsReleased), which re-queues the
   * deferred chunks so the next tick — or the auto-tick drain — compresses
   * the now-final content.
   */
  releaseCompression(messageIds: Iterable<MessageId>): void {
    const before = this.compressionHolds.size;
    for (const id of messageIds) {
      const group = this.compressionHoldGroups.get(id);
      if (group) {
        for (const member of group) {
          this.compressionHolds.delete(member);
          this.compressionHoldInfo.delete(member);
        }
        this.compressionHoldGroups.delete(id);
      }
      this.compressionHolds.delete(id);
      this.compressionHoldInfo.delete(id);
    }
    if (this.compressionHolds.size !== before) this.notifyHoldsReleased();
  }

  /** Set when a hold went away while the strategy was (re)initializing. */
  private holdReleaseNotifyPending = false;

  /**
   * Tell the strategy holds went away (release or removal) so it re-queues
   * deferred work. Never throws into the caller (a settle path); while the
   * strategy is initializing, the notification is deferred until it is
   * ready rather than dropped.
   */
  private notifyHoldsReleased(): void {
    if (!this.strategy.onCompressionHoldsReleased || this.closed) return;
    if (this.initializedAttempt !== this.initializationAttempt) {
      this.holdReleaseNotifyPending = true;
      return;
    }
    this.holdReleaseNotifyPending = false;
    try {
      this.strategy.onCompressionHoldsReleased(this.createStrategyContext());
    } catch (err) {
      // Holds are already gone; the strategy's next rebuild (addMessage,
      // compile) re-queues the work.
      this.diag.error('Strategy onCompressionHoldsReleased failed:', err);
    }
  }

  /** Currently held message ids (snapshot; expired timed holds released first). */
  getCompressionHolds(): ReadonlySet<MessageId> {
    this.expireCompressionHolds();
    return new Set(this.compressionHolds);
  }

  /**
   * Currently held message ids with `heldAt` and, for timed holds,
   * `expiresAt` (snapshot; expired timed holds released first).
   */
  getCompressionHoldDetails(): ReadonlyMap<MessageId, CompressionHoldInfo> {
    this.expireCompressionHolds();
    const out = new Map<MessageId, CompressionHoldInfo>();
    for (const id of this.compressionHolds) {
      const info = this.compressionHoldInfo.get(id);
      out.set(id, info ? { ...info } : { heldAt: 0 });
    }
    return out;
  }

  /**
   * Remove a message from the store. Propagates to context log.
   */
  removeMessage(messageId: MessageId): void {
    this.requireInitialized('removeMessage');
    this.write(() => this.messageStore.remove(messageId));
    // Propagation handled by event listener
  }

  /**
   * Remove a range of messages from the store.
   */
  removeMessages(fromId: MessageId, toId: MessageId): void {
    this.requireInitialized('removeMessages');
    this.write(() => this.messageStore.removeRange(fromId, toId));
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
   *
   * A listener runs synchronously inside the write that emitted its event,
   * so it can run while a sharded addMessage is still storing that body's
   * remaining shards. It must not add a message synchronously: one added there
   * would land between a body's shards and split the body (body-runs.ts).
   * Add it after the call returns (a microtask or later) instead. A listener
   * that throws is logged, naming the message it missed, and the write it
   * heard stands: the throw doesn't reach the caller. A listener that calls
   * close() lets the write that ran it finish (see close()). Each call
   * registers its own listener and returns its own unsubscribe, so a function
   * registered twice hears each event twice.
   */
  onMessage(listener: MessageStoreListener): () => void {
    // A host's listener observes; its throw isn't the write's failure. The
    // manager's own listener (the context log's propagation) stays outside
    // this, so a failure there still fails the write as before.
    return this.messageStore.addListener((event) => {
      try {
        listener(event);
      } catch (err) {
        logThrown(`[context-manager] an onMessage listener threw on a '${event.type}' event for ${describeStoreEvent(event)}; the write stands:`, err, this.diag);
      }
    });
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

  /**
   * Query messages by timestamp range — O(log n + k) via chronicle's native
   * `/timestamp` secondary index, not a full scan. Throws if the underlying
   * chronicle build predates the field-index capability. See
   * MessageStore.queryByTime for the exact semantics (inclusive bounds,
   * page-size-only `matchedCount`).
   */
  queryMessagesByTime(opts: TimeRangeQueryOptions): IndexedMessageQueryResult {
    return this.messageStore.queryByTime(opts);
  }

  /**
   * Query messages by exact external channel id — via chronicle's native
   * `/metadata/external/channelId` secondary index. See
   * MessageStore.queryByChannel.
   */
  queryMessagesByChannel(channelId: string, opts?: ChannelQueryOptions): IndexedMessageQueryResult {
    return this.messageStore.queryByChannel(channelId, opts);
  }

  /**
   * Query messages matching both a timestamp range and a channel. See
   * MessageStore.queryByTimeAndChannel for why this needs the two native
   * ordinal sets fetched uncapped and intersected before paginating.
   */
  queryMessagesByTimeAndChannel(opts: TimeAndChannelQueryOptions): IndexedMessageQueryResult {
    return this.messageStore.queryByTimeAndChannel(opts);
  }

  /**
   * Distinct channel ids and their message counts, native and instant
   * (O(index size), no content decoding). See MessageStore.getChannelCounts.
   */
  getChannelMessageCounts(): ChannelCount[] {
    return this.messageStore.getChannelCounts();
  }

  /**
   * Aggregate message counts and token estimates by channel, optionally
   * restricted to a timestamp range. See MessageStore.getChannelTokenStats.
   */
  getChannelTokenStats(opts?: ChannelTokenStatsOptions): ChannelTokenStats {
    return this.messageStore.getChannelTokenStats(opts);
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
    this.requireInitialized('branchAt');
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
   *
   * Transitions are nontransactional: if initialization rejects, the selected
   * branch and any initialization writes remain. Inspect currentBranch();
   * mutations and strategy operations stay blocked until a successful
   * switchBranch() or setStrategy(). Inspection and close remain available.
   * If a newer initialization supersedes this one, the call rejects with
   * InitializationSupersededError naming the branch it selected.
   */
  async switchBranch(branchId: string): Promise<void> {
    this.requireOpen('switchBranch');
    await this.selectBranch(branchId, false);
  }

  private async selectBranch(name: string, created: boolean): Promise<void> {
    this.store.switchBranch(name);
    const requested = markStoreBranchSwitch(this.store);
    await this.initializeStrategy(requested, { branch: requested.name, created });
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
   * new branch so it picks up the forked state. If initialization rejects,
   * the new branch remains present and selected unless another operation
   * switches it. The same recovery contract as switchBranch() applies. If a
   * newer initialization supersedes this one, the call rejects with
   * InitializationSupersededError naming the branch it created, so a caller
   * never retries a fork to learn whether it happened.
   */
  async fork(name?: string): Promise<string> {
    this.requireInitialized('fork');
    const branchName = name ?? `fork-${Date.now()}`;
    const currentBranch = this.store.currentBranch();
    const currentSeq = this.store.currentSequence();
    const branch = this.store.createBranchAt(branchName, currentBranch.name, currentSeq);
    await this.selectBranch(branch.name, true);
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
    this.requireInitialized('isReady');
    return this.strategy.checkReadiness().ready;
  }

  /**
   * Get info about pending background work.
   */
  getPendingWork(): PendingWork | null {
    this.requireInitialized('getPendingWork');
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
   * - "beforeUser": inserted before the last user message, or, when the
   *   messages hold none, at the end, ahead of any "afterUser" injections
   * - "afterUser": inserted after the last user message, or at the end when
   *   the messages hold none
   *
   * With `opts.thinkingBinding.binds`, it then leaves out the thinking a
   * model that binds thinking can no longer take, injections placed (see
   * `SelectOptions.thinkingBinding`).
   *
   * May block if strategy has pending work.
   */
  async compile(
    budget?: TokenBudget,
    injections?: ContextInjection[],
    opts?: SelectOptions
  ): Promise<CompileResult> {
    this.requireInitialized('compile');
    // Before anything is selected or committed: a compile refused here leaves
    // nothing behind.
    if (opts?.thinkingBinding?.binds === true) refuseUnboundBinding(opts);
    this.expireCompressionHolds();
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

    const _diag = typeof process !== 'undefined' && !!process.env?.CM_CACHE_DIAG;
    const _t0 = _diag ? Date.now() : 0;

    // The branch and view this compile reads; provenance binds to both.
    const branch = branchRefOf(this.store);
    const view = this.strategyMessageView();

    // Get selected entries from strategy
    const entries = this.strategy.select(
      view,
      this.contextLog.createView(),
      effectiveBudget,
      opts
    );
    const selectionCause = this.strategy.takeSelectionCause?.();
    // Read now, before anything else selects: these are this select's own.
    const renderStats = isRenderStatsCapable(this.strategy) ? this.strategy.getLastSelectStats?.() ?? null : null;
    if (_diag) this.diag.error(`[cm-cache] compile: select ${Date.now() - _t0}ms (${entries.length} entries)`);

    const viewMessages = view.getAll();
    // Raw bodies are judged as stored: the view filter can hide a shard of a
    // body from the strategy, but the body's identity (shard 0, the id
    // addMessage returned) and its membership are the stored group's. The
    // layout stays on the filtered view the strategy rendered. Attribution
    // reads only around the messages the raw entries name, and a lookup
    // asks for a sequence, not the message (#273).
    const storedView = this.viewFilter ? this.mergedMessageView() : view;
    const storedMessages = this.viewFilter ? storedView.getAll() : viewMessages;
    const sequenceOf = storedView.sequenceOf
      ? (id: MessageId) => storedView.sequenceOf!(id)
      : (id: MessageId) => storedView.get(id)?.sequence;
    const attribution = attributeEntries(entries, storedMessages, sequenceOf);

    // Convert to NormalizedMessage[]. We split each entry individually
    // so we know the output-count per input and can re-attach cache
    // markers to the last output of each (matching the marker's
    // "cache up to here" intent).
    //
    // Splitting handles the claude.ai bundled-tool-cycle artifact: a
    // non-user message containing `tool_result` blocks becomes a sequence
    // of agent/user/agent turns so the API accepts it. Already-API-shape
    // messages pass through untouched. See `src/normalize-tool-messages.ts`.
    // Every part of a split entry carries that entry's sources.
    const messages: NormalizedMessage[] = [];
    const messageSources: CompiledMessageSources[] = [];
    for (let e = 0; e < entries.length; e++) {
      const entry = entries[e]!;
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
        messageSources.push(attribution.sources[e]!);
      }
    }

    const finish = (result: CompileResult, injected: ContentBlock[][]): CompileResult => {
      const rawBodies = rawBodiesOf(attribution);
      const compileId = randomUUID();
      const binding = opts?.thinkingBinding?.binds === true
        ? this.bindThinkingIn(result, messageSources, opts, compileId)
        : null;
      result.rawBodies = rawBodies;
      if (renderStats) result.renderStats = renderStats;
      // A body sent without its thinking isn't carried whole, and the layout
      // prices what was sent: thinking only where a stored body kept it.
      let layoutEntries = entries;
      let layoutInjected = injected;
      let rawComplete = attribution.rawComplete;
      if (binding) {
        const without = new Set(binding.record.without);
        if (without.size > 0) {
          markThinkingLeftOut(messageSources, without);
          // Keyed by each stored member of a body, as attribution keys it.
          const complete = new Map(rawComplete);
          for (const id of without) {
            for (const member of rawBodies.get(id) ?? []) if (complete.has(member.id)) complete.set(member.id, false);
          }
          rawComplete = complete;
        }
        // Each entry keeps the thinking the compile sent of it: an entry the
        // compile splits (a bundled tool cycle) is bound part by part, so one
        // part can keep what another leaves out. The record's `without` is
        // per body, so from the next compile such a body goes without whole.
        const sent = thinkingSent(result.messages);
        layoutEntries = entries.map((entry) => {
          const content = thinkingAsSent(entry.content, sent);
          return content === entry.content ? entry : { ...entry, content };
        });
        layoutInjected = injected.map((content) => (content.some(isThinkingBlock) ? withoutThinking(content) : content));
      }
      const layout = this.renderedLayoutFor(viewMessages, layoutEntries, rawComplete, layoutInjected, selectionCause);
      result.provenance = {
        compileId,
        namespace: this.strategyNamespace,
        branch,
        messages: messageSources,
        layout,
        strategy: this.strategy.name,
        // Only a layout is ever accepted, so only then ask where the journal stands.
        ...(layout ? { journalMark: this.foldJournal.mark() } : {}),
      };
      if (this.debugLogContext) this.logCompiledContext(result);
      // Last, once nothing of the compile can still fail: what a committing
      // compile leaves behind for the next one.
      if (opts?.dryRun !== true) {
        if (binding) {
          // Nothing here fails the compile: a record it can't write leaves
          // the one before, if any, which this compile's stream can't note
          // onto, so what it sends past that record goes without its
          // thinking. The strategy's note only adjusts its calibration, so a
          // strategy that throws there is logged and the compile stands too.
          this.writeBindingRecordFor(
            binding.record,
            'this compile\'s stream can\'t note onto the record before it, if any, so its replies go without their thinking until a compile with binds writes the record',
          );
          if (binding.leftOut.length > 0) {
            try {
              this.strategy.noteThinkingLeftOut?.(binding.leftOut);
            } catch (err) {
              this.diag.error('[context-manager] the strategy failed to take note of thinking left out:', describeThrown(err));
            }
          }
        }
        // A compile without binds neither reads nor writes the record. One an
        // earlier binding compile left is compared at the next binding compile
        // like any other: a message keeps its thinking only while everything
        // up to it matches what that compile sent and its stream noted, a
        // prefix the provider took with that thinking, and nothing past the
        // record's end keeps it.
      }
      return result;
    };

    // If no injections, log and return early
    if (!injections || injections.length === 0) {
      return finish({ messages, systemInjections: [] }, []);
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

    const injectedContent: ContentBlock[][] = [];
    const injectionSources = (list: ContextInjection[]): CompiledMessageSources[] =>
      list.map((inj) => ({ kind: 'injection', namespace: inj.namespace }));

    // Insert beforeUser injections before the last user message. Messages
    // with none take them at the end, as afterUser's fallback below does, so
    // afterUser's land after them.
    if (beforeUser.length > 0) {
      const insertIdx = lastUserIdx >= 0 ? lastUserIdx : messages.length;
      const injectedMessages: NormalizedMessage[] = beforeUser.map((inj) => ({
        participant: `system_context:${inj.namespace}`,
        content: inj.content,
      }));
      messages.splice(insertIdx, 0, ...injectedMessages);
      messageSources.splice(insertIdx, 0, ...injectionSources(beforeUser));
      injectedContent.push(...beforeUser.map((inj) => inj.content));
      // Adjust lastUserIdx to account for inserted messages
      if (lastUserIdx >= 0) lastUserIdx += injectedMessages.length;
    }

    // Insert afterUser injections after the last user message. Messages with
    // none take them at the end, after the beforeUser injections placed there.
    if (afterUser.length > 0) {
      const insertIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : messages.length;
      const injectedMessages: NormalizedMessage[] = afterUser.map((inj) => ({
        participant: `system_context:${inj.namespace}`,
        content: inj.content,
      }));
      messages.splice(insertIdx, 0, ...injectedMessages);
      messageSources.splice(insertIdx, 0, ...injectionSources(afterUser));
      injectedContent.push(...afterUser.map((inj) => inj.content));
    }

    return finish({ messages, systemInjections }, injectedContent);
  }

  /**
   * Leave out of `result.messages` the thinking the branch's record says a
   * binding model can no longer take, and report it (see
   * `SelectOptions.thinkingBinding`). Returns what a committing compile then
   * leaves behind: the record, and the stored thinking it left out.
   */
  private bindThinkingIn(
    result: CompileResult,
    sources: readonly CompiledMessageSources[],
    opts: SelectOptions,
    compileId: string,
  ): BindOutcome {
    const record = this.readBindingRecordFor('this compile goes on as if the branch had no record, and if it commits, its record takes that one\'s place');
    const outcome = bindThinking({
      messages: result.messages,
      sources,
      record,
      dropBlock: opts.thinkingBinding?.dropBlock === true,
      // Checked at the compile's start (refuseUnboundBinding).
      identity: opts.identity!,
      participant: opts.thinkingBinding!.participant!,
      sequence: this.store.currentSequence(),
      compileId,
    });
    result.messages = outcome.messages;
    if (outcome.strip) result.thinkingStrip = outcome.strip;
    result.thinkingRecordedAfter = outcome.record.recordedAfter;
    return outcome;
  }

  /**
   * The rendered layout of one compile, or null when the strategy does not
   * report its layout, or names a summary it cannot describe (a layout that
   * would read covered history as omitted is worse than none).
   */
  private renderedLayoutFor(
    viewMessages: StoredMessage[],
    entries: ContextEntry[],
    rawComplete: ReadonlyMap<MessageId, boolean>,
    injected: ContentBlock[][],
    cause: string | undefined,
  ): RenderedLayout | null {
    if (!this.strategy.renderedForms) return null;
    const summaryIds = new Set<string>();
    for (const entry of entries) for (const s of entry.summaries ?? []) summaryIds.add(s.id);
    const summaryInfo = summaryIds.size > 0
      ? this.strategy.describeRenderedSummaries?.([...summaryIds]) ?? new Map<string, RenderedSummaryInfo>()
      : new Map<string, RenderedSummaryInfo>();
    const undescribed = [...summaryIds].filter((id) => !summaryInfo.has(id));
    if (undescribed.length > 0) {
      const fresh = undescribed.filter((id) => !this.undescribedSummariesReported.has(id));
      if (fresh.length > 0) {
        for (const id of fresh) this.undescribedSummariesReported.add(id);
        this.diag.warn(
          `[context-manager] ${this.strategy.name} rendered summaries it cannot describe ` +
          `(${fresh.slice(0, 5).join(', ')}${fresh.length > 5 ? ', …' : ''}); ` +
          'no rendered layout is reported for a compile that renders them',
        );
      }
      return null;
    }
    // Estimators are store-level: the strategy view's estimates and its
    // calibration are this store's (auxiliary slots delegate to it). Layouts
    // keep base estimates, taken before the calibration multiplier and its
    // per-block rounding, so identical content costs the same in every
    // compile whatever the calibration was.
    const calibration = this.messageStore.getTokenCalibration();
    const factor = Number.isFinite(calibration) && calibration > 0 ? calibration : 1;
    const estimateBase = (content: ContentBlock[]): number => this.messageStore.estimateBaseTokens(content);
    let extraTokens = 0;
    for (const content of injected) extraTokens += estimateBase(content);
    return buildRenderedLayout({
      view: viewMessages,
      entries,
      rawComplete,
      summaryInfo,
      estimateBase,
      extraTokens,
      calibration: factor,
      cause,
    });
  }

  // ==========================================================================
  // Accepted rounds and fold receipts
  // ==========================================================================

  /**
   * Accept a compile whose provider round succeeded. Call once a round that
   * carried `provenance`'s messages has stood. A compile is accepted once:
   * repeat calls (later rounds of the same compile, or a retry after an
   * uncertain failure, from this manager or another of its namespace on the
   * store, before or after a reopen) are no-ops. Compares the compile's
   * rendered layout with the last layout accepted on the compile's own branch
   * in its namespace, by any manager of it on the store — even when another
   * branch is selected by now — and appends a fold receipt when any message
   * changed form, or a baseline when that branch has no record it can read.
   * `usage` is the confirming round's own usage as the provider reported it;
   * leave a field undefined when it was not reported. `presentation` is how
   * that round carried the compile, as its producer reported (`verbatim`,
   * `altered`, or `unknown`, the default); receipts record it beside the
   * layout, which is the compile's.
   *
   * Returns the receipt, or null: no change, or a compile with no layout to
   * record (`provenance.layout` is null): a strategy that doesn't report its
   * layout, or one that rendered a summary it can't describe, reported once
   * per summary. Nothing is recorded for such a compile, so the next one
   * accepted is compared with the last layout recorded before it, and its
   * receipt carries the changes of both rounds. A compile accepted before
   * returns what that acceptance returned, its receipt or null, so a retry
   * after an uncertain failure learns the outcome, and a receipt can come
   * back again (key on its id and compileId: a receipt lost to Chronicle's
   * rot exception can have its id go to a later receipt). A provenance of
   * another namespace is refused with an error, and so is one whose branch
   * this store doesn't know, live or recorded in this namespace, such as
   * another store's: accept a compile on the manager that compiled it. So is
   * a layout whose shape changed after compile returned it: members out of
   * order, unit counts that aren't positive whole numbers adding up to the
   * members, or not one id for each member.
   */
  acceptRound(args: {
    provenance: CompileProvenance;
    acceptedAt?: number;
    usage?: RoundUsage;
    presentation?: Presentation;
  }): FoldReceipt | null {
    this.requireOpen('acceptRound');
    return this.write(() => this.foldJournal.accept(args.provenance, args.acceptedAt ?? Date.now(), args.usage, args.presentation));
  }

  /**
   * Fold receipts of one branch (default: the selected one): newest first,
   * or, with `afterId`, oldest first from just after it, so a reader can page
   * forward; `more` says whether the query matched more than it returned.
   */
  listFoldReceipts(query?: FoldQuery): FoldQueryResult {
    return this.foldJournal.query(query);
  }

  /**
   * Be told of fold receipts, each once it is durable: every receipt this
   * manager's `acceptRound` returns, and, at its next acceptance on a
   * branch, that branch's newest receipt if this manager hasn't announced it
   * (one whose write reported a failure, one another manager on the store
   * wrote, or one from before a reopen). So a listener can hear a receipt
   * again, and needn't hear every receipt: key on `receipt.id`, and read
   * `listFoldReceipts` for the whole record. A listener that calls close()
   * lets the acceptance that announced to it commit its receipt (see
   * close()). Returns a detacher.
   */
  onFoldReceipt(listener: (receipt: FoldReceipt) => void): () => void {
    return this.foldJournal.onReceipt(listener);
  }

  /** Deployment facts recorded in every receipt from now on. */
  setReceiptSource(source: ReceiptSource): void {
    this.foldJournal.setSource(source);
  }

  /**
   * The store's id, minted once per store on first use. After close() it is
   * never minted, since minting writes the store's identity record: it is
   * answered when it was read before, or, while the store is open, read from
   * that record. Otherwise it refuses by name: on a store that has none, and
   * on a closed store with none read before.
   */
  getStoreId(): string {
    if (this.closed) {
      const id = this.store.isClosed() ? cachedStoreIdentity(this.store) : existingStoreIdentity(this.store);
      return id ?? this.refuseAfterClose('getStoreId');
    }
    return this.foldJournal.storeId();
  }

  /** The selected branch as receipts name it (id, name, creation time). */
  currentBranchRef(): BranchRef {
    return branchRefOf(this.store);
  }

  /**
   * How the active strategy can render history, for an honest answer when
   * there are no receipts: which forms it uses, or null when it does not
   * report its rendered layout at all.
   */
  describeRenderedForms(): { strategy: string; forms: ReadonlyArray<'raw' | 'summary' | 'omitted'> | null } {
    return { strategy: this.strategy.name, forms: this.strategy.renderedForms ?? null };
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
      namespace: this.strategyNamespace,
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
   * Set the context management strategy and initialize it on the selected branch.
   * The strategy it replaces is detached first (ContextStrategy.detach).
   * Also recovers a manager after failed initialization. A failure leaves the
   * manager's operations fenced until another successful initialization, with
   * the strategy still held; it does not restore the old strategy.
   */
  async setStrategy(strategy: ContextStrategy): Promise<void> {
    this.requireOpen('setStrategy');
    if (strategy !== this.strategy) this.detachStrategy(this.strategy);
    this.strategy = strategy;
    await this.initializeStrategy();
  }

  /** Tell a strategy the manager is done with it (ContextStrategy.detach). */
  private detachStrategy(strategy: ContextStrategy): void {
    // The manager lets go either way: a replacement still initializes and
    // close() still closes the store.
    const failed = (err: unknown) => this.diag.error('Strategy detach failed:', strategy.name, err);
    try {
      // detach() is synchronous by contract. A promise or other thenable one
      // returns anyway isn't awaited, and its rejection is logged rather than
      // left unhandled.
      const returned = strategy.detach?.() as unknown;
      if (typeof (returned as PromiseLike<unknown> | null | undefined)?.then === 'function') {
        Promise.resolve(returned as PromiseLike<unknown>).catch(failed);
      }
    } catch (err) {
      failed(err);
    }
  }

  /**
   * Get the current strategy.
   */
  getStrategy(): ContextStrategy {
    return this.strategy;
  }

  /**
   * What the next compile sends for each of `ids`, messages this manager
   * stores, such as ones it has just stored or the rows a stream has sent
   * (`noteRequestSent`), in the form the compile sends each, wherever it
   * places it (see `ContextStrategy.renderAsNewest`), before any thinking
   * the thinking binding leaves out (`SelectOptions.thinkingBinding`). Give
   * each message by the id
   * `addMessage` returned. For a body stored as shards that's its first
   * shard's, which stands for the whole body where the compile joins its
   * shards; where the compile sends each shard on its own, an id gives back
   * its own shard.
   * Undefined when the strategy has no such hook, so a caller appends the
   * content as stored. An id comes back as null only when the next compile
   * doesn't send that message, such as one the view filter leaves out. A
   * strategy's own doc names where its compile still sends a message
   * otherwise than its render, as the memory strategy's does for a message
   * a summary covers and a body whose shards it doesn't send together.
   * Tool blocks come back as the per-message cap leaves them, so for a
   * message that holds them the compile can send something else, as the
   * strategy's doc says; and the manager sends a message other than a
   * user's that holds a `tool_result` as several turns
   * (`splitMixedToolMessages`), where the render gives one array. It throws
   * for an id no stored message has, before
   * the strategy has initialized, and where the strategy's select would
   * throw first, as the autobiographical strategy does on a branch it
   * hasn't loaded. It releases no compression hold: where a message's
   * window starts doesn't change the form it's rendered in.
   */
  renderAsNewest(ids: readonly MessageId[]): Array<ContentBlock[] | null> | undefined {
    this.requireInitialized('renderAsNewest');
    const stored = this.mergedMessageView();
    const unknown = ids.filter((id) => stored.get(id) === null);
    if (unknown.length > 0) {
      throw new Error(
        `ContextManager.renderAsNewest: no stored message has id ${unknown.join(', ')}; ` +
          'give each message by the id addMessage returned for it',
      );
    }
    if (typeof this.strategy.renderAsNewest !== 'function') return undefined;
    return this.strategy.renderAsNewest(this.strategyMessageView(), ids);
  }

  /**
   * Note what a stream built from this branch's last committing compile with
   * `binds` sent
   * after the compiled messages (see `SelectOptions.thinkingBinding`): as it
   * sends each later round, every row its request carried so far, and once
   * the stream has ended, those rows and its last reply. Call it on the
   * branch that compile was on, with `compileId`, that compile's
   * `provenance.compileId`. Each row, in order, is the id `addMessage`
   * returned for a stored message, which stands for the whole body, or
   * `{ unstored: true }`. `identity` is the head the stream was sent with.
   * The branch's record then holds these rows, so at the next compile they
   * keep their thinking while nothing up to them differs. Past the record's
   * end nothing keeps its thinking: a reply keeps its thinking at the next
   * compile only once a note holds it.
   *
   * Note only what the host can vouch it sent, or for the last reply, got
   * back: a stored row whose copy, as `renderAsNewest` renders it and the
   * host's request then carries it, differs from what was sent or returned
   * is `{ unstored: true }`, and so is a row the store doesn't hold that the
   * next request won't carry where this one did. A request-only row the
   * host puts back in the same place at every later request needs no row,
   * since no compile holds it. A note sent with another head than the
   * record's leaves the record vouching for nothing until a compile writes
   * it again: the stream's earlier thinking was minted under the
   * old head. A host that notes nothing keeps no reply's thinking past the
   * compile after it was stored, and is never refused for it.
   *
   * Each stored row is digested as `renderAsNewest` renders it and as the
   * compile turns that into messages: a tool result under another
   * participant goes as the user's, and a bundled tool cycle as each of its
   * parts (`splitMixedToolMessages`). So one it renders as null, or that the
   * next compile renders otherwise, matches nothing there, and what follows
   * goes without its thinking. Rendering them releases no compression hold,
   * as `renderAsNewest` releases none. Without `renderAsNewest`, a row is
   * its stored content, and a body stored as shards matches nothing, and so
   * does an id the store doesn't hold, as after a removal.
   *
   * Returns false and writes nothing when `compileId` isn't the compile that
   * wrote the branch's record, as for a stream whose note arrives after
   * another committing compile with `binds`: its replies were minted under a
   * prefix the record no longer holds, and go without their thinking. A
   * compile without `binds` leaves the record, so a note after one still
   * writes. It returns false too when the branch has no record, and, logging
   * it, when the record is one this version can't read, or the store can't
   * read or write it; a note it can't write is lost, and the record stands
   * as the last one written.
   * A dry compile writes no record, so it leaves a stream's notes as they
   * were. Throws, writing nothing, for a row that isn't an id or the marker,
   * a `compileId` that isn't a string, or a digest that isn't a string.
   */
  noteRequestSent(rows: ReadonlyArray<MessageId | { unstored: true }>, identity: RequestIdentity, compileId: string): boolean {
    this.requireInitialized('noteRequestSent');
    if (!Array.isArray(rows)) throw new TypeError(`noteRequestSent: \`rows\` must be an array, got ${typeof rows}`);
    rows.forEach((row: unknown, i) => {
      if (typeof row === 'string') return;
      if (typeof row === 'object' && row !== null && (row as { unstored?: unknown }).unstored === true) return;
      throw new TypeError(`noteRequestSent: row ${i} must be a message id or { unstored: true }, got ${JSON.stringify(row) ?? typeof row}`);
    });
    refuseUnreadableIdentity(identity);
    if (typeof compileId !== 'string') {
      throw new TypeError(
        `noteRequestSent: \`compileId\` must be a string, the provenance.compileId of the compile the stream was built from; got ${typeof compileId}`,
      );
    }
    const record = this.readBindingRecordFor('this note writes nothing, and the branch\'s next committing compile with binds replaces the record');
    // A note is for the stream of the compile that wrote the record; after
    // another committing compile with binds its replies were minted under a
    // prefix the record no longer holds.
    if (record === null || record.compileId !== compileId) return false;
    const view = this.mergedMessageView();
    // An id the store doesn't hold, as after a removal, is nothing the next
    // compile sends: it vouches for nothing, as the marker does.
    const ids = rows.filter((row): row is MessageId => typeof row === 'string' && view.get(row) !== null);
    const rendered = ids.length > 0 ? this.renderAsNewest(ids) : [];
    let next = 0;
    const continued: string[] = [];
    for (const row of rows) {
      const stored = typeof row === 'string' ? view.get(row) : null;
      if (stored === null) {
        continued.push(UNVOUCHED);
        continue;
      }
      // With no renderAsNewest, a row is its stored content, which for a body
      // stored as shards is only its first shard's.
      const content = rendered === undefined ? (stored.bodyGroupId === undefined ? stored.content : null) : rendered[next];
      next++;
      if (content === null || content === undefined) {
        continued.push(UNVOUCHED);
        continue;
      }
      // As the compile turns it into messages: a tool result under another
      // participant goes as the user's, and a bundled tool cycle as each of
      // its parts.
      for (const part of splitMixedToolMessages([{ participant: stored.participant, content }])) continued.push(messageDigest(part));
    }
    return this.writeBindingRecordFor(
      continueRecord(record, continued, identity),
      'this note is lost: the record stands as the last one written, so the rows this note adds go without their thinking unless a later note of the stream writes',
    );
  }

  /**
   * The branch's binding record. One this version doesn't read, or that the
   * store can't give, is logged, with what follows from it, and read as
   * none; a committing compile with `binds` then writes its own in its place.
   */
  private readBindingRecordFor(consequence: string): BindingRecord | null {
    let read: ReturnType<typeof readBindingRecord>;
    try {
      read = readBindingRecord(this.store, this.strategyNamespace);
    } catch (err) {
      this.diag.warn(`[context-manager] the thinking-binding record of branch ${this.store.currentBranch().name} couldn't be read (${describeThrown(err)}); ${consequence}`);
      return null;
    }
    if (read.malformed) {
      this.diag.warn(
        `[context-manager] the thinking-binding record of branch ${this.store.currentBranch().name} isn't ` +
        `one this version reads; ${consequence}`,
      );
    }
    return read.record;
  }

  /** Write the branch's binding record; a write that throws is logged, with what follows from it, and false. */
  private writeBindingRecordFor(record: BindingRecord, consequence: string): boolean {
    try {
      writeBindingRecord(this.store, this.strategyNamespace, record);
      return true;
    } catch (err) {
      this.diag.warn(`[context-manager] the thinking-binding record of branch ${this.store.currentBranch().name} couldn't be written (${describeThrown(err)}); ${consequence}`);
      return false;
    }
  }

  /** Read the active strategy's allowlisted live settings, if supported. */
  getHotContextSettings(): HotContextSettingsStatus | null {
    this.requireInitialized('getHotContextSettings');
    if (!isHotConfigurableStrategy(this.strategy)) return null;
    return this.strategy.getHotContextSettings();
  }

  /** Update only settings the active strategy explicitly declares hot-safe. */
  updateHotContextSettings(update: HotContextSettingsUpdate): HotContextSettingsStatus {
    this.requireInitialized('updateHotContextSettings');
    if (!isHotConfigurableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support live context settings');
    }
    return this.strategy.updateHotContextSettings(update);
  }

  /**
   * Non-committing preview of the layout at a hypothetical budget and/or
   * settings. Commits nothing — see `AutobiographicalStrategy.previewContext`.
   * Returns null when the active strategy has no fold plan to preview.
   * `opts.thinkingBinding` previews a compile with that option: a binding
   * one prices a summary's carriers as such a compile renders them (see
   * `SelectOptions.thinkingBinding`); without it, as configured.
   */
  previewContext(
    budget: TokenBudget,
    overrides?: Record<string, unknown>,
    opts?: { render?: boolean; thinkingBinding?: ThinkingBinding },
  ): PreviewResult | null {
    this.requireInitialized('previewContext');
    const s = this.strategy as unknown as {
      previewContext?: (
        store: ReturnType<MessageStore['createView']>,
        log: ReturnType<ContextLog['createView']>,
        budget: TokenBudget,
        overrides?: Record<string, unknown>,
        opts?: { render?: boolean; thinkingBinding?: ThinkingBinding },
      ) => PreviewResult;
    };
    if (typeof s.previewContext !== 'function') return null;
    return s.previewContext(
      this.strategyMessageView(),
      this.contextLog.createView(),
      budget,
      overrides,
      opts,
    );
  }

  // ==========================================================================
  // Pins / documents (passthrough to the active strategy)
  // ==========================================================================

  /**
   * Pin a range of messages. A pin's bound is its `level`, or without one
   * its `maxLevel`. A raw pin, with no bound or a bound of 0, keeps the
   * messages out of compression and renders them raw at their original
   * chronological position, a message stored in parts whole, as
   * `ProtectedRange` describes. A compile whose budget can't hold them beside
   * the rest refuses with `OverBudgetError`; where the adaptive plan's middle
   * is over the budget, its message and `diagnostics.rawPins` name each pin
   * keeping raw tokens in that middle. A bound above 0 is read only under
   * `foldingStrategy: 'kv-stable'` and `'kv-unified'` with
   * `adaptiveResolution`: there the range is still compressed, since only a
   * summary can supply its level, and is held at `level`, or no deeper than
   * `maxLevel`, as `ProtectedRange` describes. Anywhere else the range is
   * raw. Where bounds are read and pins overlap at a message, the bound
   * `ProtectedRange` names holds it, which can compress a message a raw pin
   * covers. Returns the new pin id.
   *
   * Throws if the active strategy doesn't support pins.
   */
  pinRange(firstMessageId: MessageId, lastMessageId: MessageId, opts?: PinLevelOptions): string {
    this.requireInitialized('pinRange');
    if (!isPinnableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support pins');
    }
    return this.strategy.pinRange(firstMessageId, lastMessageId, opts);
  }

  /**
   * V2 dynamic pin-at-level-k: fix a range to render at fold level `level`
   * (0 = raw) — the frontier cut passes through that L_k node. Under
   * kv-stable, a chunk whose summaries stop below `level` renders at the
   * deepest it has, and one whose own-lineage summary at `level` doesn't list
   * it renders where one does, or raw (`ProtectedRange.level`). Honored
   * by `foldingStrategy: 'kv-stable'` and `'kv-unified'` with adaptive
   * resolution; under any other selector the range is raw, in the live view
   * and in the canonical L1 compression prompt where its budgets allow (see
   * `compressionRecallBudgetTokens`). Returns the new pin id.
   */
  pinAtLevel(firstMessageId: MessageId, lastMessageId: MessageId, level: number, opts?: { name?: string }): string {
    this.requireOpen('pinAtLevel');
    return this.pinRange(firstMessageId, lastMessageId, { name: opts?.name, level });
  }

  /**
   * Mark a single message as a "document" (semantically a body of
   * information to keep). Same effect as a single-message pin with
   * `kind: 'document'`, levels included (see `pinRange`): without a `level`
   * or `maxLevel` the message is kept raw, while
   * `markDocument(id, { maxLevel })` lets it fold no deeper than that level
   * where the selector reads level bounds. Under adaptive resolution, a mark
   * on any part of a message stored in parts covers the whole message, less
   * a part locked with `lockChunk` outside the span the mark's id names, as
   * `pinRange` does.
   * Under `kv-stable`, a mark with `level` (not `maxLevel`) holds whole each
   * summary it reaches, so a locked part that shares a summary with a part
   * the mark covers renders at the level the mark holds that summary at.
   * Returns the new pin id.
   */
  markDocument(messageId: MessageId, opts?: PinLevelOptions): string {
    this.requireInitialized('markDocument');
    if (!isPinnableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support documents');
    }
    return this.strategy.markDocument(messageId, opts);
  }

  /** Remove a pin or document mark. Returns true if removed. */
  unpin(pinId: string): boolean {
    this.requireInitialized('unpin');
    if (!isPinnableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support pins');
    }
    return this.strategy.unpin(pinId);
  }

  /** List all current pins. Returns empty array if strategy is not pinnable. */
  listPins(): ReadonlyArray<ProtectedRange> {
    this.requireInitialized('listPins');
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
    this.requireInitialized('searchSummaries');
    if (!isSearchableStrategy(this.strategy)) return [];
    return this.strategy.searchSummaries(query);
  }

  /** Look up a single summary by id. Returns null if not found / unsupported. */
  getSummary(id: string): SummaryEntry | null {
    this.requireInitialized('getSummary');
    if (!isSearchableStrategy(this.strategy)) return null;
    return this.strategy.getSummary(id);
  }

  /**
   * List existing summaries whose source span overlaps a time range, as a
   * table-of-contents — no generation, purely a read over what compression
   * has already produced. Returns `[]` only when the active strategy doesn't
   * support this capability (e.g. `PassthroughStrategy`) — with a strategy
   * that DOES support it, this can still throw (via `requireLoadedBranch`)
   * against a stale branch generation, same as any other strategy method;
   * this passthrough does not swallow that.
   *
   * Suitable for a "browse my history" agent tool at the framework layer —
   * see e.g. agent-framework's MCPL host integration.
   */
  getSummariesInRange(opts: { fromMs?: number; toMs?: number; level?: number }): TimeRangeSummaryEntry[] {
    this.requireInitialized('getSummariesInRange');
    if (!isSummaryOverviewStrategy(this.strategy)) return [];
    return this.strategy.listSummariesInRange(this.strategyMessageView(), opts);
  }

  /**
   * Cheap: max(level) over all currently-minted summaries. 0 if the strategy
   * doesn't support the summary table-of-contents, or none exist yet.
   */
  getMaxSummaryLevel(): number {
    this.requireInitialized('getMaxSummaryLevel');
    return isSummaryOverviewStrategy(this.strategy) ? this.strategy.getMaxSummaryLevel() : 0;
  }

  /**
   * Per-render stats of the last live compile: head/tail message + token
   * counts, plus per-level summary counts and total tokens. Returns null
   * if the strategy doesn't implement `getRenderStats`, and before a live
   * compile has run since the strategy loaded its branch (opening the store,
   * `setStrategy()`, a branch switch). A dry run or preview leaves it as it
   * was; a compile's own stats, a dry one's included, are its result's
   * `renderStats`.
   *
   * Designed for TUIs / dashboards that want to display "how much of the
   * agent's context is folded vs raw" at a glance.
   */
  getRenderStats(): RenderStats | null {
    this.requireInitialized('getRenderStats');
    if (!isRenderStatsCapable(this.strategy)) return null;
    return this.strategy.getRenderStats(this.strategyMessageView());
  }

  /**
   * Reset the head window to start from a new position.
   * Old head window messages become compressible.
   *
   * If transitionText is provided, it's used as the transition summary.
   * If omitted, an LLM call auto-generates a transition summary.
   *
   * Returns the transition summary text used. A close() from a listener of
   * the transition message's add lets the add finish, and the call then
   * rejects, naming the stored message, without resetting the head window.
   */
  async resetHeadWindow(transitionText?: string): Promise<string> {
    const attempt = this.requireInitialized('resetHeadWindow');
    if (!isResettableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support head window reset');
    }

    const ctx = this.createStrategyContext();

    // Generate transition summary if not provided
    const summary = transitionText ?? await this.strategy.generateTransitionSummary(ctx);
    this.requireInitialized('resetHeadWindow', attempt);

    // Inject transition message
    const msgId = this.addMessage('Context Manager', [
      { type: 'text', text: `[Topic Transition]\n\n${summary}` },
    ]);
    // A listener of that add may have closed the manager, set a strategy or
    // moved the store's branch. The add stands and the strategy isn't told,
    // and the refusal says the message is stored. It gives the reason without
    // the advice to retry or to recover, and says instead what a later call
    // that goes ahead does: it stores a second transition. After a close(), or
    // while a strategy initializes, a later call refuses at once.
    try {
      this.requireInitialized('resetHeadWindow', attempt, false);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${reason.endsWith('.') ? reason : `${reason}.`} Its transition add finished: message ${msgId} is ` +
          "stored, and the head window wasn't reset. A later resetHeadWindow() that goes ahead adds " +
          'another transition message.',
      );
    }

    // Reset head window to start from this message
    this.strategy.resetHeadWindow(msgId);

    return summary;
  }

  /**
   * Trigger background maintenance work.
   * Call this periodically to allow strategies to do compression, etc.
   */
  async tick(): Promise<void> {
    this.requireInitialized('tick');
    this.expireCompressionHolds();
    if (this.strategy.tick) {
      await this.strategy.tick(this.createStrategyContext());
    }
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private async initializeStrategy(
    expectedBranch?: StoreBranchGeneration,
    selection?: { branch: string; created: boolean },
  ): Promise<void> {
    const attempt = ++this.initializationAttempt;
    this.initializedAttempt = null;
    const strategy = this.strategy;
    expectedBranch ??= observeStoreBranch(this.store);
    const branchId = this.store.currentBranch().id;
    if (strategy.initialize) {
      try {
        await strategy.initialize(this.createStrategyContext());
      } catch (error) {
        // An initialize() that rejects after close() or a replacement let go
        // of the strategy is detached again too, as below; its own error is
        // the one the caller sees.
        if (this.closed || strategy !== this.strategy) this.detachStrategy(strategy);
        throw error;
      }
    }
    // close() ran while the strategy initialized: the call that started this
    // fails rather than leave a closed manager's strategy marked initialized.
    // close() detached the strategy before its initialize() finished, so it
    // is detached again here, for work it started after that.
    if (this.closed) {
      this.detachStrategy(strategy);
      throw new Error('ContextManager closed during strategy initialization');
    }
    if (attempt !== this.initializationAttempt || strategy !== this.strategy) {
      // A setStrategy() that replaced it while it initialized detached it
      // then; detach it again, for work it started after that. A newer
      // initialization of the same instance is left alone.
      if (strategy !== this.strategy) this.detachStrategy(strategy);
      throw new InitializationSupersededError(selection);
    }
    const current = observeStoreBranch(this.store);
    const currentBranchId = this.store.currentBranch().id;
    if (
      current.name !== expectedBranch.name ||
      current.generation !== expectedBranch.generation ||
      currentBranchId !== branchId
    ) {
      throw new Error(
        `Branch changed during strategy initialization: requested ${expectedBranch.name} ` +
        `(id ${branchId}, generation ${expectedBranch.generation}), now ${current.name} ` +
        `(id ${currentBranchId}, generation ${current.generation})`,
      );
    }
    this.initializedAttempt = attempt;
    if (this.holdReleaseNotifyPending) this.notifyHoldsReleased();
  }

  /** Refuse an operation on a closed manager, naming it. */
  private requireOpen(operation: string): void {
    if (this.closed) this.refuseAfterClose(operation);
  }

  private refuseAfterClose(operation: string): never {
    throw new Error(`ContextManager.${operation} after close()`);
  }

  /**
   * Fence failed/pending attempts; optionally pin a manager-owned operation
   * across an await. `advise` false leaves out the refusal's advice on what
   * to do next, for a caller whose own words say what a later call would do.
   */
  private requireInitialized(operation: string, expected?: InitializationStamp, advise = true): InitializationStamp {
    this.requireOpen(operation);
    const current: InitializationStamp = {
      ...observeStoreBranch(this.store),
      id: this.store.currentBranch().id,
      attempt: this.initializationAttempt,
    };
    if (this.initializedAttempt !== current.attempt) {
      throw new Error(
        `ContextManager.${operation} requires successful strategy initialization (selected branch ${current.name}).` +
        (advise ? ' Inspect currentBranch() and recover with switchBranch() or setStrategy().' : ''),
      );
    }
    if (expected && (
      expected.attempt !== current.attempt ||
      expected.name !== current.name || expected.generation !== current.generation ||
      expected.id !== current.id
    )) {
      throw new Error(`Branch or strategy changed during ContextManager.${operation}${advise ? '; retry on the intended branch' : ''}.`);
    }
    return current;
  }

  /**
   * Live tool definitions for the owning agent, refreshed by the host on
   * every activation (Agent.buildActivationRequest in agent-framework).
   * Threaded into StrategyContext so compression/summarizer LLM calls can
   * declare the same tools as the live instance — required to avoid
   * reasoning_extraction refusals on transcripts containing tool blocks.
   */
  private toolDefinitions?: ToolDefinition[];

  /** Host hook: record the agent's current tool definitions (see above). */
  setToolDefinitions(tools: ToolDefinition[] | undefined): void {
    if (tools && tools.length > 0) this.toolDefinitions = tools;
  }

  /**
   * Live system prompt for the owning agent, refreshed by the host on every
   * activation alongside the tool definitions above. Threaded into
   * StrategyContext so memory-writing LLM calls can be served the same system
   * voice the live instance is served.
   */
  private systemPrompt?: string;

  /**
   * Host hook: record the agent's current system prompt (see above). Only the
   * LATEST value is retained — this is a single slot, not a per-message
   * history — so a mint is served the identity policy in force AT MINT TIME.
   * That equals what the original instance was served exactly insofar as the
   * host keeps the prompt stable across the span being compressed; where it
   * has changed, the memory is authored under the current policy and the
   * older text is not recoverable from here. On hosts whose identity and
   * conduct live in system voice, serving it at all is what keeps the
   * summarizer the same agent as the one whose memory it writes. Never
   * called, or called only with an empty value, leaves mint requests in
   * their no-system-prompt shape.
   */
  setSystemPrompt(text: string | undefined): void {
    if (text && text.length > 0) this.systemPrompt = text;
  }

  private createStrategyContext(): StrategyContext {
    const self = this;
    return {
      messageStore: this.strategyMessageView(),
      contextLog: this.contextLog.createView(),
      membrane: this.membrane,
      currentSequence: this.store.currentSequence(),
      store: this.store,
      namespace: this.strategyNamespace,
      // Live getter, not a snapshot: strategies capture a ctx object once and
      // reuse it across a long-running drain (driveSpeculativeDrain recurses
      // with the same ctx). A snapshot taken before the session's first
      // activation would freeze `tools` as undefined for the drain's entire
      // lifetime — the getter always reflects the latest activation.
      get tools() { return self.toolDefinitions; },
      // Live getter for the same reason as `tools` above.
      get systemPrompt() { return self.systemPrompt; },
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
        // Ids of the removed span aren't in the event; prune holds whose
        // message no longer exists.
        {
          const before = this.compressionHolds.size;
          for (const id of [...this.compressionHolds]) {
            if (!this.messageStore.get(id)) this.compressionHolds.delete(id);
          }
          for (const [key, members] of [...this.compressionHoldGroups]) {
            if (!members.some((m) => this.compressionHolds.has(m))) this.compressionHoldGroups.delete(key);
          }
          if (this.compressionHolds.size !== before) this.notifyHoldsReleased();
        }
        // For range removes, we need to check all affected messages
        // This is a simplification - in practice we'd need to track the IDs
        break;
    }
  }

  private handleMessageAdd(message: StoredMessage): void {
    if (this.holdingAdds) {
      this.holdingAdds.push(message.id);
      this.placeHold(message.id, this.holdingAddOptions, this.holdingAddAt);
    }
    // Notify strategy of new message. After close() nothing reaches the
    // strategy: a close() from a listener lets the write it interrupted
    // finish, and that write's remaining shards are stored unheard.
    if (this.strategy.onNewMessage && !this.closed) {
      // Fire and forget: the write doesn't wait for the strategy, and the
      // strategy's failure isn't the write's (#288). The hook runs here,
      // inside the append, so its synchronous part comes before addMessage
      // returns, after a holdCompression hold is placed. A hook that isn't
      // async can throw before it returns, and the throw is logged the same
      // way as a rejection. It can also return no promise, which isn't a
      // failure. Either way the message stays stored, as do a sharded body's
      // remaining shards, and the strategy isn't offered it again. Only the
      // strategy's call is caught: the manager's own work around it, the
      // context it hands the strategy among it, still fails the write, as
      // onMessage's note says. The log is logThrown's, which survives a
      // thrown value that can't be formatted.
      const failed = (err: unknown) =>
        logThrown(`Strategy onNewMessage failed for ${describeStoreEvent({ type: 'add', message })}:`, err, this.diag);
      const ctx = this.createStrategyContext();
      try {
        Promise.resolve(this.strategy.onNewMessage(message, ctx)).catch(failed);
      } catch (err) {
        failed(err);
      }
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
    if (this.compressionHolds.delete(messageId)) {
      for (const [key, members] of [...this.compressionHoldGroups]) {
        if (!members.some((m) => this.compressionHolds.has(m))) this.compressionHoldGroups.delete(key);
      }
      this.notifyHoldsReleased();
    }
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
   * Close the context manager. This is final, whoever owns the store.
   *
   * The strategy is detached first (ContextStrategy.detach). The manager's
   * mutations and strategy operations then stay blocked, with no recovery:
   * each throws "ContextManager.<operation> after close()", the reads that
   * go through the strategy, such as getSummary() and isReady(), included,
   * and a setStrategy(), switchBranch() or fork() still initializing the
   * strategy when close() runs rejects. Inspection of messages, branches and
   * receipts reads the store, so it answers while the store is open: after
   * close() with an app-owned store, not with one the manager owned, which
   * close() closes. describeRenderedForms(), which reads the strategy's
   * declared forms, and the manager's own setters, such as
   * setSystemPrompt(), still answer, and releaseCompression() still doesn't
   * throw. close() throws the store's own error when closing a store the
   * manager owns fails at its final sync; the store is closed all the same.
   * A second close() does nothing. A close() from inside a listener (onMessage,
   * onFoldReceipt) lets the write it interrupted finish and starts nothing
   * new: the write's remaining shards are stored and its receipt committed,
   * nothing after the close() reaches the strategy, and a store the manager
   * owns closes once that write returns, a failure of that close logged
   * rather than thrown.
   * If the manager owns the store (created via path config), this closes the store.
   * If the app owns the store (passed via store config), the store stays open;
   * the app is responsible for closing it when done.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachStrategy(this.strategy);
    if (this.ownsStore) {
      // From a listener inside a write: the write finishes on the open
      // store, and write() closes it when the write returns.
      if (this.writeDepth > 0) this.storeCloseAfterWrite = true;
      else this.store.close();
    }
  }

  /**
   * Run one write that calls a host's listeners: an add, whose shards' events
   * each run them, a round's acceptance, which announces a branch's earlier
   * receipt before it commits its own, or an edit or a removal, whose one
   * event runs them once its change is stored. A close() from one of those
   * listeners lets the write finish, since a write is the unit the store
   * stays whole in, and a store the manager owns closes when the outermost
   * write returns, so the listeners after the one that closed still find it
   * open. A failure of that close is logged: the close() that asked for it
   * has returned, and the write it followed stands.
   */
  private write<T>(run: () => T): T {
    this.writeDepth++;
    try {
      return run();
    } finally {
      this.writeDepth--;
      if (this.writeDepth === 0 && this.storeCloseAfterWrite) {
        this.storeCloseAfterWrite = false;
        try {
          this.store.close();
        } catch (error) {
          logThrown('[context-manager] closing the store after a close() from a listener failed; the store is closed all the same:', error, this.diag);
        }
      }
    }
  }

  /**
   * Whether close() has run, or the store has been closed.
   */
  isClosed(): boolean {
    return this.closed || this.store.isClosed();
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

/**
 * What a store event was about, for a log line's message: its message (and
 * body group), or its span. The message is a format string, since a thrown
 * value follows it, so a '%' in an id, such as a body group a host's strategy
 * chose, is doubled to print as itself.
 */
function describeStoreEvent(event: MessageStoreEvent): string {
  const text = ((): string => {
    switch (event.type) {
      case 'add':
        return `message ${event.message.id}${event.message.bodyGroupId ? ` (body group ${event.message.bodyGroupId})` : ''}`;
      case 'edit':
      case 'remove':
        return `message ${event.messageId}`;
      case 'removeRange':
        return `messages ${event.fromId} to ${event.toId}`;
    }
  })();
  return text.replaceAll('%', '%%');
}
