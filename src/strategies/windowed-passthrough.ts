import { type Diagnostics, namespaceDiagnostics } from '../diagnostics.js';
import type {
  ContextStrategy,
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
} from '../types/index.js';
import { registerStateIfAbsent } from '../state-registration.js';
import { DEFAULT_AUTOBIOGRAPHICAL_CONFIG } from '../types/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { JsStore } from '@animalabs/chronicle';
import { OverBudgetError } from '../adaptive/picker.js';
import { observeStoreBranch, type StoreBranchGeneration } from '../branch-generation.js';
import { hasImage, imagesIn, inlineImageBytes, replaceImages, strippedImageSaving } from '../inline-images.js';
import { capContent, cappedPriceExtra } from './message-cap.js';

/**
 * Options for {@link WindowedPassthroughStrategy}.
 */
export interface WindowedPassthroughOptions {
  /**
   * When the window no longer fits the budget, the anchor jumps forward so
   * the new window is roughly this fraction of the usable budget (default
   * 0.5). Between jumps the anchor never moves, so compiled output between
   * re-anchors is a byte-stable prefix plus pure appends — and the strategy
   * marks that prefix for the provider's prompt cache (see
   * {@link WindowedPassthroughStrategy} on cache markers), so the accepted
   * cost is one cache miss per jump, amortized over ~(1 - fraction) × budget
   * of appended tokens, instead of the per-turn prefix churn a naively
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
   * strategy's byte wall); 0 disables that dimension. A strip changes the
   * bytes at that position, which the cache-marker placement absorbs by
   * measurement (the marker falls back to the deepest byte-stable entry).
   */
  maxLiveImages?: number;
  imageStripDepthTokens?: number;
  maxLiveImageBytes?: number;
}

/** Text substituted for an image block once it leaves the live-image window
 *  (identical to the autobiographical strategy's placeholder, so a merged
 *  timeline reads the same in both agents' windows). */
const IMAGE_PLACEHOLDER = '[image not shown: this context keeps only some images]';
/** Mirrors `AutobiographicalStrategy.DEFAULT_MAX_LIVE_IMAGE_BYTES` (protected there). */
const DEFAULT_MAX_LIVE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Passthrough over a recent window, anchored at a sequence number.
 *
 * Built for side-process agents (issue #77's subconscious) whose view is a
 * merged multi-slot timeline and whose durable output is what they deliver
 * elsewhere: no memory pyramid, no compression, no coverage machinery —
 * just "everything since the anchor," with the anchor moved only in coarse
 * jumps (see {@link WindowedPassthroughOptions.reAnchorFraction}) and moved
 * outward only explicitly ({@link setAnchor}, e.g. to the start of the
 * oldest active tune-out).
 *
 * **Branch scoping.** The anchor persists in a chronicle snapshot slot, so
 * it survives restarts and follows branches like every other piece of
 * durable state. The in-memory copy is re-derived from the slot whenever
 * the store's current branch is observed to have changed — including
 * host-side switches that bypass `ContextManager.switchBranch` (undo/redo
 * switch the chronicle directly) — and a persisted value that cannot name
 * a position on the current branch (past its head) resets to 0 rather than
 * yielding an empty window.
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
 * budget the strategy refuses with {@link OverBudgetError} (the framework's
 * over-budget breaker handles it) rather than emitting a request the
 * provider will reject. Previews report the oversized window instead.
 */
export class WindowedPassthroughStrategy implements ContextStrategy {
  readonly name = 'windowed-passthrough';
  readonly maxMessageTokens?: number;
  /** Renders the window raw; history before the anchor is not rendered. */
  readonly renderedForms = ['raw', 'omitted'] as const;

  private readonly reAnchorFraction: number;
  private readonly anchorStateIdOverride?: string;
  private readonly maxLiveImages: number;
  private readonly imageStripDepthTokens: number;
  private readonly maxLiveImageBytes: number;

  private anchor: Sequence = 0;
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

  constructor(options: WindowedPassthroughOptions = {}) {
    const fraction = options.reAnchorFraction ?? 0.5;
    if (!(fraction > 0 && fraction <= 1)) {
      throw new Error(`reAnchorFraction must be in (0, 1], got ${fraction}`);
    }
    this.reAnchorFraction = fraction;
    this.anchorStateIdOverride = options.anchorStateId;
    this.maxMessageTokens = options.maxMessageTokens;
    this.maxLiveImages = options.maxLiveImages ?? DEFAULT_AUTOBIOGRAPHICAL_CONFIG.maxLiveImages ?? 0;
    this.imageStripDepthTokens =
      options.imageStripDepthTokens ?? DEFAULT_AUTOBIOGRAPHICAL_CONFIG.imageStripDepthTokens ?? 0;
    this.maxLiveImageBytes = options.maxLiveImageBytes ?? DEFAULT_MAX_LIVE_IMAGE_BYTES;
  }

  async initialize(ctx: StrategyContext): Promise<void> {
    this.store = ctx.store;
    this.ns = ctx.namespace;
    this.stateId = this.anchorStateIdOverride ?? `${ctx.namespace}/windowed:anchor`;
    registerStateIfAbsent(this.store, { id: this.stateId, strategy: 'snapshot' });
    this.loadBranchState();
    this.loadedBranch = observeStoreBranch(this.store);
  }

  checkReadiness(): ReadinessState {
    return { ready: true };
  }

  async onNewMessage(_message: StoredMessage, _ctx: StrategyContext): Promise<void> {
    // No-op: the window is recomputed on select().
  }

  /** The current window start (inclusive), as a chronicle sequence. */
  getAnchor(): Sequence {
    this.syncToBranch();
    return this.anchor;
  }

  /**
   * Move the window start explicitly and persist it. Movement is
   * unrestricted — callers own the policy (e.g. "start of the oldest
   * active tune-out"). Moving the anchor earlier deliberately accepts one
   * full prefix invalidation.
   */
  setAnchor(sequence: Sequence): void {
    this.syncToBranch();
    if (sequence === this.anchor) return;
    this.anchor = sequence;
    this.persistAnchor();
  }

  // --------------------------------------------------------------------------
  // Branch-scoped state
  // --------------------------------------------------------------------------

  /**
   * (Re)derive every piece of in-memory branch-scoped state from the current
   * branch: the anchor from its snapshot slot (validated against the branch
   * head), and no memory of a previous compile (the last request was built
   * on another timeline, or never).
   */
  private loadBranchState(): void {
    this.anchor = 0;
    this.prevCacheKeys = null;
    if (!this.store || !this.stateId) return;
    const persisted = this.store.getStateJson(this.stateId) as { anchor?: unknown } | null;
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

    // The window: everything at or after the anchor.
    let start = 0;
    while (start < messages.length && messages[start].sequence < this.anchor) {
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

    let total = 0;
    for (let i = start; i < messages.length; i++) total += priced(i);

    if (total > maxTokens) {
      // Coarse re-anchor: jump forward so the window is ~fraction × budget,
      // then emit from the new anchor. One prefix invalidation, then
      // byte-stable prefix + appends again until the next overflow.
      const target = maxTokens * this.reAnchorFraction;
      let acc = 0;
      let newStart = messages.length;
      for (let i = messages.length - 1; i >= start; i--) {
        const tokens = priced(i);
        if (acc + tokens > target) break;
        acc += tokens;
        newStart = i;
      }
      // Always make progress: if even the newest message exceeds the
      // target, emit just that message rather than nothing — subject to the
      // hard-budget check below.
      if (newStart === messages.length && messages.length > 0) {
        newStart = messages.length - 1;
      }
      start = newStart;
      total = 0;
      for (let i = start; i < messages.length; i++) total += priced(i);
      if (!opts?.dryRun && start < messages.length) {
        const newAnchor = messages[start].sequence;
        if (newAnchor !== this.anchor) {
          this.anchor = newAnchor;
          this.persistAnchor();
          this.pendingCause = 'window';
        }
      }
    }

    // Hard budget: the progress clause above can leave a single newest
    // message larger than the usable budget. Never emit it — the provider
    // would reject the request; refuse loudly instead (the framework
    // recognizes OverBudgetError and runs its over-budget breaker), as the
    // autobiographical strategy does. Previews report rather than throw.
    if (total > maxTokens && !opts?.dryRun) {
      throw new OverBudgetError({
        budget: maxTokens,
        actual: total,
        stage: 'Windowed passthrough: the newest message alone',
        // No compression here: the window moves past this message once a
        // newer one that fits arrives (the progress clause above).
        clearedBy: ['newer-message'],
        diagnostics: {
          headTokens: 0,
          tailTokens: total,
          middleTokens: 0,
          middleChunkCount: 0,
          deepestLevel: 0,
        },
      });
    }

    const entries: ContextEntry[] = [];
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i];
      entries.push({
        index: i,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content: shaped.get(i) ?? msg.content,
      });
    }

    this.stripImages(entries, policy);
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
   * newest message, so they're select's. A message before the anchor, which select
   * leaves out, comes back as null. Like select, it first reloads the
   * branch the store has moved to. A re-anchor the next compile's budget
   * forces isn't foreseen: it moves the anchor only past a window bigger
   * than the budget allows. A body sharded under the autobiographical
   * strategy comes back shard by shard, since select sends each as its own
   * message.
   */
  renderAsNewest(store: MessageStoreView, ids: readonly MessageId[]): Array<ContentBlock[] | null> {
    this.syncToBranch();
    const messages = store.getAll();
    const at = new Map(messages.map((m, i) => [m.id, i] as const));
    const shown = (i: number): boolean => messages[i]!.sequence >= this.anchor;
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
    return ids.map((id) => rendered.get(id) ?? null);
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
   * applies.
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
  ): { strips: (boolean[] | undefined)[]; saved: number[] } {
    const strips: (boolean[] | undefined)[] = [];
    const saved: number[] = [];
    const maxLive = this.maxLiveImages;
    const depthTokens = this.imageStripDepthTokens;
    const maxLiveBytes = this.maxLiveImageBytes;
    if (maxLive === 0 && depthTokens === 0 && maxLiveBytes === 0) return { strips, saved };
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
    return { strips, saved };
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

  private persistAnchor(): void {
    if (!this.store || !this.stateId) return;
    this.store.setStateJson(this.stateId, { anchor: this.anchor });
  }
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
