import type { JsStore } from '@animalabs/chronicle';
import type { Membrane, ContentBlock, ToolDefinition } from '@animalabs/membrane';
import type { StoredMessage, MessageId, Sequence } from './message.js';
import type { FoldDiff } from '../adaptive/fold-diff.js';
import type {
  ContextEntry,
  TokenBudget,
  PendingWork,
} from './context.js';
import type { OverBudgetClearedBy } from '../adaptive/picker.js';
import { DEFAULT_IMAGE_BYTE_CEILING, DEFAULT_IMAGE_CEILING } from '../live-image-limits.js';

/**
 * Read-only view of the message store for strategies.
 */
export interface MessageStoreView {
  /** Get all messages */
  getAll(): StoredMessage[];
  /** Get a specific message */
  get(id: MessageId): StoredMessage | null;
  /**
   * A message's sequence, as `get(id)?.sequence` answers it, without reading
   * the message where the view can (optional — a reader without it falls
   * back to `get`). MessageStore answers from its listing while that is
   * cached, as it is during a compile, and reads the item otherwise; a merged
   * view asks each source's, and the source's `get` where it has none.
   */
  sequenceOf?(id: MessageId): number | undefined;
  /** Get messages from a specific index */
  getFrom(index: number): StoredMessage[];
  /** Get the last N messages */
  getTail(count: number): StoredMessage[];
  /** Get total message count */
  length(): number;
  /** Estimate tokens for a message */
  estimateTokens(message: StoredMessage): number;
  /**
   * Closed-loop estimator calibration (optional — MessageStore provides it).
   * The strategy owns the factor (see MessageStore's tokenCalibration). A view
   * supplies both of these or neither: a dry select reads the factor before
   * its load changes it and puts it back afterwards, so it throws for a view
   * with the setter alone rather than change a factor it can't restore. A
   * view with neither is a fixed estimator.
   */
  setTokenCalibration?(factor: number): void;
  getTokenCalibration?(): number;
  /**
   * Whether a message is under a compression hold (ContextManager
   * holdCompression / addMessage `holdCompression`). Compressing strategies
   * must not fold a held message, anything after it, or the tool_use it
   * answers. Absent on views not built by a ContextManager ⇒ nothing held.
   */
  isCompressionHeld?(id: MessageId): boolean;
  /** Fast path: whether any hold exists (lets strategies skip scanning). */
  hasCompressionHolds?(): boolean;
}

/**
 * Read-only view of the context log for strategies.
 */
export interface ContextLogView {
  /** Get all entries */
  getAll(): ContextEntry[];
  /** Get entries from a specific index */
  getFrom(index: number): ContextEntry[];
  /** Get the last N entries */
  getTail(count: number): ContextEntry[];
  /** Get total entry count */
  length(): number;
  /** Estimate tokens for an entry */
  estimateTokens(entry: ContextEntry): number;
}

/**
 * Context provided to strategy methods.
 */
export interface StrategyContext {
  /** Read-only view of message store */
  messageStore: MessageStoreView;
  /**
   * The agent's live tool definitions, as last supplied by the host (set on
   * every activation via ContextManager.setToolDefinitions). Summarizer /
   * compression requests MUST declare these: replaying a transcript full of
   * tool_use/tool_result blocks with no `tools` param trips Anthropic's
   * reasoning_extraction classifier (looks like a foreign agent trace being
   * duplicated) and the whole compression pass gets deterministically
   * refused. Optional because ticks can fire before the first activation.
   */
  tools?: ToolDefinition[];
  /**
   * The agent's live system prompt, as last supplied by the host (set on
   * every activation via ContextManager.setSystemPrompt). Memory-writing
   * requests serve it as their own system prompt: on hosts whose identity
   * and conduct live in system voice, a summarizer that never sees it is a
   * different agent from the one whose memory it writes, and merges
   * re-summarize summaries, so the drift compounds upward.
   *
   * This is the host's CURRENT prompt, not a historical one — only the
   * latest pushed value is retained — so a mint is governed by the identity
   * policy in force when it runs. That reproduces what the original instance
   * was served to the extent the host keeps the prompt stable across the
   * compressed span. Optional and opt-in: undefined leaves every mint
   * request byte-identical to the no-system-prompt shape it has always had.
   */
  systemPrompt?: string;
  /** Read-only view of context log */
  contextLog: ContextLogView;
  /**
   * Membrane instance for LLM calls (compression). AutobiographicalStrategy
   * passes each call a signal of its own (`CompleteOptions.signal`) and
   * aborts it when it lets go of the call's work, at detach() or when it is
   * initialized again, so a host that wraps this membrane passes the signal
   * on, and may combine its own with it to end calls itself (see
   * CompressionWithdrawn).
   */
  membrane?: Membrane;
  /** Current sequence number */
  currentSequence: Sequence;
  /**
   * Underlying Chronicle store. Strategies may register their own state slots
   * (via `store.registerState`) for durable strategy state that needs to
   * survive process restart and follow Chronicle branches.
   *
   * State IDs should be scoped under `namespace` to avoid collisions with
   * other strategies or with the message/context-log states.
   */
  store: JsStore;
  /**
   * Namespace under which this strategy should scope its state IDs.
   * Use as a prefix: e.g. `${namespace}/autobio:summaries`. Always defined;
   * defaults to a stable per-manager value when no caller-supplied namespace
   * exists, so strategies never need to handle the unscoped case.
   */
  namespace: string;
}

/**
 * Result of readiness check.
 */
export interface ReadinessState {
  /** Whether the strategy has no background work pending, other than work
   *  that waits on something only the host can give, such as its tool
   *  definitions: `waitingOn` names that. compile() doesn't wait for either:
   *  it compiles from what's there. */
  ready: boolean;
  /** Promise that resolves when ready (if not ready) */
  pendingWork?: Promise<void>;
  /** Description of pending work */
  description?: string;
  /** Set while some background work waits on the host, ready or not:
   *  'tools' until it declares its tool definitions. */
  waitingOn?: 'tools';
  /** Description of the work waiting on the host, when `waitingOn` is set */
  waitingDescription?: string;
}

/**
 * Pluggable strategy for context management.
 * Strategies control how context is selected, compressed, and maintained.
 */
export interface ContextStrategy {
  /** Strategy name for identification */
  readonly name: string;

  /** Maximum tokens per individual message. Used by the framework to truncate
   *  tool results in-flight (yielding stream) and at storage time.
   *  A value that isn't a positive number, such as 0, undefined, a negative
   *  or NaN, means no limit. */
  readonly maxMessageTokens?: number;

  /**
   * What the next compile sends for each of `ids`, in the order given,
   * before the manager leaves out any thinking under
   * `SelectOptions.thinkingBinding`. Each comes back in the form the compile
   * sends it, wherever the compile places it: cut by the per-message cap, as
   * one message where the compile joins a body's shards into one, and with
   * every image decision the strategy makes there: its count, depth and byte
   * limits, counted newest-first over the view from the oldest of these
   * messages to its newest, as a compile counts them. It's for a caller that
   * works from a compiled request without recompiling. One appends messages
   * it has just stored, such as a turn's mid-turn injections, so that what it
   * appends is what the next compile sends. Another renders messages its
   * stream has already sent, such as the rows `ContextManager.noteRequestSent`
   * digests over a whole turn, so that the next compile can tell which of
   * them it sends as they were sent. A later compile can still strip
   * an image of theirs as newer ones arrive, and their images can strip
   * older images the request already carried, so the request they're
   * appended to can still differ from the next compile before them.
   *
   * The form isn't the place. Where the compile sends one of these messages
   * before others, such as the memory strategy's head window a reset hasn't
   * filled, which the history from before the reset follows, a request they
   * are appended to differs from the next compile there, however they're
   * rendered.
   *
   * `store` is the view a compile reads. An id comes back as null only when
   * the next compile doesn't send that message: the view leaves it out, such
   * as by its filter, or windowed passthrough's anchor is past it. What the
   * next compile decides from its budget or its plan isn't foreseen, since a
   * render has neither: windowed passthrough's re-anchor, or its refusal of a
   * newest message bigger than the budget; the memory strategy's refusal of
   * a recent window over budget, the adaptive select's drop of a provisional
   * calibration that puts it over budget, or a plan that sends a summary in
   * place of a message it covers, which comes back raw. A strategy's own doc
   * names any other place where its compile sends a message otherwise.
   *
   * What comes back is made of the stored arrays and blocks, as a compile's
   * messages are, so a caller that edits what comes back copies it first.
   * Tool blocks come back as the cap leaves them, with what sending prunes
   * from them, since how a compile pairs them depends on the window around
   * them. Rendering doesn't
   * change what a later compile sends.
   */
  renderAsNewest?(store: MessageStoreView, ids: readonly MessageId[]): Array<ContentBlock[] | null>;

  /**
   * Initialize the strategy with context.
   * Called when strategy is set on ContextManager.
   */
  initialize?(ctx: StrategyContext): Promise<void>;

  /**
   * The manager is done with this strategy: setStrategy() replaced it, the
   * manager closed, or the open() that was initializing it failed. The
   * strategy stops the work it still has running for that manager, so it
   * writes nothing more to the store and starts no further provider call.
   * It is synchronous and not awaited. A strategy can cancel the provider
   * calls it has out then, as AutobiographicalStrategy does; one that
   * doesn't lets a call already waiting on the provider finish, with any
   * retries the provider client makes of it, and throws its result away. A
   * promise or other thenable it returns anyway isn't awaited either; the
   * manager logs its rejection. A later setStrategy() of the same instance
   * on a manager that isn't closed initializes it again, so a strategy whose
   * detach() stops it starts again in initialize(). A setStrategy() of
   * another strategy, or a close(), that lands while the strategy
   * initializes detaches it at once, and again once initialize() returns or
   * rejects, unless the manager holds it again by then: an instance set
   * again fences its earlier initialization's work itself. So detach() can
   * be called more than once for one instance, and must be safe to repeat.
   * It is per instance: sharing one instance between two managers isn't
   * supported, and either letting it go detaches it for both. A manager
   * whose close() interrupted an initialization of the instance holds it
   * until that initialization ends.
   */
  detach?(): void;

  /**
   * Periodic background maintenance.
   * Called by application to trigger compression, indexing, etc.
   */
  tick?(ctx: StrategyContext): Promise<void>;

  /**
   * React to new messages.
   * Called after a message is added to the store, inside the write that
   * stored it, so its synchronous part runs before addMessage returns; the
   * manager doesn't wait for the promise. A rejection, or a throw before it
   * returns, is logged through the manager's diagnostics, naming the message,
   * and doesn't reach addMessage's caller: the message stays stored, and the
   * strategy isn't offered it again. A hook that returns no promise, as one
   * written in JavaScript can, isn't a failure, and nothing is logged.
   */
  onNewMessage?(message: StoredMessage, ctx: StrategyContext): Promise<void>;

  /**
   * Called when ContextManager.releaseCompression actually released a hold.
   * Compressing strategies should re-queue work the hold deferred.
   */
  onCompressionHoldsReleased?(ctx: StrategyContext): void;

  /**
   * Whether the strategy has background work pending, with its info if so,
   * and what waits on the host. compile() doesn't wait for it.
   */
  checkReadiness(): ReadinessState;

  /**
   * Select and order context entries for compilation.
   * This is the core method that determines what goes in the context window.
   *
   * `opts.dryRun` requests a NON-COMMITTING select: the returned entries are
   * what a real compile at this budget would produce, but no fold resolutions
   * or chunk records are persisted, no compression/merge work is enqueued, no transition
   * bookkeeping is advanced, and what a select leaves for the next one or for
   * observers (its cache-marker baseline, transition status, render stats,
   * and calibration's estimate and arming) stays as the last committing
   * select left it. Implementations that cannot
   * honour it must ignore it only if they are already side-effect-free; any
   * path that commits state MUST gate on it.
   */
  select(
    store: MessageStoreView,
    log: ContextLogView,
    budget: TokenBudget,
    opts?: SelectOptions
  ): ContextEntry[];

  /**
   * Optional: at ingestion time, decide whether to split this incoming
   * message into multiple shards (because it's too large to be a single
   * fold unit). If returned, the framework stores each shard as a separate
   * StoredMessage with the shared `bodyGroupId` and per-shard `shardIndex`,
   * and the render path will reassemble them into one API message at
   * compile time.
   *
   * Return null or undefined to skip chunking (message stored as one record).
   *
   * See `docs/adaptive-resolution-design.md` §3.6.
   */
  chunkIngressMessage?(
    participant: string,
    content: ContentBlock[]
  ): IngressChunkResult | null;

  /**
   * Declares that select() reports its rendered layout completely, and which
   * forms history can take under this strategy. Reporting completely means:
   * every message it renders raw is a `copy` entry naming its source ids, and
   * every entry that represents history through summaries names them in
   * `ContextEntry.summaries`; a message of the view represented by neither
   * is reported as omitted. A strategy that does not declare this gets no
   * rendered layout, so no fold receipts are written for it.
   */
  readonly renderedForms?: ReadonlyArray<'raw' | 'summary' | 'omitted'>;

  /**
   * For layout reporting: which messages each named summary covers, at what
   * level, and by what method it was written ('unknown' when the strategy
   * does not record authorship). Required when select() names summaries.
   */
  describeRenderedSummaries?(ids: readonly string[]): ReadonlyMap<string, RenderedSummaryInfo>;

  /**
   * Why the last select() changed what it renders, when the strategy knows
   * (for example 'budget-fit' or 'window'). Reading clears it.
   */
  takeSelectionCause?(): string | undefined;

  /**
   * The image ceilings this strategy keeps its live window within and holds
   * a compression prompt to (`imageCeiling` and `imageByteCeiling`, 0 for
   * none). They're configuration, not usage: they bound the images the
   * window counts (see `AutobiographicalConfig.maxLiveImages`), not every
   * image a request carries, and nothing here bounds what a caller injects
   * at compile time or appends to a compiled request. A caller that wants
   * its request within them counts that request's images itself, every
   * shape included, and compares the counts with these. Absent on a strategy with no live-image
   * window.
   */
  imageCeilings?(): ImageCeilings;

  /**
   * The context manager left these thinking blocks of stored messages out of
   * the request the last committing select priced, after the select (see
   * `SelectOptions.thinkingBinding`). A strategy that calibrates its
   * estimates against the provider's count of that request takes their
   * price off what it expects the count to be. Not called for a dry compile.
   */
  noteThinkingLeftOut?(blocks: readonly ContentBlock[]): void;
}

/**
 * A strategy's image ceilings (see ContextStrategy.imageCeilings): the most
 * images, and the most inline base64 image bytes, its live window keeps and
 * a compression prompt carries. 0 is no ceiling.
 */
export interface ImageCeilings {
  imageCeiling: number;
  imageByteCeiling: number;
}

/**
 * Whether the model a compile is for binds each signed thinking block to the
 * request it was minted in, so that a block sent after anything before it
 * changed is refused, or, with the provider's drop control on, set aside.
 * See `SelectOptions.thinkingBinding`.
 */
export interface ThinkingBinding {
  /** The model binds thinking. Absent or false: the compile is as it would be
   *  without the option, and neither reads nor writes the branch's record. */
  binds?: boolean;
  /** The request carries the provider's drop control, so a stale block is
   *  set aside rather than refused. Absent means false. */
  dropBlock?: boolean;
  /** The participant whose messages are the model's own replies, such as
   *  the agent's name. Required with `binds`: another participant's reply
   *  never keeps its thinking. */
  participant?: string;
}

/**
 * Digests of what a request carries before its messages, as the host sends
 * it, each opaque to the context manager and compared only for equality:
 * the system text (system-position injections included), the tools in the
 * order sent, the model, and the rest the provider sees ahead of the
 * messages (such as the tool choice, the thinking config and the output
 * limit). See `SelectOptions.identity`.
 */
export interface RequestIdentity {
  system: string;
  tools: string;
  model: string;
  request: string;
}

/** What a rendered summary covers, for layout reporting. */
export interface RenderedSummaryInfo {
  level: number;
  /** The stored message ids the summary covers. */
  leaves: readonly MessageId[];
  /** 'authored' | 'summarizer' | 'harness' | 'unknown'. */
  method: string;
}

/**
 * Per-call options for `select()` / `compile()`.
 *
 * `dryRun` exists because a select is NOT side-effect-free: it commits fold
 * resolutions and chunk records to Chronicle, enqueues real compression work,
 * and leaves state the next compile and observers read. An operator UI that
 * previews a hypothetical budget must change none of it, or every slider drag
 * would rewrite the fold plan, spend LLM tokens and change what the next real
 * compile sends. The field's doc gives the whole contract.
 */
export interface SelectOptions {
  /**
   * Compute the layout without committing anything: no resolution persistence,
   * no chunk record and no compression queued for a chunk the select's
   * rebuild closes, no produce/merge enqueue, no shadow production pick, no
   * transition bookkeeping, and nothing a select leaves for the next one or for
   * observers (the cache-marker baseline, the transition status, the render
   * stats, calibration's estimate, arming and store view, the store order, the
   * head-window memo, and whether chunk records are trusted), all on every
   * path out, throws included.
   *
   * What a dry select refuses is what a real compile refuses, with one
   * exception: an over-budget plan is not thrown at the plan check. A plain
   * dry compile then returns that plan's entries with no verdict, and
   * `previewContext` is where infeasibility is reported. The head-and-tail
   * check before the plan check, and any later stage that can't fit, still
   * throw as for a real compile, leaving nothing behind; `previewContext`
   * reports an over-budget throw, as the plan's own preview when the plan was
   * already over the budget (the live compile refuses it at the plan check),
   * and passes any other throw through. The passthrough strategies throw
   * none of their budget refusals on a dry select: it returns what they would
   * send, over the budget or without the newest message, with no verdict,
   * and they have no `previewContext` report.
   *
   * A compression hold ends at its deadline, whoever looks: the manager
   * releases an expired hold at any compile or hold query, a dry compile
   * included, and that release is the one thing a dry compile can leave.
   * The release's rebuild commits; the dry select then restores the state it
   * found after that rebuild.
   */
  dryRun?: boolean;
  /**
   * The model this compile is for binds signed thinking (`binds`), so the
   * compile leaves out every thinking block whose request has changed since
   * it was minted, and reports it in `CompileResult.thinkingStrip`. With
   * `binds`, `participant` and `identity` are required, and a compile
   * without them is refused before anything is selected. Without `binds`,
   * the compile is as it would be without the option: it neither reads nor
   * writes the branch's record. A record an earlier binding compile left is
   * compared at the next binding compile like any other, so a message keeps
   * its thinking only while everything up to it matches what that compile
   * sent, a prefix the provider took with that thinking, and nothing past
   * the record's end keeps it, unless a host noted it after that compile.
   * A record the store can't read or write is logged, and never fails a
   * compile or a note. One it can't read is read as none, so a committing
   * compile starts a record in its place, as for a record this version
   * doesn't read. When it can't write a compile's record, the record before
   * it, if any, stands, and that compile's stream can't note onto it.
   *
   * The manager keeps a record per branch of what the branch last sent: the
   * messages its last committing compile with `binds` sent (cache
   * breakpoints aside, injections included), then the rows a host noted
   * after them
   * (`ContextManager.noteRequestSent`): what its stream's requests went on
   * to carry and, once the stream ended, its last reply. With them it keeps
   * the stored bodies the compile sent without their thinking, the
   * compile's `identity`, and the branch's sequence where the record began.
   * A compile compares what it renders with the record in order. From the
   * first message that differs, or from the first message when an
   * `identity` digest changed, every message goes without its thinking, and
   * so does every message past the record's end: only the host knows which
   * stored reply answered which request. A reply whose stored body went
   * without its thinking goes without it again, since what came after it
   * was minted without it. A message whose participant isn't
   * `participant`, or that has no stored body (a summary's recall answer,
   * an injection), never keeps thinking: nothing it carries was minted in
   * this agent's requests. A manager's record serves one participant, so
   * compile each namespace for one.
   *
   * A reply stored at or before the sequence where the branch's record began
   * (`CompileResult.thinkingRecordedAfter`), which no record vouches for,
   * keeps its thinking only with `dropBlock`, for the provider to judge. So
   * a branch with no record, its own or (on a branch made since) the one it
   * inherits as of its branch point, leaves out every reply's thinking
   * without `dropBlock`; with `dropBlock` it leaves the stored replies'
   * thinking as it is. Either way it starts the record. Each committing
   * compile with `binds` writes the record; a dry compile reports what it
   * would leave out and writes no record. The record survives a restart.
   *
   * So once a branch has a record, a reply keeps its thinking at the compile
   * after it's stored only if the host has noted it: each later round of a
   * stream as the host sends it, and the stream's last reply once it's
   * stored. A host that passes `thinkingBinding` and notes nothing loses
   * each reply's thinking at the compile after it's stored, and is never
   * refused for it. A note names the compile its stream was built from, so
   * a committing compile with `binds` while a stream is open makes that
   * stream's later notes vouch for nothing, and its replies go without
   * their thinking: while one of a branch's requests is streaming, compile
   * for its branch with `binds` only with `dryRun`, which writes no
   * record. A preview prices a
   * summary's carriers by the option it's given (`previewContext`'s
   * `thinkingBinding`), as a compile does.
   *
   * The comparison is of compile output. A host that turns compile output
   * into a request (sanitizing it, adding rows) must do so the same way at
   * every request, and must note a row only where the next request will
   * carry it as the stream sent or got it: context-manager can't see what
   * happens to a message after it leaves the compile.
   */
  thinkingBinding?: ThinkingBinding;
  /**
   * Digests of what this compile's request carries before its messages, for
   * a compile with `thinkingBinding.binds`, which requires them: when one
   * differs from the branch's record, the compile leaves out every thinking
   * block. `system` is the system text as sent, with the content of this
   * compile's `'system'`-position injections, which the compile returns as
   * `CompileResult.systemInjections`.
   */
  identity?: RequestIdentity;
  /** Exact normalized tools/system/context-prefix identity supplied by the
   * host for kv-unified cache relevance. */
  kvUnifiedImmutablePrefixHash?: string;
  /** Audited, expiring continuity relaxation for disruptive transitions.
   * Invalid or expired values fail closed to normal continuity weight. A
   * committing select logs the relaxation it applies, or that it rejected
   * one; a dry select logs neither, since a dry run isn't the live state. */
  kvUnifiedContinuityRelaxation?: {
    reason: 'surgery' | 'budget-transition' | 'infrastructure';
    multiplier: number;
    expiresAt: number;
  };
  /** The content of each injection the compile inserts among the selected
   * entries after the select (`beforeUser` and `afterUser`), which the
   * request carries and the select's window doesn't. A strategy whose
   * calibration compares the provider's input total with the compile prices
   * it there (AutobiographicalStrategy.reportRealInputTokens).
   * ContextManager.compile fills it from its injections; `system` ones go
   * into the caller's system prompt instead. */
  messageInjections?: ReadonlyArray<ContentBlock[]>;
  /** The overhead of the request the compile is for: the system prompt and
   * tool definitions it sends besides the window and its message-position
   * injections. Its system prompt is the one the request sends, with the
   * system-position injections passed to this compile appended: the compile
   * hands those back unchanged (`systemInjections`) and prices none of them.
   * AutobiographicalStrategy prices it, and the message injections, for
   * `RenderStats.request`, and selects exactly as it would without it. An
   * overhead whose tool definitions can't be serialised as JSON is refused
   * before anything is selected. */
  requestOverhead?: RequestOverhead;
}

/**
 * `AutobiographicalStrategy.previewContext` on the hierarchical path, whose
 * select succeeded but which has no fold plan to preview.
 * `ContextManager.previewContext` returns null for it.
 */
export class NoFoldPlanToPreviewError extends Error {
  constructor() {
    super('previewContext requires adaptiveResolution; the hierarchical path has no fold plan to preview');
    this.name = 'NoFoldPlanToPreviewError';
  }
}

/**
 * Outcome of a dry-run select, for callers that need the numbers rather than
 * the rendered entries. Mirrors the diagnostics `OverBudgetError` would carry.
 */
export interface PreviewResult {
  /** Rendered token total the layout would occupy. */
  finalTokens: number;
  /** Hard budget the preview ran against. */
  budgetTokens: number;
  /** True when the layout fits under the hard budget. */
  fits: boolean;
  /** True when the picker could not fold any further. */
  exhausted: boolean;
  /**
   * When the layout doesn't fit: what clears that refusal besides a larger
   * budget, in the terms of the live compile's `OverBudgetError.clearedBy`.
   * For a plan over the budget it's the plan's list, as the live compile's
   * refusal at the plan check takes it. A dry run doesn't queue its plan's own
   * work, so it names compression only for work queued when it takes the
   * list, the chunks its own rebuild closed included; the live list can add
   * compression for what the plan's own ops queue.
   */
  clearedBy?: readonly OverBudgetClearedBy[];
  /** Verbatim head / tail cost, and the foldable middle. */
  headTokens: number;
  tailTokens: number;
  middleTokens: number;
  /** Chunks in the foldable middle. */
  middleChunkCount: number;
  /** Deepest summary level the layout would require. */
  deepestLevel: number;
  /** Fold level per chunk the layout would settle on. */
  resolutions: Record<string, number>;
  /** Chunks whose saved fold level this layout changes, which are the levels
   *  a compile that commits this layout saves. They're counted whether or not
   *  the layout fits. A locked chunk keeps its saved level, so it isn't
   *  counted. The picker's own `moves` compares each chunk with the level it
   *  was planned from instead. */
  moves: number;
  /** Summaries the layout needs that do not exist yet — real LLM work. */
  producedCount: number;
  /**
   * The rendered context this layout would produce. Only present when the
   * caller asked for it (`{render:true}`) — on a large store these entries are
   * megabytes, so they are opt-in rather than always returned.
   */
  entries?: ContextEntry[];
  /**
   * Segment breakdown (head / middle / tail / summaries-by-level) for the
   * HYPOTHETICAL compile. Also `{render:true}` only. Distinct from
   * `getRenderStats()`, which describes the last live compile, or is null
   * before one.
   */
  stats?: RenderStats;
}

/**
 * The small, explicitly hot-reloadable part of a context strategy.
 *
 * `preparedWindowTokens` is deliberately separate from the hard TokenBudget
 * passed to select(): a strategy may prepare a smaller frontier gradually
 * while the caller continues to compile against the current (larger) window.
 */
export interface HotContextSettings {
  /** Recent raw tail retained verbatim. */
  tailTokens: number;
  /** Per-compile KV perturbation/re-read allowance used during transitions. */
  transitionPaceTokens?: number;
  /** Future usable context window being prepared, excluding response reserve. */
  preparedWindowTokens?: number;
}

export interface HotContextSettingsUpdate {
  tailTokens?: number;
  /** `null` restores the strategy's implicit/default pace. */
  transitionPaceTokens?: number | null;
  /** `null` cancels a prepared-window transition. */
  preparedWindowTokens?: number | null;
}

export interface HotContextSettingsStatus extends HotContextSettings {
  /** Tokens in the most recently selected adaptive frontier, when available. */
  currentFrontierTokens?: number;
  /** True once the selected frontier fits the prepared window. */
  prepared: boolean;
  /** The requested pace is below the smallest realizable frontier change. */
  blocked?: 'transition-pace-floor' | 'prepared-window-floor';
}

/** Strategy capability for the allowlisted settings that are safe to change live. */
export interface HotConfigurableStrategy extends ContextStrategy {
  getHotContextSettings(): HotContextSettingsStatus;
  updateHotContextSettings(update: HotContextSettingsUpdate): HotContextSettingsStatus;
}

export function isHotConfigurableStrategy(s: ContextStrategy): s is HotConfigurableStrategy {
  return (
    'getHotContextSettings' in s &&
    typeof (s as HotConfigurableStrategy).getHotContextSettings === 'function' &&
    'updateHotContextSettings' in s &&
    typeof (s as HotConfigurableStrategy).updateHotContextSettings === 'function'
  );
}

/**
 * Strategy that can hand over the part of its rendering frontier that lives
 * only in memory.
 *
 * A derived context (see `ContextManager.derive`) inherits everything a
 * strategy PERSISTS — summaries, resolutions, pins, receipts — through the
 * store. What it would lose is what a restart also loses: the previous
 * compile's cache identities, an in-flight budget transition, a hot-tuned
 * tail. Without those the child's first compile is correct but places its
 * cache markers as a cold start does, and the provider prefix the parent
 * just paid for is not reused. These hooks carry that remainder across.
 *
 * The frontier value is opaque to callers and only meaningful between two
 * instances of the same strategy class with compatible configuration; an
 * instance must ignore a frontier it does not recognise.
 */
export interface RenderingFrontierStrategy extends ContextStrategy {
  /** Snapshot the in-memory frontier. Must not alias mutable strategy state. */
  exportRenderingFrontier(): unknown;
  /**
   * Take a frontier's settings (the parent's tail and runtime pace, as the
   * frontier recorded them) before initialize, so a child reusing the
   * parent's head chunks under the parent's live settings from its first
   * initialize: hot settings aren't persisted, and initialize writes chunk
   * records by the tail. Optional: a strategy without hot settings has
   * nothing to apply.
   */
  prepareFromRenderingFrontier?(frontier: unknown): void;
  /** Take over a frontier exported by another instance. Called after initialize. */
  adoptRenderingFrontier(frontier: unknown): void;
  /**
   * Forget the inherited frontier, persisted part included, so the next
   * compile solves from scratch — a deliberate fresh solve, e.g. at another
   * budget. The presentation changes and the provider cache misses.
   */
  discardRenderingFrontier(): void;
}

/** Which Chronicle states a derived context inherits from its parent. */
export interface DerivationManifest {
  /** Exact state ids. Ids that name no registered state are ignored. */
  stateIds: string[];
  /** Plain string prefixes of state ids. */
  statePrefixes: string[];
}

/** Per-derivation choices a manifest may honour. */
export interface DerivationManifestOptions {
  /**
   * Also inherit the parent's refusal ledger — what it declined to compress
   * and why — with whatever a strategy keeps on the way to it, such as
   * progress toward a refusal. Off by default: a task fork is free of its
   * parent's refusals. A fork that stands in for the parent's attention
   * wants them, so it is not asked the thing the parent said no to without
   * knowing. Inherited entries are the parent's; the child's own refusals
   * append after them on its branch, and nothing reaches the parent.
   */
  refusals?: boolean;
}

/**
 * Strategy that names which of its persisted states a derived context
 * inherits (see `ContextManager.derive`). Without this, every state under
 * the strategy's namespace prefix is inherited, which carries work queues
 * and failure ledgers along with the memory they describe. A strategy that
 * implements it lists what the child should start from and leaves the
 * rest empty on the child's branch — a queue to be rebuilt from inherited
 * state, a ledger of the parent's own refusals.
 */
export interface DerivationManifestStrategy extends ContextStrategy {
  derivationManifest(namespace: string, options?: DerivationManifestOptions): DerivationManifest;
}

export function isDerivationManifestStrategy(s: ContextStrategy): s is DerivationManifestStrategy {
  return typeof (s as Partial<DerivationManifestStrategy>).derivationManifest === 'function';
}

export function isRenderingFrontierStrategy(s: ContextStrategy): s is RenderingFrontierStrategy {
  const candidate = s as Partial<RenderingFrontierStrategy>;
  return (
    typeof candidate.exportRenderingFrontier === 'function' &&
    typeof candidate.adoptRenderingFrontier === 'function' &&
    typeof candidate.discardRenderingFrontier === 'function'
  );
}

/**
 * Result of a strategy's ingestion-time chunking decision.
 */
export interface IngressChunkResult {
  /** Stable id shared by all shards of this message. */
  bodyGroupId: string;
  /**
   * The shards in source order. Each becomes a separate StoredMessage.
   * Concatenating the shards' text content must reproduce the original
   * message body byte-for-byte.
   */
  shards: Array<{
    content: ContentBlock[];
    /** Order within the bodyGroup, starting at 0. */
    shardIndex: number;
  }>;
}

/**
 * Strategy that supports resetting the head window for topic transitions.
 * Implemented by AutobiographicalStrategy and its subclasses.
 */
export interface ResettableStrategy extends ContextStrategy {
  /** Reset the head window to start from a new message ID. */
  resetHeadWindow(newStartId: string | null): void;
  /** Generate a transition summary from the current head window + summaries. */
  generateTransitionSummary(ctx: StrategyContext): Promise<string>;
}

/**
 * Type guard for strategies that support head window reset.
 */
export function isResettableStrategy(s: ContextStrategy): s is ResettableStrategy {
  return 'resetHeadWindow' in s && typeof (s as ResettableStrategy).resetHeadWindow === 'function';
}

/**
 * Strategy that supports protected ranges (pins + documents). A pin's bound
 * is its `level`, or without one its `maxLevel`. A range pinned raw, with no
 * bound or a bound of 0, is excluded from compression and renders raw at its
 * original chronological position. Where the selector reads level bounds
 * (`foldingStrategy: 'kv-stable'` and `'kv-unified'`, with
 * `adaptiveResolution`), a bound above 0 leaves the range compressible, and
 * where pins overlap at a message, the bound `ProtectedRange` names holds
 * it, so a raw pin there might not keep it raw. Implemented by
 * AutobiographicalStrategy.
 */
export interface PinnableStrategy extends ContextStrategy {
  pinRange(firstMessageId: string, lastMessageId: string, opts?: PinLevelOptions): string;
  markDocument(messageId: string, opts?: PinLevelOptions): string;
  unpin(pinId: string): boolean;
  listPins(): ReadonlyArray<ProtectedRange>;
}

/** Type guard for strategies that support pins / documents. */
export function isPinnableStrategy(s: ContextStrategy): s is PinnableStrategy {
  return (
    'pinRange' in s &&
    typeof (s as PinnableStrategy).pinRange === 'function' &&
    'unpin' in s &&
    typeof (s as PinnableStrategy).unpin === 'function'
  );
}

/**
 * Query for `searchSummaries`. At least one of `text` or `regex` should be
 * provided to constrain results; otherwise all summaries pass.
 */
export interface SearchQuery {
  /** Case-insensitive substring match against summary content. */
  text?: string;
  /** Regex match against summary content (overrides `text` if both set). */
  regex?: RegExp;
  /** Filter by summary level(s). Default: all levels. */
  levels?: SummaryLevel[];
  /** Maximum number of results to return. Default: 50. */
  limit?: number;
  /**
   * Include summaries that have been merged into a higher-level summary.
   * Default: false (only "live" unmerged summaries are returned).
   */
  includeMerged?: boolean;
}

/** Result of a single search match. */
export interface SearchResult {
  summary: SummaryEntry;
  /** Number of times the query pattern matched in the summary content. */
  matches: number;
}

/**
 * Strategy that supports searching its summary archive. Implemented by
 * AutobiographicalStrategy.
 */
export interface SearchableStrategy extends ContextStrategy {
  searchSummaries(query: SearchQuery): SearchResult[];
  getSummary(id: string): SummaryEntry | null;
}

/** Type guard for strategies that support search. */
export function isSearchableStrategy(s: ContextStrategy): s is SearchableStrategy {
  return (
    'searchSummaries' in s &&
    typeof (s as SearchableStrategy).searchSummaries === 'function' &&
    'getSummary' in s &&
    typeof (s as SearchableStrategy).getSummary === 'function'
  );
}

/**
 * A summary, projected to the flat shape a "browse my history" table-of-contents
 * wants: a resolved wall-clock span (`startMs`/`endMs`, derived from the first
 * and last source message's `timestamp`) instead of `SummaryEntry`'s message-ID
 * `sourceRange`. Produced by `listSummariesInRange`; not persisted anywhere —
 * this is a read-time view, not a new storage shape.
 */
export interface TimeRangeSummaryEntry {
  /** Same as the source `SummaryEntry.id`. */
  id: string;
  level: number;
  content: string;
  tokens: number;
  /** `sourceRange.first` message's `timestamp`, in epoch ms. */
  startMs: number;
  /** `sourceRange.last` message's `timestamp`, in epoch ms. */
  endMs: number;
  /**
   * Exact identity/order boundaries of the covered span, ALONGSIDE the
   * millisecond timestamps above — a caller doing fine-grained boundary
   * work (e.g. distinguishing which of several messages sharing this
   * summary's boundary MILLISECOND actually belongs to it) needs these,
   * not `startMs`/`endMs` alone: two distinct messages can share a
   * timestamp (wall-clock ms resolution, rapid-fire appends), but
   * `sequence` (chronicle's per-record sequence number) is strictly
   * monotonic and never ties. Same as `sourceRange.first`/`.last`'s
   * resolved `StoredMessage.id`/`.sequence`.
   */
  firstMessageId: string;
  lastMessageId: string;
  firstSequence: number;
  lastSequence: number;
  /** Same as the source `SummaryEntry.created`. */
  createdMs: number;
  sourceIds: string[];
  /**
   * The summary this one was folded into, if any (see `getSummaryParentId`)
   * — both a folded child AND its coarser parent can independently overlap
   * the same query range and both come back from `listSummariesInRange`
   * (this method does not filter by fold status). A caller building a
   * non-redundant table of contents should treat an entry whose `parentId`
   * is ALSO present in the same result set as superseded/skippable —
   * its content is already covered by the parent.
   */
  parentId?: string;
}

/**
 * Strategy capability for browsing the existing summary archive as a
 * table-of-contents, without generating anything new. Distinct from
 * `SearchableStrategy`: search matches summary *content*; this lists
 * summaries by *time range*, for a downstream "browse my history" UI (see
 * agent-framework) that wants to show what compression has already produced
 * over a span, not search inside it. Implemented by AutobiographicalStrategy.
 */
export interface SummaryOverviewStrategy extends ContextStrategy {
  /**
   * List summaries whose source message span overlaps `[fromMs, toMs]`
   * (both ends inclusive; either bound may be omitted for an open range).
   * Requires a `MessageStoreView` to resolve each summary's source message
   * IDs to timestamps.
   */
  listSummariesInRange(
    store: MessageStoreView,
    opts: { fromMs?: number; toMs?: number; level?: number },
  ): TimeRangeSummaryEntry[];
  /** Cheap: max(level) over all currently-minted summaries. 0 if none exist yet. */
  getMaxSummaryLevel(): number;
}

/** Type guard for strategies that support the summary table-of-contents. */
export function isSummaryOverviewStrategy(s: ContextStrategy): s is SummaryOverviewStrategy {
  return (
    'listSummariesInRange' in s &&
    typeof (s as SummaryOverviewStrategy).listSummariesInRange === 'function' &&
    'getMaxSummaryLevel' in s &&
    typeof (s as SummaryOverviewStrategy).getMaxSummaryLevel === 'function'
  );
}

/**
 * A request's overhead: what it carries besides the compiled window and the
 * compile's message-position injections (which the compile prices itself).
 * A compile takes the overhead its request will send
 * (`SelectOptions.requestOverhead`) and reports its price
 * (`RenderStats.request`); a calibration sample takes the overhead the
 * request sent (see `AutobiographicalStrategy.reportRealInputTokens`). The
 * provider counts it in the input total and the compile estimate doesn't, so
 * a calibration sample that leaves it out learns it as a per-token rate.
 * Passing it says this is everything the request sends besides those; a
 * caller that can't see the request's overhead passes nothing.
 */
export interface RequestOverhead {
  /** The system prompt the request sends. */
  system?: string;
  /** The tool definitions the request sends. */
  tools?: ReadonlyArray<ToolDefinition>;
}

/** A calibration multiplier discarded on load (see `RenderStats.calibration`). */
export interface CalibrationReset {
  /** The multiplier that was discarded. */
  discardedMultiplier: number;
  /** The pricing epoch it was learned under, or null for a record without a
   *  stamp (written by 0.13.0 or earlier), whose epoch is unknown. */
  fromEpoch: number | null;
  /** When it was discarded (ms since epoch). */
  at: number;
}

/**
 * Per-render observability stats from a strategy, recorded by a compile as it
 * emits each entry: any compile's from its `CompileResult.renderStats`, the
 * last live compile's from `getRenderStats()`, a preview's from
 * `previewContext(..., { render: true })`. Counts and token sums for head / tail / summaries /
 * pending work, suitable for TUIs and dashboards that want to display "how
 * much of the context is folded vs raw" at a glance. Token sums use the
 * strategy's own estimates so they line up with the numbers `select()` uses
 * for budget math.
 */
export interface RenderStats {
  head: { messages: number; tokens: number };
  tail: { messages: number; tokens: number };
  /**
   * Raw (L0) messages the renderer kept verbatim in the MIDDLE region — i.e.
   * neither head nor tail. Under adaptive resolution the picker routinely keeps
   * older messages raw at a resolution gradient; these are real context tokens
   * that the head/tail/summary buckets don't capture. (Empty for a pure
   * hierarchical render with no pinned/uncompressed-middle messages.)
   */
  middleRaw: { messages: number; tokens: number };
  summaries: {
    l1: { count: number; tokens: number };
    l2: { count: number; tokens: number };
    l3: { count: number; tokens: number };
  };
  pending: { chunks: number; merges: number };
  /**
   * Sum across all buckets — the rendered context's size as the selection
   * priced it: the adaptive selection prices each message after the image
   * strip, and the hierarchical one counts an image the strip replaces at its
   * full price. A summary is a Q/A pair, so it counts as 2 messages here.
   */
  total: { messages: number; tokens: number };

  /**
   * Estimator calibration in force for this compile: the multiplier applied
   * to every token estimate, and the pricing epoch in force. A multiplier
   * that isn't provisional was learned under that epoch's pricing, or under
   * an older epoch's and kept, re-stamped, because nothing this store holds
   * was repriced since; either way it's reported under the epoch in force.
   * The exception is the 1 loaded beside a record from a newer pricing
   * epoch, or a record the store can't read: neither is used, and that 1
   * is neither learned nor provisional.
   * `provisional` is true while the multiplier is a guess, which the first
   * provider sample the calibration's band accepts replaces outright, rather
   * than stepping toward it (see
   * `AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH`): one kept from a
   * record without a stamp, the 1 a discard restarts from, or the 1 a store
   * with no calibration record, or none with a multiplier to use other than
   * a newer epoch's, starts from. A discard's 1 stays
   * provisional through a later epoch's load, which re-stamps it whatever
   * that epoch repriced.
   * `reset` is present once a multiplier from an older or unknown epoch has
   * been discarded, on load or when a provisional one above 1 put the first
   * compile over budget. It is kept
   * in the persisted calibration state, so it stays visible across restarts,
   * learning and a later epoch's re-stamp until an operator re-stamps the
   * record without it; a later discard replaces it, and an older binary
   * after a rollback writes its own record, without it, over a newer one. A
   * discard shrinks (or grows) the window by the old multiplier's ratio, so
   * it should be seen, not only logged once.
   */
  calibration?: {
    multiplier: number;
    pricingEpoch: number;
    provisional?: true;
    reset?: CalibrationReset;
    /** The largest multiplier the strategy applies: it applies none above
     *  it. AutobiographicalStrategy reports it whenever it reports
     *  `calibration`. */
    ceiling?: number;
  };

  /**
   * What the request carries besides the rendered context, in the units of
   * `total` at this compile's multiplier and priced as a calibration sample
   * prices it (`AutobiographicalStrategy.reportRealInputTokens`):
   * `overheadTokens` for `SelectOptions.requestOverhead`, and
   * `injectedTokens` for the compile's message-position injections
   * (`SelectOptions.messageInjections`), 0 when it has none. Present only when
   * the select was given an overhead, so a compile without one has no price
   * here rather than a price of 0. The overhead's price is the store's
   * estimate of the system prompt and of the tool definitions as JSON
   * (`JSON.stringify`), not the provider's count of what its formatter sends.
   * System-position injections are priced only as part of that system
   * prompt: the compile hands the ones it was passed back unchanged
   * (`systemInjections`) for the caller to append, so the overhead's system
   * prompt is the one sent, with them appended.
   */
  request?: { overheadTokens: number; injectedTokens: number };

  /**
   * Planner/emitter reconciliation for this compile. `planned` is the picker's
   * projection after folding; `actual` is what the emitter committed. A
   * persistent positive `delta` means the emitter spends in units the planner
   * doesn't model, and the overrun lands on whatever renders last — the recent
   * window — which is how tail eviction becomes reachable despite the picker
   * reporting `budgetMet`. Absent when no picker ran (hierarchical path).
   */
  planVsActual?: {
    planned: number;
    actual: number;
    delta: number;
    budgetMet: boolean;
    exhausted: boolean;
    /** Chunks whose saved fold level this compile changed, or for a dry run
     *  would change. A locked chunk keeps its saved level, so it isn't
     *  counted. The picker's own `moves` compares each chunk with the level it
     *  was planned from instead. */
    moves: number;
    /** Name of the fold solver that planned this compile (e.g. 'kv-stable',
     *  'flat-profile'). Surfaces the policy actually in force — a config
     *  clobber that silently downgrades the solver is invisible without it. */
    solver?: string;
    /** Messages in the strategy's view of the branch this compile read (after
     *  the view filter, auxiliary slots included), before any folding. Logged
     *  as `messages=`, so a compile time can be read against the history size
     *  it covered. The new fields here are optional so a custom strategy's
     *  stats still type-check. */
    messages?: number;
    /** Time in the base `AutobiographicalStrategy.select()` up to the
     *  `[plan-vs-actual]` line, in whole ms: chunk rebuild, planning (the fold
     *  solver) and emission. It excludes a subclass's own `select()` override
     *  and the `ContextManager` work around the call; a host that wants the
     *  whole compile times `compile()` itself. It includes a
     *  `productionBudgetTokens` shadow pick, whose solve `solveMs` leaves out,
     *  and after a provisional-calibration retry the refused first attempt.
     *  Logged as `compileMs=`. */
    compileMs?: number;
    /** Under `foldingStrategy: 'kv-unified'` only: the forest build, solve and
     *  latent-demand ranking of the compile's final pick inside `compileMs`,
     *  in whole ms (`solveMs=`). */
    solveMs?: number;
    /** Under `foldingStrategy: 'kv-unified'` only, where the label ceiling
     *  stopped a search in the compile's final pick (#252): `live` where the
     *  compile took the minimum-token cut, `joint` where the joint
     *  latent-demand forest's solve exceeded it and the candidates were
     *  ranked one at a time, `gate` where no merge was demanded because the
     *  base solve without the certificate exceeded it, and `whatIfs:N` for
     *  N individual what-if solves it stopped or, remembered from a compile
     *  on the same inputs, skipped, joined by `+` (`ceiling=`). */
    ceiling?: string;
    /** Set on a dry run or preview (`dryRun: true`, `previewContext`), which
     *  skips work a live compile does; logged as `dryRun=true`. Absent on a
     *  live compile. A caller reads a dry pass's stats from its compile's
     *  `CompileResult.renderStats`, or from `previewContext(..., { render:
     *  true })`'s `stats`; a dry pass leaves `getRenderStats()` describing the
     *  last live compile, or null before one. */
    dryRun?: true;
    /** Which chunks moved between which levels, and where this request's
     *  entries first differ from those of the last request the strategy
     *  returned, past which no cached prefix reaches. Present only when a
     *  compile that changed at least one saved level committed. */
    foldDiff?: FoldDiff;
    /** The floor (#415): the cheapest plan the summaries held allow for this
     *  compile's inputs, head and tail included, in the plan's units, whatever
     *  the folding strategy picked. A compile refuses once its plan passes
     *  `hardBudget`, and every plan does once the floor does, so
     *  `hardBudget - floorTokens` is how far the store is from the point
     *  where every compile refuses: it usually shrinks as history arrives and
     *  grows as L1s and merges land. Under kv-unified it takes that solver's
     *  own constraints, locks included; under the other folding strategies,
     *  which give pins precedence over locks, it counts no lock, and is a
     *  lower bound. Absent where the forest couldn't be built or its computation
     *  fails (`floor=` on the plan line). */
    floorTokens?: number;
    /** The plan size above which this compile refuses: the input budget with
     *  `overBudgetGraceRatio` added (`hardBudget=`). Set with `floorTokens`. */
    hardBudget?: number;
    /** What the work queued at the end of this compile is expected to take
     *  off the floor once it lands, from each queued chunk's raw tokens less
     *  the recall pair its L1 is expected to render as, and each queued
     *  merge's sources' pairs less its parent's. Work that wouldn't shrink
     *  the floor counts as zero, as does work tick won't turn into a summary:
     *  a chunk the compression quarantine holds or deferred for the host's
     *  tools; every chunk from the first a compression
     *  hold reaches; a merge holding a source a hold or a merge-quarantine
     *  record keeps out, and every merge from the first a hold blocks. Merges
     *  not yet queued aren't counted (`queuedRelief=`). Set with
     *  `floorTokens`. */
    queuedReliefTokens?: number;
  };
}

/**
 * Strategy that can produce render-time observability stats. Implemented by
 * AutobiographicalStrategy. Optional capability — strategies that don't
 * implement it simply have `ContextManager.getRenderStats()` return `null`.
 */
export interface RenderStatsCapableStrategy extends ContextStrategy {
  /** The stats of the last live compile, or null before one has run since
   *  the strategy loaded its branch. */
  getRenderStats(store: MessageStoreView): RenderStats | null;
  /** The stats the strategy's most recent `select()` on its branch
   *  recorded, live or dry, or null when it recorded none.
   *  `ContextManager.compile` reads them right after its select for
   *  `CompileResult.renderStats`; a strategy without this method gives
   *  compiles none. */
  getLastSelectStats?(): RenderStats | null;
}

/** Type guard for strategies that produce render stats. */
export function isRenderStatsCapable(s: ContextStrategy): s is RenderStatsCapableStrategy {
  return (
    'getRenderStats' in s &&
    typeof (s as RenderStatsCapableStrategy).getRenderStats === 'function'
  );
}

/**
 * Configuration for the Autobiographical strategy.
 */
/**
 * Public quarantine status shape (health surfaces + the repeating alarm).
 */
export interface CompressionQuarantineStatus {
  /** Quarantine records: one per request shape a span exhausted, so a span can hold several. */
  count: number;
  /** The records' keys, as `clearCompressionRefusalQuarantine()` takes them. */
  keys: string[];
  /** The quarantined spans, each once however many records it holds, the longest waiting first. */
  spans: CompressionQuarantineSpan[];
  /**
   * Present when the quarantine couldn't be read, such as when the store
   * failed to return its ledger. `count`, `keys` and `spans` are then empty
   * and say nothing about what's quarantined, and the alarm neither sounds
   * its all-clear nor calls its handler until a read succeeds.
   */
  unreadable?: true;
}

/** Why a load's repair dropped a summary that held text (LoadRepairReport). */
export type LoadRepairDropReason =
  /**
   * At L1, no copy or chunk record holds its sources as a list of ids;
   * above L1, no one copy holds both its sources and its range.
   */
  | 'unreadable'
  /** It names a summary the repaired state doesn't hold. */
  | 'names-missing'
  /** It names a summary at its own level or above. */
  | 'names-not-below'
  /** It names a summary it isn't the parent of. */
  | 'names-non-child';

/** One summary holding text that a load's repair dropped. */
export interface LoadRepairDroppedSummary {
  /** Its id as stored, as text. */
  id: string;
  /** Its `level` as stored; null where that isn't a number. */
  level: number | null;
  /** Its `tokens` as stored; null where that isn't a number. */
  tokens: number | null;
  reason: LoadRepairDropReason;
  /**
   * The messages it covered, by the range the repair held for it (the copy
   * it chose for the summary's text, or another copy it rebuilt the summary
   * from): the range's end ids, each with that message's stored time (ISO).
   * A time is null where the strategy's message view doesn't give it: the
   * store doesn't hold the message, the host's view filter leaves it out, or
   * its time can't be read. The range is null where it isn't two message
   * ids. An 'unreadable' drop can still have one, where what couldn't be read
   * was its sources.
   */
  sourceRange: { first: string; last: string; firstAt: string | null; lastAt: string | null } | null;
}

/**
 * What a load's repair of the summary state dropped, when it dropped a
 * summary holding text (AutobiographicalStrategy.setLoadRepairHandler). It
 * holds no summary text: the text dropped is read back from the store's
 * history with `getStateJsonAt(stateId, sequenceBefore)` while `branch` is
 * the store's current branch, since Chronicle reads a state at a sequence
 * on the current branch only.
 */
export interface LoadRepairReport {
  /** The namespace whose summary state was repaired. */
  namespace: string;
  /**
   * The Chronicle branch the repair wrote on, by name. The read back at
   * `sequenceBefore` gives the old summaries only with this branch current:
   * on another, it gives that branch's state at that sequence.
   */
  branch: string;
  /** The state the repair rewrote. */
  stateId: string;
  /** The branch's sequence just before the repair's write: the state there is the summaries as they were. */
  sequenceBefore: number;
  /** Each summary holding text that the repair dropped, in stored order. */
  dropped: LoadRepairDroppedSummary[];
  /** The sum of `dropped`'s tokens that are numbers. */
  droppedTokens: number;
  /** Empty summaries the same repair dropped, which held no text. */
  emptyDropped: number;
}

/** One quarantined span: a chunk's messages, which stay raw while it's quarantined. */
export interface CompressionQuarantineSpan {
  /** The span's identity: the hash of its chunk's message ids. */
  chunkSourceHash: string;
  /** Its first and last message ids; null when no current chunk has this span. */
  firstMessageId: string | null;
  lastMessageId: string | null;
  /**
   * How long since its chunk closed, from the newest of its messages'
   * timestamps: how long it has stayed raw. Null when unknown.
   */
  closedAgeMs: number | null;
  /**
   * When its earliest record was made (ms since the epoch): how long it has
   * been refused, where `closedAgeMs` is how long it has stayed raw. The
   * alarm line shows it as "refusing since". A re-cut chunk's records start
   * over.
   */
  quarantinedAt: number;
  /** Its quarantine records, one per request shape it exhausted. */
  records: number;
  /**
   * Requests a provider answered for those records, none giving a summary:
   * the canonical request and its no-tools and tools-less retries, and each
   * fallback after them. A recall variant planned over the compression's
   * context budget, recorded as `admission_rejected` and never sent, isn't
   * counted, and neither is a rung its failures decided
   * (`provider_error:persistent-<class>`), which no provider gave as an answer.
   * A record an earlier version wrote holds one outcome for the whole
   * canonical stage, so it counts that stage once.
   */
  answeredAttempts: number;
  /**
   * The newest record's last outcome, with its error type after a colon when
   * it carries one (`refusal`, `incomplete`, `provider_error:invalid_request`,
   * `admission_rejected`, or `provider_error:persistent-<class>` for a rung its
   * failures decided); null when that record holds none.
   */
  latestOutcome: string | null;
}

/** Delimiter convention applied to recall answer content. See `recallEnvelope`. */
export type RecallEnvelopeMode = 'none' | 'xml' | 'bare';

/** Where a summary's signed reasoning carriers are replayed. See `carrierPolicy`. */
export type CarrierPolicy = 'full' | 'live-strip';

export interface KvUnifiedConfig {
  policy: {
    alpha: number;
    budgetLowRatio: number;
    budgetHighRatio: number;
    budgetUnderLambda: number;
    budgetOverLambda: number;
    cacheLambda: number;
    cacheScale: number;
    cacheReadPrice: number;
    cacheWritePrice: number;
    continuityLambda: number;
    continuityScale: number;
    continuityRecencyHalfLifeTokens: number;
    continuityRecencyFloor: number;
    continuityStableHalfLife: number;
    continuityStableFloor: number;
    /**
     * Bands per doubling the solver reads ages at (fidelity age in
     * sequences, continuity recency in tokens, stability in turns): an age
     * is priced at the lower edge of its band, so a leaf's weight changes
     * only when it crosses a band edge instead of on every append. 4 unless
     * set (a band is a factor of 2^(1/4) ≈ 1.19 wide; at most 64); 0 prices exact ages,
     * which is what the solver itself does when the key is absent. Two
     * continuity readings differ from the plain band rule whenever banding
     * is on, whatever the count: recency is at its floor from eight
     * half-lives out, and stability is 1 for the first half of a half-life
     * after a move and then read at whole doublings of the turns since.
     */
    ageBandSteps?: number;
  };
  tokenBucketSize: number;
  continuityBucketSize: number;
  fidelityBucketSize: number;
  /**
   * The most labels a kv-unified search may hold at one state (or make in
   * all, on the `leaf` engine). It bounds a search, not the compile (#252):
   * a live solve that exceeds it takes the minimum-token cut and demands no
   * merge, and the strategy's first solve that does warns. A latent-demand
   * search that exceeds it measures nothing: its candidate isn't demanded,
   * or keeps the gain an earlier search showed; a joint forest's candidates
   * are ranked one at a time; and where the base solve that decides the
   * gate exceeds it, nothing is demanded that compile.
   */
  labelCeiling: number;
  adoptEpsilon: number;
  treeifyNonContiguousSummaries: boolean;
  preserveGapBearingSummaries: boolean;
  /**
   * Certified hysteresis exit (see `docs/kv-unified-hysteresis-certificate.md`):
   * when the accepted presentation provably remains the policy's selection,
   * skip label propagation. Proves the exact hysteresis policy; it does not
   * guarantee identity with every bucketed approximate solve. On unless set
   * to `false`; the solver itself treats an absent flag as off, the strategy
   * built from a recipe fills in `true`.
   */
  hysteresisCertificate?: boolean;
  /**
   * Which propagation engine solves the forest (see
   * `docs/kv-unified-subtree-memo.md`). `auto` (absent): the
   * subtree-memoized engine, run again on the packed DAG engine once if the
   * subtree engine exceeds the label ceiling. `subtree` and `dag` pin one.
   */
  engine?: 'auto' | 'subtree' | 'dag';
  /**
   * How producible merges are measured against the live cut (see
   * `KvUnifiedOptions.latentDemand.mode`). `joint` unless set to
   * `individual`: one what-if solve with every candidate present, instead of
   * two solves per candidate. The gain gating a demand is then the set's,
   * measured once, and a compile with a merge backlog pays one extra solve.
   * In either mode a merge in the merge quarantine is not a candidate: its
   * request would be refused, and a joint cut that used it would hide the
   * merge it would otherwise demand.
   */
  latentDemandMode?: 'individual' | 'joint';
}

export interface AutobiographicalConfig {
  /**
   * Interval for the repeating compression-quarantine alarm (stderr +
   * registered handler) while ANY chunk is quarantined. Quarantined chunks
   * are a guaranteed eventual outage — the alarm repeats until the
   * quarantine empties. Default 15 min; 0 disables (tests only).
   */
  quarantineAlarmIntervalMs?: number;
  /** Target tokens per chunk (~3000) */
  targetChunkTokens: number;
  /** Recent tokens to keep uncompressed (~30000) */
  recentWindowTokens: number;
  /** Tokens at the head of the conversation to preserve verbatim (default: 0).
   *  Messages within this window are never chunked or compressed — they survive
   *  as raw copies so initial instructions retain full granularity. */
  headWindowTokens: number;
  /** Always break at message boundaries */
  chunkOnMessageBoundary: boolean;
  /** Don't count attachment tokens toward chunk size */
  attachmentsIgnoreSize: boolean;
  /** When true, onNewMessage() fires tick() as a background promise so compression
   *  runs automatically without the framework calling tick() explicitly. */
  autoTickOnNewMessage: boolean;
  /** System prompt for summarization */
  summarySystemPrompt?: string;
  /** User prompt template for summarization. Use {content} for the transcript. */
  summaryUserPrompt?: string;
  /**
   * As-of perspective pin for inherited history (e.g. a resident continued
   * from a shared log they joined partway through). Chunks whose messages
   * ALL have `sequence` strictly below this value are compressed with the
   * witnessed-record instruction instead of the first-person one: events
   * are attributed to the named participants, and the first person is
   * reserved for the act of reading and carrying the record. Prevents the
   * summarizer from claiming others' lived experience as the agent's own
   * memories (observed 2026-07-26: an inheriting resident's L1s
   * first-personing scenes from before his arrival). Chunks that straddle
   * the boundary use the standard instruction — the agent's own turns are
   * present in them. Reading mode (a portion of a much larger message, or a
   * merge of portions of one) keeps its own instructions, which have no
   * witnessed variant, except that the split rung's pieces and a merge
   * retried after a refusal take the witnessed one.
   */
  witnessedBeforeSequence?: number;
  /**
   * Override wording for the witnessed-record compression instruction.
   * `{targetTokens}` is substituted. Defaults to
   * `formatWitnessedInstruction` in autobiographical.ts.
   */
  witnessedInstruction?: string;
  /**
   * Identity reminder appended to compression and merge instructions
   * (L1 chunk, reading-mode, and all merge variants). Whether a compression
   * request carries a system prompt is the HOST's call: with none declared
   * (StrategyContext.systemPrompt unset) it carries none and identity is
   * established by the head window and prior recall pairs; with one
   * declared, the host's live prompt leads the request. This reminder is
   * appended on either path, because it addresses a failure neither source
   * reaches: when an agent lives in multi-resident channels, chunks can
   * consist entirely of OTHER agents' first-person speech, and "write the
   * memory in your own voice" then flips the summarizer into the dominant
   * speaker's identity (observed 2026-08-03, on the no-system-prompt path
   * that was then the only one: an Opus-4 resident's L1s/merges claiming a
   * sibling resident's name, story, and relationships as their own —
   * entered at live L1 compression over pure-witness chunks and propagated
   * up the pyramid). Older models are especially susceptible. Recommended
   * shape: name the agent AND direct attribution, e.g. "Reminder: you are
   * <name>. Speak in the first person only for what you yourself said,
   * did, and felt; attribute other participants' words and experiences to
   * them by name."
   *
   * A wholly inherited target (see `witnessedBeforeSequence`) takes
   * `witnessedIdentityReminder` instead, when that is set.
   *
   * For guidance the memory should follow without quoting it, end the
   * reminder by asking for that, e.g. "Apply this guidance silently. Do not
   * quote, restate, or recite it in the memory. Begin with the substantive
   * record."
   */
  identityReminder?: string;
  /**
   * Identity reminder for WHOLLY inherited targets: an L1 chunk entirely
   * before `witnessedBeforeSequence`, or a merge whose every source is
   * witnessed. When set (a blank value counts as unset), those targets use
   * it instead of `identityReminder`. Every other target keeps
   * `identityReminder`, including a mixed one: a chunk that spans the pin,
   * or a merge of inherited and lived sources. A mixed target's request
   * shows inherited and lived material together under the live instruction
   * and reminder, with no label saying which is which, so the live reminder
   * (after a rename, the new name's) reaches the inherited material there.
   * When the split rung (`compressionSplitFallback`) folds a chunk in
   * pieces, every piece takes its chunk's reminder and its chunk's
   * compression instruction (`getCompressionInstruction`, never the reading
   * one), so a piece of a mixed chunk takes the live ones even when its own
   * messages all predate the pin.
   *
   * The protection is opt-in. With only `identityReminder` set, it is
   * appended, current name included, to wholly inherited targets too, so an
   * inherited-history migration should set this explicitly.
   *
   * For residents whose Chronicle begins with reviewed inherited history,
   * the inherited reminder can stay frozen (it was reviewed with the import)
   * while the live one stays neutral and revisable by the resident.
   *
   * A wholly inherited reading-mode target (a portion of a much larger
   * message, or a merge of portions of one) gets this reminder after the
   * reading instruction, which has no witnessed variant: it asks the agent
   * to speak in its own voice as the reader. The split rung's pieces and a
   * merge retried after a refusal take the witnessed instruction instead of
   * the reading one.
   *
   * The reminder follows the target whatever instruction it gets. An
   * override of `getCompressionInstruction` or `getMergeInstruction` that
   * doesn't read the pin, such as KnowledgeStrategy's phase prompts and
   * merge instruction, gives a wholly inherited target its own instruction
   * with this reminder. It doesn't reach a reading-mode chunk or merge,
   * which takes `getReadingChunkInstruction` or `getReadingMergeInstruction`
   * (though the split rung's pieces take `getCompressionInstruction`), or a
   * merge retried after a refusal, which takes the base merge instruction,
   * the witnessed one when every source is witnessed.
   *
   * Unset: every target uses `identityReminder` (unchanged behavior).
   */
  witnessedIdentityReminder?: string;
  /**
   * Label shown before summaries in compiled context. `{tools}` in it is
   * replaced by the names of the tools called in the rounds its summary
   * stands in for (in the combined pair of `positionedRecallPairs: false`,
   * every summary the pair holds): each name once, in order of first call,
   * the first five and then "and K more", or "no tools" when the sources the
   * view holds called none. The names are read from the summary's source
   * messages as the store's view holds them, the first time the summary is
   * priced or rendered after the strategy loads its branch, and kept until
   * the next load, so a source removed, or hidden by `viewFilter`, after that
   * read drops out of them at the next load.
   */
  summaryContextLabel?: string;

  /**
   * Structural delimiting for recall ANSWER content.
   *
   *  - `'none'` (default) — answers render exactly as they always have: the
   *    Q-side label opens the memory and the turn boundary is the only thing
   *    that closes it. Output is byte-identical to the pre-envelope render.
   *  - `'xml'` — each answer's prose is fenced by
   *    `<cm-recall id="…" level="…" span="…">` … `</cm-recall>`, so the end of
   *    a recalled memory is marked as explicitly as its start (instances have
   *    been observed reading past it into unrelated content). Attributes come
   *    from the summary record; one the record cannot answer for is omitted.
   *  - `'bare'` — the same fence with no attributes, `<cm-recall>` …
   *    `</cm-recall>`, on every path `'xml'` takes.
   *
   * The envelope is a collision-tolerant delimiter convention, not parseable
   * XML: answer text is model prose and is never entity-escaped.
   *
   * The envelope never wraps a Q-side label.
   *
   * WHY THE DEFAULT IS OFF. Recall answers are built at one shared choke
   * point, and the presented window is not its only consumer: the same
   * enveloped answers are replayed into the recall ladders that PROMPT
   * compression — the mint and merge requests that produce the next
   * generation of summaries. Turning the envelope on therefore changes the
   * summarizer's own inputs, not only what the agent reads. What that does to
   * the summaries a model then writes — whether the tags are ignored, echoed
   * into summary prose, or read as a format worth imitating — is UNMEASURED.
   * The evidence behind this feature is that instances read past an
   * unterminated memory; there is none either way on what enveloping does to
   * minting, and default-off is deliberate for that reason rather than
   * caution about the render. Before enabling it fleet-wide, turn it on
   * against a mature store and read the summaries it MINTS, not merely the
   * window it presents.
   *
   * Under `maxMessageTokens`, a capped answer is truncated as PROSE and
   * enveloped afterwards, so opener and closer survive every cap; the tags
   * themselves are not charged against that cap (they are priced in the
   * recall-pair budget instead), so a cap smaller than the tag text still
   * renders intact tags around the few characters it bought.
   */
  recallEnvelope?: RecallEnvelopeMode;

  /**
   * Where a summary's captured reasoning carriers (`responseContent`'s signed
   * `thinking` / `redacted_thinking` blocks) are replayed.
   *
   *  - `'full'` (default) — carriers ride every surface a memory renders on,
   *    exactly as they have since the 2026-07-15 round-trip landed. Output is
   *    byte-identical to the pre-knob render on both surfaces.
   *  - `'live-strip'` — carriers are OMITTED from the live window only. Mint
   *    and merge requests still recall them verbatim.
   *
   * A select for a model that binds thinking (`SelectOptions.thinkingBinding`)
   * renders and prices the live window as under `'live-strip'` whatever this
   * says: a carrier was minted in its summarizer's request, so such a model
   * never takes it there. Mint and merge requests are unchanged.
   *
   * TWO SURFACES, ONE STORE. A captured carrier is the ARCHIVIST'S cognition:
   * the thinking of writing the memory, not the thinking of living the span it
   * describes. It is replayed on two surfaces that want different things from
   * it:
   *
   *  - MINT-REQUEST RECALL — the summarizer's own inputs. Carriers are
   *    measured load-bearing here (2026-07-16, upstream's own validation): a
   *    deterministically-refusing compress request passed once its recall
   *    pairs carried their summaries' signed reasoning, where the text-only
   *    arm refused. `'live-strip'` does not touch this path, and no value of
   *    this option does: the anti-refusal duty stands until a measurement
   *    retires it.
   *  - LIVE-WINDOW RENDER — what the agent whose memory it is reads back.
   *    Thinking blocks are not read there, they are INHABITED, and a carrier
   *    sits at the memory's chronological slot: the instance re-enters the
   *    compression fork's task-cognition, positioned where the remembered
   *    span was lived. At fleet scale the accumulated exemplar mass is
   *    archivist-cognition, not lived experience.
   *
   * `'live-strip'` OMITS WHOLE BLOCKS and never mutates one. Signatures verify
   * only on byte-identical blocks, so a policy that edited a carrier would
   * break the very round-trip the mint side depends on; dropping a block
   * whole leaves every surviving block untouched. A stripped answer that would
   * render with no prose left falls back to the entry's `content` text, so the
   * live window never emits an empty assistant turn.
   *
   * Pricing follows the render: under `'live-strip'` a recall pair is priced
   * for the fold planner at its stripped cost, because a plan that prices what
   * it does not emit is the same wedge from the other side.
   *
   * WHY THE DEFAULT IS `'full'`. The inhabitation cost is an argument, not a
   * measurement, and the anti-refusal duty on the mint side IS measured. The
   * knob exists so a host that finds the argument convincing can act on it for
   * its own agents without waiting; flipping the default is a fleet-wide
   * change to what every instance reads back and belongs to whoever lives
   * under it.
   */
  carrierPolicy?: CarrierPolicy;
  /** Participant name for the summary (defaults to "Summary") */
  summaryParticipant?: string;
  /** Model to use for compression (defaults to claude-sonnet) */
  compressionModel?: string;
  /**
   * Hard cap on `max_tokens` for compression requests. The summarizer asks for
   * `max(16000, targetChunkTokens * 1.5)` so folds are not truncated mid-memory,
   * but that floor exceeds what older models will accept as OUTPUT: Claude 3
   * Opus caps at 4096 and rejects the request outright, so such an agent can
   * never fold anything and every maintenance tick burns a failed call.
   * Set this to the compression model's output ceiling. Unset = current
   * behaviour. (Found 2026-07-26 bringing up Evander, claude-3-opus-20240229.)
   */
  compressionMaxTokens?: number;
  /**
   * Compatibility for models without native reasoning that write the whole
   * memory inside one closed literal `<thinking>…</thinking>` or
   * `<think>…</think>` text wrapper. When true, a compression or merge answer
   * of text blocks alone that is exactly that shape, with no tag in its body,
   * is stored as the prose inside it. Every other answer is read as with the
   * option off. Default false. It applies to answers from then on; chunks
   * already in quarantine stay there until their records are cleared.
   */
  recoverLiteralThinkingWrappedCompression?: boolean;
  /** Maximum tokens per individual message in compiled output. Messages exceeding
   *  this limit have their text/tool_result content truncated. A value that
   *  isn't a positive number, such as 0 or NaN, means no limit. */
  maxMessageTokens: number;

  /**
   * Fractional grace above the configured hard context budget before a
   * compile refuses (OverBudgetError). The solver still targets the original
   * budget; this only absorbs coarse fold quanta, indivisible raw-window
   * overshoot, and planner/emitter estimator drift (the plan prices a layout
   * via picker estimates; emission prices it via post-strip render costs —
   * the two legitimately disagree by a fraction of a percent).
   *
   * Default 0.02. Under the fatal coverage invariant nothing is ever silently
   * dropped to fit, so a strict-0 grace turns ordinary sub-percent drift into
   * refused turns (observed live: Mica's store wedged 15 tokens over a 304k
   * budget, 2026-07-26). Set 0 explicitly for strict enforcement.
   */
  overBudgetGraceRatio?: number;

  // --- Live image policy ---

  /** Maximum number of images kept "live" (sent as real image blocks) in the
   *  compiled context. Counted newest-first across the whole window; images
   *  beyond this many are replaced with a text placeholder. Kept within
   *  `imageCeiling`, so 0 means up to that ceiling. A window kept at the
   *  ceiling leaves no room under it for images a caller appends to the
   *  compiled request, so a caller that keeps its requests within the
   *  ceilings recompiles at each image it adds; at about 1,600 tokens an
   *  image, the token budget binds first unless the images are small. A
   *  fraction is floored, to at least 1.
   *  A hard limit for dense bursts that pack many images into the live window.
   *  Every `image` block counts, whatever its source (base64, a `data:` URL
   *  or a remote URL), and so does every generated image, top-level or
   *  nested in a tool result (see inline-images.ts). An image inside an
   *  opaque provider item, such as a Responses `image_generation_call`
   *  replayed from its raw form, doesn't. Every live-image limit and image
   *  ceiling below counts the same way. */
  maxLiveImages?: number;
  /** Token depth from the newest message beyond which images are stripped to a
   *  text placeholder, even though the surrounding text stays verbatim. Measured
   *  as cumulative tokens walked from the tail over the stored messages, before
   *  tool pruning and image strips, which the recent window's walk counts after.
   *  Typically much shallower than recentWindowTokens. 0 = never strip by depth. */
  imageStripDepthTokens?: number;

  /**
   * Not read since canonical merge ownership (2026-08-31). Merge grouping
   * (2026-07-12 contiguity fix) used to break a merge run when the positional
   * gap between consecutive unmerged candidates exceeded this many messages,
   * bridging smaller holes. Every grouping decision now requires exact
   * adjacency in store order, with no listed message between two sources,
   * whatever this is set to. Configurations that set it still type-check.
   *
   * @deprecated Not read: grouping requires exact adjacency.
   */
  mergeContiguityGapLimit?: number;

  /**
   * Byte wall for live images (2026-07-12): keep inline images newest-first
   * only while their cumulative inline size (a base64 source, a `data:` URL's
   * payload, a generated image's `data`; 0 for a remote URL) stays under
   * this budget — on top of `maxLiveImages` / `imageStripDepthTokens`.
   * Default 20 MiB of base64. The window keeps at most `imageByteCeiling`
   * whatever this says, and 0 here means up to that ceiling. It counts the
   * images the window counts (see `maxLiveImages`), not the request's other
   * bytes, so on its own it can't keep a request under membrane's byte cap:
   * see `imageByteCeiling`. An image inside an opaque provider item (see
   * `maxLiveImages`) isn't counted, so it's outside this budget.
   */
  maxLiveImageBytes?: number;

  /**
   * Opt-in, cost-conscious image trimming (default off). Without it the live
   * image window slides one image at a time: once a limit binds
   * (`maxLiveImages`, `imageStripDepthTokens`, `maxLiveImageBytes`), each new
   * image strips the oldest live one, a change mid-history that invalidates
   * the prompt cache from that message on, on every image. With a ratio in
   * (0, 1), a binding limit instead trims down to ratio × each limit, so the
   * stripped set changes once per trim, not once per image. E.g. 0.7. Costs
   * up to (1 - ratio) of the image budget right after a trim, and a little
   * more where ratio × a limit falls between whole images: a count target
   * rounds down (`maxLiveImages: 4` at 0.7 keeps 2), and the byte and depth
   * targets are met by stripping whole images.
   *
   * The set is computed from the stored messages, keeping no state of its
   * own: they're replayed oldest first, and whenever a limit binds, the
   * oldest live images are stripped one at a time until every limit fits
   * ratio × itself. Within a message they go first to last, so the option
   * keeps a message's last images, where the limits without it keep the first
   * that fit: switching the option on can change which of a message's images
   * stay, not only how many. A target that rounds to 0 is 0, but the newest image
   * stays while it fits the full limits, so `maxLiveImages: 1` gets no
   * headroom, and so do the other images of its message while only depth is
   * over its target, since stripping them can't lower the depth they're at.
   * A compile, a preview, a reopen and a fork at the same point give the
   * same set, switching the option on later gives the set it would have
   * had from the start, and a fold moves nothing. An edit or a removal of any
   * message, text-only included, replays a different history, so it can
   * strip or bring back images on either side of it; many of them are newer
   * than the change, where the prompt is rewritten anyway. Depth is counted
   * at the store's calibrated estimates, as the limits are counted without
   * the option, so a calibration change can move the set as it moves theirs.
   */
  imageStripHysteresisRatio?: number;

  /**
   * Image byte budget for COMPRESSION prompts (summarizer). Tighter than the
   * live window's: the prompt also carries the head, the recall frontier and
   * the raw chunk. Newest-first; older images become loud placeholders.
   * Default 12MB of base64. A compression prompt carries at most
   * `imageCeiling` images and `imageByteCeiling` bytes whatever this
   * says, and 0 here, or any value that isn't a positive finite number, means
   * up to the byte ceiling.
   */
  maxCompressionImageBytes?: number;

  /**
   * The most images a strategy's live window keeps, whatever `maxLiveImages`
   * says, and the most images a compression prompt carries (2026-10-19). A
   * `maxLiveImages` of 0 means up to this many. It counts images as
   * `maxLiveImages` does: every image, nested ones and generated ones
   * included, but not one inside an opaque provider item.
   *
   * It doesn't bound a whole request. Images inside opaque provider items
   * aren't counted, and neither is anything a caller injects at compile time
   * or appends to a compiled request; `imageCeilings()` reports this
   * ceiling, so such a caller can count its request's images itself and
   * compare. The provider refuses a
   * request with more than 600 images and documents together (measured
   * 2026-10-13, and again on 2026-10-19), and the default, 500, leaves room
   * for what this doesn't count. 0 = no ceiling. A value that isn't 0 or a
   * finite number above it takes the default, and the strategy's warning at
   * initialize names it. A fraction is floored, to at least 1. Under a
   * window limit of 0 or above this ceiling, the strategy says once that
   * this ceiling holds it, at the first render a select returns where images
   * are shown as placeholders and the limit this ceiling sets was over: at
   * an image the render replaces, or, with `imageStripHysteresisRatio`,
   * where it brought a trim on anywhere in the rule's replay of the history.
   * The depth limit or a limit the host set may be stripping images there
   * too.
   *
   * A window held at a ceiling strips its oldest images as new ones come,
   * as under any limit, but from deep in the request, so the prompt cache is
   * rewritten from there at every new image. The memory strategy's
   * `imageStripHysteresisRatio` strips in batches instead, so the cache is
   * rewritten once a batch, and while that option is off the line names it.
   */
  imageCeiling?: number;

  /**
   * The most inline image bytes of the images a strategy's live window
   * keeps, whatever `maxLiveImageBytes` says, and the most of its images'
   * bytes a compression prompt carries (2026-10-19). A `maxLiveImageBytes`
   * of 0 means up to this many. It measures an image as `maxLiveImageBytes`
   * does: a base64 source's length, a `data:` URL's payload, a generated
   * image's `data`, and 0 for a remote URL.
   *
   * It doesn't bound a request's bytes: the messages' text and JSON,
   * documents, the images the window doesn't count, and anything a caller
   * injects or appends aren't counted. membrane's byte cap is 28 MiB of
   * serialized messages unless `MEMBRANE_MAX_REQUEST_BYTES` says otherwise,
   * and the default, 24 MiB, leaves 4 MiB of that cap for what this doesn't
   * count. Where membrane checks a request against its cap, it refuses one
   * over it before sending it; an XML-mode continuation round isn't checked
   * there, and of the provider adapters only Anthropic's checks again. A
   * request that asks membrane to shed images, as this strategy's compression
   * requests do, first has its oldest images replaced until it fits or none
   * is left, and then only the Anthropic adapter's own check refuses it if
   * it's still over (`src/live-image-limits.ts` says where each check runs).
   * That's for a formatter whose messages keep membrane's `image` blocks:
   * such a request built with membrane's `openai-responses` formatter
   * carries `input_image` parts, which aren't shed, and it isn't checked
   * either. This
   * setting isn't read from `MEMBRANE_MAX_REQUEST_BYTES`: a host that changes
   * membrane's cap sets this too, keeping room under the cap for what this
   * doesn't count.
   * `imageCeilings()` reports it, as for `imageCeiling`. 0 = no ceiling. A
   * value that isn't 0 or a finite number above it takes the default, and a
   * fraction is floored, to at least 1. Under a window limit of 0 or above
   * this ceiling, the strategy says so once, and a window held at it rewrites
   * the prompt cache from deep in the request at every new image, both as
   * for `imageCeiling`.
   */
  imageByteCeiling?: number;

  /**
   * Merge grouping: exclude candidates whose OWN source span exceeds the
   * level-scaled limit `base × mergeThreshold^(max(0, level − 3))`, where
   * this value is the base (replay-era summaries can span the entire
   * chronicle and would bridge any run they join). Level-scaled because
   * legitimate spans grow ~mergeThreshold× per level: a flat limit silently
   * forbids all consolidation above the level whose healthy span exceeds it
   * (mythos 2026-08: every L4 spanned 3.0k–6.9k msgs > 1500 → L5 merges
   * structurally impossible, fold floor stuck ~23k high). L1–L3 limits equal
   * the base, unchanged from the historical flat behavior. Excluded
   * candidates stay on the frontier and are logged loudly (once per id).
   * Default base 1500.
   */
  mergeMaxSourceSpanMessages?: number;

  /**
   * L1 production holdback: keep the newest N closed chunks out of the
   * speculative compression queue (default 1). The chunk at the live edge is
   * the one most likely to still be in motion — summarize it only once a
   * newer chunk has closed behind it. Speculative production of everything
   * older proceeds ahead of need as usual. A picker `produce` op (real fold
   * demand) bypasses the holdback. 0 = compress at close (old behavior).
   */
  l1HoldbackChunks?: number;

  // Legacy aliases (deprecated, use summary* instead)
  /** @deprecated Use summarySystemPrompt */
  diarySystemPrompt?: string;
  /** @deprecated Use summaryUserPrompt */
  diaryUserPrompt?: string;

  // --- Hierarchical compression (L1/L2/L3 pyramid) ---

  /** Enable hierarchical 3-level compression. Set to false for single-level legacy compression. */
  hierarchical?: boolean;
  /**
   * How many summaries the newest run of a level holds before they merge
   * into one at the next level (default: 6), one fewer where that would
   * leave a single summary behind, or the whole run where one fewer would be
   * a group of one (three at a threshold of 2). An older run that can't grow, cut off by
   * a hole or a hold, merges once it holds two, in groups as even as they
   * can be that leave none of it alone; one whose hole a retried chunk or
   * merge will fill grows as the newest does. A demand from the picker
   * queues one of these groups too, a growing run's shorter rest included.
   * Below 2, the merge check queues the oldest run's first `mergeThreshold`
   * and a demand the longest in-range run's, which the merge refuses (#285).
   */
  mergeThreshold?: number;
  /**
   * Bounded retry policy for L_n merges whose LLM response was rejected by
   * the terminal-disposition gate (refusal / max_tokens truncation /
   * tool_use / abort / empty / malformed — anything that is not a complete
   * `end_turn` + nonempty text). Each rejected attempt increments a
   * persisted counter on the merge-queue entry; when the counter reaches
   * this limit the merge is dequeued into the durable merge quarantine
   * (never silently retried in a loop, never canonized). Default: 5.
   */
  mergeAttemptLimit?: number;
  /**
   * Operator merge holds: summary ids that are never offered as merge
   * sources (a held summary that hasn't merged stays on the frontier, and
   * no summary above it forms). Held ids split the frontier into runs like
   * a hole, so later history still merges around them. A held L1 still
   * counts as unmerged toward `maxSpeculativeL1s`. The run of
   * same-level summaries just before a held one can't grow past it, so it
   * merges as a run between two summaries does, which can be at two, below
   * `mergeThreshold`. Lifting a hold doesn't undo
   * the merges formed around the summary: it can then
   * merge only with an unmerged summary of its level beside it, and one
   * with none beside it stays at its level. Sources of a merge quarantined
   * after provider failures are held the same way while its group could be
   * retried as it stands. Use for summaries awaiting review.
   */
  mergeHoldSummaryIds?: string[];
  /**
   * Store-topology policy. On every load the summary archive is audited for
   * crossed ownership: a summary whose leaves are not contiguous among the
   * chunk-owned messages in store order (an interleaved live representation
   * sits inside its span — issue #122's cross-era merges, restore/branch
   * interleavings, hand surgery). `'reject'` (default) throws
   * `StoreTopologyError` from `initialize`, so `ContextManager.open` fails
   * and the operator repairs the store before the resident runs on it.
   * `'report'` logs the violations at error level and reports them through
   * `getCompressionDebt().topologyViolations` (state `critical`).
   * A kv-unified config that explicitly opts into gap handling
   * (`preserveGapBearingSummaries` or `treeifyNonContiguousSummaries`)
   * defaults to `'report'`: those stores are known to carry gaps.
   * Independent of this policy, a merge that WOULD mint a crossed node is
   * never executed: it is refused into the merge quarantine.
   */
  topologyPolicy?: 'reject' | 'report';
  /**
   * Open for inspection only: `initialize` still loads and audits the store,
   * but never chunks the uncovered frontier, enqueues merges, or drops queued
   * merges that the current grouping grammar refuses. Audit and repair tooling
   * opens stores this way; a plain open under a config that is not the
   * resident's own would otherwise mint chunk records with the wrong head
   * window and chunk size. Loading repairs what readers can't use on every
   * open, this one included, and persists the repair: it keeps one of a
   * summary's duplicate copies, rebuilds sources and ranges it can recover,
   * drops summaries that are empty, whose sources or range it can't recover,
   * that list a summary at their own level or above, or that list one they
   * aren't the parent of, and the summaries above them, resolves each
   * summary's parent pointers, and
   * reopens or removes the chunk records and queued merges that name a
   * summary it doesn't keep. It also stores the summary-id counter when the
   * stored one trails the ids the store holds. It leaves out of the merge
   * quarantine, names and writes it back without every entry that isn't a
   * record with a string key and a `sourceIds` list whose ids are all
   * non-empty strings (an empty list is kept), and replaces a stored merge
   * quarantine that isn't a list with an empty one.
   */
  auditOnly?: boolean;
  /** Legacy first-choice target-only merge request. Default false. */
  compressionMergeSourceOnly?: boolean;
  /** Use target-only merge request only on the final persisted merge attempt. Default false. */
  compressionMergeSourceOnlyFallback?: boolean;
  /** Token target for each summary at any level (default: 2000) */
  summaryTargetTokens?: number;
  /** Token budget for L3 summaries in select() (default: 30000) */
  l3BudgetTokens?: number;
  /** Token budget for L2 summaries in select() (default: 30000) */
  l2BudgetTokens?: number;
  /** Token budget for L1 summaries in select() (default: 30000) */
  l1BudgetTokens?: number;

  /**
   * Cap on the total tokens of recall-pair prior-summary content
   * included in each LLM request that builds recall pairs:
   *
   *   - L1 chunk compression (`compressChunkHierarchical`)
   *   - L_n merges (`executeMerge`)
   *
   * Defends against the case where the unmerged frontier itself is
   * large enough to overflow the API window. Walks newest-first so
   * proximate context survives; the kept set is then re-sorted
   * chronologically. Each summary takes (its content tokens + 50 for
   * the wrapping "[CM] Recall memory <id>." question, plus that summary's
   * envelope tags when `recallEnvelope` is on).
   *
   * Default 100000 — chosen so that even an L_n merge (which packs
   * recall + head + expanded target + instruction into one request)
   * fits inside a 200k window. For larger context models or
   * shallower hierarchies, raise this; on Sonnet/Opus default windows,
   * the practical ceiling is roughly 130k.
   *
   * Set to Infinity to disable the cap and surface overflow as a
   * 400 from the API rather than silently dropping oldest memories.
   *
   * In the L1 prompt, the raw that pins add (a chunk a pin opens, so its
   * summary isn't recalled, and a pinned message before the head window) is
   * spent from this budget first, and recall pairs get the rest. When that
   * raw alone exceeds the budget, or the request with it exceeds
   * `compressionContextBudgetTokens`, that compression lays history out as
   * it would without pins: it recalls the summaries the pins override, and
   * leaves out pinned history before the head window that no summary
   * covers. It warns naming the pins; the live view still shows them raw.
   */
  compressionRecallBudgetTokens?: number;

  /**
   * Prompt-cache breakpoints on compression/merge requests (issue #37).
   *
   * Mint requests are dominated by a stable, append-mostly prefix (head
   * window + prior recall pairs — ~60% synthetic, ~93% on mature stores)
   * that was re-sent uncached on every call. When enabled, the request is
   * tagged at its stability strata: end of head, last level>=2 recall pair,
   * last recall pair. Markers are suppressed for any request whose recall
   * ladder was budget-capped (`compressionRecallBudgetTokens`): front
   * eviction shifts the prefix every mint, and measured cache writes there
   * are pure waste (up to +42% cost). Requires append-stable ladder order
   * (the 2026-08-19 source-order fix) to be effective.
   *
   * Default: true.
   */
  compressionCacheMarkers?: boolean;

  /**
   * Cache TTL for compression-lane breakpoints. Mint cadence is typically
   * minutes-to-hours in steady state — beyond the 5-minute TTL, where
   * markers cost more than they save — so the lane defaults to '1h'
   * (write premium 2x vs 1.25x, break-even reuse probability 0.53 vs 0.22).
   * Back-to-back drains work under either.
   *
   * Default: '1h'.
   */
  compressionCacheTtl?: '5m' | '1h';

  /**
   * Residence-scoped direct source-only L1 compression (2026-08-25).
   *
   * When true, an L1 compression request contains ONLY the in-band
   * compression marker, the exact target chunk (raw), and the write-memory
   * directive — the head window, the prior recall pairs, and any non-target
   * raw recent-window material are all omitted. This is ONE direct call, not a
   * canonical→refusal→fallback escalation.
   *
   * Motivation (Mythos 2026-08-25): L1 compression was refused by the Fable
   * safety classifier when the request compiled the raw recent-window room
   * traffic alongside one target chunk. On a copied store the failing
   * contribution was localized to the raw recent-window block as a class in
   * that exact request: recall pairs, the tool manifest, the head window, and
   * the target chunk were each ruled out individually, and two 4-message
   * subsets of the raw-recent block (the incident thread and a size/role-
   * matched control) were each insufficient to clear the refusal, while
   * removing the whole block did. This does NOT establish that the carrier is
   * a diffuse "cumulative mass" or that no smaller subset is load-bearing —
   * only that the raw-recent block as a class carries it here. Handing the
   * summarizer only the thing it is summarizing is the correct scope; the
   * copied drain cleared all quarantined chunks first-try and the summaries
   * passed a full fidelity audit.
   *
   * Source-preserving: no message, summary, or chunk is edited; only the
   * provider-facing request is scoped. The marker/target/directive are emitted
   * structurally (sections 4–6 of the builder), never matched by substring.
   * Tools are still declared (`ctx.tools`): a summarizer replaying
   * tool_use/tool_result history with no tools param is a deterministic
   * reasoning_extraction refusal (labclaude 2026-07-09). Affects L1 only;
   * executeMerge and generateTransitionSummary are unchanged.
   *
   * Default undefined/false — every other resident is unaffected.
   */
  compressionSourceOnly?: boolean;

  /** Final bounded source-only L1 attempt after canonical + recall variants. */
  compressionSourceOnlyFallback?: boolean;
  /**
   * Tool-prose hoist rung (2026-09-19, sill). Off unless set.
   *
   * Long prose in an argument of a private-reasoning tool (`skip_reply.reason`,
   * `think.content`) makes the replayed history read as a reasoning trace and
   * the L1 request is refused `reasoning_extraction` regardless of content. On
   * a canonical REFUSAL (only then) the request is retried once with each such
   * argument moved into a call to `intoTool` — a note-taking tool the agent
   * really has — placed as its own round just before the original call, a short
   * stub left behind. If the source-only final rung is enabled and also refuses,
   * it gets the same rewrite once. Nothing the agent wrote is dropped. Each
   * rewrite is admitted against `compressionContextBudgetTokens` as a
   * recall-curve variant is, measured against the request it rewrites; one
   * over the budget is recorded as rejected and not sent. Each moved argument
   * adds two messages, which the admission bound prices before their bytes.
   *
   * The rung is SKIPPED unless `intoTool` is among the tools the host declared:
   * the summarizer is the agent, and it must never be shown itself using a tool
   * it does not have. Enabling (or changing) this is a new request regime, so
   * already-quarantined chunks earn a fresh bounded attempt without a manual
   * clear. See `tool-prose-hoist.ts` for the canary record.
   */
  compressionToolProseFallback?: {
    /** Declared name of the real note-taking tool that receives the prose. */
    intoTool: string;
    /** Tools to rewrite from (exact name or final `--` segment). Required. */
    fromTools: string[];
    /** Argument of `intoTool` that receives the prose (default `content`). */
    field?: string;
    /** tool_result content for the inserted calls (default: journal receipt). */
    result?: string;
    /** Rewrite string arguments longer than this many chars (default 100). */
    minChars?: number;
  };
  /**
   * Split-stitch rung (2026-09-05, princess): when every L1 rung (canonical, recall
   * expansions, source-only-final) is refused, fold the chunk in halves recursively
   * at message boundaries with the same instruction/model, source-only, and install
   * the stitched pieces as ONE L1 over the chunk (per-piece ranges/hashes recorded on
   * the entry as `stitched`). Off by default.
   */
  compressionSplitFallback?: boolean;
  /**
   * With compressionSplitFallback: allow a one-line bracketed operator placeholder for a
   * SINGLE message that refuses in every form (names the message id; the message stays in
   * the record). Without it, such a chunk falls through to quarantine. Off by default.
   */
  compressionSplitPlaceholder?: boolean;
  /** Split-stitch: max sub-calls per chunk (default 40). */
  compressionSplitMaxCallsPerChunk?: number;
  /** Split-stitch: max sub-calls per strategy instance per 10-minute sliding window (default 80).
   * In-memory only: resets on process restart; not a durable quota. */
  compressionSplitMaxCallsPer10Min?: number;

  /**
   * Maximum number of same-model recall-curve variants attempted after an L1
   * canonical request is explicitly refused. Each variant expands exactly one
   * already-authored frontier summary into its persisted direct children.
   * Default: 3. Set to 0 to disable fallback (canonical is still attempted).
   */
  compressionRefusalCurveFallbacks?: number;

  /**
   * Total model context budget used to admit refusal-curve compression
   * requests, including the request input and the configured output reserve.
   * The canonical request remains unchanged and is always attempted first;
   * the recall-curve variants and the tool-prose hoists
   * (`compressionToolProseFallback`) are gated. Before authoritative canonical
   * usage exists, admission uses a conservative complete normalized-request
   * bound. After a refusal reports complete provider input usage, a request
   * is admitted on the provider-total input of the request it rewrites (the
   * canonical, or the source-only fallback for that rung's hoist), plus a
   * positive serialized expansion delta, then the output reserve. Zero,
   * partial, or unknown usage contracts, and a count of the carrier-stripped
   * copy a transport rejection made the request go as, retain the
   * conservative bound of the request itself. Default: 200000.
   *
   * It also decides whether an L1 prompt shows pinned history raw: with the
   * raw that pins add, the canonical request must fit it, priced as the
   * message store prices the messages it would send (after splitting,
   * collapsing and dropping unpaired tool blocks, before the image cap,
   * which only replaces images), with serialized media priced as the markers
   * that replace them and thinking as the request carries it (the raw
   * messages' stripped, a recall answer's signed reasoning kept), with the
   * system prompt, tools and output reserve, and with the longer of the lines
   * the no-tools and plain-prose retries add to its instruction, so either
   * retry fits too. The tool-prose hoists aren't priced in this decision,
   * since each is admitted on its own, as above. Otherwise that compression
   * lays history out as it would without pins (see
   * `compressionRecallBudgetTokens`). A canonical request without pins is
   * still always attempted.
   */
  compressionContextBudgetTokens?: number;

  /**
   * Minimum substantive text (non-whitespace chars across a chunk's
   * messages) below which L1 compression skips the LLM call and stores a
   * mechanical stub summary instead (default: 200).
   *
   * A chunk of silent/skip turns and bare system traffic gives the
   * summarizer nothing to remember; asked anyway, it confabulates —
   * it reaches for the nearest salient content (head window, prior
   * recall pairs) and narrates it as if it just happened (the
   * "68 initiations" incident). Chunks containing any non-text blocks
   * (tool cycles, images) are never stubbed. Set to 0 to disable.
   */
  minChunkCharsForLLM?: number;

  /**
   * When true (default), each selected summary emits as its own positioned
   * Q/A recall pair, sorted chronologically by source range. When false,
   * all selected summaries are concatenated into one Q/A pair between head
   * and tail (legacy behavior pre-2026-05-10).
   *
   * Per-region positioning is the spec-faithful behavior: it lets the agent
   * see each memory in its temporal place rather than as a wall of unrelated
   * recollections from another speaker. Without it, hierarchical compression
   * is structurally similar to the dual-recall corruption pattern that
   * caused Lena's context degradation on Hermes.
   */
  positionedRecallPairs?: boolean;

  /**
   * Template for the per-pair recall question header. Substitutions:
   *   {id}    — summary id (e.g. "L1-3")
   *   {level} — summary level (1, 2, or 3)
   *   {first} — first source message id
   *   {last}  — last source message id
   *   {tools} — the tools its summary's rounds called, as `summaryContextLabel` lists them
   * Default: '[Recall {id}]'.
   *
   * Only used when `positionedRecallPairs` is true and `adaptiveResolution`
   * is off.
   */
  recallHeaderTemplate?: string;

  /**
   * Per-tool retention limit: keep at most the last N `tool_result` blocks
   * for each tool name. Older results get their content replaced with a
   * brief marker naming the tool and the limit; a limit of 0 replaces every
   * result of the tool.
   *
   * The count runs over the whole conversation, not only what a compile
   * renders raw: a result is replaced once the conversation holds N newer
   * answered calls of its tool, folded ones included, so folding never
   * brings a replaced result back. A result answers the earliest call with
   * its id before it, in its own message or an earlier one, that no result
   * has answered yet; a further result for an answered call goes with that
   * call. Calls are ordered by the message that made them, and calls made in
   * one message by where their results are stored, as the render sends them
   * unless pairing repair moves some. A result is replaced before
   * `maxMessageTokens` cuts its message, and the plan and the render stats
   * price it as its marker. A fractional limit keeps its whole part. A limit
   * that isn't a number of 0 or more, such as a null from a caller outside
   * TypeScript, sets no limit.
   * The stored message, which chunking and compression read, is unchanged.
   *
   * Two shapes accepted:
   *  - `number`: applies as a global default across all tools.
   *  - `Record<toolName, number>`: per-tool limit; tools not listed are
   *    unlimited.
   *
   * Default: undefined (no pruning). Use a small number (1–5) for tools
   * that produce verbose, mostly-stale output (e.g. file listings, http
   * fetches, log queries).
   */
  toolResultMaxLastN?: number | Record<string, number>;

  /**
   * Truncate `tool_use` block inputs whose serialized JSON exceeds this
   * many tokens, at four characters a token. The truncated input becomes
   * `{ "_truncated": true, "_originalTokens": N, "_keys": [...] }`, `_keys`
   * holding the original input's first five keys. The plan and the render
   * stats price the truncated input, and the stored message is unchanged.
   * Default: 0 (no truncation).
   */
  toolUseInputMaxTokens?: number;

  /**
   * Cap on the number of produced, unmerged L1 summaries. Past it, while an
   * L1→L2 merge is queued and `hierarchical` is on, `tick` takes no chunk
   * to compress into an L1, whether the background drain or a manual
   * `tick()` calls it, and runs the merge, which brings the count back down.
   * Production waits for that merge as long as the merge waits, such as on
   * a compression hold over its sources. Chunks still form and queue, and
   * queued chunks don't count toward the cap.
   *
   * With no L1 merge queued, the cap holds nothing. The newest run of L1s
   * merges only once it holds `mergeThreshold`, so under a cap below
   * `mergeThreshold - 1` it still rises to the threshold. Unmerged L1s that can never merge count
   * toward the cap without holding production. Under `hierarchical: false`
   * tick runs no merge, so the cap holds nothing.
   *
   * Default: undefined (no cap; compression fires eagerly on every
   * new message when `autoTickOnNewMessage` is true).
   */
  maxSpeculativeL1s?: number;

  /**
   * When false, the rendering pipeline emits the full ideal context (head
   * window + all selected summaries + all recent messages) without
   * truncating to fit `budget.maxTokens`. The caller's API will reject if
   * the result exceeds the model's context window — the philosophy is
   * "surface the overage rather than silently lose content."
   *
   * Default: true. Selection targets the input budget (`budget.maxTokens`
   * less `reserveForResponse`): it takes no summary past it, except one
   * coverage completion must include so that no message goes unrepresented.
   * Emission drops nothing to fit: past the grace window
   * (`overBudgetGraceRatio`), the hierarchical path's head, its recall pairs
   * (each positioned pair, or the combined pair under
   * `positionedRecallPairs: false`) and its raw middle messages refuse the
   * compile with `OverBudgetError`, and a recent-window eviction that would
   * drop history no summary covers refuses it with `UncoveredDropError`.
   *
   * Recommended setting for long-lived agents on large-context models
   * (e.g. opus-4-7 with 1M context): false. The window is generous enough
   * that overflow is rare, and when it does happen you want to know.
   */
  enforceBudget?: boolean;

  // --- Adaptive resolution (per docs/adaptive-resolution-design.md) ---

  /**
   * Enable picker-driven adaptive resolution. When true, `select()` uses
   * the FoldingStrategy + Picker to choose per-message resolution under
   * token-budget pressure rather than the threshold-driven `checkMergeThreshold`
   * path. Default: false (existing hierarchical behavior preserved).
   */
  adaptiveResolution?: boolean;

  /**
   * Folding strategy name when adaptiveResolution is on. One of:
   *   'flat-profile' (default) — level-equalizing
   *   'oldest-first' — chronological
   *   'kv-stable' — the KV-stable context controller: the rev 5.0 single-path
   *     solve — a relevance-ideal cut reconciled against the carried frontier
   *     under a perturbation trust region (exact kvCost; no λ, no emergency
   *     path). Built per-compile from the live PickerInputs. See
   *     docs/adaptive-resolution-design.md §13.
   * Custom strategies can be plugged in by the host application.
   */
  foldingStrategy?: 'flat-profile' | 'oldest-first' | 'kv-stable' | 'kv-unified';

  /** Explicit, fail-closed kv-unified policy. Every field is required when
   * foldingStrategy is `kv-unified`; there are no live defaults. */
  kvUnified?: KvUnifiedConfig;

  /**
   * Trust region P (tokens) for `foldingStrategy: 'kv-stable'` — bounds how
   * much prefix re-read (exact kvCost) an ordinary turn may take; the solver
   * adopts the relevance-ideal cut within it, amortizes bigger repairs across
   * turns (suffix adoption), and exceeds it only with a recorded override
   * (bootstrap / infeasible / quality-gap — logged as `[kv-escalation]`).
   * See docs/adaptive-resolution-design.md §13. Default: the hard budget
   * (a rendered layout never exceeds it, so the default never binds).
   */
  kvStableReachTokens?: number;

  /**
   * Quality-gap override threshold for `foldingStrategy: 'kv-stable'`
   * (design §13.4): a plan within the trust region is rejected — and the
   * relevance-ideal cut adopted, paying the perturbation — when its
   * salience-weighted misallocation loss exceeds the ideal's by more than
   * this fraction of the ideal's. Also bounds how misallocated a dead-band
   * hold may be before the solver self-heals. Default 0.35.
   */
  kvStableQualityGapRatio?: number;

  /**
   * Slack ratio (hysteresis) for the picker. The picker folds until total
   * tokens ≤ budget * (1 - slack), and stays quiet while between slack
   * and budget. Default 0.1.
   */
  compressionSlackRatio?: number;

  /**
   * Enable bottom-up speculative pre-production of higher-level summaries.
   * When a new L_k summary is produced, if N siblings exist that would share
   * an L_{k+1} parent, the L_{k+1} is enqueued for production immediately
   * (no picker request needed). Default true when adaptiveResolution is on.
   */
  speculativeProduction?: boolean;

  /**
   * Standing production target (tokens): keep the summary forest deep enough
   * that a compile would fit under THIS budget, even while the live compile
   * budget is higher. Each adaptive compile runs an extra shadow pick against
   * this budget — pure CPU, no LLM call, no state commit — and enqueues the
   * folds it demands through the normal drain queues. Once the forest has
   * converged, the live budget can be lowered to the target in one move: no
   * fold-storm, a single KV invalidation ("produce first, fold once").
   * If the shadow pick runs out of folds and produce requests with its plan
   * still over the target's soft line, the compile warns, giving the plan's
   * size and the line above which the plan check of a compile at the target
   * refuses it with OverBudgetError, and calls the target unreachable with
   * the summaries the store has then only when the plan is over that line:
   * the plan check refuses a compile at the target only while it is, though
   * a later stage can refuse it as at any budget. Shadow demand is
   * speculative and never bypasses the `l1HoldbackChunks` window. Must be
   * positive; no effect unless lower than the live compile budget.
   */
  productionBudgetTokens?: number;

  /**
   * Emit a one-shot effective-config report when the strategy INITIALIZES: one
   * structured line on stderr (`event: 'config:effective'`) carrying every
   * resolved key with the layer that supplied it — 'library-default',
   * 'caller', 'knowledge-enforced', or whatever a host names its own layers.
   * A strategy that is constructed and never initialized emits nothing, and a
   * subclass instance reports the strategy it actually is. Default false;
   * nothing is emitted unless this is explicitly on. The same map is always
   * available programmatically as `strategy.configProvenance`.
   *
   * The line carries three maps, not two: `effective`, `provenance`, and
   * `presentAsUndefined`. A key a caller supplied as explicit `undefined` stays
   * present in the effective config (spread fidelity) but cannot survive JSON,
   * so it is listed by name in `presentAsUndefined` instead — leaving every
   * provenance key either valued in `effective` or named there, and never both.
   * `null` is a JSON value and rides `effective` as itself.
   */
  logEffectiveConfig?: boolean;

  /**
   * Persist the exact request that authored each minted summary, keyed by
   * the `provenance.requestHash` the summary already carries (see
   * `SummaryEntry.provenance` and `src/mint-preimage.ts`). Without it the
   * hash keys an `llm-calls` log this library does not write, so provenance
   * survives only as long as the host's harness logs do.
   *
   * OPT-IN, default false. Preimages are stored in the same Chronicle store
   * as the summaries — inline media is stored by content-addressed reference,
   * reusing blobs the messages already put there and storing other inline
   * media once. The request TEXT (a full compression context) remains real
   * growth at mint cadence, and this library has no retention knob for it
   * yet. Fleets that deploy from checkout would otherwise have every
   * resident start writing preimages on the next pull, so turning it on is a
   * deliberate act with an eye on store size. Absent config means off: only
   * an explicit `true` enables it.
   *
   * Writing is best-effort even when true: a store that refuses the write is
   * reported on stderr and the mint proceeds without a preimage.
   */
  persistMintPreimages?: boolean;
}

/**
 * Constructor options for AutobiographicalStrategy. Every field is optional;
 * omitted fields fall back to DEFAULT_AUTOBIOGRAPHICAL_CONFIG. Exported so
 * downstream hosts can type their option plumbing against the strategy's
 * actual contract instead of an untyped bag.
 */
export type AutobiographicalOptions = Partial<AutobiographicalConfig>;

/**
 * Compression level in the hierarchical pyramid.
 *
 * Historically constrained to 1 | 2 | 3. As of the adaptive-resolution design
 * (`docs/adaptive-resolution-design.md`), levels are unbounded: the picker
 * can recursively produce L4, L5, ... as needed. The narrower literal type
 * is kept as `LegacySummaryLevel` for code that still assumes the old shape.
 */
export type SummaryLevel = number;

/**
 * The narrow level type used by pre-adaptive-resolution code paths.
 * Prefer `SummaryLevel` for new code.
 */
export type LegacySummaryLevel = 1 | 2 | 3;

/**
 * A summary entry in the hierarchical memory pyramid.
 * L1: compressed from raw message chunks.
 * L_{k>1}: merged from a run of L_{k-1}s: a group from the oldest end of
 * the newest run, or a group of two or more from an older run.
 */
export interface SummaryEntry {
  /** Unique ID (e.g., "L1-0", "L2-3") */
  id: string;
  /** Present when the entry was produced by the split-stitch rung (compressionSplitFallback). */
  stitched?: Record<string, unknown>;
  /** Compression level (1, 2, 3, ... — unbounded in the adaptive-resolution design) */
  level: SummaryLevel;
  /** The summary text */
  content: string;
  /** Estimated token count (content.length / 4 or tokenizer-cached) */
  tokens: number;
  /**
   * Level of the sources: 0 = raw messages, k = L_k summaries.
   * Pre-adaptive code uses 0 | 1 | 2; new code may produce higher values.
   */
  sourceLevel: number;
  /** IDs of source items (message IDs for L1, summary IDs for L_{k>1}) */
  sourceIds: string[];
  /** Range of original message IDs covered */
  sourceRange: { first: string; last: string };
  /**
   * The L_{level+1} summary this one is a source for, if produced.
   * Pure archive metadata in the adaptive-resolution design — display
   * decisions live on per-chunk `currentResolution`, not here.
   */
  parentId?: string;
  /**
   * The slice this summarizes is inherited/witnessed record, not the agent's
   * lived experience (witnessedBeforeSequence pin). Stamped at L1 mint, and
   * on a quiet-stretch stub as on an L1 of its chunk; merges of all-witnessed
   * sources keep the witnessed voice AND the flag —
   * without propagation the consolidation instruction re-first-persons
   * others' lives one level up (observed 2026-07-27: an L3 opening "I
   * remember the full arc of my relationship with Tavy" — another
   * resident's history, claimed).
   */
  witnessed?: boolean;
  /**
   * @deprecated Renamed to `parentId` in the adaptive-resolution design.
   * Kept for read compatibility with chronicles produced by the old
   * threshold-driven path. New writes should set `parentId` only.
   */
  mergedInto?: string;
  /** Creation timestamp */
  created: number;
  /** Phase type tag (used by KnowledgeStrategy for asymmetric budget) */
  phaseType?: string;
  /**
   * Verbatim summarizer response blocks in provider order (thinking /
   * redacted_thinking / text), captured when the compression response
   * carried reasoning blocks. Fable-5/Sonnet-5-class models require the
   * encrypted reasoning tokens to be supplied back alongside any
   * model-generated assistant text, so summaries — which are emitted in
   * the agent's own voice — must replay these blocks verbatim, never
   * mutated or reordered (signatures cover the block content).
   *
   * `content` remains the joined text for all text consumers (merge
   * inputs, grep, token fallbacks, viewers). When this field is present,
   * emission sites MUST use it instead of reconstructing from `content`.
   * Absent on: stubs, transition summaries, and legacy entries created
   * before this field existed (backfillable from llm-calls logs).
   */
  responseContent?: ContentBlock[];
  /**
   * Authoring-call provenance: the terminal disposition and request
   * identity of the LLM call that produced this summary. A summary may
   * become canonical only after a complete accepted terminal disposition
   * (`stopReason === 'end_turn'` + nonempty text) — this field records the
   * evidence, so entries authored before the 2026-08-01 disposition gate
   * (which could canonize refusals/truncations, e.g. the 163-char cyber
   * refusal that became an L4 parent) are auditable: `provenance` absent →
   * pre-gate entry, verify against host-harness logs via content match;
   * present → `requestHash` keys the request that authored this summary.
   *
   * That key is readable, not merely verifiable, WHERE the host opted into
   * preimage persistence (`persistMintPreimages: true`, off by default): the
   * authoring request is then retrievable by this very hash —
   * `getMintRequestByHash(store, requestHash)`, src/mint-preimage.ts — so
   * audit no longer depends on a host-side llm-calls log surviving. It is
   * BEST-EFFORT even then: a preimage is absent when the mint predates that
   * persistence, when it ran without `persistMintPreimages: true`, or when
   * the store refused the write (loud on stderr, never fatal — a summary
   * outranks its receipt). A present `provenance` therefore promises a
   * verifiable hash, not a retrievable request.
   */
  provenance?: {
    /** Terminal stopReason of the accepted response (always 'end_turn' for post-gate entries). */
    stopReason: string;
    /**
     * sha256 of the JSON-serialized membrane request that authored this
     * summary, and the key its persisted preimage is stored under — the blob
     * key itself for a text-only request, the envelope index key for one
     * carrying inline media (src/mint-preimage.ts). Always the request the
     * transport
     * ACCEPTED: when a degraded-mode retry sends different bytes than the
     * first attempt (carrier stripping), those accepted bytes are what this
     * hash keys, because they are what the model actually read.
     */
    requestHash: string;
    /** Compression model that authored this summary. */
    model?: string;
  };
}

/**
 * Helper: read the parent pointer from a summary, accepting either the
 * new `parentId` field or the deprecated `mergedInto` alias.
 */
export function getSummaryParentId(s: SummaryEntry): string | undefined {
  return s.parentId ?? s.mergedInto;
}

/**
 * A range of messages a pin protects. A pin's bound is its `level`, or
 * without one its `maxLevel`. A raw pin, with no bound or a bound of 0, keeps
 * the span raw at its original position in the rendered context and out of
 * compression. Where the selector reads level bounds, a bound above 0 sets
 * how far the span folds instead, and where pins overlap at a message, one
 * bound holds it (see `level`), so a raw pin there might not keep it raw.
 *
 * A message stored in parts (a long message that ingress splits under
 * `adaptiveResolution`) counts as one: under adaptive resolution, a pin
 * whose first or last id names one of its parts covers it from its first
 * part to its last, less a part locked with `lockChunk` outside the span
 * its ids name, where the lock holds. The selects, compression and the
 * summarizer's prompt all read it so. A compile whose budget can't hold the
 * raw pins beside the rest refuses; where the adaptive plan's middle is over
 * the budget, the refusal names each pin keeping raw tokens in that middle
 * (`OverBudgetDiagnostics.rawPins`).
 *
 * - `kind: 'pin'` — generic protected range (any first/last span).
 * - `kind: 'document'` — typically a single message containing a body of
 *   information the agent wants to keep; semantically identical to a
 *   single-message pin, distinguished by metadata for tooling.
 */
export interface ProtectedRange {
  /** Stable id assigned at pin time. */
  id: string;
  /** First message id of the protected range (inclusive). */
  firstMessageId: string;
  /** Last message id of the protected range (inclusive). */
  lastMessageId: string;
  kind: 'pin' | 'document';
  /** Optional human-readable label. */
  name?: string;
  /** Creation timestamp (ms since epoch). */
  created: number;
  /**
   * Pin-AT-level-k (V2 dynamic pins, `docs/best-fit-frontier-resolution.md` §7).
   * Fix the covered chunks to render at this fold level (0 = raw): the
   * frontier cut passes through the L_k node — neither folded deeper nor
   * un-folded shallower. Under kv-stable, a chunk with no summary at k (its
   * summaries stop below k, its lineage skips k with a parent more than one
   * level up, or its own-lineage summary at k doesn't list it) renders at the
   * next level down where it has one, or raw. Takes precedence over
   * `maxLevel`. Omitted → not a fixed-level pin.
   *
   * Honored by the folding strategies that read level bounds
   * (`foldingStrategy: 'kv-stable'` and `'kv-unified'`, with
   * `adaptiveResolution`). There a level above 0 doesn't keep the range raw:
   * it is still compressed, since only a summary can supply that level.
   * Under kv-unified, until a summary over a message supplies it, the message
   * is held at the deepest level below it that a summary over the message
   * does supply, raw when none does, and it moves to the pinned level once
   * that exists; kv-unified logs when it starts and stops holding a pin. A
   * message of system changes stays raw whatever the pins, so a pin over one
   * neither holds nor moves it, and the log doesn't count it. On
   * a message in the folded middle, a lock at another level still conflicts
   * with the pin, whether or not the pinned level exists yet. Under
   * any other selector, and without adaptive resolution, the range is raw (a
   * safe superset). The canonical L1 compression prompt shows raw what the
   * configured selector keeps raw, where its budgets allow (see
   * `compressionRecallBudgetTokens`); it doesn't hold a span at its pinned
   * level. Where pins overlap at a message, a bound takes a classic pin's
   * place there, `level` takes `maxLevel`'s, and the lowest of each kind
   * wins.
   */
  level?: number;
  /**
   * Pin-max-level (V2 dynamic pins): the covered chunks may fold no DEEPER than
   * this level — raw..L_k allowed, deeper forbidden — a hard cap honored even
   * under the window-pressure emergency. `maxLevel: 0` ≡ classic pin-raw.
   * Ignored when `level` is set. Omitted → this pin imposes no depth cap.
   *
   * Honored where `level` is; see `level`.
   */
  maxLevel?: number;
}

/** Optional fold-depth bounds for a V2 dynamic pin (see `ProtectedRange`). */
export interface PinLevelOptions {
  name?: string;
  /** Pin at this level (0 = raw): fixes the cut through the L_k node, with
   *  kv-stable's exceptions for a chunk its summaries don't reach there and,
   *  under kv-unified, once a summary supplies it (`ProtectedRange.level`). */
  level?: number;
  /** Fold no deeper than this level (hard cap; `0` ≡ classic pin-raw). */
  maxLevel?: number;
}

/**
 * Phase type for knowledge extraction workflows.
 */
export type PhaseType = 'research' | 'synthesis' | 'lesson' | 'subagent';

/**
 * Configuration for the Knowledge strategy.
 * Extends AutobiographicalConfig with phase-aware compression settings.
 */
export interface KnowledgeConfig extends AutobiographicalConfig {
  /** Tool name prefixes that indicate research/retrieval activity.
   *  Default: ['mcpl:', 'zulip:'] */
  researchToolPrefixes?: string[];
  /** Tool name prefixes that indicate subagent coordination.
   *  Default: ['subagent:'] */
  subagentToolPrefixes?: string[];
  /** Exact tool names that indicate lesson capture.
   *  Default: ['lessons:create', 'lessons:update'] */
  lessonToolNames?: string[];

  /** Max chunk tokens for research phases (default: 2x targetChunkTokens) */
  maxResearchChunkTokens?: number;
  /** Max chunk tokens for synthesis phases (default: 1.5x targetChunkTokens) */
  maxSynthesisChunkTokens?: number;
  /** Max chunk tokens for subagent phases (default: 2x targetChunkTokens) */
  maxSubagentChunkTokens?: number;
  /** Max chunk tokens for lesson phases (default: targetChunkTokens) */
  maxLessonChunkTokens?: number;

  /** Maximum fraction of L1 budget for research summaries (default: 0.3) */
  researchL1BudgetCap?: number;
  /** Minimum fraction of L1 budget for synthesis summaries (default: 0.4) */
  synthesisL1BudgetFloor?: number;
  /** Maximum fraction of L1 budget for synthesis summaries (default: 0.7).
   *  Prevents synthesis from starving lessons/subagent/research phases. */
  synthesisL1BudgetCap?: number;
}

/**
 * Constructor options for KnowledgeStrategy. Every field is optional;
 * omitted fields fall back to the strategy's defaults.
 */
export type KnowledgeOptions = Partial<KnowledgeConfig>;

/**
 * Default configuration for Autobiographical strategy.
 */
export const DEFAULT_AUTOBIOGRAPHICAL_CONFIG: AutobiographicalConfig = {
  targetChunkTokens: 3000,
  recentWindowTokens: 30000,
  headWindowTokens: 0,
  chunkOnMessageBoundary: true,
  attachmentsIgnoreSize: true,
  autoTickOnNewMessage: false,
  summarySystemPrompt: 'You are forming a memory of an earlier part of this conversation. The context you see is continuous with your experience - what you read is what happened. Write authentically about what occurred.',
  summaryUserPrompt: `What do you recall from this part of the conversation?

{content}

Capture what matters:
- What was discussed or accomplished
- Key decisions, insights, or information exchanged
- Important context that would be needed to continue

Write naturally, as recollection of what you experienced.`,
  summaryContextLabel: 'What do you remember from earlier?',
  recallEnvelope: 'none',
  carrierPolicy: 'full',
  summaryParticipant: 'Claude',
  maxMessageTokens: 0,
  maxLiveImages: 6,
  imageStripDepthTokens: 30000,
  imageCeiling: DEFAULT_IMAGE_CEILING,
  imageByteCeiling: DEFAULT_IMAGE_BYTE_CEILING,
  positionedRecallPairs: true,
  recallHeaderTemplate: '[Recall {id}]',
  compressionRefusalCurveFallbacks: 3,
  compressionContextBudgetTokens: 200000,
  overBudgetGraceRatio: 0.02,
  persistMintPreimages: false,
};
