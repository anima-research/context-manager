import { type Diagnostics, namespaceDiagnostics } from '../diagnostics.js';
import { describeThrown } from '../describe-thrown.js';
import type {
  ContextStrategy,
  ImageCeilings,
  StrategyContext,
  ReadinessState,
  MessageStoreView,
  MessageId,
  ContextLogView,
  TokenBudget,
  ContextEntry,
  StoredMessage,
  SelectOptions,
  Sequence,
  DerivationManifest,
  WindowIndexView,
} from '../types/index.js';
import { registerStateIfAbsent } from '../state-registration.js';
import { DEFAULT_AUTOBIOGRAPHICAL_CONFIG } from '../types/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { JsStore } from '@animalabs/chronicle';
import { OverBudgetError } from '../adaptive/picker.js';
import { observeStoreBranch, type StoreBranchGeneration } from '../branch-generation.js';
import { hasImage, imagesIn, inlineImageBytes, replaceImages, strippedImageSaving } from '../inline-images.js';
import { capContent, cappedPriceExtra } from './message-cap.js';
import {
  DEFAULT_IMAGE_CEILING,
  DEFAULT_IMAGE_BYTE_CEILING,
  liveImageLimitsWarning,
  ceilingBoundLine,
  ceilingSetLimits,
  resolveLiveImageLimits,
  type ResolvedImageLimits,
} from '../live-image-limits.js';
import { holdsSystemChange, systemChangePositions } from '../system-changes.js';

/**
 * Options for {@link WindowedPassthroughStrategy}.
 */
export interface WindowedPassthroughOptions {
  /**
   * When the window no longer fits the budget, the anchor jumps forward so
   * the new window is roughly this fraction of the usable budget (default
   * 0.5), or, when the store holds system changes, which go out wherever the
   * window starts, this fraction of the room they leave. Between jumps the
   * anchor never moves, so compiled output between re-anchors is a
   * byte-stable prefix plus pure appends — and the strategy
   * marks that prefix for the provider's prompt cache (see
   * {@link WindowedPassthroughStrategy} on cache markers), so the accepted
   * cost is one cache miss per jump, amortized over ~(1 - fraction) × that
   * room of appended tokens, instead of the per-turn prefix churn a naively
   * sliding front produces.
   */
  reAnchorFraction?: number;
  /**
   * Override the chronicle state id used to persist the anchor.
   * Default: `${namespace}/windowed:anchor`.
   */
  anchorStateId?: string;
  /**
   * Per-message token ceiling. Applied HERE to text blocks and string
   * tool-result content by the truncator the autobiographical strategy uses
   * (`capContent`): a `[truncated — original was N tokens]` marker on the
   * block it cuts, and one `[content omitted: this message reached its token
   * limit]` block where the first text block it drops that held anything
   * was. A text block that holds nothing (empty or only whitespace) stays as
   * it is before the cap, and is left out across or past it, and a message
   * of such blocks alone, one of which the cap leaves out, carries the
   * omission block alone. It's surfaced as
   * `ContextStrategy.maxMessageTokens` so the framework's storage-time
   * tool-result clamp mirrors it. Side-process agents should mirror their
   * principal's value so the two see the same truncation policy. Images are
   * not subject to this cap; they are governed by the live-image policy
   * below. Unset, or any value that isn't a positive number, = no
   * truncation, in which case a single message larger than the usable
   * budget is refused (see {@link OverBudgetError}).
   */
  maxMessageTokens?: number;
  /**
   * Live-image policy, mirroring `AutobiographicalConfig`: an image, nested in
   * a tool result or not (see inline-images.ts), is
   * replaced by the memory strategy's text placeholder once it is beyond the
   * `maxLiveImages` newest images (counted newest-first), deeper than
   * `imageStripDepthTokens` from the newest message, or past
   * `maxLiveImageBytes` of cumulative inline image bytes (newest-first).
   * Defaults follow `DEFAULT_AUTOBIOGRAPHICAL_CONFIG` (and the memory
   * strategy's byte wall). A count or byte limit of 0 means up to its
   * image ceiling, below, and a depth of 0 means no depth strip. A strip changes the
   * bytes at that position, which the cache-marker placement absorbs by
   * measurement (the marker falls back to the deepest byte-stable entry).
   */
  maxLiveImages?: number;
  imageStripDepthTokens?: number;
  maxLiveImageBytes?: number;
  /**
   * The image ceilings, mirroring `AutobiographicalConfig.imageCeiling` and
   * `imageByteCeiling`: the most images, and the most of their inline image
   * bytes, the window keeps, counted as
   * `AutobiographicalConfig.maxLiveImages` says, whatever `maxLiveImages` and
   * `maxLiveImageBytes` say (0 there means up to these). They don't bound a
   * whole request: what the window doesn't count, and what a caller injects
   * or appends, isn't counted. `imageCeilings()` reports them.
   * Defaults 500 images and 24 MiB; 0 = no ceiling, and a value that isn't 0
   * or a finite number above it takes the default.
   */
  imageCeiling?: number;
  imageByteCeiling?: number;
}

/** Text substituted for an image block once it leaves the live-image window
 *  (identical to the autobiographical strategy's placeholder, so a merged
 *  timeline reads the same in both agents' windows). */
const IMAGE_PLACEHOLDER = '[image not shown: this context keeps only some images]';

/** The live-image policy's verdicts, by message position (see liveImagePolicy). */
interface ImagePolicy {
  strips: (boolean[] | undefined)[];
  saved: number[];
  ceilings: ({ images: boolean; bytes: boolean } | undefined)[];
}

/** Mirrors `AutobiographicalStrategy.DEFAULT_MAX_LIVE_IMAGE_BYTES` (protected there). */
const DEFAULT_MAX_LIVE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Passthrough over a recent window, anchored at a sequence number while the
 * manager's window is the record, and at an index ordinal once a host
 * presents rows to the agent (ContextManager.presentRows).
 *
 * Built for side-process agents (issue #77's subconscious) whose view is a
 * merged multi-slot timeline and whose durable output is what they deliver
 * elsewhere: no memory pyramid, no compression, no coverage machinery —
 * just "everything since the anchor," with the anchor moved only in coarse
 * jumps (see {@link WindowedPassthroughOptions.reAnchorFraction}) and moved
 * outward only explicitly ({@link setAnchor}, e.g. to the start of the
 * oldest active tune-out).
 *
 * **Sequence or ordinal.** In legacy mode, until a host presents a row on
 * the branch, the window is the record, in record order, and the anchor is
 * a sequence: the window is every row stored at it or after. Once rows are
 * presented, the window is the agent's window index, in the order rows
 * were presented, and the anchor is an index ordinal (agent-framework
 * #291): the window is the row at it and every row presented after it. An
 * ordinal counts the window before the view filter and never moves, so
 * neither a host's filter nor a row taken out shifts the anchor. A
 * sequence anchor, persisted by an earlier release or set before the first
 * presentation, is converted when the branch is first read in presented
 * mode: to the ordinal of the first row in the window stored at that
 * sequence or after (WindowIndexView.ordinalFrom), which is written to the
 * slot then. The window is then the one the sequence gave, since the index
 * is first written down in record order. From then on a row stored before
 * the anchor's sequence but presented after that row is in the window,
 * where a sequence anchor would leave it out: the window is what the agent
 * was shown since, not what was stored since. The conversion gives the
 * sequence's window exactly until such a row is presented (one taken out
 * and presented again, as an undo and its redo do), so it is made at the
 * branch's first read in presented mode and kept.
 *
 * **Branch scoping.** The anchor persists in a chronicle snapshot slot, so
 * it survives restarts and follows branches like every other piece of
 * durable state. The in-memory copy is re-derived from the slot whenever
 * the store's current branch is observed to have changed — including
 * host-side switches that bypass `ContextManager.switchBranch` (undo/redo
 * switch the chronicle directly) — and a persisted value that cannot name
 * a position on the current branch (a sequence past its head, or an
 * ordinal past its window index's length) resets to 0 rather than
 * yielding an empty window.
 *
 * The slot holds `{ anchor }`, the sequence, while the window is the
 * record, as it always has, and `{ anchor, ordinal, v: 2 }` once the anchor
 * is an ordinal: once a compile or a setter moves it in presented mode, or
 * a sequence anchor is converted. A conversion is written when it is made,
 * since converting the same sequence later, once rows have been presented
 * out of record order, can give another ordinal, and so another window,
 * with no move: a reload has to read the ordinal the window was sent
 * from. A load itself stays read-only, a preview (`dryRun`) converts
 * without keeping or writing anything, and an anchor of 0, the start,
 * isn't written, as it converts to the whole window whenever it is
 * converted. `anchor` stays a sequence in both forms, at or before the
 * branch head, so a release that reads only it still loads the slot: the
 * sequence setAnchor was given, or that of the row the window starts at.
 * A slot naming a `v` other than 2 is another version's, whose `anchor`
 * this one can't vouch for: it is read as no anchor, so the window starts
 * at the branch's start, with a warning. One naming a later version than 2 is
 * never written over, so that version reads back what it wrote, and the
 * anchor's moves here are kept in memory only; any other is written over
 * by the next move.
 *
 * **Cache markers.** The strategy holds first claim on message-level cache
 * breakpoints under the same slot contract as the autobiographical
 * strategy (≤ 3 message markers; membrane spends the remainder). It places
 * at most two: the last entry whose bytes survived unchanged from the
 * previous committed compile (explicit reuse of the prior request's cached
 * prefix — Anthropic's backward search covers only ~20 blocks, so between
 * wakes the previous endpoint must be named), and the end (pure-append
 * reuse). After a re-anchor or an image strip the measured stable prefix
 * shrinks to wherever the bytes still agree; the first compile after
 * initialize/branch change marks the end only. Previews (`dryRun`) neither
 * place markers nor advance the measurement.
 *
 * **Hard budget.** After per-message shaping (truncation, image policy) the
 * window is priced against `maxTokens - reserveForResponse`. Overflow
 * re-anchors; if the single newest message alone still exceeds the usable
 * budget, or with system changes, the changes and the newest conversation
 * message, or the changes alone, the strategy refuses with
 * {@link OverBudgetError} (the framework's over-budget breaker handles it)
 * rather than emitting a request the provider will reject. Previews report
 * the oversized window instead.
 */
export class WindowedPassthroughStrategy implements ContextStrategy {
  readonly name = 'windowed-passthrough';
  readonly maxMessageTokens?: number;
  /** Renders the window raw; history before the anchor is not rendered, but for its system changes. */
  readonly renderedForms = ['raw', 'omitted'] as const;

  private readonly reAnchorFraction: number;
  private readonly anchorStateIdOverride?: string;
  /** The image limits as configured, with the defaults where unset. */
  private readonly configuredImageLimits: {
    maxLiveImages: number; maxLiveImageBytes: number; imageCeiling: number; imageByteCeiling: number;
  };
  /** The image limits the options didn't give, whose values are defaults. */
  private readonly imageLimitsDefaulted: ReadonlySet<string>;
  private readonly imageStripDepthTokens: number;
  /** Whether the image limits' warning has been said (once per instance). */
  private imageLimitsWarningReported = false;
  /** Which ceilings have been said to strip the live window (once each per instance). */
  private readonly ceilingBoundReported = { images: false, bytes: false };

  /**
   * The window start as a sequence: the anchor while the window is the
   * record, and the sequence persisted beside the ordinal once rows are
   * presented (see the class doc).
   */
  private anchor: Sequence = 0;
  /**
   * The window start as an index ordinal, on a branch where rows are
   * presented; null until a setter or a re-anchor sets it there, or the
   * sequence is converted (presentedAnchor), and always in legacy mode.
   */
  private anchorOrdinal: number | null = null;
  /** The manager's window index (StrategyContext.window); null for a context without one, which reads as legacy mode. */
  private window: WindowIndexView | null = null;
  private store: JsStore | null = null;
  private stateId: string | null = null;
  /** Its namespace, set in initialize(), which its stderr lines name (#239). */
  private ns = '';
  private readonly diag: Diagnostics = namespaceDiagnostics(() => this.ns);
  /** The branch (name + generation) the in-memory state was loaded from. */
  private loadedBranch: StoreBranchGeneration | null = null;
  /** Content identity of the previous committed compile's entries. */
  private prevCacheKeys: string[] | null = null;
  /** Set when a committed select moved the anchor (see takeSelectionCause). */
  private pendingCause: string | undefined;
  /** Whether this branch load has said that a later version's slot is kept and not written over. */
  private keptSlotReported = false;

  constructor(options: WindowedPassthroughOptions = {}) {
    const fraction = options.reAnchorFraction ?? 0.5;
    if (!(fraction > 0 && fraction <= 1)) {
      throw new Error(`reAnchorFraction must be in (0, 1], got ${fraction}`);
    }
    this.reAnchorFraction = fraction;
    this.anchorStateIdOverride = options.anchorStateId;
    this.maxMessageTokens = options.maxMessageTokens;
    this.configuredImageLimits = {
      maxLiveImages: options.maxLiveImages ?? DEFAULT_AUTOBIOGRAPHICAL_CONFIG.maxLiveImages ?? 0,
      maxLiveImageBytes: options.maxLiveImageBytes ?? DEFAULT_MAX_LIVE_IMAGE_BYTES,
      imageCeiling: options.imageCeiling ?? DEFAULT_IMAGE_CEILING,
      imageByteCeiling: options.imageByteCeiling ?? DEFAULT_IMAGE_BYTE_CEILING,
    };
    this.imageLimitsDefaulted = new Set(
      (['maxLiveImages', 'maxLiveImageBytes', 'imageCeiling', 'imageByteCeiling'] as const).filter((key) => options[key] == null),
    );
    this.imageStripDepthTokens =
      options.imageStripDepthTokens ?? DEFAULT_AUTOBIOGRAPHICAL_CONFIG.imageStripDepthTokens ?? 0;
  }

  /**
   * The image ceilings (see ContextStrategy.imageCeilings), as the window
   * applies them: a malformed one at its default, a fraction floored.
   */
  imageCeilings(): ImageCeilings {
    const { ceiling } = this.resolvedImageLimits();
    return { imageCeiling: ceiling.images, imageByteCeiling: ceiling.bytes };
  }

  /** The live window's count and byte limits, kept within the image
   *  ceilings, and the ceilings themselves. */
  private resolvedImageLimits(): ResolvedImageLimits {
    return resolveLiveImageLimits(this.configuredImageLimits);
  }

  /** Say once that an image ceiling holds a limit the options set as none
   *  or above it, once a limit it sets was over where the window strips an
   *  image (liveImagePolicy's `ceilings`). */
  private reportCeilingBoundOnce(kind: 'images' | 'bytes'): void {
    if (this.ceilingBoundReported[kind]) return;
    this.ceilingBoundReported[kind] = true;
    this.diag.warn(ceilingBoundLine(this.name, kind, this.configuredImageLimits, this.imageLimitsDefaulted));
  }

  async initialize(ctx: StrategyContext): Promise<void> {
    this.store = ctx.store;
    this.window = ctx.window ?? null;
    this.ns = ctx.namespace;
    if (!this.imageLimitsWarningReported) {
      this.imageLimitsWarningReported = true;
      const line = liveImageLimitsWarning(this.name, this.configuredImageLimits, this.imageLimitsDefaulted);
      if (line) this.diag.warn(line);
    }
    this.stateId = this.anchorStateIdOverride ?? `${ctx.namespace}/windowed:anchor`;
    registerStateIfAbsent(this.store, { id: this.stateId, strategy: 'snapshot' });
    this.loadBranchState();
    this.loadedBranch = observeStoreBranch(this.store);
  }

  checkReadiness(): ReadinessState {
    return { ready: true };
  }

  async onNewMessage(_message: StoredMessage, _ctx: StrategyContext): Promise<void> {
    // No-op: the window is recomputed on select(), whether a row entered
    // the agent's window (ContextManager.presentRows) at its add or at its
    // presentation. There is deliberately no onPresented beside it, so a
    // subclass that overrides this still hears each row
    // (ContextStrategy.onNewMessage).
  }

  /**
   * The current window start (inclusive), as a chronicle sequence. While
   * the window is the record, the window is every row stored at it or
   * after. Once rows are presented the window starts at an ordinal
   * (getAnchorOrdinal), and this is the sequence it was set from: the one
   * setAnchor was given, or that of the row a re-anchor started the window
   * at.
   */
  getAnchor(): Sequence {
    this.syncToBranch();
    return this.anchor;
  }

  /**
   * The current window start (inclusive), as an index ordinal, on a branch
   * where the manager presents rows: the window is the row at it and every
   * row presented after it. Undefined in legacy mode, and under a context
   * without a window index. A sequence anchor not converted yet is
   * converted here, as a compile converts it, and written to the slot (see
   * the class doc).
   */
  getAnchorOrdinal(): number | undefined {
    this.syncToBranch();
    return this.presentedAnchor()?.from;
  }

  /**
   * Move the window start explicitly and persist it. Movement is
   * unrestricted — callers own the policy (e.g. "start of the oldest
   * active tune-out"). Moving the anchor earlier deliberately accepts one
   * full prefix invalidation. The sequence the anchor already has changes
   * nothing, so a host that sets a tune-out's start again at a restart
   * keeps the window it had, but only while the anchor hasn't moved since.
   * A re-anchor (select, on overflow) gives the anchor the sequence of the
   * row it starts the window at, so the tune-out's start is then converted
   * again, which can give another window (below).
   *
   * While the window is the record, the window is every row stored at
   * `sequence` or after. Once the manager presents rows on the branch, the
   * sequence is converted here, at the call, to an index ordinal: that of
   * the first row in the window stored at `sequence` or after, or the
   * ordinal the next presented row will take when no row in the window is
   * (WindowIndexView.ordinalFrom). The window is then that row and every
   * row presented after it, so a row stored before `sequence` and
   * presented later is in it: a tune-out's start given as the store's
   * `currentSequence()` keeps every row presented to the agent from then
   * on, wherever the record has it. A caller that moves the anchor back to
   * a place it was before, once rows have been presented out of record
   * order, gets that place back only by ordinal (setAnchorOrdinal): the
   * same sequence converted again can give a later ordinal, leaving out a
   * row stored before it that was presented after the first conversion. A
   * host that sets a tune-out's start again after a re-anchor, at a
   * restart or when another tune-out starts, keeps the window by recording
   * the tune-out's start as an ordinal (ContextManager.indexLength() at
   * that start) and setting it with setAnchorOrdinal.
   */
  setAnchor(sequence: Sequence): void {
    this.syncToBranch();
    if (sequence === this.anchor) return;
    this.anchor = sequence;
    this.anchorOrdinal = this.window?.ordinalFrom(sequence) ?? null;
    this.persistAnchor();
  }

  /**
   * Move the window start to an index ordinal and persist it, on a branch
   * where the manager presents rows: the window is then the row at
   * `ordinal` and every row presented after it. For a host that keeps its
   * places in the window by ordinal (`ContextManager.indexLength()` at a
   * tune-out's start, say). The ordinal is persisted with the sequence of
   * the first row in the window at it or after, or the store's current
   * sequence when none is, for a reader that knows no ordinal (see the
   * class doc). Throws in legacy mode, where there are no ordinals, and
   * for an ordinal that isn't a whole number from 0 to the index length.
   */
  setAnchorOrdinal(ordinal: number): void {
    this.syncToBranch();
    const window = this.window;
    if (!window || window.mode() !== 'presented') {
      throw new Error(
        'WindowedPassthroughStrategy.setAnchorOrdinal: no row has been presented on this branch, so its window has no ordinals; ' +
          'set the anchor by sequence (setAnchor)',
      );
    }
    const length = window.length();
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > length) {
      throw new RangeError(
        `WindowedPassthroughStrategy.setAnchorOrdinal: ${ordinal} is not an ordinal of this branch's window, ` +
          `a whole number from 0 to its index length ${length}`,
      );
    }
    if (ordinal === this.presentedAnchor()?.from) return;
    this.anchorOrdinal = ordinal;
    this.anchor = window.sequenceFrom(ordinal) ?? this.store!.currentSequence();
    this.persistAnchor();
  }

  /**
   * The window's ordinals and the anchor as an ordinal, on a branch where
   * the manager presents rows; null in legacy mode, where the anchor is a
   * sequence. Read once per select: the ordinals are one reading of the
   * index.
   *
   * A sequence anchor (persisted by an earlier release, or set before the
   * first presentation) is converted here, as setAnchor converts one, and
   * written to the slot at once (see the class doc): converted again later,
   * once a row stored before it has been presented after the row it names,
   * it would give another ordinal. A `preview` (a dryRun select) converts
   * for itself and keeps nothing, so a later read converts and writes it.
   * An anchor of 0, the start, which a branch with no slot has, is kept in
   * memory only: the row it converts to is the first in the window, so
   * every row presented since is at or after it, whenever it is converted.
   */
  private presentedAnchor(preview = false): { ordinals: ReadonlyMap<MessageId, number>; from: number } | null {
    const ordinals = this.window?.ordinals() ?? null;
    if (!ordinals) return null;
    if (this.anchorOrdinal !== null) return { ordinals, from: this.anchorOrdinal };
    const from = this.window!.ordinalFrom(this.anchor) ?? 0;
    if (preview) return { ordinals, from };
    this.anchorOrdinal = from;
    if (this.anchor !== 0) {
      try {
        this.persistAnchor();
      } catch (err) {
        // The window is the same either way: a slot not written is
        // converted again at the next load, as before the conversion was
        // written.
        this.diag.warn(
          `[windowed-passthrough] the anchor converted to ordinal ${from} couldn't be written, ` +
            `so a reload converts its sequence ${this.anchor} again: ${describeThrown(err)}`,
        );
      }
    }
    return { ordinals, from };
  }

  /**
   * Whether a row is at the window start or after: by its index ordinal on
   * a branch where the manager presents rows (`presented`, from
   * presentedAnchor), by its sequence while the window is the record. A row
   * the index doesn't hold, which the manager's view never lists in
   * presented mode, counts as after it.
   */
  private atOrAfterAnchor(
    presented: { ordinals: ReadonlyMap<MessageId, number>; from: number } | null,
  ): (message: StoredMessage) => boolean {
    if (!presented) {
      const anchor = this.anchor;
      return (message) => message.sequence >= anchor;
    }
    const { ordinals, from } = presented;
    return (message) => (ordinals.get(message.id) ?? Infinity) >= from;
  }

  // --------------------------------------------------------------------------
  // Branch-scoped state
  // --------------------------------------------------------------------------

  /**
   * (Re)derive every piece of in-memory branch-scoped state from the current
   * branch: the anchor from its snapshot slot (its sequence validated
   * against the branch head, and its ordinal, on a branch where rows are
   * presented, against the branch's index length), and no memory of a
   * previous compile (the last request was built on another timeline, or
   * never).
   *
   * Read-only, as it always was. A slot of the first form, `{ anchor }`,
   * loads its sequence, which a branch in presented mode converts, and
   * writes as an ordinal, when the window is first read (presentedAnchor):
   * a branch made before the upgrade, or by `createBranchAt` or `derive`
   * from one, carries its own, so each is converted where it is read. On a
   * branch in legacy mode an ordinal names nothing, there being no index
   * there (a branch a host made without carrying the manager's index;
   * derive carries it), so the sequence beside it is the anchor. A slot
   * naming another `v` is another version's and loads as no anchor (see
   * the class doc).
   */
  private loadBranchState(): void {
    this.anchor = 0;
    this.anchorOrdinal = null;
    this.prevCacheKeys = null;
    this.keptSlotReported = false;
    if (!this.store || !this.stateId) return;
    const persisted = this.store.getStateJson(this.stateId) as { anchor?: unknown; ordinal?: unknown; v?: unknown } | null;
    const format = slotFormatOf(persisted);
    if (format !== undefined && format !== ANCHOR_SLOT_FORMAT) {
      // Another version's slot: its `anchor` may not mean what this
      // version's does, so it names no place here, and the window starts
      // at the branch's start, as for a value that names no position.
      const newer = isNewerSlot(persisted);
      if (newer) this.keptSlotReported = true;
      this.diag.warn(
        `[windowed-passthrough] the anchor slot of ${this.store.currentBranch().name} is in format ` +
          `${JSON.stringify(format)}, which this version (format ${ANCHOR_SLOT_FORMAT}) doesn't read; the window starts at 0` +
          (newer
            ? `, and the slot isn't written over: a move of the anchor on this branch is kept in memory only`
            : `, and the next move of the anchor writes over it`),
      );
      return;
    }
    const value = persisted?.anchor;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
    const head = this.store.currentSequence();
    if (value > head) {
      // Cannot name a position on this branch. A stale value here would make
      // every select() return an empty window — and the next re-anchor would
      // persist the stale-derived value into this branch.
      this.diag.warn(
        `[windowed-passthrough] persisted anchor ${value} is past the branch head ${head} ` +
        `(${this.store.currentBranch().name}); resetting to 0`,
      );
      return;
    }
    this.anchor = value;
    const ordinal = persisted!.ordinal;
    if (format !== ANCHOR_SLOT_FORMAT || typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0) return;
    if (!this.window?.ordinals()) return;
    const length = this.window.length();
    if (ordinal > length) {
      // As a sequence past the head: an ordinal this branch's index never
      // issued names no place in its window.
      this.diag.warn(
        `[windowed-passthrough] persisted anchor ordinal ${ordinal} is past the window index's length ${length} ` +
        `(${this.store.currentBranch().name}); resetting to 0`,
      );
      this.anchor = 0;
      return;
    }
    this.anchorOrdinal = ordinal;
  }

  /**
   * Hosts may switch the chronicle's branch without re-initializing the
   * manager (undo/redo do). Detect that via the store's branch generation
   * and reload, so the window is always the current branch's.
   */
  private syncToBranch(): void {
    if (!this.store) return;
    const current = observeStoreBranch(this.store);
    if (
      this.loadedBranch &&
      current.name === this.loadedBranch.name &&
      current.generation === this.loadedBranch.generation
    ) {
      return;
    }
    this.loadBranchState();
    this.loadedBranch = current;
  }

  // --------------------------------------------------------------------------
  // Selection
  // --------------------------------------------------------------------------

  select(
    store: MessageStoreView,
    _log: ContextLogView,
    budget: TokenBudget,
    opts?: SelectOptions,
  ): ContextEntry[] {
    this.syncToBranch();
    const maxTokens = budget.maxTokens - budget.reserveForResponse;
    const messages = store.getAll();
    const presented = this.presentedAnchor(opts?.dryRun === true);
    const shown = this.atOrAfterAnchor(presented);

    // The window: everything at or after the anchor. The view lists rows in
    // record order while the window is the record, and in window order, the
    // order of their ordinals, once rows are presented, so the rows before
    // the anchor come first in both.
    let start = 0;
    while (start < messages.length && !shown(messages[start]!)) {
      start++;
    }

    // Per-message shaping BEFORE pricing, so the window is sized on what
    // will actually be sent: the live-image policy's verdicts, decided once
    // from the newest message down to the anchor (liveImagePolicy), so the
    // window is priced without the images the strip takes out, and
    // truncation. A message the cap cuts is priced as it renders, as the
    // autobiographical strategy prices one: its price after the policy,
    // plus what the cut adds to it as the store estimates the content sent
    // (cappedPriceExtra). The cut changes text and string results alone,
    // and the store prices the text the cap keeps at its own rates, so the
    // difference holds the kept text, the suffix, the omission notices and
    // the marker, and the message's other blocks keep their price, its
    // images at the policy's. A message the truncator leaves whole renders
    // whole and is priced at its estimate after the policy, even past the
    // cap. The two estimates differ: the store's counts every block,
    // thinking included, and the truncator's counts text and string results
    // alone, rounding each block up, so either can pass the cap with nothing
    // cut. The image strip's depth (liveImagePolicy) is still measured by
    // the store's estimate of each stored message, before the cap, as the
    // autobiographical strategy measures its own.
    const policy = this.liveImagePolicy(messages, store, start);
    const shaped = new Map<number, ContentBlock[]>();
    const priced = (i: number): number => {
      const msg = messages[i];
      const estimate = Math.max(0, store.estimateTokens(msg) - (policy.saved[i] ?? 0));
      const content = this.cappedContent(msg);
      if (content === msg.content) return estimate;
      shaped.set(i, content);
      return estimate + cappedPriceExtra(store, msg, content);
    };

    // A system change before the window is sent too, in its order ahead of
    // it: it changes the tools and system text everything after it was read
    // with (system-changes.ts). So every change is priced wherever the
    // window starts.
    const changes = systemChangePositions(messages);
    const keptBefore = (from: number): number[] => changes.filter((i) => i < from);
    let changeTokens = 0;
    for (const i of changes) changeTokens += priced(i);
    let total = 0;
    for (const i of keptBefore(start)) total += priced(i);
    for (let i = start; i < messages.length; i++) total += priced(i);

    let movedAnchor: { sequence: Sequence; ordinal: number | null } | undefined;
    if (total > maxTokens) {
      // Coarse re-anchor: jump forward so the window holds the changes and
      // about that fraction of the room they leave, then emit from the new
      // anchor. One prefix invalidation, then
      // byte-stable prefix + appends again until the next overflow. The
      // system changes go out wherever the window starts, so its messages
      // take that fraction of the room the changes leave, and appends get
      // the rest of that room, (1 - fraction) × (budget - changes), before
      // the next.
      const target = changeTokens + (maxTokens - changeTokens) * this.reAnchorFraction;
      let acc = changeTokens;
      let newStart = messages.length;
      for (let i = messages.length - 1; i >= start; i--) {
        if (holdsSystemChange(messages[i]!.content)) continue; // priced above
        const tokens = priced(i);
        if (acc + tokens > target) break;
        acc += tokens;
        newStart = i;
      }
      // Always make progress: if even the newest message exceeds the
      // target, emit just that message rather than nothing — subject to the
      // hard-budget check below. A system change is no conversation message,
      // so that's the newest message that isn't one, if the window holds one.
      if (newStart === messages.length && messages.length > 0) {
        newStart = messages.length - 1;
        while (newStart > start && holdsSystemChange(messages[newStart]!.content)) newStart--;
      }
      start = newStart;
      total = 0;
      for (const i of keptBefore(start)) total += priced(i);
      for (let i = start; i < messages.length; i++) total += priced(i);
      // The window now starts at messages[start]: by its ordinal once rows
      // are presented, by its sequence while the window is the record.
      const first = messages[start];
      if (first && presented) {
        const ordinal = presented.ordinals.get(first.id);
        if (ordinal !== undefined && ordinal !== presented.from) movedAnchor = { sequence: first.sequence, ordinal };
      } else if (first && first.sequence !== this.anchor) {
        movedAnchor = { sequence: first.sequence, ordinal: null };
      }
    }

    // Hard budget: the progress clause above can leave a single newest
    // message larger than the usable budget. Never emit it — the provider
    // would reject the request; refuse loudly instead (the framework
    // recognizes OverBudgetError and runs its over-budget breaker), as the
    // autobiographical strategy does. Previews report rather than throw.
    // The anchor moves only for a compile that sends, below: a refused one
    // leaves it where the last sent window started, so the turns that fit
    // once the caller consolidates its changes are still in the window.
    if (total > maxTokens && !opts?.dryRun) {
      throw new OverBudgetError({
        budget: maxTokens,
        actual: total,
        // Which part is over: the newest message alone, or the system
        // changes sent beside it, with it or alone.
        stageId: changeTokens === 0
          ? 'windowed-newest-message'
          : total > changeTokens
            ? 'windowed-changes-and-newest-message'
            : 'windowed-system-changes',
        // No compression here: the window moves past this message once a
        // newer one that fits arrives (the progress clause above). System
        // changes go out wherever the window starts, so once they leave no
        // room for a message only the caller, consolidating them, clears it.
        clearedBy: changeTokens < maxTokens ? ['newer-message'] : [],
        diagnostics: {
          headTokens: changeTokens,
          tailTokens: total - changeTokens,
          middleTokens: 0,
          middleChunkCount: 0,
          deepestLevel: 0,
        },
      });
    }
    if (movedAnchor !== undefined && !opts?.dryRun) {
      this.anchor = movedAnchor.sequence;
      this.anchorOrdinal = movedAnchor.ordinal;
      this.persistAnchor();
      this.pendingCause = 'window';
    }

    const entries: ContextEntry[] = [];
    const add = (i: number): void => {
      const msg = messages[i]!;
      entries.push({
        index: i,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content: shaped.get(i) ?? msg.content,
      });
    };
    for (const i of keptBefore(start)) add(i);
    for (let i = start; i < messages.length; i++) add(i);

    this.stripImages(entries, policy);
    // Only a render select returns says a ceiling's line, for the images it
    // holds. A preview's (dryRun) doesn't, nor any other caller's.
    if (!opts?.dryRun) this.reportCeilings(entries, policy);
    if (!opts?.dryRun) this.placeCacheMarkers(entries);
    return entries;
  }

  /** A stored message's content as select sends it under the per-message
   *  cap: the content itself when no cap is set or nothing needs cutting. */
  private cappedContent(msg: StoredMessage): ContentBlock[] {
    const cap = this.maxMessageTokens ?? 0;
    return cap <= 0 ? msg.content : truncateContent(msg.content, cap);
  }

  /**
   * See `ContextStrategy.renderAsNewest`. The steps select takes for the
   * messages it sends, over the view's suffix from the batch's oldest
   * message to its newest: each cut as select cuts it (cappedContent), then
   * the live-image policy's verdicts applied (liveImagePolicy, stripImages),
   * each decided from its message and newer ones, with depth from the view's
   * newest message, so they're select's. A message before the anchor (by
   * its ordinal once rows are presented, by its sequence before) comes back
   * as null, since select leaves it out, but for a system change, which
   * comes back as select sends it ahead of the window, cut as any message
   * is: a compile moves the anchor only to a message it sent, but a
   * caller's setAnchor can move it past one just stored. Like select, it
   * first reloads the branch the store has moved to. A re-anchor the next
   * compile's budget forces isn't foreseen: it moves the anchor only past a
   * window bigger than the budget allows. A body sharded under the
   * autobiographical strategy comes back shard by shard, since select sends
   * each as its own message.
   */
  renderAsNewest(store: MessageStoreView, ids: readonly MessageId[]): Array<ContentBlock[] | null> {
    this.syncToBranch();
    const messages = store.getAll();
    const at = new Map(messages.map((m, i) => [m.id, i] as const));
    const atOrAfter = this.atOrAfterAnchor(this.presentedAnchor());
    const shown = (i: number): boolean => atOrAfter(messages[i]!);
    let from = messages.length;
    for (const id of ids) {
      const i = at.get(id);
      if (i !== undefined && shown(i)) from = Math.min(from, i);
    }
    // Timeline order with each message's position as its index, as select's
    // entries have, which stripImages reads the verdicts by.
    const entries: ContextEntry[] = [];
    for (let i = from; i < messages.length; i++) {
      const msg = messages[i]!;
      entries.push({
        index: i,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content: this.cappedContent(msg),
      });
    }
    this.stripImages(entries, this.liveImagePolicy(messages, store, from));
    const rendered = new Map<MessageId, ContentBlock[]>();
    for (const entry of entries) rendered.set(entry.sourceMessageId!, entry.content);
    return ids.map((id) => {
      const i = at.get(id);
      if (i !== undefined && !shown(i) && holdsSystemChange(messages[i]!.content)) return this.cappedContent(messages[i]!);
      return rendered.get(id) ?? null;
    });
  }

  /** 'window' when the last committed select moved the window's start. */
  takeSelectionCause(): string | undefined {
    const cause = this.pendingCause;
    this.pendingCause = undefined;
    return cause;
  }

  // --------------------------------------------------------------------------
  // Live-image policy (mirrors AutobiographicalStrategy.applyImageStripping)
  // --------------------------------------------------------------------------

  /**
   * The policy's verdict on every image of the messages from `from` to the
   * newest (`strips`, true where the placeholder replaces it, in the order
   * `imagesIn` and `replaceImages` visit a message's images), and the tokens
   * each message's estimate gives back for the images it loses (`saved`).
   * `select` prices the window by `saved` and applies `strips` to what it
   * emits (stripImages), so the verdicts it prices are the ones the strip
   * applies. `ceilings` names, for each message, the limits an image
   * ceiling sets (ceilingSetLimits) that were over where one of its images
   * is stripped, whatever else strips it too, for the line a returned
   * render says (reportCeilings).
   *
   * That holds wherever the window starts, and the re-anchor walk reads them
   * as they are, as `renderAsNewest` does from the batch's oldest message:
   * the window is every message from the anchor on, and each
   * verdict is decided from that message and newer ones only, its depth from
   * the newest message over the whole view and its count and bytes
   * newest-first. So a message's verdicts, and its price after them, are the
   * same whichever message the window starts at. A rule that looked at older
   * messages, or at where the window starts, would break that, and the
   * window would again be priced with images the strip takes out.
   */
  private liveImagePolicy(
    messages: StoredMessage[],
    store: MessageStoreView,
    from: number,
  ): ImagePolicy {
    const strips: (boolean[] | undefined)[] = [];
    const saved: number[] = [];
    const ceilings: ({ images: boolean; bytes: boolean } | undefined)[] = [];
    // Count and bytes within the image ceilings; 0 = unlimited.
    const { images: maxLive, bytes: maxLiveBytes } = this.resolvedImageLimits().target;
    const depthTokens = this.imageStripDepthTokens;
    if (maxLive === 0 && depthTokens === 0 && maxLiveBytes === 0) return { strips, saved, ceilings };
    const calibration = store.getTokenCalibration?.() ?? 1;
    // The placeholder as the store prices it, calibrated, by its own text estimator.
    const placeholderPrice = store.estimateTokens({ content: [{ type: 'text', text: IMAGE_PLACEHOLDER }] } as unknown as StoredMessage);

    // Depth boundary: walk newest→oldest over the whole view (the policy is
    // "distance from the newest message", not "distance from the anchor").
    let stripStart = 0;
    if (depthTokens > 0) {
      let tokens = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        tokens += store.estimateTokens(messages[i]);
        if (tokens > depthTokens) { stripStart = i + 1; break; }
      }
    }

    const ceilingSet = ceilingSetLimits(this.configuredImageLimits);
    let keptImages = 0;
    let keptImageBytes = 0;
    // Newest-first. Every image a message carries, nested in a tool_result
    // included, is counted as the autobiographical strategy counts it (see
    // inline-images.ts).
    for (let i = messages.length - 1; i >= from; i--) {
      const content = messages[i]!.content;
      if (!hasImage(content)) continue;
      const tooDeep = depthTokens > 0 && i < stripStart;
      const verdicts: boolean[] = [];
      let tokens = 0;
      for (const image of imagesIn(content)) {
        const bytes = inlineImageBytes(image);
        const overCount = maxLive > 0 && keptImages >= maxLive;
        const overBytes = maxLiveBytes > 0 && keptImageBytes + bytes > maxLiveBytes;
        const strip = tooDeep || overCount || overBytes;
        const decided = (ceilings[i] ??= { images: false, bytes: false });
        decided.images ||= overCount && ceilingSet.images;
        decided.bytes ||= overBytes && ceilingSet.bytes;
        if (strip) {
          tokens += strippedImageSaving(image, placeholderPrice, calibration);
        } else {
          keptImages++;
          keptImageBytes += bytes;
        }
        verdicts.push(strip);
      }
      strips[i] = verdicts;
      saved[i] = tokens;
    }
    return { strips, saved, ceilings };
  }

  /** The policy's verdicts applied to entries whose `index` is their
   *  message's position. Truncation passes every block that holds an image
   *  through, so an entry's images are its message's, in the order the
   *  verdicts follow. */
  private stripImages(entries: ContextEntry[], policy: { strips: (boolean[] | undefined)[] }): void {
    for (const entry of entries) {
      const strips = policy.strips[entry.index];
      if (!strips) continue;
      let k = 0;
      entry.content = replaceImages(entry.content, () => strips[k++]!, IMAGE_PLACEHOLDER);
    }
  }

  /**
   * A derived context inherits the anchor; nothing else is persisted. The
   * window index isn't the strategy's to name: the manager owns it, and
   * ContextManager.derive carries it whatever this names, so the child
   * reads an ordinal against the parent's index as of the checkpoint. The
   * slot carries the anchor's sequence beside its ordinal, so a child on a
   * branch without that index still reads it, by sequence.
   */
  derivationManifest(namespace: string): DerivationManifest {
    return { stateIds: [this.anchorStateIdOverride ?? `${namespace}/windowed:anchor`], statePrefixes: [] };
  }

  // --------------------------------------------------------------------------
  // Rendering frontier hand-over (RenderingFrontierStrategy)
  // --------------------------------------------------------------------------

  /** The anchor is persisted and inherited through the store; only the
   *  previous compile's cache identities live in memory. */
  exportRenderingFrontier(): unknown {
    return { strategy: 'windowed-passthrough', prevCacheKeys: this.prevCacheKeys ? [...this.prevCacheKeys] : null };
  }

  adoptRenderingFrontier(frontier: unknown): void {
    const f = frontier as { strategy?: string; prevCacheKeys?: string[] | null } | null | undefined;
    if (!f || f.strategy !== 'windowed-passthrough') return;
    this.prevCacheKeys = Array.isArray(f.prevCacheKeys) ? [...f.prevCacheKeys] : null;
  }

  /** A fresh solve re-marks from a cold start; the anchor is a position, not a solve. */
  discardRenderingFrontier(): void {
    this.prevCacheKeys = null;
  }

  /** Says a ceiling's line once, for a ceiling whose limit was over where the window strips an image of an entry the render holds. */
  private reportCeilings(entries: ContextEntry[], policy: ImagePolicy): void {
    for (const entry of entries) {
      const decided = policy.ceilings[entry.index];
      if (decided?.images) this.reportCeilingBoundOnce('images');
      if (decided?.bytes) this.reportCeilingBoundOnce('bytes');
    }
  }

  // --------------------------------------------------------------------------
  // Cache markers (first-claim ≤ 3; this strategy uses ≤ 2)
  // --------------------------------------------------------------------------

  private placeCacheMarkers(entries: ContextEntry[]): void {
    for (const e of entries) if (e.cacheMarker) e.cacheMarker = false;
    const n = entries.length;
    if (n === 0) {
      this.prevCacheKeys = [];
      return;
    }
    // Bytes are what the provider hashes: key on participant + content.
    const keys = entries.map((e) => `${e.participant} ${JSON.stringify(e.content)}`);
    const prev = this.prevCacheKeys;
    let firstDiff = n;
    if (prev) {
      let i = 0;
      while (i < n && i < prev.length && keys[i] === prev[i]) i++;
      firstDiff = i;
    }
    this.prevCacheKeys = keys;

    const marks = new Set<number>();
    const stableEnd = prev ? firstDiff - 1 : -1;
    if (stableEnd >= 0) marks.add(stableEnd); // previous request's cached prefix, named explicitly
    marks.add(n - 1);                          // end → pure-append reuse
    for (const idx of marks) entries[idx].cacheMarker = true;
  }

  /**
   * `{ anchor }` while the window is the record, as before, and
   * `{ anchor, ordinal, v: 2 }` once the anchor is an ordinal (see the
   * class doc). A slot a later version wrote (a `v` above 2) is left as it
   * is, with a warning once per branch load, and the anchor kept in memory:
   * that version reads its slot back as it wrote it.
   */
  private persistAnchor(): void {
    if (!this.store || !this.stateId) return;
    const persisted: unknown = this.store.getStateJson(this.stateId);
    if (isNewerSlot(persisted)) {
      if (!this.keptSlotReported) {
        this.keptSlotReported = true;
        this.diag.warn(
          `[windowed-passthrough] the anchor slot of ${this.store.currentBranch().name} is in format ` +
            `${JSON.stringify(slotFormatOf(persisted))}, a later version's, so this version doesn't write over it: ` +
            `a move of the anchor on this branch is kept in memory only`,
        );
      }
      return;
    }
    this.store.setStateJson(
      this.stateId,
      this.anchorOrdinal === null ? { anchor: this.anchor } : { anchor: this.anchor, ordinal: this.anchorOrdinal, v: ANCHOR_SLOT_FORMAT },
    );
  }
}

// ----------------------------------------------------------------------------
// The anchor slot's format
// ----------------------------------------------------------------------------

/** The `v` of the slot's ordinal form, `{ anchor, ordinal, v: 2 }`; the first form, `{ anchor }`, has none. */
const ANCHOR_SLOT_FORMAT = 2;

/** The `v` a persisted slot names, or undefined for one that names none (the first form, or no slot). */
function slotFormatOf(persisted: unknown): unknown {
  return typeof persisted === 'object' && persisted !== null ? (persisted as { v?: unknown }).v : undefined;
}

/** Whether a persisted slot names a later format than this version writes, which it must not write over. */
function isNewerSlot(persisted: unknown): boolean {
  const v = slotFormatOf(persisted);
  return typeof v === 'number' && v > ANCHOR_SLOT_FORMAT;
}

// ----------------------------------------------------------------------------
// Helpers (ports of the autobiographical strategy's protected utilities)
// ----------------------------------------------------------------------------

/** Text-only token estimate at the same chars/4 rate the truncation marker reports. */
function estimateTextOnlyTokens(content: ContentBlock[]): number {
  let tokens = 0;
  for (const block of content) {
    if (block.type === 'text') {
      tokens += Math.ceil(block.text.length / 4);
    } else if (block.type === 'tool_result' && typeof block.content === 'string') {
      tokens += Math.ceil(block.content.length / 4);
    }
  }
  return tokens;
}

/**
 * Cut a message's text and string tool-result content to `maxTokens`, with
 * the truncator the autobiographical strategy uses (`capContent`). This
 * strategy's estimate counts text and string tool results alone, where the
 * autobiographical one also counts thinking and tool calls. The estimate
 * only decides whether the truncator looks: it cuts by the characters of
 * text and string results, and returns the content itself when nothing
 * needs cutting, so the two strategies cap a message alike.
 */
function truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
  return capContent(content, maxTokens, estimateTextOnlyTokens);
}
