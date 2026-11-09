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
  WaitingWork,
  BranchInfo,
  ContextStrategy,
  StrategyContext,
  WindowIndexView,
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
  isRenderingFrontierStrategy,
  isDerivationManifestStrategy,
} from './types/index.js';
import type { DerivationManifestOptions } from './types/index.js';
import { isStateExistsFor } from './state-registration.js';
import { NoFoldPlanToPreviewError } from './types/strategy.js';
import type { RenderStats } from './types/index.js';
import { overRequestLimit, refuseUnreadableRequestLimit, requestOverheadContent } from './request-limit.js';
import { MessageStore, MessageStoreEvent, MessageStoreListener, MessageWindow, MessageWindowOptions } from './message-store.js';
import { ContextLog } from './context-log.js';
import { MalformedContentError, contentForWrite, malformedContentPlaces } from './well-formed-content.js';
import { filterMessageStoreView, mergeMessageStoreViews } from './message-view.js';
import { WindowIndex, WindowWriteOutcomeUnknownError, presentedMessageView, recordPositionOf, requireBatchedIdentityAppend, requireMessageIds, windowIndexStateId, type LeftRow, type WindowMode, type WindowStatus } from './window-index.js';
import { bodyBoundsIn } from './body-runs.js';
import { PassthroughStrategy } from './strategies/passthrough.js';
import { splitMixedToolMessages } from './normalize-tool-messages.js';
import { markStoreBranchSwitch, observeStoreBranch } from './branch-generation.js';
import { MINT_PREIMAGE_ENVELOPE_INDEX_STATE_ID } from './mint-preimage.js';
import type { StoreBranchGeneration } from './branch-generation.js';
import { randomUUID } from 'node:crypto';
import { attributeEntries, buildRenderedLayout, rawBodiesOf } from './compile-provenance.js';
import { FoldJournal, branchRefOf, cachedStoreIdentity, existingStoreIdentity } from './fold-journal.js';
import { describeThrown, logThrown } from './describe-thrown.js';
import {
  UNVOUCHED, bindThinking, continueRecord, isThinkingBlock, markThinkingLeftOut, messageDigest, readBindingRecord,
  bindingStateId, refuseUnboundBinding, refuseUnreadableIdentity, registerBindingState, thinkingAsSent, thinkingSent, withoutThinking, writeBindingRecord,
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
/** A store branch as ContextManager.branchStamp reads it. */
type BranchStamp = StoreBranchGeneration & { id: string };

/**
 * A compiled message as `firstChanged` compares it. An injection's content
 * is the caller's, which may change in place, so its bytes are taken when
 * it's compiled, also when a binding compile sends it without its thinking,
 * as a new array of the caller's blocks. Other content is the store's, the
 * strategy's or the manager's own, which nothing changes in place (as the
 * store's own per-message caches assume), so the same array is the same
 * content, and its bytes are taken only when a comparison with another array
 * needs them.
 */
interface CompiledMessageKey {
  readonly participant: string;
  readonly content: readonly ContentBlock[];
  readonly injected: boolean;
  bytes?: string;
}

/** The index of the first of `keys` that differs from `before`'s at its index, or has none there (ContextManager.recordFirstChanged). */
function firstDifference(keys: readonly CompiledMessageKey[], before: readonly CompiledMessageKey[]): number {
  const bytesOf = (key: CompiledMessageKey): string => (key.bytes ??= JSON.stringify(key.content));
  let i = 0;
  for (; i < keys.length && i < before.length; i++) {
    const now = keys[i]!;
    const then = before[i]!;
    if (now.participant !== then.participant) break;
    if (now.content === then.content && !now.injected && !then.injected) continue;
    if (bytesOf(now) !== bytesOf(then)) break;
  }
  return i;
}

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
   * preview, ticks, and onPresented/onNewMessage context alike — contains only kept
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
   * sources are now hidden stays loadable and selectable. In legacy mode
   * `removeMessage` has the same property. Once a host presents rows, a
   * removal takes the row out of the window too, and the strategy is told
   * (ContextStrategy.onRetracted): a strategy that folds rows, such as the
   * autobiographical one, lets go of what covers it. To excise content that may already have been
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
 * Options for {@link ContextManager.derive}.
 */
export interface DeriveContextOptions {
  /** Name of the Chronicle branch to create for the derived context. Must be unused. */
  branch: string;
  /**
   * Strategy for the derived manager. Strategy instances hold state and are
   * never shared: pass a fresh one. To reuse the parent's rendering, it must
   * be the same class with compatible configuration.
   */
  strategy: ContextStrategy;
  /** Membrane for the derived manager's own compression calls. Default: the parent's. */
  membrane?: Membrane;
  /**
   * - `'reuse'` (default): keep the parent's rendering frontier — persisted
   *   fold state arrives through the store, and, at the head, the in-memory
   *   remainder is handed from the parent's strategy to the child's — so the
   *   child's first compile reproduces the parent's presentation and cache
   *   markers when it reads through the parent's view; with a view of its
   *   own (`viewFilter`) the frontier is handed over all the same, and the
   *   child renders what its view holds. Derived from an earlier point
   *   (`atSequence`), the child keeps what was persisted by then and
   *   nothing in memory, since the parent's in-memory frontier describes
   *   its head.
   * - `'fresh'`: discard the inherited frontier and solve from scratch, e.g.
   *   at another budget. Presentation changes; the provider cache misses.
   */
  solve?: 'reuse' | 'fresh';
  /** Passed to the strategy's derivation manifest (e.g. `{ refusals: true }`). */
  inherit?: DerivationManifestOptions;
  /**
   * Derive from an earlier point: a sequence on the parent's branch. The
   * child then starts from history as it was, loaded cold (the parent's
   * live caches describe the head, not the past). Default: the current head.
   *
   * Once the parent's host presents rows (see presentRows), give a
   * presentation boundary here, such as `currentSequence()` read after a
   * presentRows, not a row's own sequence: a row stored after the window
   * was written down enters it at a write after its own, so a cut at its
   * own sequence holds the row in the child's record but not in its
   * window, and the child lists it among its arrived rows
   * (getUnpresentedMessages). A row stored before the write-down was in the
   * window from its own write: a cut at its sequence, before the
   * write-down, leaves the child in legacy mode, its window the record,
   * which holds the row. branchAt, which takes a row's id, finds the
   * boundary itself.
   */
  atSequence?: number;
  /**
   * The derived manager's view (see ContextManagerBaseConfig.viewFilter), in
   * place of the parent's: it replaces the parent's exclusions rather than
   * adding to them. Default: the parent's. The inherited memory was built
   * under the parent's view, so this one keeps and leaves out what the
   * parent's does of the history that memory covers, and may differ on rows
   * the parent hasn't folded, such as those stored after the checkpoint. A
   * host whose forks see what their parent sees and their own rows besides
   * (agent-framework's shared forks, whose stored context injections carry
   * the fork's name) passes the composed predicate here, so the first compile
   * already reads through it. A predicate isn't part of the derivation
   * record: reopening takes it again (ReopenDerivedOptions.viewFilter).
   */
  viewFilter?: (message: StoredMessage) => boolean;
  debugLogContext?: boolean;
}

/** Where a derived context came from. */
export interface ContextDerivation {
  /** The branch it was derived from. */
  parentBranch: string;
  /** Its own branch: every write it makes lands here. */
  branch: string;
  /** The checkpoint on the parent's branch. */
  atSequence: number;
  solve: 'reuse' | 'fresh';
  /** The states it inherited; anything else reads as empty on its branch. */
  inherited: { stateIds: string[]; statePrefixes: string[] };
  /**
   * How the manager's slots are named — with `branch`, what the store needs
   * to reopen the derived context later (see {@link ContextManager.reopenDerived}),
   * which also takes the strategy and the view it read through.
   * `null` stands for "no namespace" so the record survives JSON.
   */
  slots: {
    messageNamespace: string | null;
    contextNamespace: string | null;
    auxiliaryNamespaces: Array<string | null>;
  };
}

/** Options for {@link ContextManager.reopenDerived}. */
export interface ReopenDerivedOptions {
  /** Any handle on the store that holds the derived branch. */
  store: JsStore;
  /** The record `getDerivation()` returned when the context was derived. */
  derivation: ContextDerivation;
  strategy?: ContextStrategy;
  membrane?: Membrane;
  tokenEstimator?: (text: string) => number;
  /**
   * The view the derived manager read through: the one given to `derive`,
   * else the parent's exclusion predicate, if it had one.
   */
  viewFilter?: (message: StoredMessage) => boolean;
  debugLogContext?: boolean;
}

/** Thrown when the installed Chronicle cannot bind a handle to a branch. */
export class ContextDerivationUnsupportedError extends Error {
  constructor() {
    super(
      'Context derivation needs branch-bound store handles (JsStore.view) and branches forked with ' +
        'selected states (createBranchWithStates, createBranchAtWithStates), which this ' +
        '@animalabs/chronicle build does not provide',
    );
    this.name = 'ContextDerivationUnsupportedError';
  }
}

/** Chronicle surface derivation depends on; absent on builds without views. */
interface DerivableStore {
  view(branch: string): JsStore;
  createBranchWithStates(
    name: string,
    from: string | undefined | null,
    filter: { stateIds?: string[]; statePrefixes?: string[] },
  ): { id: string };
  createBranchAtWithStates(
    name: string,
    from: string,
    atSequence: number,
    filter: { stateIds?: string[]; statePrefixes?: string[] },
  ): { id: string };
}

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
 * An addMessage that failed after storing some of the message: the rows of
 * it the store holds, and the error the write failed with.
 *
 * `landed` names those rows, in store order: the message's one row, or the
 * shards of a sharded body that stayed. The store holds no other row of the
 * message. `cause` is the write's own error, and this error's message ends
 * with its message, so a check that the message contains or ends with the
 * write's own error's message still matches; one that compares the whole
 * message, or is anchored at its start, doesn't.
 *
 * What addMessage throws tells which of three things happened:
 * - WriteLandedError: the store holds the rows of the message `landed`
 *   names, and no others.
 * - {@link WriteOutcomeUnknownError}: the manager can't tell whether the
 *   store holds some row of the message, because the read of the store that
 *   would tell threw. It names what the manager does know.
 * - Any other error: the store holds none of the message.
 *
 * It is thrown when a row of the write stays:
 * - A message stored as one row stays: its append can fail after the row
 *   landed, when the manager's own listener fails inside it (see
 *   onMessage), and `landed` names the row.
 * - A sharded write that fails partway removes the shards it stored, the
 *   failing shard's row with them where it landed, so that a retry writes
 *   one body, and then throws its own error, unwrapped. When that removal
 *   fails too, `landed` names the shards that stayed: a body short of its
 *   shardCount, which a retry doesn't remove.
 * - A sharded write whose store a listener of a shard's add moved to
 *   another branch stops before the next shard, which would land on that
 *   branch: `landed` names the shards stored, which stay on the branch the
 *   write started on, and `cause` says the branch moved. Nothing is
 *   removed, since the store no longer reads that branch. Nor is it where
 *   a sharded write fails partway and the store then can't say its branch
 *   (the failed read is logged): `landed` names the shards stored, on the
 *   branch the write started on, and `cause` is the write's own error.
 *
 * A write that fails before a row lands throws its own error, unwrapped: a
 * refusal of the message, or of a shard as the strategy chunked it
 * (MalformedContentError), a chunking the manager refuses, a strategy not
 * initialized, a store that refuses the first append, an add made while a
 * sharded add stores its shards.
 *
 * Its add may have gone unheard: a failure in the manager's own listener
 * ends the event before a host's onMessage listener hears it, and before
 * the strategy does in legacy mode. There a sharded write that fails tells
 * the strategy of the shards that stay, in one call before this is thrown:
 * those its own listener heard and, on the branch the write started on
 * while the window reads legacy, any it didn't, read from the slot. Where
 * such a shard can't be read, or that telling fails in the manager's own
 * work, they wait for the strategy's next notification, which tells those
 * the window then holds. Once a host presents rows on the
 * branch, a row is out of the window until it is presented, as for any
 * add, but a host's listener of the add may have presented one already, as
 * a host that presents each row as it is stored does, or taken one out
 * again: on the branch the store was on when addMessage was called (read
 * currentBranch() before the call; where a listener's move stopped the
 * write, `cause` names it too: switch back to it first), present the first
 * row of `landed`
 * that windowStatusOf doesn't read `'in'`, if any, which presentRows takes
 * as naming the rest of the
 * body, since it refuses a row the window holds and a later shard whose
 * earlier shards aren't all in it. Where the add placed a holdCompression
 * hold on them, it stays: releaseCompression(landed) releases it.
 */
export class WriteLandedError extends Error {
  readonly landed: readonly MessageId[];
  override readonly cause: unknown;

  constructor(landed: readonly MessageId[], cause: unknown) {
    super(
      `addMessage failed after storing ${rowsOfTheMessage(landed)}, which the store holds: ${describeThrown(cause)}`,
    );
    this.name = 'WriteLandedError';
    this.landed = Object.freeze([...landed]);
    this.cause = cause;
  }
}

/**
 * An addMessage that failed where the manager can't tell whether the store
 * holds some row of the message: the read of the store that would tell
 * threw, or the write's branch moved, so the manager can't read it. What
 * the manager does know, and the error the write failed with.
 *
 * - `landed`: the rows of the message the manager knows the store holds, in
 *   store order. Possibly none.
 * - `unknown`: rows the write stored, by id, that may have gone since: a
 *   sharded write's removal of its shards threw, and the store can't be
 *   read to tell whether it took them out before it threw. The removal is
 *   one store write, so the store holds all of these or none of them.
 * - `unnamed`: how many rows the store may hold that the manager can't
 *   name: 1 when the store can't be read to tell whether the row of the
 *   append that failed the write landed (the store gives a row its id as it
 *   writes it, so an append that throws returns none), else 0.
 * - `cause`: the write's own error. This error's message ends with its
 *   message, as WriteLandedError's does.
 *
 * Together they name every row of the message the store may hold: `landed`
 * is stored, and of the rest the store holds at most those `unknown` names
 * and `unnamed` counts. It is thrown:
 * - For a message stored as one row whose append threw, where the store
 *   can't be read to tell whether the row landed (`unnamed` 1). The manager
 *   logs the failed read. So too where the append threw after a listener
 *   of the add moved the store to another branch, or where the store then
 *   can't say its branch: the row landed on the branch the add started
 *   on, if it did, which the store no longer reads, or may not.
 * - For a sharded write whose first shard's append threw, likewise. Nothing
 *   is removed, since no id names what to remove (`unnamed` 1). The manager
 *   logs the failed read.
 * - For a sharded write that stored shards before the one whose append
 *   threw, where the store can't be read to tell whether that one landed,
 *   and removing what it stored threw too (`landed` the shards that stayed,
 *   `unnamed` 1). Where the removal goes through, it takes out the failing
 *   shard's row with the run of shards before it, if that row landed, so
 *   the write's own error is thrown.
 * - For a sharded write whose removal of what it stored threw, where the
 *   store can't be read to tell whether the shards stayed (`unknown`, and
 *   `unnamed` 1 if the failing shard's landing can't be read either).
 * - For a sharded write whose shard's append threw after a listener moved
 *   the store to another branch, or where the store then can't say its
 *   branch: the shards stored before it stay on the branch the write
 *   started on (`landed`), which the store no longer reads, or may not, to
 *   tell whether the failing shard's row landed there (`unnamed` 1), and
 *   nothing is removed.
 *
 * A host that stores the message another way when an add stored none of it
 * can't tell from this error whether doing so stores it twice: a read of
 * the store, once it reads, tells.
 *
 * As for WriteLandedError, the add may have gone unheard; once a host
 * presents rows on the branch, a row of `landed` is out of the window until
 * it is presented, unless a listener of the add presented it already, so a
 * host presents, on the branch the store was on when addMessage was
 * called (read currentBranch() before the call: `cause` is the failing
 * append's own error, which names no branch; switch back to it first), the
 * first row of `landed`
 * that windowStatusOf doesn't read `'in'`, if any, which presentRows takes
 * as naming the rest of the body;
 * and a holdCompression hold the add placed stays on any row of it that is
 * stored (getCompressionHolds lists it, and releaseCompression releases
 * it).
 *
 * A window write (presentRows and the retractions) whose outcome can't be
 * read throws WindowWriteOutcomeUnknownError instead; see it.
 */
export class WriteOutcomeUnknownError extends Error {
  readonly landed: readonly MessageId[];
  readonly unknown: readonly MessageId[];
  readonly unnamed: number;
  override readonly cause: unknown;

  constructor(
    known: { landed: readonly MessageId[]; unknown: readonly MessageId[]; unnamed: number },
    cause: unknown,
  ) {
    const whether = [
      ...(known.unknown.length > 0 ? [rowsOfTheMessage(known.unknown)] : []),
      ...(known.unnamed > 0 ? [known.unnamed === 1 ? 'a row of the append that threw' : `${known.unnamed} rows of appends that threw`] : []),
    ];
    super(
      `addMessage failed, and the manager can't tell whether the store holds ${whether.length > 0 ? whether.join(', or ') : 'some of the message'}` +
        `${known.landed.length > 0 ? `; it holds ${rowsOfTheMessage(known.landed)}` : ''}: ${describeThrown(cause)}`,
    );
    this.name = 'WriteOutcomeUnknownError';
    this.landed = Object.freeze([...known.landed]);
    this.unknown = Object.freeze([...known.unknown]);
    this.unnamed = known.unnamed;
    this.cause = cause;
  }
}

/** Rows of a message as an error names them: `message <id>`, or `<n> rows of the message (<ids>)`. */
function rowsOfTheMessage(ids: readonly MessageId[]): string {
  return ids.length === 1 ? `message ${ids[0]}` : `${ids.length} rows of the message (${ids.join(', ')})`;
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
 * be partial: isReady, getPendingWork, getWaitingWork, getHotContextSettings,
 * previewContext, listPins, searchSummaries, getSummary, getSummariesInRange,
 * getMaxSummaryLevel and getRenderStats. Raw message reads and branch
 * inspection remain available for recovery with switchBranch() or
 * setStrategy(). So do compression holds (holdCompression,
 * releaseCompression) and request settings (setToolDefinitions,
 * setSystemPrompt): they live in memory, and the strategy hears of a released
 * hold only once an attempt succeeds. So do the window's writes (presentRows,
 * retractRows, retractRemoved, retractAbsentRows), which require only an open
 * manager: they change the window the strategy reads, and the strategy
 * hears of the rows they move once an attempt succeeds
 * (ContextStrategy.onPresented, onRetracted).
 *
 * The fence governs operations that start while an attempt is pending or
 * failed. Work already in flight when a transition begins, and a superseded
 * initializer's own writes before it returns, are the strategy's to guard;
 * transitions do not roll back earlier writes. Direct Chronicle switches retain
 * their existing strategy-specific semantics; this fence does not pin a manager
 * to a branch. After one, or after another manager on the store switched or
 * forked, setStrategy(getStrategy()) initializes this manager's strategy
 * again on the branch the store is on.
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
  /**
   * The last committing compile's messages, for the next one's
   * `firstChanged`, whatever branch or strategy it read; null before this
   * manager's first committing compile.
   */
  private lastCompiled: CompiledMessageKey[] | null = null;
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
  /**
   * While a sharded addMessage stores its shards: the rows a legacy window
   * took in, which the strategy hears in one call once every shard is
   * stored (handleMessageAdd). An addMessage meanwhile is refused.
   */
  private writingShards: { heard: StoredMessage[] } | null = null;
  /** Read-only auxiliary stores merged into the strategy-facing view. */
  private auxiliaryStores: MessageStore[];
  /** How this manager's slots are named — what a derived context inherits. */
  private slots: {
    messageNamespace: string | undefined;
    contextNamespace: string | undefined;
    auxiliaryNamespaces: Array<string | undefined>;
    tokenEstimator: ((text: string) => number) | undefined;
  } = { messageNamespace: undefined, contextNamespace: undefined, auxiliaryNamespaces: [], tokenEstimator: undefined };
  /** Set on a manager created by {@link derive}. */
  private derivation: ContextDerivation | null = null;
  /** Fold receipts for this manager's namespace (see fold-journal.ts). */
  private foldJournal: FoldJournal;
  /** The rows this manager's agent has been shown, in order (see window-index.ts). */
  private windowIndex: WindowIndex;
  /**
   * Rows that entered the window while the strategy wasn't initialized, for
   * it to hear once it is (notifyPresented), by id, each with whether it
   * entered a legacy window, where the add itself entered it. A row that
   * enters again before then waits once: the delivery reads the window, so
   * however often a row entered, it is heard once if the window holds it.
   */
  private presentedUnheard = new Map<MessageId, boolean>();
  /**
   * Calls of onRetracted made while the strategy wasn't initialized, in
   * order, for it to hear once it is (notifyRetracted). Each keeps its rows'
   * ids and ordinals, and the row itself only for a row a removal took,
   * which the store no longer holds: the others are read when the call is
   * made, so what waits is small however long the initialization fails.
   */
  private retractedUnheard: Array<{ left: RetractedRow[]; info: Retraction }> = [];
  /**
   * While a removal through this manager runs (removeMessage,
   * removeMessages, a failed sharded addMessage's removal of its shards):
   * the rows it takes, read before they went, for the strategy to be told
   * of them (handleMessageStoreEvent), and their ids, which a removal that
   * names its rows keeps where that read failed (rowsBeforeRemoval).
   */
  private removing: Removing | null = null;

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
    this.windowIndex = new WindowIndex(store, strategyNamespace, this.diag);

    // Set up edit propagation
    this.messageStore.addListener((event) => this.handleMessageStoreEvent(event));
  }

  /**
   * The strategy-facing message view — the single choke point through which
   * every strategy read passes (compile, preview, render stats, and the
   * tick/onPresented StrategyContext). Composition order: merge auxiliary
   * slots into the timeline first, then take the agent's window over it
   * (presentedMessageView), then apply the exclusion filter, so a filter
   * sees (and can exclude from) the merged world as the agent was shown it.
   * Until a host presents rows the window is the merged record itself, so
   * the strategy reads what it always read.
   */
  private strategyMessageView() {
    let view = this.presentedMessageView();
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

  /** This manager's messages merged with its auxiliary slots, before the view filter: the record, in record order. */
  private mergedMessageView(): MessageStoreView {
    return mergeMessageStoreViews(
      this.messageStore.createView(),
      this.auxiliaryStores.map((s) => s.createView()),
    );
  }

  /**
   * The agent's window before the view filter: the merged record in legacy
   * mode, the rows its index holds in its order once a host has presented
   * any (see window-index.ts). It answers `positionOf`, which compile's
   * attribution looks bodies up by.
   */
  private presentedMessageView(): MessageStoreView {
    return presentedMessageView(this.mergedMessageView(), this.windowIndex);
  }

  /**
   * The window index as a strategy reads it (StrategyContext.window), live:
   * each read asks the index on the branch the store is on, and the
   * lookups by sequence read the merged record as it stands, once a host
   * presents: in legacy mode they give undefined without listing it, so a
   * strategy that looks one up at every move (WindowedPassthroughStrategy's
   * setAnchor) costs what it did before the index.
   */
  private windowIndexView(): WindowIndexView {
    const index = this.windowIndex;
    const record = () => this.mergedMessageView().getAll();
    return {
      mode: () => index.mode(),
      ordinals: () => index.ordinals(),
      left: () => index.left(),
      length: () => index.length(),
      ordinalFrom: (sequence) => (index.mode() === 'legacy' ? undefined : index.ordinalFrom(sequence, record())),
      sequenceFrom: (ordinal) => (index.mode() === 'legacy' ? undefined : index.sequenceFrom(ordinal, record())),
    };
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
    // The index refuses a store without the batched append (chronicle 0.6.0
    // on). Asked first, so a refused open registers no state (#350 review, 16).
    requireBatchedIdentityAppend(store);
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
    manager.slots = {
      messageNamespace,
      contextNamespace: config.namespace,
      auxiliaryNamespaces: [...seenAuxSlots].map((slotId) =>
        (config.auxiliaryMessageViews ?? []).find(
          (aux) => MessageStore.registrationFor(aux.namespace).id === slotId,
        )?.namespace,
      ),
      tokenEstimator: config.tokenEstimator,
    };

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
   * holdCompression) on the new message BEFORE the strategy hears of it
   * (ContextStrategy.onPresented: inside this add in legacy mode, at the
   * row's presentRows once a host presents rows), so not even the ingress
   * chunk rebuild can fold it. Release it with
   * releaseCompression([returnedId]) (releases every shard).
   *
   * What a write that fails throws says what of the message the store
   * holds:
   * - {@link WriteLandedError}: the rows its `landed` names, in store order,
   *   and no others. A message stored as one row stays when its append fails
   *   after the row landed, the manager's own listener failing inside it
   *   (see onMessage). A sharded write that fails partway removes the shards
   *   it stored, and when that removal fails too, the error names the shards
   *   that stayed.
   * - {@link WriteOutcomeUnknownError}: the manager can't tell whether the
   *   store holds some row of the message, because the read of the store
   *   that would tell threw. Its `landed` names the rows it knows are
   *   stored, and its `unknown` and `unnamed` what it can't say about.
   * - Any other error: none of it. A write that fails before a row lands
   *   throws its own error, and so does a sharded write that fails partway,
   *   once it has removed what it stored.
   *
   * The first two carry the write's own error as their `cause`.
   *
   * A sharded body's shards land together, as one body: a chunking whose
   * `bodyGroupId` is empty or not a string is refused before any shard is
   * stored, and an addMessage on this manager made while a sharded
   * addMessage of its stores its shards (from a listener of a shard's add,
   * or a strategy hook a listener runs by presenting a shard) is refused,
   * saying why, since its
   * row would land between the shards and split the body. In legacy mode
   * the strategy hears the shards once every one is stored, in one call,
   * so no hook of its runs between them. A listener that moves the store's
   * branch between shards stops the write there, and its WriteLandedError
   * names the shards stored, on the branch the write started on. A write
   * that fails partway where the store then can't say its branch removes
   * nothing either, and its error names the shards stored likewise.
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
    // So does a sharded addMessage storing its shards, whose listeners can
    // run a host's code (onMessage) and the strategy's (through a listener
    // that presents a shard): a row added now would land between the
    // shards, and the body-runs rule (body-runs.ts) would read two bodies.
    if (this.writingShards) {
      throw new Error(
        'ContextManager.addMessage refused: a sharded addMessage is storing its shards, and a message added now would ' +
          'land between them and split the body. Add it once that call has returned.',
      );
    }
    // First, so a message refused here changes nothing: no hold expires, no
    // hold is placed, and the strategy's ingress chunking never reads it.
    // What a write mends is mended here, so the strategy chunks what is
    // stored (well-formed-content.ts). A shard of that chunking is checked
    // later (appendMessage), once expired holds have been released, as at
    // any add.
    content = contentForWrite(content, 'Message refused');
    // So is a system change between a tool call and its result
    // (MessageStore.refuseToolPairSplit).
    this.messageStore.refuseToolPairSplit(content, 'Message refused');
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
        // The group id is what makes the shards one body (body-runs.ts) and
        // what a failed write's cleanup removes by: a shard without one is a
        // message of its own.
        if (typeof decision.bodyGroupId !== 'string' || decision.bodyGroupId === '') {
          throw new Error(
            `chunkIngressMessage returned bodyGroupId ${JSON.stringify(decision.bodyGroupId) ?? String(decision.bodyGroupId)}; ` +
              `a group of ${shardCount} shards needs a non-empty string`,
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
        const stored: MessageId[] = [];
        const lengthBefore = this.messageStore.length();
        // These appends must stay synchronous: one body's shards in one loop, in
        // shard order, with no await between them. The body-runs rule (body-runs.ts)
        // reads a body as consecutive messages of one group id whose shard indices
        // rise, so a body's shards must land together: a message appended between
        // them would split the body. Nothing in context-manager appends a message
        // anywhere but here and below, and an addMessage on this manager made while
        // this loop runs is refused (writingShards, this manager's own: another
        // manager on the slot doesn't see it, and onMessage's contract rules out an
        // add from a listener there too): a host's onMessage listener runs inside each
        // append, and the strategy's hooks run there when that listener presents a
        // shard. In legacy mode the strategy hears the body once the loop ends, in
        // one call, as presentRows gives a body, so no hook of its runs between
        // the shards. They land on one branch too: a listener that moves the
        // store's branch stops the write before the next shard, which would land
        // on the other branch.
        // The branch the shards land on: its id, which a branch made again
        // under the same name doesn't share.
        const branch = this.store.currentBranch();
        const onBranch = () => this.store.currentBranch().id === branch.id;
        // The rows a legacy window took in, which the strategy hears; kept
        // here, so a failure after the loop still tells the shards that stay.
        const heard: StoredMessage[] = [];
        // Set while a shard's append runs: an error from it may follow its
        // row landing, which then has no id here. Any other error comes
        // between appends, or after the last, when every row is named.
        let appending = false;
        this.writingShards = { heard };
        try {
          for (const shard of ordered) {
            if (stored.length > 0 && !onBranch()) {
              throw new Error(
                `the store's branch moved from ${branch.name} to ${this.store.currentBranch().name} while addMessage stored ` +
                  `the shards of body group ${decision.bodyGroupId}, after ${stored.length} of ${shardCount}; the rest weren't ` +
                  `stored, and those that were are on ${branch.name}`,
              );
            }
            appending = true;
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
            appending = false;
            stored.push(message.id);
          }
          // The strategy hears the shards a legacy window took in, once every
          // shard is stored, where the last shard's listeners left the store:
          // on another branch they wait, as rows a hook stopped do.
          this.writingShards = null;
          if (onBranch()) this.notifyPresented(heard);
          else this.deferPresented(heard, true);
        } catch (err) {
          this.writingShards = null;
          // The shards a failed write leaves stored are in a legacy window,
          // so the strategy hears those it took in, as it hears a write that
          // completes: at once on the branch the write started on, and after
          // a move once the strategy is initialized, where the window of
          // the branch it initialized on holds them.
          // Where the store can't say its branch, they wait as after a move.
          // Shards of the write that wait to be heard by their ids alone,
          // where the store is on the branch the write started on and its
          // window reads legacy: that window is the record, which holds a
          // shard the store kept, so the delivery tells it as the add would
          // have. Anywhere else nothing waits, since a presented window
          // holds such a shard only once a host presents it, which tells
          // the strategy itself.
          const waitInLegacyWindow = (ids: readonly MessageId[]) => {
            if (ids.length === 0 || this.closed) return;
            try {
              if (!onBranch() || this.windowIndex.mode() !== 'legacy') return;
            } catch {
              return;
            }
            for (const id of ids) this.presentedUnheard.set(id, true);
          };
          // A shard can stay without the manager's listener having kept it:
          // its append can land and throw before the event, or the
          // listener's read of the window can throw first. On the branch
          // the write started on, while the window reads legacy, such a
          // shard is read from the slot (guarded), so the strategy hears
          // every shard that stayed. One whose row can't be read waits by
          // its id (waitInLegacyWindow), and so do the rows read with it:
          // the delivery tells them in one call, those the window's listing
          // then holds. Where the window can't say it is legacy, a shard the
          // listener didn't keep isn't told: a presented window doesn't
          // hold it, and would hear it twice once a host presents it. Where
          // the manager's own work telling it fails, the rows wait for the
          // strategy's next notification, as tellPresentation's do.
          const hearStayed = (stayed: readonly MessageId[]) => {
            const ids = new Set(stayed);
            const rows = heard.filter((m) => ids.has(m.id));
            let here: boolean;
            try {
              here = onBranch();
            } catch {
              here = false;
            }
            const unread: MessageId[] = [];
            if (here && rows.length < ids.size) {
              try {
                if (this.windowIndex.mode() === 'legacy') {
                  const kept = new Set(rows.map((m) => m.id));
                  for (const id of stayed) {
                    if (kept.has(id)) continue;
                    let row: StoredMessage | null;
                    try {
                      row = this.messageStore.get(id);
                    } catch {
                      unread.push(id);
                      continue;
                    }
                    if (row) rows.push(row);
                  }
                  const order = new Map(stayed.map((id, i) => [id, i] as const));
                  rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
                }
              } catch {
                // The rows the listener kept are told; the window can't say
                // it is legacy, so the rest aren't.
              }
            }
            waitInLegacyWindow(unread);
            try {
              if (here && unread.length === 0) this.notifyPresented(rows);
              else this.deferPresented(rows, true);
            } catch (error) {
              this.waitToBeHeard(rows, true);
              this.logOnFailedAdd(
                '[context-manager] a sharded addMessage failed partway, and telling the strategy of the shards that stayed failed; it is told at its next notification:',
                error,
              );
            }
          };
          // Where which shards stayed is unknown (a read that would tell
          // threw, or a shard's own append threw and its row has no id
          // here), every shard the legacy window took in waits, and so does
          // every shard the write names (`named`: what the read-back named,
          // or every shard it stored where the read-back threw), by its id,
          // where the window reads legacy (waitInLegacyWindow). The
          // delivery tells those the window's listing then holds
          // (deliverPresentedUnheard), at once where it reads, and at the
          // strategy's next notification where it doesn't. A shard whose
          // own append threw, where the read of whether it landed threw
          // too, has no id, and waits only where the listener kept it.
          const hearWhatStayed = (named: readonly MessageId[] = []) => {
            waitInLegacyWindow(named);
            try {
              this.deferPresented(heard, true);
            } catch (error) {
              this.logOnFailedAdd('[context-manager] a sharded addMessage failed partway, and telling the strategy of the shards that stayed failed:', error);
            }
          };
          // A write the store's branch moved under stopped there, or failed
          // after it moved: what it stored is on the branch it started on,
          // which the store no longer reads, so nothing is read or removed.
          // So too where the store can't say its branch: the shards it
          // stored are on the branch it started on, and the store may not
          // read it. The shards it stored stayed; a shard whose append threw
          // may have landed there too.
          let away: boolean;
          try {
            away = !onBranch();
          } catch (read) {
            this.logOnFailedAdd(
              `[context-manager] a sharded addMessage failed partway, and reading the store's branch threw, so nothing is ` +
                `removed, and body group ${decision.bodyGroupId} may be left short: ${describeThrown(read)}`,
            );
            away = true;
          }
          if (away) {
            if (appending) hearWhatStayed();
            else hearStayed(stored);
            throw appending ? new WriteOutcomeUnknownError({ landed: stored, unknown: [], unnamed: 1 }, err) : new WriteLandedError(stored, err);
          }
          // A write that fails partway leaves no part of the body in the
          // store: remove what it wrote (the failing shard too, if it
          // landed), so a retry writes one body, and throw the write's own
          // error. A shard's own append can throw after it landed: then its
          // row follows the shards stored before it, and removing their run
          // removes it too, whether or not the store could be read to tell
          // that it landed. If the removal fails as well, the shards may
          // stay, and shardCount marks the body short: the error names those
          // that did (WriteLandedError). Where the store can't be read to
          // tell whether a row of the write is in it, the error says so,
          // naming what the manager knows (WriteOutcomeUnknownError).
          const wrote = [...stored];
          // 1 when the store can't be read to tell whether the failing
          // shard's row landed, which then has no id here. Only an append
          // can leave a row: a write that failed outside one has none.
          let unnamed = 0;
          try {
            const failing = appending ? this.rowLandedAt(lengthBefore + stored.length, decision.bodyGroupId) : null;
            if (failing !== null) wrote.push(failing);
          } catch (read) {
            unnamed = 1;
            // With no shard stored before it, no id names what to remove,
            // so nothing is removed. The legacy window may have taken the
            // shard in, so the strategy hears it where the window's listing
            // holds it, as on the other exits whose outcome is unknown.
            if (stored.length === 0) {
              this.logOnFailedAdd(
                `[context-manager] a sharded addMessage failed on its first shard, and reading the store to tell whether that ` +
                  `shard landed threw, so it may be stored, leaving body group ${decision.bodyGroupId} short: ` +
                  describeThrown(read),
              );
              hearWhatStayed();
              throw new WriteOutcomeUnknownError({ landed: [], unknown: [], unnamed }, err);
            }
          }
          if (wrote.length === 0) throw err;
          // A host's listener of the add may have presented a shard, so the
          // removal takes the window's shards out with it, and the strategy
          // is told, as removeMessages tells it: the rows are read first,
          // for the store's event (handleMessageStoreEvent). Where the
          // failing shard's landing couldn't be read (`unnamed`), its row,
          // if it landed, has no id here, and the removal takes it with the
          // run all the same: the run is read from the slot then, as the
          // removal finds it (bodyRunOf), so the rows named are the rows it
          // takes. Where that read fails, the shards the write named are
          // read by their ids, as otherwise.
          const removingBefore = this.removing;
          try {
            const named = this.rowsBeforeRemoval(`body group ${decision.bodyGroupId} (first shard ${wrote[0]})`, wrote, () => {
              const byId = () =>
                wrote.flatMap((id) => {
                  const row = this.messageStore.get(id);
                  return row ? [row] : [];
                });
              if (unnamed === 0) return byId();
              try {
                return this.bodyRunOf(wrote[0]!) ?? byId();
              } catch {
                return byId();
              }
            });
            this.removing = named && { ids: [...new Set([...named.ids, ...named.rows.map((m) => m.id)])], rows: named.rows };
            this.messageStore.removeBodyGroup(wrote[0]!);
          } catch (removal) {
            this.logOnFailedAdd(
              `[context-manager] a sharded addMessage failed partway, and removing what it wrote threw, so body group ` +
                `${decision.bodyGroupId} (first shard ${wrote[0]}) may be left short: ` +
                describeThrown(removal),
            );
            // The removal is one store write, of the whole run: the shards
            // stayed, a failing shard's row that landed with them, or none
            // of them did. They are asked of the branch the write started
            // on: a hook the removal's event ran (onCompressionHoldsReleased)
            // can move the store, and another branch's record says nothing
            // of this one's. Where it moved, or the store can't say, which
            // stayed is unknown.
            let here: boolean;
            try {
              here = onBranch();
            } catch {
              here = false;
            }
            const stayed = here ? this.rowsStillStored(wrote) : null;
            if (stayed === null) {
              hearWhatStayed(wrote);
              throw new WriteOutcomeUnknownError({ landed: [], unknown: wrote, unnamed }, err);
            }
            if (stayed.length > 0) {
              if (unnamed === 0) hearStayed(stayed);
              else hearWhatStayed(stayed);
              throw unnamed === 0 ? new WriteLandedError(stayed, err) : new WriteOutcomeUnknownError({ landed: stayed, unknown: [], unnamed }, err);
            }
          } finally {
            this.removing = removingBefore;
          }
          throw err;
        }
        return stored[0]!;
      }
    }
    const lengthBefore = this.messageStore.length();
    // The branch the row lands on, read guarded: where the store can't say
    // it here, a failure is read back as before.
    let startedOn: string | null;
    try {
      startedOn = this.store.currentBranch().id;
    } catch {
      startedOn = null;
    }
    try {
      return this.messageStore.append(participant, content, metadata, causedBy).id;
    } catch (err) {
      // The append can throw after its row landed: the manager's own
      // listener runs inside it, and its failure fails the write (see
      // onMessage). The row stays, and the error names it. Where the store
      // can't be read to tell, the error says the manager can't. So too
      // where a listener of the add moved the store's branch before the
      // append threw (a host listener's throw is caught and logged, but the
      // log can throw too): the row landed on the branch the add started
      // on, if it landed, which the store no longer reads, and the other
      // branch's row at that place says nothing of it.
      let moved: boolean;
      try {
        moved = startedOn !== null && this.store.currentBranch().id !== startedOn;
      } catch {
        moved = true;
      }
      if (moved) throw new WriteOutcomeUnknownError({ landed: [], unknown: [], unnamed: 1 }, err);
      let landed: MessageId | null;
      try {
        landed = this.rowLandedAt(lengthBefore);
      } catch (read) {
        this.logOnFailedAdd(
          `[context-manager] addMessage failed, and reading the store to tell whether its row landed threw, so the row may be stored: ` +
            describeThrown(read),
        );
        throw new WriteOutcomeUnknownError({ landed: [], unknown: [], unnamed: 1 }, err);
      }
      throw landed === null ? err : new WriteLandedError([landed], err);
    }
  }

  /**
   * Log a line on a failed add's way to the error that says what the store
   * holds of the message (WriteLandedError, WriteOutcomeUnknownError, or
   * the write's own error, which says it holds none): a log that throws
   * (a console.error that throws) is dropped, so that error is always
   * built, and the log's error never reaches the host in its place. With
   * a thrown value after the message, the line is logThrown's.
   */
  private logOnFailedAdd(message: string, ...thrown: [] | [unknown]): void {
    try {
      if (thrown.length === 0) this.diag.error(message);
      else logThrown(message, thrown[0], this.diag);
    } catch {
      // A failed log isn't the add's outcome.
    }
  }

  /**
   * The id of the row an append that threw left in this manager's slot, if
   * it landed: the slot's row at `index`, the slot's length before the
   * append, when it carries the append's body group (none for a message
   * stored as one row). Null when the slot holds no such row. A read that
   * fails throws.
   */
  private rowLandedAt(index: number, bodyGroupId?: string): MessageId | null {
    const length = this.messageStore.length();
    if (length <= index) return null;
    const row = this.messageStore.getTail(length - index)[0];
    return row !== undefined && row.bodyGroupId === bodyGroupId ? row.id : null;
  }

  /**
   * The body the slot holds `id` in, in store order, as
   * MessageStore.removeBodyGroup finds it: the run of shards around it
   * (body-runs.ts). Null where the slot doesn't hold `id`. A read that
   * fails throws.
   */
  private bodyRunOf(id: MessageId): StoredMessage[] | null {
    const all = this.messageStore.getAll();
    const at = all.findIndex((m) => m.id === id);
    if (at === -1) return null;
    const { from, to } = bodyBoundsIn(all, at);
    return all.slice(from, to + 1);
  }

  /**
   * The rows of `ids` this manager's slot still holds, in the order given:
   * what a sharded write's failed removal left. Null when the store can't be
   * read to tell: a removal can throw after it took the rows out (its
   * listeners run after the write).
   */
  private rowsStillStored(ids: readonly MessageId[]): MessageId[] | null {
    try {
      return ids.filter((id) => this.messageStore.sequenceOf(id) !== undefined);
    } catch {
      return null;
    }
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
   *
   * Once a host presents rows on the branch (see presentRows), a row the
   * window holds leaves it as retractRows takes a row out: a tombstone at
   * its ordinal, so no other row's ordinal moves. The strategy is told the
   * row left (ContextStrategy.onRetracted, with `removed`), with the row as
   * it was before it went, and is told so too where the window can't be
   * read to tell whether it held the row. In legacy mode the window is the
   * record, and the strategy isn't told: what it folded of the row it
   * keeps. A removal through another manager on the same slot isn't heard
   * here: a host takes that row out of this window with retractRemoved,
   * naming it, or retractAbsentRows, which finds every such row, and this
   * manager's strategy is told then, by the row's id, as this one's is told
   * here. A removal made while a sharded addMessage stores its shards (from
   * an onMessage listener of a shard's add) is refused (see onMessage).
   *
   * Except where a strategy hook the removal runs moves the store's branch:
   * onCompressionHoldsReleased, run by the removal's release of holds, or a
   * hook that hears what an earlier window write whose outcome was unknown
   * did, which the tombstone's write settles first. Then nothing is taken
   * out of the window of the branch the store is on, whose record may hold
   * the row, and no strategy is told (a warning says so); on the removal's
   * branch the row keeps its ordinal until retractAbsentRows takes it out
   * there.
   */
  removeMessage(messageId: MessageId): void {
    this.requireInitialized('removeMessage');
    this.refuseWhileWritingShards('removeMessage');
    this.write(() => {
      // The row is gone by the time the store's event is heard, so it is
      // read here first, for the strategy (handleMessageStoreEvent), as
      // removeMessages reads its range.
      this.removing = this.rowsBeforeRemoval(`message ${messageId}`, [messageId], () => {
        const row = this.messageStore.get(messageId);
        return row ? [row] : [];
      });
      try {
        this.messageStore.remove(messageId);
      } finally {
        this.removing = null;
      }
    });
    // Propagation handled by event listener
  }

  /**
   * Remove a range of messages from the store. Every row of the range the
   * window holds leaves it, and the strategy is told, as removeMessage says.
   * The store's event names only the range's ends, so its rows are read
   * before it goes: where that read fails (logged), the removal goes ahead,
   * and the window's rows of the range keep their ordinals, untold, until
   * retractAbsentRows takes them out and tells the strategy.
   */
  removeMessages(fromId: MessageId, toId: MessageId): void {
    this.requireInitialized('removeMessages');
    this.refuseWhileWritingShards('removeMessages');
    this.write(() => {
      // The store's event names the range by its ends, and its rows are gone
      // by the time the event is heard, so they are read here first
      // (handleMessageStoreEvent).
      this.removing = this.rowsBeforeRemoval(`messages ${fromId} to ${toId}`, null, () => this.slotRowsBetween(fromId, toId));
      try {
        this.messageStore.removeRange(fromId, toId);
      } finally {
        this.removing = null;
      }
    });
    // Propagation handled by event listener
  }

  /**
   * The rows a removal is about to take, as `read` finds them in this
   * manager's slot, for the store's event to take out of the window
   * (retractOnRemoval), with their ids: `ids`, for a removal that names its
   * rows (removeMessage, a failed sharded addMessage's removal of what it
   * stored), else the ids of the rows read. They are read in either mode,
   * without asking the window: an index that can't be read doesn't keep
   * the strategy from being told, and in legacy mode the event writes and
   * tells nothing. The removal goes ahead whatever happens here, as it does
   * when a tombstone can't be written: a read that fails is logged, and the
   * rows a removal names leave the window by their ids, told by their ids
   * alone. A removal of a range, whose event names only its ends, then
   * leaves the window's rows of it their ordinals, untold (null).
   */
  private rowsBeforeRemoval(what: string, ids: readonly MessageId[] | null, read: () => StoredMessage[]): Removing | null {
    try {
      const rows = read();
      return { ids: ids ?? rows.map((m) => m.id), rows };
    } catch (err) {
      // A format string, since the error follows it: a '%' in an id is doubled.
      const message =
        `[context-manager] reading the rows before removing ${what} failed; ` +
        (ids
          ? `the removal goes ahead, and the window's rows of it leave by their ids:`
          : `the removal goes ahead, and the window's rows of it keep their ordinals, untold, until retractAbsentRows() takes them out and tells the strategy by id:`);
      logThrown(message.replaceAll('%', '%%'), err, this.diag);
      return ids ? { ids, rows: [] } : null;
    }
  }

  /**
   * Refuses a removal made while a sharded addMessage stores its shards
   * (from an onMessage listener of a shard's add, or a strategy hook that
   * listener runs): a shard it took would split the body, and any row it
   * took would move the rows that write's failure reads back and removes.
   */
  private refuseWhileWritingShards(operation: 'removeMessage' | 'removeMessages'): void {
    if (!this.writingShards) return;
    throw new Error(
      `ContextManager.${operation} refused: a sharded addMessage is storing its shards, and a removal now could split the body ` +
        'or move the rows that call removes if it fails. Remove it once that call has returned.',
    );
  }

  /**
   * Refuses a branch cut asked for while a sharded addMessage stores its
   * shards (branchAt, branchSequenceOf, and fork and derive, which cut at
   * the head): the record holds only the shards stored so far, so the cut
   * would come before the body's last shard, and the new branch's record
   * would hold part of the body. A fork would also move the store's branch,
   * which stops the write.
   */
  private refuseCutWhileWritingShards(operation: 'branchAt' | 'branchSequenceOf' | 'fork' | 'derive'): void {
    if (!this.writingShards) return;
    throw new Error(
      `ContextManager.${operation} refused: a sharded addMessage is storing its shards, and a cut now would come before ` +
        "the body's later shards, so the new branch's record wouldn't hold the whole body. Ask for it once that call has returned.",
    );
  }

  /** The rows of this manager's slot from `fromId` to `toId`, in slot order; empty when either isn't there. */
  private slotRowsBetween(fromId: MessageId, toId: MessageId): StoredMessage[] {
    const view = this.messageStore.createView();
    const listing = view.getAll();
    const from = recordPositionOf(view, listing, fromId);
    const to = recordPositionOf(view, listing, toId);
    if (from === undefined || to === undefined) return [];
    return listing.slice(from, to + 1);
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
   * would land between a body's shards and split the body (body-runs.ts), so
   * an addMessage on this manager made while a sharded addMessage of its
   * stores its shards is refused; one on another manager sharing the slot
   * isn't, and is the listener's to avoid. Add it after the call returns (a
   * microtask or later) instead. Nor may it remove a message then
   * (removeMessage, removeMessages on this manager are refused, as a
   * removal could split the body or move the rows the sharded
   * write removes if it fails), nor ask for a branch cut (branchAt,
   * branchSequenceOf, fork and derive on this manager are refused, as the
   * record holds only the shards stored so far), or move the store's
   * branch: the sharded write stops before its next shard and throws
   * (WriteLandedError). It may present a shard it hears stored: that
   * presents only the shards stored by then, the strategy hears that
   * presentation at that call, and a later presentRows naming the body
   * puts the rest in (see presentRows). A listener
   * that throws is logged, naming the message it missed, and the write it
   * heard stands: the throw doesn't reach the caller, unless the log
   * throws too (a console.error that throws), when the write fails as
   * addMessage's errors say. A listener that calls
   * close() lets the write that ran it finish (see close()). Each call
   * registers its own listener and returns its own unsubscribe, so a function
   * registered twice hears each event twice.
   */
  onMessage(listener: MessageStoreListener): () => void {
    // A host's listener observes; its throw isn't the write's failure. The
    // manager's own listener (the context log's propagation) stays outside
    // this, so a failure there still fails the write as before: an add
    // whose row stays throws WriteLandedError, naming it, and one where the
    // store can't be read to tell throws WriteOutcomeUnknownError.
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
  // The agent's window: which stored rows it was shown, in what order
  // ==========================================================================

  /**
   * Present rows to this manager's agent: they enter its window, after the
   * rows already there, in the order given. The window is what every
   * strategy read and every compile follows (see window-index.ts); the
   * store's record keeps the order rows arrived in. A host presents an
   * agent's own rows as it writes them and another writer's at the agent's
   * turn start or tool boundary, so a row stored during the agent's turn
   * enters its window after the turn's own rows, as its requests carried
   * them.
   *
   * Give each row by its id. A body stored as shards is presented whole, by
   * the id addMessage returned for it (its first shard's), which stands for
   * every shard in order; its other shards may follow that id in order.
   * Throws, presenting nothing, for an id no merged slot holds (this
   * manager's own or an auxiliary one), a row in the window already, a row
   * named twice, or a later shard of a body named without its first, unless
   * the window holds every shard before it (below).
   *
   * A call's rows go in as one record, at one sequence (chronicle's
   * appendManyToStateJsonWithIdentity, the identity-stamped batched append
   * of chronicle 0.6.0, which this package requires): the store keeps or
   * loses the call whole, and a call the store refuses has presented
   * nothing (after any throw the window is read again from the store). A
   * store handle without the batched append is refused when the manager is
   * made over it (open, derive, reopenDerived), before any record changes,
   * so no call meets one. The call is then
   * one presentation point: branchAt of any row it presented cuts after all
   * of them (see branchAt), so a host that wants a cut at one row, such as
   * an agent's own row, presents it in a call of its own, which is one
   * record as a single row always was.
   *
   * Pre-release builds of the window index, before batched writes, wrote
   * each row presented as one record (no release did), so in an index they
   * wrote a call cut short (it threw partway, or the process died before
   * the store synced) can have left a body's first shards in the window and
   * the rest out; so can a branch or a derive cut between its shards'
   * presentations there. So, in any index, can a host's onMessage listener
   * of a shard's add that presents the shard while a sharded addMessage
   * runs: it presents only the shards stored by then. Such a body
   * is completed, not refused: naming it, by its first shard's id or by the
   * first shard the window lacks, which getUnpresentedMessages lists with
   * the shards after it, presents only the shards it lacks, at the end of
   * the window. The shards in it keep their ordinals. A row presented in
   * between stays between them, and the body is then compiled as two runs,
   * each reported incomplete in compile provenance. A host that presents
   * its unpresented rows at turn start completes such a body that way.
   *
   * A body the window holds the other way round, its first shard out and a
   * later one in (a retractRows cut short after the first shard's
   * tombstone, in such an index), can't be completed where it stands:
   * its head would follow its own later shards. Naming it by its first
   * shard's id takes those shards out and presents the body whole at the
   * end, in body order, in the one write: they take new ordinals, and the
   * strategy hears them leave (onRetracted), then the body enter. A hook of
   * the first call that closes the manager, sets a strategy, starts an
   * initialization or moves the store's branch sends the second where a
   * call made then goes: the body is heard once the strategy is
   * initialized, where the window of the branch it initialized on holds
   * it. Such a first shard reads `'undone'` or `'out'` (windowStatusOf), as
   * its own tombstone left it.
   *
   * Until the first presentation on a branch the manager is in legacy
   * mode: the window is the merged record itself, read live, so compiles
   * are what they always were. That first call writes the window down as it
   * stands (every row of the record, in record order, which takes in the
   * rows it names), and from then on the window grows only by presentation.
   * A host that presents starts each agent's window at boot, before
   * anything arrives mid-turn, with presentRows([]). The write-down is one
   * record, and the first batch a store records moves its MANIFEST to
   * format version 2, which chronicle releases from before batched appends
   * refuse to open. It switches the mode with its last item, the header, so
   * a write-down a pre-release build cut short, one record per stored row
   * (the call threw partway, or the process died before the store synced),
   * leaves the manager in legacy mode, its window still the whole record,
   * and the next presentRows, the boot call presentRows([]) among them, or
   * a retractRows that names a row finishes the write-down, in one record,
   * before it does its own work.
   *
   * On a branch whose window index another version wrote in a format this
   * one doesn't read, the window is the record (with a warning when the
   * index is read), and this throws, writing nothing.
   *
   * The strategy hears the rows that entered the window
   * (ContextStrategy.onPresented) once they are in it and before this
   * returns, fire and forget: its failure is logged, and the rows stay
   * presented. So is a failure of the manager's own work around the call
   * (the context it builds for the strategy), which doesn't throw here, as
   * the rows are in the window: they wait, and are heard at the strategy's
   * next notification. The first call, which writes the legacy window down, enters
   * no row the window didn't already hold, which the strategy reads in its
   * view, so it hears nothing. A call the store refuses tells it nothing; a
   * call that throws after the store kept part of it tells the strategy the
   * rows that left and entered before it, then throws; a call that
   * completes a body tells it only the shards that entered then. Either
   * way, where the index reads again after the write threw, the error
   * thrown is the write's own, whether the store kept the write or refused
   * it: ordinalOf or windowStatusOf tells which, and a retry of a write the
   * store kept is refused, the rows being in the window already. Where the
   * write throws and
   * the index can't be read again to tell whether it landed, the call
   * throws WindowWriteOutcomeUnknownError (its `cause` the write's own
   * error), and the strategy hears what the store kept at the next write
   * to the window on that branch, with the rows as this call found them:
   * a row removed meanwhile is heard entering as it was stored, and then
   * leaving, as the removal tells it. Where the store can't say which
   * branch the write was made on, before it or after it, nothing waits: a
   * warning and the error's message say so, and the strategy reads the
   * window at its next select.
   *
   * Returns each named row's index ordinal (see ordinalOf). A closed
   * manager refuses it.
   *
   * Presenting a row to the agent is not the fold journal's
   * `presentation`, which acceptRound takes: that says how a provider
   * round carried a compile.
   */
  presentRows(ids: readonly MessageId[]): number[] {
    this.requireOpen('presentRows');
    const merged = this.mergedMessageView();
    const record = merged.getAll();
    const positionOf = (id: MessageId) => recordPositionOf(merged, record, id);
    // A write that threw tells the strategy its rows as this call's record
    // holds them, read from it by id, never from the store: one whose
    // outcome was unknown is told at a later write, when the store may no
    // longer hold a row of it (a removal meanwhile, whose own onRetracted
    // follows), or can't be read. What waits for that write keeps only the
    // rows the write named (keep), not the record.
    const asFound = rowsAsFound(record);
    return this.write(() => {
      let presented: ReturnType<WindowIndex['present']>;
      try {
        presented = this.windowIndex.present(ids, record, positionOf, this.cutShortPresentation(asFound));
      } catch (error) {
        if (error instanceof WindowWriteOutcomeUnknownError) asFound.keep([...error.entering, ...error.leaving]);
        throw error;
      }
      const { ordinals, entered, left } = presented;
      // The rows are in the window: a failure of the manager's own work
      // around the strategy's call is logged, not thrown, since a retry
      // would be refused, and what it was for waits (tellPresentation).
      try {
        this.tellPresentation(left, entered, (id) => record[positionOf(id)!]!);
      } catch (error) {
        logThrown('[context-manager] presentRows presented its rows, and telling the strategy of them failed; it is told at its next notification:', error, this.diag);
      }
      return ordinals;
    });
  }

  /**
   * Tell the strategy what a presentRows did: the later shards of a body
   * whose first shard was out, which left so the body could enter whole
   * (WindowIndex.present), and the rows that entered, each read by
   * `rowOf`. The rows are found before either hook runs, since a hook can
   * move the store's branch, or take the rows that entered out of the
   * window again. The second call is made where the first's hook leaves
   * it, as notifyPresented makes a row's call after another row's hook
   * (deferPresented): for the rows the window holds when it is made.
   * Where the manager's own work around a
   * call throws (the rows' reading, the context it builds), no hook of
   * that call has run: the call's rows wait, as rows a delivery that
   * failed to read left waiting do, to be heard at the strategy's next
   * notification, and the error is thrown on.
   */
  private tellPresentation(left: readonly LeftRow[], entered: readonly MessageId[], rowOf: (id: MessageId) => StoredMessage): void {
    let leftTold = left.length === 0;
    try {
      const leftRows = left.map(({ id, ordinal, by }) => ({ id, row: rowOf(id), ordinal, by }));
      const enteredRows = entered.map(rowOf);
      const scope = leftRows.length > 0 ? this.hookScope() : null;
      this.notifyRetracted(leftRows, { undone: false, removed: false });
      leftTold = true;
      // The first call's hook may also have taken rows that entered out of
      // the window again (a retractRows, a nested write the manager allows),
      // moving nothing else: the second call then waits too, and is made
      // for the rows the window holds when it is delivered. A read that
      // throws can't tell, so they wait as well.
      const stillIn = () => {
        try {
          return entered.every((id) => this.windowIndex.ordinalOf(id) !== undefined);
        } catch {
          return false;
        }
      };
      if (scope === null || (this.inHookScope(scope) && stillIn())) this.notifyPresented(enteredRows);
      else this.deferPresented(enteredRows, false);
    } catch (error) {
      if (!leftTold) this.retractedUnheard.push({ left: left.map(({ id, ordinal, by }) => ({ id, ordinal, by })), info: { undone: false, removed: false } });
      for (const id of entered) this.presentedUnheard.set(id, this.presentedUnheard.get(id) === true);
      throw error;
    }
  }

  /**
   * presentRows' hook for a window write that threw (WindowIndex.present's
   * `cutShort`): it tells the strategy the rows that left and entered
   * before the throw, read from `rows`, and logs a failure to. It is made
   * here, apart from the call, so a hook that waits for a later write
   * holds `rows` and nothing else of the call.
   */
  private cutShortPresentation(rows: RowsAsFound): (entered: MessageId[], left: LeftRow[]) => void {
    return (entered, left) => {
      // The rows a failed write got in stay in the window, and no later
      // call presents them again: this is the strategy's one hearing of
      // them, as of the rows it took out. The write's own error is the
      // one thrown, or WindowWriteOutcomeUnknownError where the index couldn't be read again.
      try {
        this.tellPresentation(left, entered, (id) => rows.get(id)!);
      } catch (error) {
        logThrown('[context-manager] presentRows was cut short, and telling the strategy of the rows that left or entered before it failed:', error, this.diag);
      }
    };
  }

  /**
   * Take rows out of this manager's agent's window. Each leaves a hole at
   * its ordinal, so no other row's ordinal moves, and the rows after it in
   * the window move up one place in what the strategies read. A row taken
   * out is presented again only by a later presentRows, which gives it a
   * new ordinal at the end.
   *
   * With `undone`, the rows are an undone turn's: getUnpresentedMessages()
   * leaves them out until they are presented again (a redo). Without it, a
   * row taken out counts as arrived and not presented, as another agent's
   * row presented during an undone turn does.
   *
   * A body goes whole, named by its first shard's id, which stands for
   * every shard the window holds. A row the store no longer holds can still
   * be taken out by its id. Throws, taking out nothing, for a row not in
   * the window, a row named twice, or a later shard named without its
   * first. A closed manager refuses it.
   *
   * retractRows([]) takes nothing out and writes nothing, in either mode.
   * Any other call in legacy mode switches the manager to presented mode:
   * the window, which is the whole record there, is first written down, as
   * presentRows writes it, and the rows named leave it, so a row stored
   * after the call enters the window only when presented. It refuses, as
   * presentRows does, an index in another version's format.
   *
   * The strategy is told the rows left (ContextStrategy.onRetracted, with
   * `undone` as given) once they are out of the window and before this
   * returns, fire and forget: its failure is logged, and the rows stay out.
   * A failure of the manager's own work around the call is logged too, and
   * the call waits, as presentRows' rows do.
   * A call that throws after the store kept its tombstones tells the
   * strategy the rows that left, then throws the write's own error, as one
   * the store refused does: ordinalOf or windowStatusOf tells which, and a
   * retry of a write the store kept is refused, the rows being out of the
   * window already. Where the index can't be read again to tell, it throws
   * WindowWriteOutcomeUnknownError and the strategy hears at the next write
   * to the window, unless the store can't say which branch the write was
   * made on, before it or after it: then nothing waits, as presentRows says.
   * A row the store no longer holds (one removed through another manager)
   * has no row to give: it is told by its id alone, in a call of its own
   * with `removed`, after the call for the rows the store holds, so a
   * strategy lets go of what it folded of it too. A hook of the first call
   * that closes the manager, sets a strategy, starts an initialization or
   * moves the store's branch sends the second where a call made then goes,
   * as presentRows sends its second. A call's tombstones are
   * one record, as presentRows's rows are, so a call the store refuses has
   * taken nothing out and told nothing (in legacy mode the write-down is a
   * record of its own, before them). A store handle without the batched
   * append is refused at open (see presentRows).
   */
  retractRows(ids: readonly MessageId[], options?: { undone?: boolean }): void {
    this.requireOpen('retractRows');
    const merged = this.mergedMessageView();
    const record = merged.getAll();
    const positionOf = (id: MessageId) => recordPositionOf(merged, record, id);
    const info: Retraction = { undone: options?.undone === true, removed: false };
    // As presentRows' rows, a write that threw tells its rows as this
    // call's record holds them, and what waits keeps only those.
    const asFound = rowsAsFound(record);
    this.write(() => {
      let left: LeftRow[];
      try {
        left = this.windowIndex.retract(ids, record, positionOf, info.undone, this.cutShortRetraction(asFound, info));
      } catch (error) {
        if (error instanceof WindowWriteOutcomeUnknownError) asFound.keep([...error.entering, ...error.leaving]);
        throw error;
      }
      // The rows are out of the window: as presentRows, a failure of the
      // manager's own work around the call is logged, and the call waits.
      try {
        this.tellRetraction(left, info, (id) => {
          const at = positionOf(id);
          return at === undefined ? undefined : record[at];
        });
      } catch (error) {
        logThrown('[context-manager] retractRows took its rows out, and telling the strategy of them failed; it is told at its next notification:', error, this.diag);
      }
    });
  }

  /**
   * Tell the strategy the rows a retractRows took out, each with the row
   * `rowOf` gives. A row taken out by its id after the store dropped it
   * has none to give: it is told by its id, as removed, in a call of its
   * own. Both calls' rows are found before either hook runs, and the
   * second call is made where the first's hook leaves it (deferRetracted),
   * as presentRows makes its second. Where the manager's own work around a
   * call throws, what it was for waits, as tellPresentation's rows do (a
   * waiting call tells a row the store no longer holds by its id, in a
   * call of its own), and the error is thrown on.
   */
  private tellRetraction(left: readonly LeftRow[], info: Retraction, rowOf: (id: MessageId) => StoredMessage | undefined): void {
    const removed: Retraction = { undone: info.undone, removed: true };
    let waiting: { left: RetractedRow[]; info: Retraction } = { left: left.map(({ id, ordinal, by }) => ({ id, ordinal, by })), info };
    try {
      const held: RetractedRow[] = [];
      const gone: RetractedRow[] = [];
      for (const { id, ordinal, by } of left) {
        const row = rowOf(id);
        if (row === undefined) gone.push({ id, ordinal, by });
        else held.push({ id, row, ordinal, by });
      }
      const scope = held.length > 0 && gone.length > 0 ? this.hookScope() : null;
      this.notifyRetracted(held, info);
      waiting = { left: gone, info: removed };
      if (scope === null || this.inHookScope(scope)) this.notifyRetracted(gone, removed);
      else this.deferRetracted(gone, removed);
    } catch (error) {
      if (waiting.left.length > 0) this.retractedUnheard.push(waiting);
      throw error;
    }
  }

  /**
   * retractRows' hook for a window write that threw (WindowIndex.retract's
   * `cutShort`), as cutShortPresentation is presentRows': a row the store
   * holds when it is told is given as the call's record held it, and one
   * it no longer holds is told by its id.
   */
  private cutShortRetraction(rows: RowsAsFound, info: Retraction): (left: LeftRow[]) => void {
    return (left) => {
      // The rows a failed write took out stay out, and no later call
      // takes them out again: this is the strategy's one hearing of them.
      // The write's own error is the one thrown, or WindowWriteOutcomeUnknownError where the index couldn't be read again.
      try {
        const merged = this.mergedMessageView();
        this.tellRetraction(left, info, (id) => (holdsRow(merged, id) ? rows.get(id) : undefined));
      } catch (error) {
        logThrown('[context-manager] retractRows was cut short, and telling the strategy of the rows that left before it failed:', error, this.diag);
      }
    };
  }

  /**
   * Take rows removed from the record out of this manager's agent's
   * window, by their ids: the repair for a removal through another manager
   * on this manager's slot or an auxiliary one, which this one doesn't hear
   * (see ordinalOf). Each id the window holds and no slot the manager
   * merges holds any more leaves a hole at its ordinal, as retractRows
   * leaves one, so no other row's ordinal moves. Every other id is passed
   * over: one the window doesn't hold, and one the record still holds on
   * the store's branch, such as a row a branch made before the removal
   * keeps (retractRows takes a held row out). Each id is one row, so a
   * removed body is named by each of its shards. Returns the ids taken
   * out, in window order.
   *
   * In legacy mode it writes nothing and takes nothing out: the window is
   * the record there, and a removed row has left it already. Unlike
   * retractRows it never writes the window down, nor finishes a write-down
   * cut short, and on an index in another version's format it writes
   * nothing either. Where its write throws and the index can't be read again, it
   * throws WindowWriteOutcomeUnknownError, as presentRows does; where the
   * index reads again, it throws the write's own error, whether the store
   * kept the write or refused it. The rows are ones the store no longer
   * holds, so windowStatusOf reads 'absent' for them either way: ordinalOf
   * tells which (undefined once taken out), and calling this again takes
   * out only what is still there.
   *
   * A row of a slot the manager no longer merges (an auxiliary view
   * dropped from its configuration since the row was presented) reads as
   * removed, and leaves the window if it is named; a host presents it
   * again once the slot is merged again.
   *
   * The strategy is told the rows left (ContextStrategy.onRetracted), as a
   * removal through this manager tells it, with `removed`, once they are
   * out of the window and before this returns: by their ids alone, since
   * the store holds no row of them to give, so a strategy that folded them
   * lets go of what it folded, as the manager that removed them did. It is
   * fire and forget, as retractRows's call, and as there a failure of the
   * manager's own work around it (the context it builds) is logged, not
   * thrown, since the rows are out: the call waits, to be made at the
   * strategy's next notification. The tombstones are one record,
   * and a write the store refuses has taken nothing out and told nothing:
   * a later call takes the rows out. A closed manager refuses it.
   */
  retractRemoved(ids: readonly MessageId[]): MessageId[] {
    this.requireOpen('retractRemoved');
    requireMessageIds('retractRemoved', ids);
    if (this.windowIndex.mode() === 'legacy') return [];
    const merged = this.mergedMessageView();
    const removed = ids.filter((id) => !holdsRow(merged, id));
    return this.retractGone('retractRemoved', (cutShort) => this.windowIndex.retractRemoved(removed, cutShort));
  }

  /**
   * Take out of this manager's agent's window every row no slot the
   * manager merges holds any more on the store's branch, as retractRemoved
   * takes out the rows it names: each leaves a hole at its ordinal, and no
   * other row's ordinal moves. These are rows removed through managers
   * this one didn't hear, the ones no live manager could reach among them
   * (a removal made while the agent wasn't running), and rows whose own
   * removal's tombstone failed. A host runs it at boot. Returns the ids
   * taken out, in window order, and writes nothing when there are none.
   * Where its write throws, it throws as retractRemoved does, and as there
   * ordinalOf, not windowStatusOf, tells whether the write landed, and
   * calling it again is safe.
   *
   * A row of a slot the manager no longer merges (an auxiliary view
   * dropped from its configuration since the row was presented) reads as
   * removed, and leaves the window: open the manager with every slot its
   * window was presented from before calling this.
   *
   * As with retractRemoved, it writes nothing in legacy mode or on an
   * index in another version's format, and the strategy is told the rows
   * it takes out by their ids, with `removed`. A row whose own removal's
   * tombstone failed was told when it was removed, whether or not the
   * window could be read then, and is told again here: a strategy has
   * nothing left of it to let go of. A row of a removeMessages range whose
   * rows couldn't be read before they went wasn't told then, and is told
   * here. It reads the whole record. A closed manager refuses it.
   */
  retractAbsentRows(): MessageId[] {
    this.requireOpen('retractAbsentRows');
    if (this.windowIndex.mode() === 'legacy') return [];
    const record = this.mergedMessageView().getAll();
    return this.retractGone('retractAbsentRows', (cutShort) => this.windowIndex.retractAbsent(record, cutShort));
  }

  /**
   * Write the tombstones `take` writes for rows the record no longer holds
   * (retractRemoved, retractAbsentRows), and tell the strategy of the rows
   * that left by their ids, with `removed`: once they are out, or, for a
   * write that fails partway, the rows it took out before it, before the
   * error is thrown on. Returns the ids taken out, in window order.
   */
  private retractGone(operation: string, take: (cutShort: (left: LeftRow[]) => void) => LeftRow[]): MessageId[] {
    return this.write(() => {
      const left = take(this.cutShortGone(operation));
      // The rows are out of the window: as retractRows, a failure of the
      // manager's own work around the call is logged, and the call waits.
      try {
        this.tellGone(left);
      } catch (error) {
        logThrown(`[context-manager] ${operation} took its rows out, and telling the strategy of them failed; it is told at its next notification:`, error, this.diag);
      }
      return left.map((row) => row.id);
    });
  }

  /**
   * Tell the strategy rows retractGone took out, by their ids, with
   * `removed`. Where the manager's own work around the call throws, no hook
   * of it has run: the call waits, to be made at the strategy's next
   * notification, and the error is thrown on.
   */
  private tellGone(left: readonly LeftRow[]): void {
    const told = left.map(({ id, ordinal, by }): RetractedRow => ({ id, ordinal, by }));
    const info: Retraction = { undone: false, removed: true };
    try {
      this.notifyRetracted(told, info);
    } catch (error) {
      if (told.length > 0) this.retractedUnheard.push({ left: told, info });
      throw error;
    }
  }

  /**
   * retractGone's hook for a write that threw, made apart from the call, as
   * cutShortPresentation is, so one that waits for a later write holds
   * nothing of the call (retractAbsentRows' record).
   */
  private cutShortGone(operation: string): (left: LeftRow[]) => void {
    return (left) => {
      // The rows a failed write took out stay out, and a later call passes
      // over them: this is the strategy's one hearing of them here. The
      // write's own error is the one thrown, or WindowWriteOutcomeUnknownError where the index couldn't be read again.
      try {
        this.tellGone(left);
      } catch (error) {
        logThrown(`[context-manager] ${operation} was cut short, and telling the strategy of the rows that left before it failed:`, error, this.diag);
      }
    };
  }

  /**
   * `'legacy'` until the first presentRows, or a retractRows that names a
   * row, on the store's branch has written the window down whole, while the
   * window is the merged record itself; `'presented'` after, even while the
   * window holds no row. A write-down a pre-release build cut short leaves
   * it `'legacy'` (see presentRows), as does an index in another version's
   * format.
   */
  windowMode(): WindowMode {
    return this.windowIndex.mode();
  }

  /**
   * A row's index ordinal: where it entered the window. Ordinals only grow
   * and never move, whatever leaves the window or the store, so a host can
   * compare them as watermarks. Undefined for a row not in the window, and
   * for every row in legacy mode, where there is no index.
   *
   * An id can outlive its row here. A removal through this manager takes
   * the row out of its window (removeMessage, removeMessages), but one
   * through another manager, on this manager's slot or an auxiliary one,
   * isn't heard: the row leaves the record, and so the rows this manager's
   * reads list (getPresentedMessages, presentedLength, the compile), but
   * its ordinal stays issued, ordinalOf still gives it, and the strategy's
   * `ordinals()` (StrategyContext.window) still maps it, until a host takes
   * it out by its id: retractRemoved for the rows a removal named,
   * retractAbsentRows for every such row (at boot, say, for removals no
   * live manager heard), or retractRows. A host that keeps watermarks or
   * cursors by ordinal takes such a row out of each window that holds it,
   * or reads them from the listing.
   */
  ordinalOf(id: MessageId): number | undefined {
    return this.windowIndex.ordinalOf(id);
  }

  /**
   * Where a row stands with this manager's agent's window, on the store's
   * branch and before the view filter:
   *
   * - `'absent'`: no slot the manager merges (its own and its auxiliary
   *   ones) holds the row: it was never stored on this branch, or it was
   *   removed. A row removed through another manager reads so while its
   *   ordinal is still issued here (see ordinalOf), until retractRemoved or
   *   retractAbsentRows takes it out.
   * - `'in'`: the window holds it. In legacy mode that is every row the
   *   merged slots hold, the window being the record.
   * - `'undone'`: an undone turn's row (retractRows with `undone`), out of
   *   the window until a presentRows names it again, and left out of
   *   getUnpresentedMessages.
   * - `'out'`: stored and not in the window: arrived and not presented, or
   *   taken out without `undone`. These are the rows getUnpresentedMessages
   *   lists, so an undone turn's shard is `'out'` while a shard of its body
   *   before it is in the window (a redo cut short, in an index written one
   *   record per row: see presentRows), since the rest of the
   *   body is due. A shard with no earlier shard of its body in the window
   *   reads as its own tombstone left it, `'undone'` or `'out'`, whatever
   *   the shards after it: a retract cut short after a body's first
   *   tombstone leaves the first shard `'undone'` and the others `'in'`, and
   *   presentRows of it presents the body whole again (see presentRows).
   *
   * It looks the row up by its sequence (MessageStoreView.sequenceOf), as
   * the window's other reads do, rather than reading it whole, and writes
   * nothing. Only for an undone turn's row does it read the merged record's
   * listing, to find the shards of the row's body before it.
   */
  windowStatusOf(id: MessageId): WindowStatus {
    const merged = this.mergedMessageView();
    if (!holdsRow(merged, id)) return 'absent';
    const index = this.windowIndex;
    if (index.mode() === 'legacy' || index.ordinalOf(id) !== undefined) return 'in';
    if (!index.isUndone(id)) return 'out';
    const record = merged.getAll();
    const at = recordPositionOf(merged, record, id);
    if (at === undefined) return 'undone';
    // The shards before it, as getUnpresentedMessages reads them: one in
    // the window makes the rest of the body due.
    const { from } = bodyBoundsIn(record, at);
    for (let k = from; k < at; k++) if (index.ordinalOf(record[k]!.id) !== undefined) return 'out';
    return 'undone';
  }

  /**
   * The index's length: every ordinal below it has been issued on this
   * branch, to rows, tombstones and the header. A presentation's rows take
   * ordinals from it on, after any tombstones the same write puts first (a
   * body moved whole). 0 in legacy mode.
   */
  indexLength(): number {
    return this.windowIndex.length();
  }

  /** How many rows the window holds, before the view filter: the record's count in legacy mode. */
  presentedLength(): number {
    return this.getPresentedMessages().length;
  }

  /**
   * The rows in the window, in order, before the view filter: the merged
   * record (this manager's slot and its auxiliary slots) in legacy mode.
   * The same array comes back while the window is unchanged, the store's
   * own listing when the window is the whole record in record order; never
   * change it.
   */
  getPresentedMessages(): StoredMessage[] {
    return this.presentedMessageView().getAll();
  }

  /**
   * The stored rows not in the window, in record order, from this manager's
   * slot and its auxiliary slots: arrived and not presented. Leaves out an
   * undone turn's rows (retractRows with `undone`). Empty in legacy mode.
   *
   * A body whose first shards are in the window and the rest out (see
   * presentRows) lists the shards it lacks, undone or not, and presentRows
   * takes the first of them as naming the rest of the body, so presenting
   * these ids completes it. A shard with no earlier shard of its body in
   * the window is listed as any row is, and left out when it is undone,
   * whatever the shards after it: the first shard of a body whose later
   * shards are in the window is listed only when its tombstone wasn't
   * `undone`, and presenting it puts the body back whole (see presentRows,
   * windowStatusOf).
   *
   * With `afterSequence`, only the rows stored after that sequence: the
   * rows the whole listing gives whose sequence is greater, found by a
   * binary search over the merged record's listing, so the call walks the
   * rows stored since (and, for a cut inside a body, that body's shards
   * before the cut) and not the whole record; the listing itself is
   * built once per change of the record (with auxiliary slots, merged and
   * sorted), as a compile's reads are. A shard of a body stored across
   * the cut is listed as the whole listing lists it. A cut inside a body
   * partly in the window leaves out the shards it lacks before the cut,
   * and presentRows refuses a later shard named alone: name the body's
   * first shard, which it takes as naming the rest. Throws a TypeError for
   * an `afterSequence` that isn't a number.
   */
  getUnpresentedMessages(options?: { afterSequence?: number }): StoredMessage[] {
    const after = options?.afterSequence;
    if (after !== undefined && (typeof after !== 'number' || Number.isNaN(after))) {
      const got = typeof after === 'number' ? String(after) : JSON.stringify(after) ?? typeof after;
      throw new TypeError(`ContextManager.getUnpresentedMessages: afterSequence must be a sequence number, got ${got}`);
    }
    return this.windowIndex.unpresented(this.mergedMessageView().getAll(), after);
  }

  /**
   * The newest store sequence among the rows in the window, before the view
   * filter, the record's newest row's in legacy mode; undefined when the
   * window holds none. It is the sequence a row was stored at, not where
   * the window reached: a row stored after the window was written down is
   * presented by a later write than its own, and the window can hold an
   * older row presented after a newer one. The write that presented such a
   * row is where branchAt cuts for it (a row the write-down entered it cuts
   * at its own sequence, a body stored as shards at its last shard's); for
   * a place in the record that follows a presentation, as derive's
   * `atSequence` needs, read currentSequence() after the presentRows. For
   * where the window reached, compare ordinals (indexLength, ordinalOf).
   */
  newestWindowSequence(): number | undefined {
    let last: number | undefined;
    for (const message of this.getPresentedMessages()) if (last === undefined || message.sequence > last) last = message.sequence;
    return last;
  }

  // ==========================================================================
  // Branching
  // ==========================================================================

  /**
   * Create a branch from a specific message.
   * The new branch will have state as of the point the message is cut at
   * (time-travel branching): its own sequence in legacy mode and for a row
   * the window doesn't hold; for a row the window holds, the write that
   * presented it, or the sequence of its body's last shard where the
   * write-down presented it (below).
   * The message can be in this manager's slot or one of its auxiliary slots.
   *
   * Once a host presents rows on the branch (see presentRows), a row is in
   * the window only from the write that presented it, which comes after the
   * row's own. For a row the window holds, the branch is then cut at that
   * write, the one that presented the last of its body's shards, and never
   * before its body's last shard's own sequence, so the new branch's record
   * holds the whole body. The new branch's window is the window as it stood
   * at the cut: the row, and every row in the window then (a row taken out
   * before the cut isn't). Rows stored after the row but before the cut,
   * and not presented by then, are in the new branch's record, arrived and
   * not presented; rows stored after the cut are not. A row the window
   * doesn't hold, and every row in legacy mode, is cut at its own sequence,
   * as before.
   *
   * One presentRows call is one record, so it is one presentation point: a
   * row it presented is cut after the whole call, and the new branch's
   * window holds the rows presented with it after it too, since the store
   * cuts only between records. A row presented in a call of its own, as a
   * host presents an agent's own rows, is cut exactly there. In an index a
   * pre-release build wrote one record per row (see presentRows), the cut
   * takes no row presented after the row's body.
   *
   * A row the window holds from the write-down (the first presentRows on
   * the branch, which writes the window down as the record stood) was in
   * the window from its own write, as every row was then: it is cut at the
   * sequence of its body's last shard, which is its own for a row stored as
   * one. Legacy mode cuts at the named row's own sequence instead, so a
   * body stored as shards and named by its first shard is cut there at
   * that first shard, and after the write-down at its last. The new
   * branch has no index, or the start of one without its header, and is in
   * legacy mode, its window the record up to the row; a cut at the
   * write-down's item would keep every row stored before the write-down in
   * the new branch's record, and the strategy state written after the row.
   *
   * A branchAt made while a sharded addMessage of this manager stores its
   * shards (from an onMessage listener of a shard's add, or a strategy hook
   * that listener runs by presenting a shard) is refused, saying why: the
   * record then holds only the shards stored so far, so no cut could hold
   * the whole body.
   *
   * Returns the new branch *name*, which is what `switchBranch` and `forkAt`
   * expect. (Chronicle's branch APIs are name-keyed; the numeric `id` field
   * on JsBranch is an internal identifier and isn't accepted by switchBranch.)
   */
  branchAt(messageId: MessageId, name?: string): string {
    this.requireInitialized('branchAt');
    this.refuseCutWhileWritingShards('branchAt');
    const branchPoint = this.branchSequenceOf(messageId);

    // Create branch name if not provided
    const branchName = name ?? `branch-${Date.now()}`;

    // Get current branch name to branch from
    const currentBranch = this.store.currentBranch();

    // Use createBranchAt to branch at the message's sequence (time-travel),
    // or at the write that presented it
    const branch = this.store.createBranchAt(branchName, currentBranch.name, branchPoint);

    return branch.name;
  }

  /**
   * The sequence branchAt(messageId) cuts at, without making a branch: for
   * a host that accounts for a cut, such as the rows a rollback to the row
   * leaves out of the branch's record (those stored after the cut) and the
   * rows it keeps there but not in the window (stored before the cut, and
   * presented by a later write than the row's, or not at all). It is the
   * named row's own sequence for a row the window doesn't hold and for
   * every row in legacy mode, so a body stored as shards and named by its
   * first shard's id is cut there; its body's last shard's own for a body
   * the write-down presented; and for any other row the window holds, the
   * latest write that presented a shard of its body, which is the record of
   * the whole presentRows call (see branchAt), and never before its body's
   * last shard's own sequence, so the new branch's record holds the whole
   * body. The row can be in this manager's slot or an auxiliary one.
   * Throws `Message not found: <id>`, as branchAt does, for a row no merged
   * slot holds, and is refused, as branchAt is, while a sharded addMessage
   * of this manager stores its shards (see onMessage). It writes nothing.
   */
  branchSequenceOf(messageId: MessageId): Sequence {
    this.refuseCutWhileWritingShards('branchSequenceOf');
    const merged = this.mergedMessageView();
    const message = merged.get(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }
    return this.branchPointOf(message, merged);
  }

  /**
   * The sequence branchAt cuts at for `message`: its own, unless the window
   * holds it, and then the latest write that presented a shard of its body,
   * or its body's last shard's own sequence where that is later (a shard
   * presented before the rest of its body was stored), so the new branch's
   * record holds the whole body.
   * That write (WindowIndex.write) is the record of the whole presentRows
   * call that presented it, so the cut keeps every row the call presented:
   * a batch is one presentation point. In an index a pre-release build
   * wrote one record per row, the cut takes no row presented after the
   * body's last shard. A body
   * the write-down presented, every shard of it, is cut at its last shard's
   * own sequence instead: it was in the window from its own write.
   */
  private branchPointOf(message: StoredMessage, merged: MessageStoreView): number {
    const index = this.windowIndex;
    if (index.ordinalOf(message.id) === undefined) return message.sequence;
    const record = merged.getAll();
    const at = recordPositionOf(merged, record, message.id);
    if (at === undefined) return message.sequence;
    const { from, to } = bodyBoundsIn(record, at);
    let stored = message.sequence;
    let presented = message.sequence;
    let writtenDown = true;
    for (let k = from; k <= to; k++) {
      const row = record[k]!;
      stored = Math.max(stored, row.sequence);
      presented = Math.max(presented, row.sequence, index.presentedAt(row.id) ?? row.sequence);
      if (!index.presentedByWriteDown(row.id)) writtenDown = false;
    }
    return writtenDown ? stored : presented;
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
   *
   * The switch moves the store's branch, which every manager on the store
   * follows, and starts a new branch generation. Every other manager's
   * strategy was initialized at the old one, and a strategy that checks the
   * generation, as AutobiographicalStrategy does, refuses its work until it
   * initializes again: call setStrategy(getStrategy()) on each of those
   * managers, not switchBranch(), whose own new generation would leave this
   * one's strategy stale in turn.
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
   * context log, the window index, and strategy state) and diverges from
   * there.
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
   *
   * A fork made while a sharded addMessage of this manager stores its
   * shards (from an onMessage listener of a shard's add) is refused before
   * it makes a branch, as branchAt is: the head holds only the shards
   * stored so far, and the move would stop the write.
   */
  async fork(name?: string): Promise<string> {
    this.refuseCutWhileWritingShards('fork');
    this.requireInitialized('fork');
    const branchName = name ?? `fork-${Date.now()}`;
    const currentBranch = this.store.currentBranch();
    const currentSeq = this.store.currentSequence();
    const branch = this.store.createBranchAt(branchName, currentBranch.name, currentSeq);
    await this.selectBranch(branch.name, true);
    return branch.name;
  }

  // ==========================================================================
  // Derivation: shared reads, separate writes
  // ==========================================================================

  /** Whether `store` can bind handles to branches and fork a branch with selected states, which derivation requires. */
  static supportsDerivation(store: JsStore): boolean {
    const derivable = store as unknown as Partial<DerivableStore>;
    return typeof derivable.view === 'function'
      && typeof derivable.createBranchWithStates === 'function'
      && typeof derivable.createBranchAtWithStates === 'function';
  }

  /**
   * Derive a second context manager from this one.
   *
   * The derived manager starts from this manager's state at a checkpoint —
   * its messages, and everything its strategy persists (the memory tree and
   * its alternative resolutions, pins, the solver's carried frontier) — and
   * from then on the two diverge. Reads of the inherited past are SHARED:
   * no log record is copied and the materialized messages are the same
   * objects in memory. Writes are SEPARATE: each manager writes only its own
   * Chronicle branch, so this manager's later folding cannot change what the
   * derived one inherited, and nothing the derived one does — background
   * compression included — is visible here. This manager keeps running.
   *
   * Unlike {@link fork}, the store's branch cursor is not touched: the
   * derived manager holds a handle bound to its own branch.
   *
   * What is inherited is the set of states this manager owns: its message
   * slot, its auxiliary slots, its context log, its window index (see
   * presentRows), its thinking-binding record and its strategy's states.
   * Other states in the store are not carried onto the derived branch.
   * The window is the parent's as of the checkpoint: at the head the child
   * starts with the parent's window and its arrived-and-not-presented rows
   * (getUnpresentedMessages), and from `atSequence` it starts with the
   * window as it stood then, which names only rows stored by then. The cut
   * is taken as given: a row stored by then and presented after it is in
   * the child's record and not in its window. A row stored after the
   * parent's window was written down is presented at a write after its
   * own, so a cut at its own sequence leaves it out of the child's window
   * too: give a presentation boundary (`currentSequence()` read after a
   * presentRows) instead. A row stored before the write-down was in the
   * window from its own write, as every row is in legacy mode: a cut at its
   * sequence comes before the write-down, so the child is in legacy mode,
   * and its window, the record up to the cut, holds the row. A presentRows
   * call that the store wrote as one record (see presentRows) is in the
   * child's window whole or not at all. A cut between a sharded body's
   * presentations, in an index a pre-release build wrote one record per
   * shard (see presentRows), leaves the body partly in the child's window,
   * and the child's presentRows of the body completes it. A parent that hadn't written
   * its window down by the checkpoint (its first presentRows, presentRows([])
   * among them, or a retractRows that names a row) has no window written,
   * and the child is in legacy mode.
   * Compression holds, and compression work in flight here, are not
   * inherited: the derived strategy re-derives its queue from what is
   * persisted, as after a restart.
   *
   * The derived context persists. Keep `getDerivation()` and reopen it
   * later with {@link ContextManager.reopenDerived}.
   *
   * A derive made while a sharded addMessage of this manager stores its
   * shards (from an onMessage listener of a shard's add) is refused before
   * it makes a branch, as branchAt is: the checkpoint would hold only the
   * shards stored so far.
   */
  async derive(options: DeriveContextOptions): Promise<ContextManager> {
    this.refuseCutWhileWritingShards('derive');
    if (!ContextManager.supportsDerivation(this.store)) {
      throw new ContextDerivationUnsupportedError();
    }
    const source = this.store as unknown as JsStore & DerivableStore;
    const solve = options.solve ?? 'reuse';
    const parentBranch = this.store.currentBranch().name;
    const head = this.store.currentSequence();
    const atHead = options.atSequence === undefined || options.atSequence === head;
    const atSequence = atHead ? head : options.atSequence!;

    const stateIds = [
      MessageStore.registrationFor(this.slots.messageNamespace).id,
      ...this.slots.auxiliaryNamespaces.map((ns) => MessageStore.registrationFor(ns).id),
      ContextLog.stateIdFor(this.slots.contextNamespace),
      bindingStateId(this.strategyNamespace),
      // The window: the manager's, not the strategy's, so it is listed here
      // whatever a strategy's manifest names. A parent still in legacy mode
      // has none written, and the child is in legacy mode too, its window the
      // record as of the checkpoint, as the parent's was then.
      windowIndexStateId(this.strategyNamespace),
      // Authoring-request preimages are keyed by hash in one store-wide
      // tree; inherited so the child can still resolve a memory's origin.
      // Ignored by the store when the tree was never created.
      MINT_PREIMAGE_ENVELOPE_INDEX_STATE_ID,
    ];
    // Strategy state: what the strategy names (DerivationManifestStrategy),
    // else everything under its namespace prefix (`{namespace}/autobio:*`,
    // `{namespace}/windowed:anchor`, ...). A manifest lets a strategy leave
    // its work queues and failure ledgers behind.
    const manifest = isDerivationManifestStrategy(this.strategy)
      ? this.strategy.derivationManifest(this.strategyNamespace, options.inherit ?? {})
      : { stateIds: [], statePrefixes: [`${this.strategyNamespace}/`] };
    const filter = {
      stateIds: [...new Set([...stateIds, ...manifest.stateIds])],
      statePrefixes: [...manifest.statePrefixes],
    };

    // ---- Synchronous from here to the seeded stores: the checkpoint is ----
    // ---- this manager's state at one instant, with no turn in between. ----
    const frontier =
      solve === 'reuse' && atHead && isRenderingFrontierStrategy(this.strategy)
        ? this.strategy.exportRenderingFrontier()
        : undefined;

    const branch = options.branch;
    const created = atHead
      ? source.createBranchWithStates(branch, parentBranch, filter)
      : source.createBranchAtWithStates(branch, parentBranch, atSequence, filter);
    let derived: ContextManager | undefined;
    try {
      const view = source.view(branch);

      const coldStore = (namespace: string | undefined) =>
        new MessageStore(view, { estimator: this.slots.tokenEstimator, namespace });
      const messageStore = atHead
        ? this.messageStore.deriveOnto(view)
        : coldStore(this.slots.messageNamespace);
      const auxiliaryStores = this.auxiliaryStores.map((aux, i) =>
        atHead ? aux.deriveOnto(view) : coldStore(this.slots.auxiliaryNamespaces[i]),
      );
      // ---- End of the synchronous section. ----

      const contextLog = new ContextLog(view, {
        estimator: this.slots.tokenEstimator,
        namespace: this.slots.contextNamespace,
      });
      derived = new ContextManager(
        view,
        messageStore,
        contextLog,
        options.strategy,
        false, // the app owns the store; a derived manager never closes it
        this.strategyNamespace,
        options.membrane ?? this.membrane,
        options.debugLogContext ?? this.debugLogContext,
        options.viewFilter ?? this.viewFilter,
        auxiliaryStores,
      );
      // At the head the child's branch took the window's chain head as it was,
      // so the child starts from the parent's reading of it, as its message
      // store starts from the parent's listing. The reading is taken only
      // while it is current and is of the record the child's chain ends at;
      // otherwise the child reads its own branch when it first asks.
      if (atHead) derived.windowIndex.seedFrom(this.windowIndex);
      derived.now = this.now;
      derived.slots = { ...this.slots, auxiliaryNamespaces: [...this.slots.auxiliaryNamespaces] };
      derived.toolDefinitions = this.toolDefinitions;
      derived.systemPrompt = this.systemPrompt;
      derived.derivation = {
        parentBranch,
        branch,
        atSequence,
        solve,
        inherited: filter,
        slots: {
          messageNamespace: this.slots.messageNamespace ?? null,
          contextNamespace: this.slots.contextNamespace ?? null,
          auxiliaryNamespaces: this.slots.auxiliaryNamespaces.map((ns) => ns ?? null),
        },
      };

      if (frontier !== undefined && isRenderingFrontierStrategy(derived.strategy)) {
        derived.strategy.prepareFromRenderingFrontier?.(frontier);
      }
      await derived.initializeStrategy(observeStoreBranch(view));

      if (isRenderingFrontierStrategy(derived.strategy)) {
        if (solve === 'fresh') {
          derived.strategy.discardRenderingFrontier();
        } else if (frontier !== undefined) {
          derived.strategy.adoptRenderingFrontier(frontier);
        }
      }
      return derived;
    } catch (error) {
      try {
        derived?.close();
      } catch (cleanup) {
        logThrown(`[context-manager] derive of '${branch}' failed, and closing the child failed too:`, cleanup, this.diag);
      }
      try {
        if (this.store.listBranches().some((b) => b.name === branch && b.id === created.id)) {
          this.store.deleteBranch(branch);
        }
      } catch (cleanup) {
        logThrown(`[context-manager] derive of '${branch}' failed, and removing its branch failed too:`, cleanup, this.diag);
      }
      throw error;
    }
  }

  /** How this manager was derived, or null if it was opened directly. */
  getDerivation(): ContextDerivation | null {
    return this.derivation ? structuredClone(this.derivation) : null;
  }

  /**
   * Reopen a derived context on its own branch — after a restart, to resume
   * the agent that owned it, or to inspect what it left. The branch is the
   * derived context's durable state: this reads it cold, as any reopened
   * store is read, and neither creates a branch nor touches the parent. The
   * window is read from the branch too, as derive left it and the derived
   * context's own presentations grew it, under the namespace the derivation
   * names.
   */
  static async reopenDerived(options: ReopenDerivedOptions): Promise<ContextManager> {
    if (!ContextManager.supportsDerivation(options.store)) {
      throw new ContextDerivationUnsupportedError();
    }
    const { derivation } = options;
    const view = (options.store as unknown as DerivableStore).view(derivation.branch);
    const namespace = derivation.slots.contextNamespace ?? undefined;
    const manager = await ContextManager.open({
      store: view,
      ...(namespace !== undefined ? { namespace } : {}),
      // Isolated iff the message slot carried the namespace too.
      ...(derivation.slots.messageNamespace !== null ? { isolate: true } : {}),
      ...(derivation.slots.auxiliaryNamespaces.length > 0
        ? {
            auxiliaryMessageViews: derivation.slots.auxiliaryNamespaces.map((ns) =>
              ns === null ? {} : { namespace: ns },
            ),
          }
        : {}),
      ...(options.strategy ? { strategy: options.strategy } : {}),
      ...(options.membrane ? { membrane: options.membrane } : {}),
      ...(options.tokenEstimator ? { tokenEstimator: options.tokenEstimator } : {}),
      ...(options.viewFilter ? { viewFilter: options.viewFilter } : {}),
      ...(options.debugLogContext !== undefined ? { debugLogContext: options.debugLogContext } : {}),
    });
    manager.derivation = structuredClone(derivation);
    return manager;
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
   * Whether the strategy has no background work pending (its
   * `checkReadiness()`), other than work that waits on the host, such as for
   * its tool definitions, which getWaitingWork() names. compile() doesn't
   * wait for that work: it compiles from what's there.
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
   * Background work that waits on something only the host can give, such as
   * its tool definitions, which `isReady()` and `getPendingWork()` don't
   * count. Null when nothing waits.
   */
  getWaitingWork(): WaitingWork | null {
    this.requireInitialized('getWaitingWork');
    const state = this.strategy.checkReadiness();
    if (state.waitingOn === undefined) return null;
    return { waitingOn: state.waitingOn, description: state.waitingDescription ?? 'Background work waits on the host' };
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
   * It awaits nothing, so it doesn't wait for the strategy's background work.
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
    refuseUnreadableRequestLimit(opts);
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
    const messageInjections = (injections ?? [])
      .filter((inj) => inj.position === 'beforeUser' || inj.position === 'afterUser')
      .map((inj) => inj.content);
    let selectOpts = opts;
    if (messageInjections.length > 0) selectOpts = { ...opts, messageInjections };
    else if (opts?.messageInjections !== undefined) {
      const { messageInjections: _callers, ...rest } = opts;
      selectOpts = rest;
    }
    const entries = this.strategy.select(view, this.contextLog.createView(), effectiveBudget, selectOpts);
    const selectionCause = this.strategy.takeSelectionCause?.();
    // Read now, before anything else selects: these are this select's own.
    const renderStats = isRenderStatsCapable(this.strategy) ? this.strategy.getLastSelectStats?.() ?? null : null;
    if (_diag) this.diag.error(`[cm-cache] compile: select ${Date.now() - _t0}ms (${entries.length} entries)`);
    if (opts?.requestLimitTokens !== undefined) {
      this.refuseOverRequestLimit(opts, effectiveBudget, entries, renderStats, view, messageInjections);
    }

    const viewMessages = view.getAll();
    // Raw bodies are judged as stored: the view filter can hide a shard of a
    // body from the strategy, but the body's identity (shard 0, the id
    // addMessage returned) and its membership are the stored group's. The
    // layout stays on the filtered view the strategy rendered. Attribution
    // reads the agent's window before the filter, only around the messages
    // the raw entries name, and a lookup asks for a position, which the
    // window answers without reading the message (#273).
    const storedView = this.viewFilter ? this.presentedMessageView() : view;
    const storedMessages = this.viewFilter ? storedView.getAll() : viewMessages;
    const positionOf = (id: MessageId) => storedView.positionOf!(id);
    const attribution = attributeEntries(entries, storedMessages, positionOf);

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
      // compile leaves behind for the next one. A compile that throws before
      // here, which no caller sends, is never the one the next is compared with.
      if (opts?.dryRun !== true) {
        this.recordFirstChanged(result, messageSources);
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
   * Records a committing compile's messages for the next one's comparison
   * (CompiledMessageKey), and gives `result` its `firstChanged`, compared
   * when it's read: a caller that never reads it pays for no comparison.
   * That is the index of the first compiled message whose
   * participant or content bytes differ from the last committing compile's
   * message at that index, or that has none there (so the first appended
   * index after appends alone, and the message count when these messages are
   * that compile's or a prefix of them); null before this manager's first
   * committing compile. The comparison is by bytes, so it holds across a
   * branch or strategy switch, which the manager can't always see (a direct
   * switch of the store's branch away and back). Cache markers are message
   * flags, not content, so they don't count. Read after later compiles, it
   * still compares this compile with the one before it. Until it's read, a
   * result keeps this compile's keys and the last one's.
   */
  private recordFirstChanged(result: CompileResult, sources: readonly CompiledMessageSources[]): void {
    // An injection is told by its source, not its array: a binding compile
    // sends one that holds thinking as a new array.
    const keys: CompiledMessageKey[] = result.messages.map((message, i) => sources[i]?.kind === 'injection'
      ? { participant: message.participant, content: message.content, injected: true, bytes: JSON.stringify(message.content) }
      : { participant: message.participant, content: message.content, injected: false });
    const before = this.lastCompiled;
    this.lastCompiled = keys;
    // The first read, or a write, settles the value and lets go of both
    // compiles' keys, so the result then holds a number. It stays an
    // accessor, so a frozen or sealed result reads it too.
    let pending: { keys: CompiledMessageKey[]; before: typeof before } | null = { keys, before };
    let value: number | null | undefined;
    Object.defineProperty(result, 'firstChanged', {
      enumerable: true,
      configurable: true,
      get: () => {
        if (pending) {
          value = pending.before ? firstDifference(pending.keys, pending.before) : null;
          pending = null;
        }
        return value;
      },
      set: (next: number | null | undefined) => {
        value = next;
        pending = null;
      },
    });
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
    // Members are the rows' sequences while the window is the record, and
    // their ordinals once rows are presented, which ascend in the window's
    // order whatever order the record has (RenderedLayout.keyedBy). Read in
    // the same synchronous compile as the view, so the two agree.
    const ordinals = this.windowIndex.ordinals();
    return buildRenderedLayout({
      view: viewMessages,
      entries,
      rawComplete,
      summaryInfo,
      estimateBase,
      extraTokens,
      calibration: factor,
      cause,
      ...(ordinals ? { ordinalOf: (id: MessageId) => ordinals.get(id) } : {}),
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
   * A layout counts its members by store sequence while the window is the
   * record, and by window-index ordinal once rows are presented on its
   * branch (RenderedLayout.keyedBy). The journal never compares one with the
   * other: an acceptance whose layout counts something other than what the
   * branch's newest record counts writes a baseline there, and the receipts
   * before it stay listed. That is the first acceptance on a branch of a
   * compile made after its first presentRows, and again any acceptance
   * that switches back, such as one of a compile made before the first
   * presentRows and accepted after a compile made after it.
   * `usage` is the confirming round's own usage as the provider reported it;
   * leave a field undefined when it was not reported. `presentation` is how
   * that round carried the compile, as its producer reported (`verbatim`,
   * `altered`, or `unknown`, the default); receipts record it beside the
   * layout, which is the compile's. It has nothing to do with presentRows,
   * which puts rows in the agent's window; the window decides only what a
   * layout's members count.
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
   * members, not one id and one sequence for each member, or a word of what
   * its members count that the journal doesn't know. A `v: 2` layout, which
   * has no word of it (one an earlier release's compile returned, carried
   * across the upgrade), is read as counting store sequences, which it did;
   * a layout of any other version without it is refused, writing nothing.
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
   *
   * Given the strategy the manager already holds, setStrategy(getStrategy())
   * detaches nothing and initializes that strategy again on the branch the
   * store is on. It is the call for a manager whose store something else
   * moved: a host's own `store.switchBranch`, or another manager's
   * switchBranch() or fork(). It selects no branch and starts no branch
   * generation, so every manager sharing the store can make it after one
   * move, in turn or at once, and none of them leaves another stale. It
   * adds no message and writes no window, but the strategy's initialize may
   * write its own load-time repairs (AutobiographicalStrategy lets go of a
   * folded row that left the window unheard, say), so the store's sequence
   * can advance. The window index follows the store's branch on its own,
   * so on a branch made before this manager's write-down windowMode() reads
   * 'legacy' after the call, and presentRows([]) writes that branch down.
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
   * doesn't send that message, such as one the view filter leaves out, or
   * one the agent hasn't been presented yet (see presentRows): present a row
   * before rendering it. A
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
   * The text the per-message cap measures for a message or summary, read
   * through this agent's view (see `ContextStrategy.capMeasuredText`): the
   * text whose characters a capped message's marker names, so a reader that
   * pages it from the marker's first offset reads exactly what the cap
   * elided. Give a message by the id `addMessage` returned, or a summary by
   * its id; with `toolUseId`, that call's input as JSON. Null for a row this
   * agent's view doesn't hold, such as one the view filter leaves out or one
   * not yet presented, for an id nothing has, for a call the message doesn't
   * hold, and under a strategy with no per-message cap.
   */
  capMeasuredText(at: { id: string; toolUseId?: string }): string | null {
    this.requireInitialized('capMeasuredText');
    if (typeof this.strategy.capMeasuredText !== 'function') return null;
    return this.strategy.capMeasuredText(this.strategyMessageView(), at);
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
   * does an id the store doesn't hold, as after a removal, and, once a host
   * presents rows (see presentRows), one the agent's window doesn't hold.
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
    const view = this.presentedMessageView();
    // An id the store doesn't hold, as after a removal, is nothing the next
    // compile sends: it vouches for nothing, as the marker does. Nor is a row
    // the agent's window doesn't hold, once a host presents rows: present
    // the rows a request carried before noting them.
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
   * Note the stored replies whose thinking the provider set aside, under the
   * drop control (`ThinkingBinding.dropBlock`), in a request of a stream
   * built from this branch's last committing compile with `binds`. Call it on
   * the branch that compile was on, with `compileId`, that compile's
   * `provenance.compileId`. Each id is a body's head as the compile's
   * provenance names it (`RawBodySource.messageId`), the id `addMessage`
   * returned; an id that names no stored body's head, such as a missing id
   * or a later shard, changes no compile while it names none (a later shard
   * is its body's head once the shards before it are removed). From the next
   * compile on, each goes without its thinking, as a reply the record's own
   * compile sent without it does, so a block the provider can't take goes
   * out only in the requests of the stream it was set aside in, not in every
   * later compile's. The replies after it keep their thinking while it is
   * otherwise as the record's compile sent it, for the provider to judge: a
   * note follows a block the provider set aside under the drop control, so a
   * later block it can't take is set aside in turn, and can be noted the
   * same way, never refused. A note naming some but not all of a
   * compiled message's bodies leaves that message differing from the record,
   * so it and the replies after it go without their thinking, and its bodies
   * the note didn't name, other than those the record's compile sent without
   * their thinking, are reported in `thinkingStrip`.
   *
   * A noted reply isn't reported in a later compile's `thinkingStrip`, since
   * the provider's report of the request it was set aside in told the host,
   * unless a committing compile with `binds` came between that didn't leave
   * its thinking out: as `ThinkingStrip.newly` says, it can then be reported
   * again.
   * Returns true when `compileId` is the compile that wrote the
   * branch's record, and false, writing nothing, when it isn't or the branch
   * has no record, as `noteRequestSent` does. It writes only when an id it's
   * given isn't already noted, so a repeated note writes nothing. A
   * record it can't read or write is logged, and it returns false.
   * Throws, writing nothing, for ids that aren't an array of strings, or a
   * `compileId` that isn't a string.
   */
  noteThinkingDropped(messageIds: readonly MessageId[], compileId: string): boolean {
    this.requireInitialized('noteThinkingDropped');
    if (!Array.isArray(messageIds)) throw new TypeError(`noteThinkingDropped: \`messageIds\` must be an array, got ${typeof messageIds}`);
    for (let i = 0; i < messageIds.length; i++) {
      const id: unknown = messageIds[i];
      if (typeof id !== 'string') throw new TypeError(`noteThinkingDropped: id ${i} must be a message id, got ${JSON.stringify(id) ?? typeof id}`);
    }
    if (typeof compileId !== 'string') {
      throw new TypeError(
        `noteThinkingDropped: \`compileId\` must be a string, the provenance.compileId of the compile the stream was built from; got ${typeof compileId}`,
      );
    }
    const record = this.readBindingRecordFor('this note writes nothing, and the provider sets these replies\' thinking aside again until a note writes');
    if (record === null || record.compileId !== compileId) return false;
    const known = new Set(record.dropped ?? []);
    const added = [...new Set(messageIds)].filter((id) => !known.has(id));
    if (added.length === 0) return true;
    return this.writeBindingRecordFor(
      { ...record, dropped: [...(record.dropped ?? []), ...added] },
      'this note is lost: the provider sets these replies\' thinking aside again until a note writes',
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
   * Returns null when the active strategy has no fold plan to preview: one
   * without `previewContext`, or `AutobiographicalStrategy`'s hierarchical
   * path when its select succeeds, where the strategy's own method throws
   * `NoFoldPlanToPreviewError` (over the budget, that path still returns an
   * infeasible preview). `opts` takes the select options a compile takes and
   * passes them to the dry select, all but `dryRun`, which is always set, and
   * `identity`, which nothing in a preview reads. Unlike `compile`, it doesn't
   * refuse a binding option without its participant or identity up front.
   * `opts.thinkingBinding` previews a compile with that option: a binding one
   * prices a summary's carriers as such a compile renders them (see
   * `SelectOptions.thinkingBinding`); without it, as configured.
   * `opts.excludePins` lists pin and document-mark ids (as `pinRange` and
   * `markDocument` return them) that the dry select reads as absent: the
   * preview answers what a compile would do were they unpinned. Nothing is
   * unpinned or written, and the option adds no log call; an id no pin has
   * is ignored, and no compile takes the option.
   */
  previewContext(
    budget: TokenBudget,
    overrides?: Record<string, unknown>,
    opts?: { render?: boolean; excludePins?: readonly string[] } & Omit<SelectOptions, 'dryRun' | 'identity'>,
  ): PreviewResult | null {
    this.requireInitialized('previewContext');
    refuseUnreadableRequestLimit(opts);
    const s = this.strategy as unknown as {
      previewContext?: (
        store: ReturnType<MessageStore['createView']>,
        log: ReturnType<ContextLog['createView']>,
        budget: TokenBudget,
        overrides?: Record<string, unknown>,
        opts?: { render?: boolean; excludePins?: readonly string[] } & Omit<SelectOptions, 'dryRun' | 'identity'>,
      ) => PreviewResult | null;
    };
    if (typeof s.previewContext !== 'function') return null;
    try {
      return s.previewContext(
        this.strategyMessageView(),
        this.contextLog.createView(),
        budget,
        overrides,
        opts,
      );
    } catch (err) {
      if (err instanceof NoFoldPlanToPreviewError) return null;
      throw err;
    }
  }

  private refuseOverRequestLimit(
    opts: SelectOptions,
    budget: TokenBudget,
    entries: readonly ContextEntry[],
    stats: RenderStats | null,
    view: MessageStoreView,
    messageInjections: ReadonlyArray<ContentBlock[]>,
  ): void {
    const price = (content: ContentBlock[]) => (content.length > 0 ? view.estimateTokens({ content } as unknown as StoredMessage) : 0);
    const priced = stats?.request;
    const window = stats && priced ? stats.total.tokens : entries.reduce((n, entry) => n + price(entry.content), 0);
    const overhead = priced ? priced.overheadTokens : price(requestOverheadContent(opts.requestOverhead!));
    const injected = priced ? priced.injectedTokens : messageInjections.reduce((n, content) => n + price(content), 0);
    const parts = { limit: opts.requestLimitTokens!, reserve: budget.reserveForResponse, overhead, injected, window };
    if (window + overhead + injected + parts.reserve > parts.limit) throw overRequestLimit(parts);
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
   * resolution (under kv-unified, a message no summary supplies that level
   * over yet is held at the deepest level below it that one does; see
   * `ProtectedRange.level`); under
   * any other selector the range is raw, in the live view
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
   * The transition is stored as a message from 'Context Manager', with
   * `options.metadata` when given (a host's stamps, such as who the row is
   * for). Once a host presents rows on the branch (presentRows), a stored
   * row enters the window only when presented, so the transition is
   * presented before the head window is reset to start at it, and the
   * strategy hears it there (ContextStrategy.onPresented), unless a host's
   * listener of its add (onMessage) presented it already, which this then
   * leaves as it stands (every shard of it, for a transition the strategy
   * stores as shards: one a listener presented in part is presented, which
   * puts the rest in); in legacy mode it is in the window from its add,
   * as before, and nothing more is written.
   *
   * Returns the transition summary text used. A close() from a listener of
   * the transition message's add lets the add finish, and the call then
   * rejects, naming the stored message, without resetting the head window.
   * So does a presentation of it that fails, or whose strategy hook closes
   * the manager, sets a strategy, moves the store's branch or takes the
   * transition out of the window again, and a read of the window, before
   * the presentation or after it, that fails. Each such refusal says where
   * the transition stands as the store and then the window tell it when
   * the call refuses: no longer stored (a listener or a hook removed it,
   * through this manager or another on the slot), presented, presented in
   * part (a listener of a sharded transition's first shard's add presented
   * the shards stored by then), stored and out of the window, or, in
   * legacy mode, where the window is the record, stored. Where they can't
   * tell (the store is on another branch than the one the transition was
   * added on, can't say its branch, or can't say whether it still holds
   * the transition), it says what the call last knew of
   * that branch, such as stored, or stored and maybe presented, and, once a
   * host presents, that it is what the call last knew (in legacy mode it
   * says stored, as before).
   * Legacy mode reads no record before the reset itself, as before: a
   * transition a listener removed there is reset at all the same. An add of the
   * transition that fails after storing it rejects with addMessage's
   * WriteLandedError, naming it, without resetting the head window, and one
   * where the store can't be read to tell whether it was stored rejects with
   * its WriteOutcomeUnknownError, likewise.
   */
  async resetHeadWindow(transitionText?: string, options?: { metadata?: MessageMetadata }): Promise<string> {
    const attempt = this.requireInitialized('resetHeadWindow');
    if (!isResettableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support head window reset');
    }

    const ctx = this.createStrategyContext();

    // Generate transition summary if not provided
    const summary = transitionText ?? await this.strategy.generateTransitionSummary(ctx);
    this.requireInitialized('resetHeadWindow', attempt);

    // The branch the add stores the transition on, for whereNow below, and
    // whether its window is the record (legacy mode) then.
    let addedOn: string | null;
    try {
      addedOn = this.store.currentBranch().id;
    } catch {
      addedOn = null;
    }
    let legacyAtAdd: boolean;
    try {
      legacyAtAdd = this.windowIndex.mode() === 'legacy';
    } catch {
      legacyAtAdd = false;
    }

    // Inject transition message
    const msgId = this.addMessage('Context Manager', [
      { type: 'text', text: `[Topic Transition]\n\n${summary}` },
    ], options?.metadata);
    // A listener of that add may have closed the manager, set a strategy or
    // moved the store's branch. The add stands and the strategy isn't told,
    // and the refusal says where the message stands (whereNow). It gives the
    // reason without the advice to retry or to recover, and says instead
    // what a later call that goes ahead does: it stores a second transition.
    // After a close(), or while a strategy initializes, a later call refuses
    // at once.
    const refuse = (reason: string, where: string): Error =>
      new Error(
        `${reason.endsWith('.') ? reason : `${reason}.`} Its transition add finished: message ${msgId} ` +
          `${where}, and the head window wasn't reset. A later resetHeadWindow() that goes ahead adds ` +
          'another transition message.',
      );
    const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
    // How much of the transition's body the window holds: every shard,
    // some, or none. A listener of a sharded transition's first shard can
    // present that shard before the rest is stored. One the record no
    // longer holds is judged by its id.
    const heldOfBody = (): 'all' | 'some' | 'none' => {
      const merged = this.mergedMessageView();
      const record = merged.getAll();
      const at = recordPositionOf(merged, record, msgId);
      if (at === undefined) return this.windowIndex.ordinalOf(msgId) === undefined ? 'none' : 'all';
      const { from, to } = bodyBoundsIn(record, at);
      let held = 0;
      for (let k = from; k <= to; k++) if (this.windowIndex.ordinalOf(record[k]!.id) !== undefined) held++;
      return held === 0 ? 'none' : held === to - from + 1 ? 'all' : 'some';
    };
    // Where the transition stands now, for a refusal, as the words after
    // its id: a listener of its add, or a hook its presentation ran, can
    // have presented it, taken it out of the window or removed it. The
    // store is asked first, since a removal through another manager on the
    // slot leaves the row's ordinal issued here (see ordinalOf), then the
    // window, which judges the body whole, each read guarded. `known` is
    // what the call last knew, given where the reads can't tell: the store
    // is on another branch than the one the add stored it on, or can't say
    // its branch, or can't say whether it holds the transition; once a host
    // presents, the words say so, and in legacy
    // mode, where only the refusal after the add can be reached, they are
    // main's ("stored"). `out` is where the window lacks it and the store
    // holds it: once a host presents, stored and out of the window, and in
    // legacy mode, where the window is the record, stored.
    const whereNow = (known: string, out?: string): string => {
      const lastKnown = (why: string) =>
        legacyAtAdd ? `is ${known}` : `was ${known} on the branch it was added on, as the call last knew, and ${why}`;
      if (addedOn === null) return lastKnown("the store couldn't say its branch when the call added it");
      try {
        if (this.store.currentBranch().id !== addedOn) return lastKnown('the store is on another branch now');
      } catch {
        return lastKnown("the store can't say its branch now");
      }
      try {
        if (this.messageStore.sequenceOf(msgId) === undefined) return 'is no longer stored (a listener of its add, or a hook its presentation ran, removed it)';
      } catch {
        // The store can't say whether a listener or a hook removed it, so
        // the window, which a removal through another manager doesn't
        // reach, can't say either.
        return lastKnown("the store can't say now whether it still holds it");
      }
      let held: 'all' | 'some' | 'none' | undefined;
      let presented: boolean | undefined;
      try {
        presented = this.windowIndex.mode() === 'presented';
        held = heldOfBody();
      } catch {
        held = undefined;
      }
      if (held === 'all') return 'is stored and presented';
      if (held === 'some') return 'is stored, and presented in part';
      if (held === undefined) return 'is stored, and may be presented';
      return `is ${out ?? (presented ? 'stored and out of the window' : 'stored')}`;
    };
    try {
      this.requireInitialized('resetHeadWindow', attempt, false);
    } catch (error) {
      throw refuse(reasonOf(error), whereNow('stored'));
    }

    // Once rows are presented, the head window can start only at a row the
    // window holds: the transition enters it first, as a host's own row does,
    // unless a host's listener of the add presented it already. A
    // transition stored as shards is judged by its whole body: a listener
    // of its first shard's add can present that shard before the rest is
    // stored, and presentRows puts the rest in. Where the window can't be
    // read to tell, the call refuses as a presentation that fails does,
    // naming the stored transition, which a listener may have presented.
    // One a listener removed is out: its presentation refuses its id.
    const outOfWindow = (): boolean => heldOfBody() !== 'all';
    let presenting: boolean;
    try {
      presenting = this.windowIndex.mode() === 'presented' && outOfWindow();
    } catch (error) {
      throw refuse(`ContextManager.resetHeadWindow couldn't read the window to present its transition: ${reasonOf(error)}`, whereNow('stored and maybe presented'));
    }
    if (presenting) {
      try {
        this.presentRows([msgId]);
      } catch (error) {
        // A presentation can land and then throw, so the window says
        // whether the transition is in it; where it can't be read, it may be.
        // One the window lacks may be gone from the store: a listener of its
        // add can remove it, and the presentation then refuses its id.
        throw refuse(`ContextManager.resetHeadWindow's presentation of its transition failed: ${reasonOf(error)}`, whereNow('stored'));
      }
      // The strategy's hook for the presentation may have done what a listener of the add can.
      try {
        this.requireInitialized('resetHeadWindow', attempt, false);
      } catch (error) {
        throw refuse(reasonOf(error), whereNow('stored and presented', 'stored and out of the window'));
      }
      // It may also have taken the transition out again, or a shard of it,
      // moving nothing else: the head window can't start at a row the
      // window lacks, or at a body it holds in part.
      let out: boolean;
      try {
        out = outOfWindow();
      } catch (error) {
        throw refuse(
          `ContextManager.resetHeadWindow couldn't read the window once its transition was presented: ${reasonOf(error)}`,
          whereNow('stored and maybe presented', 'stored and out of the window'),
        );
      }
      if (out) {
        throw refuse(
          "ContextManager.resetHeadWindow: the strategy's hook for its transition's presentation took the transition out of the window",
          whereNow('stored and out of the window', 'stored and out of the window'),
        );
      }
    }

    // Reset head window to start from this message
    this.strategy.resetHeadWindow(msgId);

    return summary;
  }

  /**
   * The transition summary resetHeadWindow() would write of the head window
   * as it stands, storing nothing: the strategy's generateTransitionSummary
   * over the manager's own strategy context. Refuses as resetHeadWindow()
   * does — not initialized, a strategy that can't reset its head window —
   * and when the manager is re-initialized or its branch moves while the
   * summary is written. A host that checks its own conditions between this
   * call and resetHeadWindow(summary) (an idle agent, no turn alive, nothing
   * moved) stores a transition only when they hold, and gives the summary
   * back otherwise (connectome-host's bare /newtopic).
   */
  async generateTransitionSummary(): Promise<string> {
    const attempt = this.requireInitialized('generateTransitionSummary');
    if (!isResettableStrategy(this.strategy)) {
      throw new Error('Active strategy does not support head window reset');
    }
    const summary = await this.strategy.generateTransitionSummary(this.createStrategyContext());
    this.requireInitialized('generateTransitionSummary', attempt);
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
    // Rows that left first: what the strategy kept of a row that left and
    // was presented again is at its old place, and goes before the row is
    // heard at its new one (deliverUnheard).
    this.deliverUnheard();
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
      window: this.windowIndexView(),
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
      case 'remove': {
        // The row is gone from the record whatever the context log makes of
        // it, so it leaves the window even when that throws. What this
        // removal read of it is taken now: the strategy's hook for the holds
        // it releases can remove a row too, which sets the slot and clears it.
        // So is the branch it was removed on: that hook can move the store.
        const removing = this.removing;
        const removedOn = this.removalBranch();
        try {
          this.handleMessageRemove(event.messageId);
        } finally {
          if (this.stillOnRemovalBranch(removedOn, [event.messageId])) this.retractOnRemoval([event.messageId], removing?.rows ?? [], removedOn);
        }
        break;
      }
      case 'removeRange': {
        // As for 'remove', before any hook runs.
        const removing = this.removing;
        const removedOn = this.removalBranch();
        // Ids of the removed span aren't in the event; prune holds whose
        // message no longer exists.
        try {
          const before = this.compressionHolds.size;
          for (const id of [...this.compressionHolds]) {
            if (!this.messageStore.get(id)) this.compressionHolds.delete(id);
          }
          for (const [key, members] of [...this.compressionHoldGroups]) {
            if (!members.some((m) => this.compressionHolds.has(m))) this.compressionHoldGroups.delete(key);
          }
          if (this.compressionHolds.size !== before) this.notifyHoldsReleased();
        } finally {
          // For range removes, we need to check all affected messages
          // This is a simplification - in practice we'd need to track the IDs
          //
          // The window's rows of the span were read before it went
          // (removeMessages). The only other range removed here is what a
          // sharded addMessage that failed partway wrote, whose rows it reads
          // first too, since a host's listener of the add may have presented
          // a shard (appendMessage), and whose ids it knows where that read
          // failed. Holds can be probed by asking the slot, since every held
          // row is this slot's; the window can't, since it also holds rows of
          // the auxiliary slots, and a row of a slot this manager no longer
          // merges would read as removed and leave the window for good. The
          // rows leave the window even when the pruning throws, as the
          // 'remove' case's row does.
          if (removing && this.stillOnRemovalBranch(removedOn, removing.ids)) this.retractOnRemoval(removing.ids, removing.rows, removedOn);
        }
        break;
      }
    }
  }

  /** The store's branch as a removal's event finds it, before any hook runs; null where the store can't say. */
  private removalBranch(): { id: string; name: string } | null {
    try {
      const branch = this.store.currentBranch();
      return { id: branch.id, name: branch.name };
    } catch {
      return null;
    }
  }

  /**
   * Whether the store is still on `removedOn`, the branch a removal was
   * made on, once the hooks its event ran have returned: the strategy's
   * onCompressionHoldsReleased can move it (switchBranch, before its first
   * await). Where it moved, the removal's rows aren't taken out of the
   * window of the branch the store is on now, whose record may hold them,
   * and no strategy is told, as a window write after a hook moved the
   * store writes nothing (WindowIndex.settled). The move is logged: on the
   * removal's branch the rows keep their ordinals until retractAbsentRows
   * takes them out there and tells the strategy. Where the store can't say
   * its branch, before the hooks or after, the removal's rows leave the
   * window as before.
   */
  private stillOnRemovalBranch(removedOn: { id: string; name: string } | null, ids: readonly MessageId[]): boolean {
    if (removedOn === null) return true;
    let now: { id: string; name: string };
    try {
      now = this.store.currentBranch();
    } catch {
      return true;
    }
    if (now.id === removedOn.id) return true;
    const rows = ids.length === 1 ? `removed message ${ids[0]}` : `${ids.length} removed messages`;
    this.diag.warn(
      `[context-manager] a strategy hook the removal of ${rows} ran moved the store's branch from ${removedOn.name} to ${now.name}, ` +
        `so nothing is taken out of the window of ${now.name}, whose record may hold them, and no strategy is told; on ` +
        `${removedOn.name} they keep their ordinals until retractAbsentRows takes them out there`,
    );
    return false;
  }

  /**
   * Take rows just removed from this manager's slot out of the window (see
   * removeMessage), and tell the strategy of those the window held, as
   * `removed` gives them, read before they went (by id alone where that
   * read failed). The removal stands whatever happens here: a tombstone
   * that can't be written is logged, and the row, which the record no
   * longer holds, is already out of the listing the strategy reads; it
   * keeps its ordinal until retractAbsentRows, retractRemoved or
   * retractRows takes it out. The strategy is told of every row the window
   * held all the same, since the row has left what it reads: the ordinals
   * are read before the tombstones are written, once the writes waiting to
   * be settled are. So whether or not the tombstones land, it is told of
   * the rows they were to take out, and a row a hook took out first, as it
   * heard what an earlier window write did (WindowIndex.settled), is told
   * once, by that hook's call. Where the index can't be
   * read to tell which rows it held, or whether it is in legacy mode, the
   * strategy is told of every row removed, in the order given, with no
   * ordinal: a strategy that kept nothing of a row takes the call as
   * nothing to do. A failure of the manager's own work telling it (the
   * context it builds) is logged too, and the call waits, to be made at the
   * strategy's next notification, as a call made while it initializes does.
   *
   * `removedOn` is the branch the removal was made on (removalBranch). The
   * tombstones' write first settles a write whose outcome was unknown, and
   * a hook that hears it can move the store's branch, which makes the write
   * refuse (WindowIndex.settled): then no strategy is told, as where the
   * hold-release hook moved it (stillOnRemovalBranch), since the rows read
   * before are of the removal's branch, and the window of the branch the
   * store is on now may hold them.
   */
  private retractOnRemoval(ids: readonly MessageId[], removed: readonly StoredMessage[], removedOn: { id: string; name: string } | null): void {
    // The rows the window held, in window order; null while the index
    // hasn't been read.
    let held: RetractedRow[] | null = null;
    try {
      // One reading of the index, null in legacy mode, where nothing is
      // written or told. It stands for what the window held only where the
      // index can't be read again, or the store's branch can't be said,
      // before the writes waiting to be settled are: retractRemoved first
      // settles a write whose outcome was unknown, and a hook that hears it
      // can take a row out itself (retractRows, retractRemoved), which
      // tells the strategy then. So the rows it is about to take out once
      // they are settled replace it (`leaving`), and are the ones told
      // where its tombstones' write throws, as are the rows it takes out
      // where that write lands.
      const ordinals = this.windowIndex.ordinals();
      const inWindow: LeftRow[] = [];
      if (ordinals) {
        for (const id of new Set(ids)) {
          const ordinal = ordinals.get(id);
          if (ordinal !== undefined) inWindow.push({ id, ordinal, by: this.windowIndex.issuedBy(ordinal) });
        }
        inWindow.sort((a, b) => a.ordinal - b.ordinal);
      }
      held = inWindow;
      held = this.windowIndex.retractRemoved(ids, undefined, (leaving) => {
        held = leaving;
      });
    } catch (err) {
      // A format string, since the error follows it: a '%' in an id is doubled.
      const rows = ids.length === 1 ? `removed message ${ids[0]}` : `${ids.length} removed messages`;
      const message =
        `[context-manager] taking ${rows} out of the window failed; ` +
        `the window leaves them out of what it lists, and their ordinals stay issued until retractAbsentRows takes them ` +
        `out, unless the store kept the tombstone before it threw:`;
      logThrown(message.replaceAll('%', '%%'), err, this.diag);
      if (!this.stillOnRemovalBranch(removedOn, ids)) return;
    }
    const told = held ?? [...new Set(ids)].map((id): RetractedRow => ({ id }));
    if (told.length === 0) return;
    const byId = new Map(removed.map((m) => [m.id, m] as const));
    const left = told.map(({ id, ordinal, by }): RetractedRow => {
      const row = byId.get(id);
      return row ? { id, row, ordinal, by } : { id, ordinal, by };
    });
    const info: Retraction = { undone: false, removed: true };
    try {
      this.notifyRetracted(left, info);
    } catch (err) {
      // No hook of the call has run: the manager's own work around it threw.
      this.retractedUnheard.push({ left, info });
      const rows = told.length === 1 ? `removed message ${told[0]!.id}` : `${told.length} removed messages`;
      logThrown(
        `[context-manager] telling the strategy that ${rows} left the window failed; the removal stands, and it is told at its next notification:`.replaceAll('%', '%%'),
        err,
        this.diag,
      );
    }
  }

  private handleMessageAdd(message: StoredMessage): void {
    // What a write holds is placed as it is stored, in either mode: the hold
    // shapes what the store keeps folded, and touches no window.
    if (this.holdingAdds) {
      this.holdingAdds.push(message.id);
      this.placeHold(message.id, this.holdingAddOptions, this.holdingAddAt);
    }
    // In legacy mode the window is the record, so the row enters it here,
    // and the strategy hears it inside the append: its synchronous part
    // comes before addMessage returns, after a holdCompression hold is
    // placed (#288). A sharded add's shards it hears together, once the
    // last is stored (appendMessage), so no hook of its runs between them
    // (a listener that presents a shard while the add runs hears that
    // presentation at its own call: see onMessage).
    // Once a host presents rows on the branch, the row enters the window at
    // its presentRows, and the strategy hears it then.
    if (this.windowIndex.mode() === 'legacy') {
      if (this.writingShards) this.writingShards.heard.push(message);
      else this.notifyPresented([message]);
    }
  }

  /**
   * Tell the strategy rows entered the agent's window
   * (ContextStrategy.onPresented), or, for a strategy without that hook,
   * each row in turn through onNewMessage. After close() nothing reaches
   * the strategy: a close() from a listener lets the write it interrupted
   * finish, and a sharded write's shards are then stored unheard. While the
   * strategy isn't initialized the rows wait for the manager's strategy,
   * whether or not the one initializing has a row hook
   * (deliverPresentedUnheard); an add, the legacy caller, requires an
   * initialized strategy.
   *
   * Each row's onNewMessage call is checked as a call of its own, so a hook
   * that closes the manager, sets a strategy or starts an initialization
   * (a setStrategy() or switchBranch() called before its first await) stops
   * the calls after it, even when that initialization finished before the
   * hook returned, and so does one that moves the store's branch itself or,
   * once a host presents, takes the next row out of the window. The rows it
   * hasn't been given go nowhere after close(), and otherwise wait for the
   * initialization (deferPresented): once it has finished they are heard
   * where the window of the branch the store is on when they are delivered
   * holds them (the branch it initialized on, unless a hook moved the store
   * itself, which leaves the strategy to setStrategy(getStrategy())), at
   * once for a strategy with no initialize or one that is initialized still.
   * The strategy it let go hears no more.
   *
   * Fire and forget: the write doesn't wait for the strategy, and the
   * strategy's failure isn't the write's (#288). A hook that isn't async can
   * throw before it returns, and the throw is logged the same way as a
   * rejection. It can also return no promise, which isn't a failure. Either
   * way the rows stay stored and in the window, as do a sharded body's
   * remaining shards, and the strategy isn't offered them again. Only the
   * strategy's call is caught: the manager's own work around it, the
   * context it hands the strategy among it, still fails an add, as
   * onMessage's note says. A presentRows or retractRows, whose window
   * write has landed by then, logs it instead, and the rows wait to be
   * heard at the strategy's next notification (tellPresentation). The
   * log is logThrown's, which survives a thrown value that can't be
   * formatted.
   */
  private notifyPresented(rows: readonly StoredMessage[]): void {
    if (rows.length === 0 || this.closed) return;
    // The rows wait for the manager's strategy, whichever instance that is
    // once it is initialized, so they wait while one without a row hook
    // initializes too: a replacement set meanwhile hears them. They wait
    // too behind calls a delivery that failed to read left waiting, once
    // those are tried again (callWaits). A hook of those can move the
    // store's branch itself, which starts no initialization, or, moving
    // nothing else, take a row of these out of the window again (a
    // retractRows): the rows then wait too, and are heard where the window
    // of the branch the store is on holds them (deferPresented), as
    // tellPresentation's second call is. So too where the store can't say
    // its branch before the retry, and a move can't be seen.
    const scope = this.retryScope();
    // Whether the rows entered a legacy window: read before a retried hook
    // can move the store, where one may run; otherwise only if they wait.
    let legacy: boolean | undefined;
    if (scope !== null) {
      try {
        legacy = this.windowIndex.mode() === 'legacy';
      } catch {
        legacy = undefined;
      }
    }
    if (this.callWaits()) {
      this.waitToBeHeard(rows, legacy ?? this.windowIndex.mode() === 'legacy');
      return;
    }
    if (!this.leftInScope(scope) || (scope !== null && legacy === false && !this.allInWindow(rows))) {
      this.deferPresented(rows, legacy ?? false);
      return;
    }
    this.tellPresented(rows);
  }

  /** Whether the window holds every row; false where the index can't be read to tell. */
  private allInWindow(rows: readonly StoredMessage[]): boolean {
    try {
      return rows.every((m) => this.windowIndex.ordinalOf(m.id) !== undefined);
    } catch {
      return false;
    }
  }

  /**
   * The hook scope a notification's own call is made under, read before it
   * tries again the calls a failed delivery left waiting (callWaits), whose
   * hooks can move the store's branch: null where nothing waits, so no
   * hook runs, and `'unknown'` where the store can't say its branch, so a
   * move can't be seen (leftInScope takes it as one).
   */
  private retryScope(): ReturnType<ContextManager['hookScope']> | 'unknown' | null {
    if (!this.unheardWaiting()) return null;
    try {
      return this.hookScope();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Whether the retried calls' hooks left the manager as `scope` found it
   * (inHookScope): true for no scope, false for one that couldn't be read
   * and where the check throws, so the call is made where the window of
   * the branch the store is on, read at delivery, holds its rows or left
   * them, as after a move.
   */
  private leftInScope(scope: ReturnType<ContextManager['retryScope']>): boolean {
    if (scope === null) return true;
    if (scope === 'unknown') return false;
    try {
      return this.inHookScope(scope);
    } catch {
      return false;
    }
  }

  /** Make notifyPresented's call of the initialized strategy, now. */
  private tellPresented(rows: readonly StoredMessage[]): void {
    if (rows.length === 0 || this.closed) return;
    const strategy = this.strategy;
    if (!strategy.onPresented && !strategy.onNewMessage) return;
    const ctx = this.createStrategyContext();
    if (strategy.onPresented) {
      const failed = (err: unknown) => logThrown(`Strategy onPresented failed for ${describeRows(rows)}:`, err, this.diag);
      try {
        Promise.resolve(strategy.onPresented(rows, ctx)).catch(failed);
      } catch (err) {
        failed(err);
      }
      return;
    }
    // The strategy, initialization and branch the calls are made under, and
    // the window the rows entered, before any hook runs.
    const scope = this.hookScope();
    const legacy = this.windowIndex.mode() === 'legacy';
    // Whether a presented row is in the window still: a hook can take it
    // out. A read that throws can't tell, so the row waits, as below.
    const inWindow = (id: MessageId) => {
      try {
        return this.windowIndex.ordinalOf(id) !== undefined;
      } catch {
        return false;
      }
    };
    // A check that throws (the store's branch can't be read) can't tell
    // either, so the rest wait: once a hook has run nothing here throws.
    const stopsBefore = (row: StoredMessage) => {
      try {
        return !this.inHookScope(scope) || (!legacy && !inWindow(row.id));
      } catch {
        return true;
      }
    };
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && stopsBefore(rows[i]!)) {
        // The previous row's hook closed the manager, set a strategy,
        // started an initialization, which may have finished before the
        // hook returned (a strategy with no initialize), moved the store's
        // branch, or took this row out of the window: the rest wait, as rows
        // presented while an initialization runs do, and are heard once
        // the strategy is initialized (at once where it is), those the
        // window of the branch it initialized on holds.
        this.deferPresented(rows.slice(i), legacy);
        return;
      }
      const message = rows[i]!;
      const failed = (err: unknown) =>
        logThrown(`Strategy onNewMessage failed for ${describeStoreEvent({ type: 'add', message })}:`, err, this.diag);
      try {
        Promise.resolve(strategy.onNewMessage!(message, ctx)).catch(failed);
      } catch (err) {
        failed(err);
      }
    }
  }

  /**
   * Rows whose onNewMessage calls a hook stopped (notifyPresented): they
   * wait for the initialization it started, as rows presented while it runs
   * do, and are given at once if it has finished, which delivers only those
   * the window of the branch the store is on then holds (the branch it
   * initialized on, unless a hook moved the store itself). Nothing after
   * close().
   */
  private deferPresented(rows: readonly StoredMessage[], legacy: boolean): void {
    if (this.closed) return;
    this.waitToBeHeard(rows, legacy);
    if (this.initializedAttempt === this.initializationAttempt) this.deliverUnheard();
  }

  /** Rows that wait to be heard entering the window (presentedUnheard), with whether they entered a legacy window. */
  private waitToBeHeard(rows: readonly StoredMessage[], legacy: boolean): void {
    for (const row of rows) this.presentedUnheard.set(row.id, legacy || this.presentedUnheard.get(row.id) === true);
  }

  /**
   * A call of onRetracted that a hook of an earlier call stopped (the
   * second call of retractRows): it waits for the initialization the hook
   * started, as a call made while the strategy initializes does, and is
   * made at once if that has finished, for the rows that left the window
   * of the branch it initialized on (deliverRetractedUnheard). Nothing
   * after close().
   */
  private deferRetracted(left: readonly RetractedRow[], info: Retraction): void {
    if (left.length === 0 || this.closed) return;
    this.retractedUnheard.push({ left: left.map(({ id, row, ordinal, by }) => (info.removed && row ? { id, row, ordinal, by } : { id, ordinal, by })), info });
    if (this.initializedAttempt === this.initializationAttempt) this.deliverUnheard();
  }

  /**
   * What a hook call can change that a call after it is made under: the
   * strategy, its initialization, and the store's branch. Read before the
   * first of two calls (presentRows, retractRows), and checked before the
   * second (inHookScope).
   */
  private hookScope(): { strategy: ContextStrategy; attempt: number; branch: BranchStamp } {
    return { strategy: this.strategy, attempt: this.initializationAttempt, branch: this.branchStamp() };
  }

  /**
   * Whether a hook call left the manager as `scope` found it: open, with
   * the same strategy, initialization and branch. Where it didn't, the call
   * after it waits for the initialization, and is made where the window of
   * the branch the strategy initialized on holds its rows.
   */
  private inHookScope(scope: ReturnType<ContextManager['hookScope']>): boolean {
    if (this.closed || this.strategy !== scope.strategy || this.initializationAttempt !== scope.attempt) return false;
    return this.onBranch(scope.branch);
  }

  /** The store's branch as a write finds it: its name and generation (observeStoreBranch) and its id. */
  private branchStamp(): BranchStamp {
    return { ...observeStoreBranch(this.store), id: this.store.currentBranch().id };
  }

  /**
   * Whether the store is still on the branch `stamp` read, at the same
   * generation: a manager's switch away and back starts a new one, and a
   * branch made again under the name has another id.
   */
  private onBranch(stamp: BranchStamp): boolean {
    const now = this.branchStamp();
    return now.name === stamp.name && now.generation === stamp.generation && now.id === stamp.id;
  }

  /**
   * Tell the strategy rows left the agent's window
   * (ContextStrategy.onRetracted): one call, in window order, the ids of
   * every row that left and the rows among them the manager can give, as
   * notifyPresented tells it of rows entering. Nothing reaches a strategy
   * without the hook, nor anything after close(). While the strategy isn't
   * initialized the call waits for the manager's strategy, whether or not
   * the one initializing has the hook (deliverRetractedUnheard), with the
   * ordinal each row left, which decides at delivery whether the row left
   * the window of the branch the strategy initialized on. Fire and forget
   * (#288): a throw before the hook returns, or a rejection, is logged,
   * naming the rows, and doesn't reach the caller; the manager's own work
   * around the call, the context it builds among it, does.
   */
  private notifyRetracted(left: readonly RetractedRow[], info: Retraction): void {
    if (left.length === 0 || this.closed) return;
    // As notifyPresented's rows, the call waits for the manager's strategy,
    // whether or not the one initializing has the hook, and behind calls a
    // delivery that failed to read left waiting; and, where a hook of those
    // moved the store's branch itself, it is made for the rows that left
    // the window of the branch the store is on (deferRetracted).
    const scope = this.retryScope();
    if (this.callWaits()) {
      // A row the store holds is read when the call is made; one a removal
      // took is kept, since the store no longer has it to give.
      this.retractedUnheard.push({ left: left.map(({ id, row, ordinal, by }) => (info.removed && row ? { id, row, ordinal, by } : { id, ordinal, by })), info });
      return;
    }
    if (!this.leftInScope(scope)) {
      this.deferRetracted(left, info);
      return;
    }
    this.tellRetracted(left, info);
  }

  /** Make notifyRetracted's call of the initialized strategy, now. */
  private tellRetracted(left: readonly RetractedRow[], info: Retraction): void {
    if (left.length === 0 || this.closed) return;
    const strategy = this.strategy;
    if (!strategy.onRetracted) return;
    const rows = left.flatMap((l) => (l.row ? [l.row] : []));
    const ids = left.map((l) => l.id);
    const ctx = this.createStrategyContext();
    const failed = (err: unknown) => logThrown(`Strategy onRetracted failed for ${describeLeft(left)}:`, err, this.diag);
    try {
      Promise.resolve(strategy.onRetracted(rows, ctx, { ...info, ids })).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  /** While deliverUnheard runs: a notification it makes, or an initialization a hook finishes, leaves what waits to it. */
  private deliveringUnheard = false;
  /** While deliverRetractedUnheard makes its calls: a call made meanwhile waits behind those it hasn't made. */
  private drainingRetracted = false;
  /** While deliverPresentedUnheard makes its calls: rows presented meanwhile wait behind the rows it hasn't given. */
  private drainingPresented = false;

  /** Whether a call waits for the initialized strategy, or a delivery of them is making its calls. */
  private unheardWaiting(): boolean {
    return this.drainingRetracted || this.drainingPresented || this.retractedUnheard.length > 0 || this.presentedUnheard.size > 0;
  }

  /**
   * Whether a notification's own call waits (notifyPresented,
   * notifyRetracted): while the strategy isn't initialized, while calls
   * still wait once those a delivery that failed to read left waiting have
   * been tried again, and where a hook of those retried calls set a
   * strategy or started an initialization, which the call then waits for.
   * A hook of theirs that moves the store's branch itself starts none: the
   * notification checks that apart (retryScope), and its call is then made
   * for the rows the window of the branch the store is on holds, or left,
   * as it is where the store can't say its branch before the retry, and,
   * for rows presented, where such a hook took one of them out again.
   */
  private callWaits(): boolean {
    if (this.initializedAttempt !== this.initializationAttempt) return true;
    return this.unheardStillWaiting() || this.initializedAttempt !== this.initializationAttempt;
  }

  /**
   * Whether calls still wait for the initialized strategy once the ones a
   * delivery that failed to read left waiting have been tried again: a
   * notification's own call then waits behind them, so the strategy hears
   * it after them, in the order deliverUnheard makes them (the waiting
   * retractions first, then the rows presented meanwhile), and a row that
   * left and was presented again is heard to go before it is heard to
   * enter.
   */
  private unheardStillWaiting(): boolean {
    if (!this.unheardWaiting()) return false;
    this.deliverUnheard();
    return this.unheardWaiting();
  }

  /**
   * Once the strategy is initialized, make the calls that waited for it:
   * the onRetracted calls first, in the order they came, then the rows
   * presented meanwhile (deliverRetractedUnheard, deliverPresentedUnheard).
   * A delivery whose read of the window or the record fails puts back what
   * it didn't make, logged, and the strategy's next notification
   * (notifyPresented, notifyRetracted) tries it again, before its own call.
   * A hook that sends calls to wait while this runs, one that starts an
   * initialization that finishes before it returns among them, leaves them
   * to this, which makes them after the ones before them. Nothing here
   * fails the initialization that ran it.
   */
  private deliverUnheard(): void {
    if (this.deliveringUnheard) return;
    this.deliveringUnheard = true;
    try {
      while (!this.closed && this.initializedAttempt === this.initializationAttempt) {
        if (this.retractedUnheard.length > 0) {
          if (!this.deliverRetractedUnheard()) return;
        } else if (this.presentedUnheard.size > 0) {
          if (!this.deliverPresentedUnheard()) return;
        } else {
          return;
        }
      }
    } finally {
      this.deliveringUnheard = false;
    }
  }

  /**
   * The calls of onRetracted made while the strategy wasn't initialized,
   * in the order they came. A row is given when it left the window of the
   * branch the strategy initialized on, as the call left it: that branch's
   * index once issued it the call's ordinal, in the record that issued it
   * there where the call left it, and has taken it out, or holds it at
   * another ordinal (presented again since); or the branch holds it and
   * its record no longer does (a removal whose tombstone failed). A call
   * with no ordinal (the index couldn't be read when it was made) gives a
   * row the branch's index took out. A branch made before it left holds
   * it there, in its window and its record, a branch made before it was
   * presented never held it, or presented it on its own, in records of its
   * own, whatever ordinal they gave it (WindowIndex.issuedBy), whether or
   * not it took it out again since, and a branch in legacy mode holds
   * every row of its record, so none of them is told. A
   * call left with no row isn't made. A row the call didn't keep is read
   * then, from the record of that branch, and given where it holds it; one
   * it no longer holds is told by its id alone, with `removed`, in a call
   * of its own after the rest of an ordinary call's rows, as retractRows
   * tells it. A call whose hook closes the manager, sets a strategy or
   * starts an initialization leaves the calls after it waiting, as a call
   * made then would. False when a read failed: the call it was for and
   * those after it wait still.
   */
  private deliverRetractedUnheard(): boolean {
    const queued = this.retractedUnheard;
    this.retractedUnheard = [];
    this.drainingRetracted = true;
    let i = 0;
    try {
      for (; i < queued.length; i++) {
        if (this.closed || this.initializedAttempt !== this.initializationAttempt) return true;
        const { left, info } = queued[i]!;
        try {
          const presented = this.windowIndex.mode() === 'presented';
          const merged = presented ? this.mergedMessageView() : null;
          const tookOut = presented ? this.windowIndex.left() : null;
          // A row left this window where this branch's own index issued the
          // call's ordinal to it, in the record that presented it where the
          // call left it (sharedPresentation), and has taken it out, or holds
          // it at another ordinal (presented again since); or where the
          // window holds it and the record no longer does (a removal whose
          // tombstone failed). A call with no ordinal (the index couldn't be
          // read when it was made) is told where this branch's index took
          // the row out. A branch made before the row was presented never
          // held it, or presented it on its own and issued it the call's
          // ordinal in a record of its own, if at all, so isn't told, even
          // where it took that presentation out again.
          const leftHere = ({ id, ordinal, by }: RetractedRow) => {
            const here = this.windowIndex.ordinalOf(id);
            const sharedPresentation =
              ordinal !== undefined &&
              this.windowIndex.issuedTo(ordinal) === id &&
              (by === undefined || this.windowIndex.issuedBy(ordinal) === by);
            if (here === undefined) return tookOut?.has(id) === true && (ordinal === undefined || sharedPresentation);
            return (ordinal !== undefined && here !== ordinal && sharedPresentation) || !holdsRow(merged!, id);
          };
          const withRow = (l: RetractedRow): RetractedRow => {
            if (l.row) return l;
            const row = merged!.get(l.id);
            return row ? { ...l, row } : l;
          };
          const told = presented ? left.filter(leftHere).map(withRow) : [];
          // A row of an ordinary call the record no longer holds (another
          // manager removed it meanwhile) is told by its id alone, with
          // `removed`, in a call of its own after the rest, as retractRows
          // tells it; where the first call's hook moved the manager on, that
          // call is made next, where a call made then would be.
          const gone = info.removed ? [] : told.filter((l) => !l.row);
          const held = gone.length === 0 ? told : told.filter((l) => l.row);
          const scope = held.length > 0 && gone.length > 0 ? this.hookScope() : null;
          this.tellRetracted(held, info);
          if (gone.length > 0) {
            const rest = { left: gone, info: { undone: info.undone, removed: true } };
            if (scope === null || this.inHookScope(scope)) {
              // Should the manager's own work around this call throw, it
              // waits alone: the rows told before it aren't told again.
              queued[i] = rest;
              this.tellRetracted(rest.left, rest.info);
            } else {
              queued.splice(i + 1, 0, rest);
            }
          }
        } catch (err) {
          logThrown(
            '[context-manager] telling the strategy of rows that left the window while it initialized failed; it is told at its next notification:',
            err,
            this.diag,
          );
          return false;
        }
      }
      return true;
    } finally {
      this.drainingRetracted = false;
      // What wasn't made waits, ahead of any call made while these were.
      if (i < queued.length) this.retractedUnheard = [...queued.slice(i), ...this.retractedUnheard];
    }
  }

  /**
   * The rows that entered the window while the strategy wasn't initialized
   * that are still in the window of the branch the store is on when they are
   * delivered (the branch it initialized on, unless a hook moved the store
   * itself, which leaves the strategy to setStrategy(getStrategy())), in
   * window order. Once a host presents there, that is the rows its index holds,
   * however each entered: a row presented on another branch has no ordinal
   * there. While that branch is in legacy mode its window is its record,
   * and the rows given are those an add entered into a legacy window (a
   * sharded add's later shards, after a hook of an earlier one started the
   * initialization) that the record holds; a row presented on a branch
   * whose index was written down isn't given there. Rows a hook presents
   * while it makes its calls wait behind the rows it hasn't given, as a
   * call made while deliverRetractedUnheard makes its calls does. False
   * when the read of the window failed, or the manager's own work around
   * the call: the rows wait still.
   */
  private deliverPresentedUnheard(): boolean {
    const waiting = this.presentedUnheard;
    let rows: StoredMessage[];
    try {
      const presented = this.windowIndex.mode() === 'presented';
      const unheard = new Set([...waiting].filter(([, legacy]) => presented || legacy).map(([id]) => id));
      // The window's listing: the index's rows once a host presents, the
      // merged record in legacy mode.
      rows = this.presentedMessageView()
        .getAll()
        .filter((m) => unheard.has(m.id));
    } catch (err) {
      logThrown('[context-manager] reading the window to tell the strategy of rows presented while it initialized failed; it is told at its next notification:', err, this.diag);
      return false;
    }
    this.presentedUnheard = new Map();
    this.drainingPresented = true;
    try {
      this.tellPresented(rows);
    } catch (err) {
      // The manager's own work before the strategy's call failed, so no
      // hook ran: the rows wait again.
      for (const [id, legacy] of waiting) this.presentedUnheard.set(id, legacy || this.presentedUnheard.get(id) === true);
      logThrown('[context-manager] telling the strategy of rows presented while it initialized failed; it is told at its next notification:', err, this.diag);
      return false;
    } finally {
      this.drainingPresented = false;
    }
    return true;
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
   * onFoldReceipt), or from a strategy hook a manager call runs (a
   * notification's, or one hearing what an earlier window write did), lets
   * the write it interrupted finish and starts nothing new: the write's
   * remaining shards are stored, its receipt committed and the call's own
   * window write made, nothing after the close() reaches the strategy, and
   * a store the manager owns closes once that write returns, a failure of
   * that close logged rather than thrown.
   * If the manager owns the store (created via path config), this closes the store.
   * If the app owns the store (passed via store config), the store stays open;
   * the app is responsible for closing it when done.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Nothing reaches the strategy after close(), so what waits for it is
    // let go: the calls waiting for its initialization, and the window
    // writes waiting to be settled. A write a close() from a listener
    // interrupted can queue a few again as it finishes; nothing reads them.
    this.presentedUnheard.clear();
    this.retractedUnheard = [];
    this.windowIndex.dropUnsettled();
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
 * The rows of a call's record by id, as the record holds them, for telling
 * the strategy what a window write that threw did (presentRows,
 * retractRows). The map is built at the first look-up, so a call whose
 * write doesn't throw builds none. `keep` narrows it to the rows a write
 * whose outcome was unknown named, and lets the record go: that write's
 * telling waits for a later write on its branch (WindowIndex settled), so
 * what waits holds those rows, not the record.
 */
interface RowsAsFound {
  get(id: MessageId): StoredMessage | undefined;
  keep(ids: readonly MessageId[]): void;
}

function rowsAsFound(record: readonly StoredMessage[]): RowsAsFound {
  let listing: readonly StoredMessage[] | null = record;
  let byId: Map<MessageId, StoredMessage> | null = null;
  return {
    get(id) {
      byId ??= new Map(listing!.map((m) => [m.id, m] as const));
      return byId.get(id);
    },
    keep(ids) {
      const named = new Set(ids);
      const kept = new Map<MessageId, StoredMessage>();
      for (const m of byId ? byId.values() : listing!) if (named.has(m.id)) kept.set(m.id, m);
      byId = kept;
      listing = null;
    },
  };
}

/**
 * Whether one of the slots `merged` merges holds the row on the store's
 * branch, looked up by its sequence (MessageStoreView.sequenceOf) rather
 * than read whole.
 */
function holdsRow(merged: MessageStoreView, id: MessageId): boolean {
  return (merged.sequenceOf ? merged.sequenceOf(id) : merged.get(id)?.sequence) !== undefined;
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

/**
 * The rows a presentation entered into a window, or a retraction took out,
 * for a log line's message, as describeStoreEvent describes one: one row as
 * its add is described, several by their count and the first and last of
 * them in window order.
 */
function describeRows(rows: readonly StoredMessage[], verb: 'presented' | 'taken out' = 'presented'): string {
  if (rows.length === 1) return describeStoreEvent({ type: 'add', message: rows[0]! });
  return `${rows.length} messages ${verb}, ${rows[0]!.id} to ${rows[rows.length - 1]!.id}`.replaceAll('%', '%%');
}

/**
 * The rows that left a window, for a log line's message, as describeRows
 * describes them: by the rows where each has one, and by their ids where a
 * row the store no longer holds left by its id alone.
 */
function describeLeft(left: readonly RetractedRow[]): string {
  if (left.every((l) => l.row)) return describeRows(left.map((l) => l.row!), 'taken out');
  if (left.length === 1) return `message ${left[0]!.id}`.replaceAll('%', '%%');
  return `${left.length} messages taken out, ${left[0]!.id} to ${left[left.length - 1]!.id}`.replaceAll('%', '%%');
}

/**
 * What a removal through the manager takes (ContextManager.removing): the
 * ids of its rows, and the rows as they were before they went, where they
 * could be read.
 */
interface Removing {
  ids: readonly MessageId[];
  rows: readonly StoredMessage[];
}

/** How rows left a window, as ContextStrategy.onRetracted is told (with the ids of each call's rows). */
interface Retraction {
  undone: boolean;
  removed: boolean;
}

/**
 * A row that left the window, with the ordinal it held there, and the row
 * itself where the manager can give it: one the store holds, or one a
 * removal through this manager read before it went. A row a removal took
 * where the index couldn't be read has no ordinal (retractOnRemoval).
 */
interface RetractedRow {
  id: MessageId;
  row?: StoredMessage;
  ordinal?: number;
  /** The identity of the record that presented the row at `ordinal` (LeftRow). */
  by?: string;
}
