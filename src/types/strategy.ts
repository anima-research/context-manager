import type { JsStore } from '@animalabs/chronicle';
import type { Membrane, ContentBlock, ToolDefinition } from '@animalabs/membrane';
import type { StoredMessage, MessageId, Sequence } from './message.js';
import type {
  ContextEntry,
  TokenBudget,
  PendingWork,
} from './context.js';

/**
 * Read-only view of the message store for strategies.
 */
export interface MessageStoreView {
  /** Get all messages */
  getAll(): StoredMessage[];
  /** Get a specific message */
  get(id: MessageId): StoredMessage | null;
  /** Get messages from a specific index */
  getFrom(index: number): StoredMessage[];
  /** Get the last N messages */
  getTail(count: number): StoredMessage[];
  /** Get total message count */
  length(): number;
  /** Estimate tokens for a message */
  estimateTokens(message: StoredMessage): number;
  /** Closed-loop estimator calibration (optional — MessageStore provides it). */
  setTokenCalibration?(factor: number): void;
  getTokenCalibration?(): number;
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
  /** Membrane instance for LLM calls (compression) */
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
  /** Whether compile() can proceed immediately */
  ready: boolean;
  /** Promise that resolves when ready (if not ready) */
  pendingWork?: Promise<void>;
  /** Description of pending work */
  description?: string;
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
   *  0 or undefined = no limit. */
  readonly maxMessageTokens?: number;

  /**
   * Initialize the strategy with context.
   * Called when strategy is set on ContextManager.
   */
  initialize?(ctx: StrategyContext): Promise<void>;

  /**
   * Periodic background maintenance.
   * Called by application to trigger compression, indexing, etc.
   */
  tick?(ctx: StrategyContext): Promise<void>;

  /**
   * React to new messages.
   * Called after a message is added to the store.
   */
  onNewMessage?(message: StoredMessage, ctx: StrategyContext): Promise<void>;

  /**
   * Check if strategy is ready to compile.
   * Returns pending work info if not ready.
   */
  checkReadiness(): ReadinessState;

  /**
   * Select and order context entries for compilation.
   * This is the core method that determines what goes in the context window.
   *
   * `opts.dryRun` requests a NON-COMMITTING select: the returned entries are
   * what a real compile at this budget would produce, but no fold resolutions
   * are persisted, no compression/merge work is enqueued, and no transition
   * bookkeeping is advanced. Implementations that cannot honour it must
   * ignore it only if they are already side-effect-free (see
   * `selectHierarchical`); any path that commits state MUST gate on it.
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
}

/**
 * Per-call options for `select()` / `compile()`.
 *
 * `dryRun` exists because the adaptive path is NOT side-effect-free: it
 * commits fold resolutions to Chronicle and enqueues real compression work.
 * An operator UI that previews a hypothetical budget must not do either, or
 * every slider drag would rewrite the fold plan and spend LLM tokens.
 */
export interface SelectOptions {
  /**
   * Compute the layout without committing anything: no resolution persistence,
   * no produce/merge enqueue, no shadow production pick, and no transition
   * bookkeeping. Over-budget becomes a reported condition rather than a throw.
   */
  dryRun?: boolean;
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
  /** Chunks whose resolution this layout would change vs the carried state. */
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
   * `getRenderStats()`, which continues to describe the live context.
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
 * Strategy that supports protected ranges (pins + documents).
 * Pinned ranges are excluded from compression and render raw at their
 * original chronological position. Implemented by AutobiographicalStrategy.
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
 * Per-render observability stats from a strategy. Counts and token sums for
 * head / tail / summaries / pending work, suitable for TUIs and dashboards
 * that want to display "how much of the context is folded vs raw" at a
 * glance. Token sums use the strategy's own estimates so they line up with
 * the numbers `select()` uses for budget math.
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
   * Sum across all buckets — the actual rendered context size. A summary is a
   * Q/A pair, so it counts as 2 messages here.
   */
  total: { messages: number; tokens: number };

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
    moves: number;
    /** Name of the fold solver that planned this compile (e.g. 'kv-stable',
     *  'flat-profile'). Surfaces the policy actually in force — a config
     *  clobber that silently downgrades the solver is invisible without it. */
    solver?: string;
  };
}

/**
 * Strategy that can produce render-time observability stats. Implemented by
 * AutobiographicalStrategy. Optional capability — strategies that don't
 * implement it simply have `ContextManager.getRenderStats()` return `null`.
 */
export interface RenderStatsCapableStrategy extends ContextStrategy {
  getRenderStats(store: MessageStoreView): RenderStats;
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
  count: number;
  keys: string[];
}

/** Delimiter convention applied to recall answer content. See `recallEnvelope`. */
export type RecallEnvelopeMode = 'none' | 'xml';

/** Where a summary's signed reasoning carriers are replayed. See `carrierPolicy`. */
export type CarrierPolicy = 'full' | 'live-strip';

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
   * present in them.
   */
  witnessedBeforeSequence?: number;
  /**
   * Override wording for the witnessed-record compression instruction.
   * `{targetTokens}` is substituted. Defaults to
   * `formatWitnessedInstruction` in autobiographical.ts.
   */
  witnessedInstruction?: string;
  /**
   * Identity reminder appended to every compression and merge instruction
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
   */
  identityReminder?: string;
  /** Label shown before summaries in compiled context */
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
   *
   * The envelope is a collision-tolerant delimiter convention, not parseable
   * XML: answer text is model prose and is never entity-escaped.
   *
   * Q-side labels are identical under both modes.
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
  /** Maximum tokens per individual message in compiled output. Messages exceeding
   *  this limit have their text/tool_result content truncated. 0 = no limit. */
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
   *  beyond this many are replaced with a text placeholder. 0 = unlimited.
   *  A hard ceiling for dense bursts that pack many images into the live window. */
  maxLiveImages?: number;
  /** Token depth from the newest message beyond which images are stripped to a
   *  text placeholder, even though the surrounding text stays verbatim. Measured
   *  the same way as recentWindowTokens (cumulative tokens walked from the tail).
   *  Typically much shallower than recentWindowTokens. 0 = never strip by depth. */
  imageStripDepthTokens?: number;

  /**
   * Merge grouping (2026-07-12 contiguity fix): break a merge run when the
   * positional gap between consecutive unmerged candidates exceeds this many
   * messages. Small holes (wiped/pruned nodes) bridge fine; cross-era gaps
   * must not — a merge group spanning already-merged history can straddle
   * the recent window and block its whole lineage from folding. Default 300.
   */
  mergeContiguityGapLimit?: number;

  /**
   * Byte wall for live images (2026-07-12): keep inline images newest-first
   * only while their cumulative base64 size stays under this budget — on top
   * of `maxLiveImages` / `imageStripDepthTokens`. Guarantees the compiled
   * window fits the API's total request size cap (413 request_too_large), so
   * membrane's oversize check is a true invariant, never a silent editor.
   * Default 20MB (of base64; the API cap is 32MB total).
   */
  maxLiveImageBytes?: number;

  /**
   * Image byte budget for COMPRESSION prompts (summarizer). Tighter than the
   * live window's: the prompt also carries the head, the recall frontier and
   * the raw chunk. Newest-first; older images become loud placeholders.
   * Default 12MB of base64.
   */
  maxCompressionImageBytes?: number;

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
  /** Number of unmerged summaries before merging to the next level (default: 6) */
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
   * only fallback variants are gated. Before authoritative canonical usage
   * exists, admission uses a conservative complete normalized-request bound.
   * After canonical refusal reports complete provider input usage, admission
   * uses provider-total input plus a positive serialized expansion delta, then
   * adds the output reserve. Zero, partial, or unknown usage contracts retain
   * the conservative bound. Default: 200000.
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
   * Default: '[Recall {id}]'.
   *
   * Only used when `positionedRecallPairs` is true.
   */
  recallHeaderTemplate?: string;

  /**
   * Per-tool retention limit: keep at most the last N `tool_result` blocks
   * for each tool name. Older results get their content replaced with a
   * brief marker referencing the tool name and how many newer results exist.
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
   * many tokens. The truncated input becomes `{ "_truncated": true,
   * "_originalTokens": N }` plus a head slice of the original input
   * keys for context. Default: 0 (no truncation).
   */
  toolUseInputMaxTokens?: number;

  /**
   * Cap on the number of speculative L1 summaries the strategy will hold
   * (queued + unmerged). When `count(unmerged L1s) + count(queued chunks)`
   * exceeds this cap, `onNewMessage`'s auto-tick is held back. Chunks
   * still form and queue, but compression is deferred until a manual
   * `tick()` or `compile()` triggers it.
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
   * Default: true (legacy budget-aware truncation: stops emitting recall
   * pairs and recent messages when the running total exceeds maxTokens).
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
  foldingStrategy?: 'flat-profile' | 'oldest-first' | 'kv-stable';

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
   * If the target is unreachable even fully folded (head + tail + max-depth
   * summaries still exceed it), every compile warns loudly — a descent to
   * that budget would hard-fail with OverBudgetError. Shadow demand is
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
 * L_{k>1}: merged from mergeThreshold L_{k-1}s.
 */
export interface SummaryEntry {
  /** Unique ID (e.g., "L1-0", "L2-3") */
  id: string;
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
   * lived experience (witnessedBeforeSequence pin). Stamped at L1 mint;
   * merges of all-witnessed sources keep the witnessed voice AND the flag —
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
   * pre-gate entry, verify against llm-calls logs via content match;
   * present → `requestHash` keys the exact request in the llm-calls log.
   */
  provenance?: {
    /** Terminal stopReason of the accepted response (always 'end_turn' for post-gate entries). */
    stopReason: string;
    /** sha256 of the JSON-serialized membrane request that authored this summary. */
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
 * A range of messages protected from compression. Pins keep a span of raw
 * messages visible at their original position in the rendered context.
 *
 * - `kind: 'pin'` — generic protected range (any first/last span).
 * - `kind: 'document'` — typically a single message containing a body of
 *   information the agent wants to retain in full; semantically identical
 *   to a single-message pin, distinguished by metadata for tooling.
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
   * Fix the covered chunks to render at EXACTLY this fold level (0 = raw): the
   * frontier cut passes through the L_k node — neither folded deeper nor
   * un-folded shallower. When set, this range is NOT a classic force-raw pin.
   * Takes precedence over `maxLevel`. Omitted → not a fixed-level pin.
   *
   * Honored only by the KV-stable controller (`foldingStrategy: 'kv-stable'`);
   * other strategies fall back to treating the range as raw (a safe superset).
   */
  level?: number;
  /**
   * Pin-max-level (V2 dynamic pins): the covered chunks may fold no DEEPER than
   * this level — raw..L_k allowed, deeper forbidden — a hard cap honored even
   * under the window-pressure emergency. `maxLevel: 0` ≡ classic pin-raw.
   * Ignored when `level` is set. Omitted → this pin imposes no depth cap.
   *
   * Honored only by the KV-stable controller; see `level`.
   */
  maxLevel?: number;
}

/** Optional fold-depth bounds for a V2 dynamic pin (see `ProtectedRange`). */
export interface PinLevelOptions {
  name?: string;
  /** Pin AT exactly this level (0 = raw). Fixes the cut through the L_k node. */
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
  positionedRecallPairs: true,
  recallHeaderTemplate: '[Recall {id}]',
  compressionRefusalCurveFallbacks: 3,
  compressionContextBudgetTokens: 200000,
  overBudgetGraceRatio: 0.02,
};
