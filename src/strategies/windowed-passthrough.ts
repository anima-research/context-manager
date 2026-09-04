import type {
  ContextStrategy,
  StrategyContext,
  ReadinessState,
  MessageStoreView,
  ContextLogView,
  TokenBudget,
  ContextEntry,
  StoredMessage,
  SelectOptions,
  Sequence,
} from '../types/index.js';
import { DEFAULT_AUTOBIOGRAPHICAL_CONFIG } from '../types/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { JsStore } from '@animalabs/chronicle';
import { OverBudgetError } from '../adaptive/picker.js';
import { observeStoreBranch, type StoreBranchGeneration } from '../branch-generation.js';

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
   * tool-result content (the autobiographical strategy's idiom, same
   * `[truncated — original was N tokens]` marker), and surfaced as
   * `ContextStrategy.maxMessageTokens` so the framework's storage-time
   * tool-result clamp mirrors it. Side-process agents should mirror their
   * principal's value so the two see the same truncation policy. Images are
   * not subject to this cap; they are governed by the live-image policy
   * below. Unset = no truncation, in which case a single message larger
   * than the usable budget is refused (see {@link OverBudgetError}).
   */
  maxMessageTokens?: number;
  /**
   * Live-image policy, mirroring `AutobiographicalConfig`: an image is
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
const IMAGE_PLACEHOLDER = '[image dropped from live context]';
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

  private readonly reAnchorFraction: number;
  private readonly anchorStateIdOverride?: string;
  private readonly maxLiveImages: number;
  private readonly imageStripDepthTokens: number;
  private readonly maxLiveImageBytes: number;

  private anchor: Sequence = 0;
  private store: JsStore | null = null;
  private stateId: string | null = null;
  /** The branch (name + generation) the in-memory state was loaded from. */
  private loadedBranch: StoreBranchGeneration | null = null;
  /** Content identity of the previous committed compile's entries. */
  private prevCacheKeys: string[] | null = null;

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
    this.stateId = this.anchorStateIdOverride ?? `${ctx.namespace}/windowed:anchor`;
    try {
      this.store.registerState({ id: this.stateId, strategy: 'snapshot' });
    } catch {
      /* already registered */
    }
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
      console.warn(
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
    // will actually be sent. Truncation follows the autobiographical
    // strategy: a capped message is priced at the cap plus its marker.
    const cap = this.maxMessageTokens ?? 0;
    const shaped = new Map<number, ContentBlock[]>();
    const priced = (i: number): number => {
      const msg = messages[i];
      const estimate = store.estimateTokens(msg);
      if (cap <= 0) return estimate;
      const content = truncateContent(msg.content, cap);
      if (content === msg.content) return estimate;
      shaped.set(i, content);
      return Math.min(estimate, cap + 50);
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

    this.applyImageStripping(entries, messages, store);
    if (!opts?.dryRun) this.placeCacheMarkers(entries);
    return entries;
  }

  // --------------------------------------------------------------------------
  // Live-image policy (mirrors AutobiographicalStrategy.applyImageStripping)
  // --------------------------------------------------------------------------

  private applyImageStripping(
    entries: ContextEntry[],
    messages: StoredMessage[],
    store: MessageStoreView,
  ): void {
    const maxLive = this.maxLiveImages;
    const depthTokens = this.imageStripDepthTokens;
    const maxLiveBytes = this.maxLiveImageBytes;
    if (maxLive === 0 && depthTokens === 0 && maxLiveBytes === 0) return;

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
    // Entries are in timeline order; the policy counts newest-first.
    for (let e = entries.length - 1; e >= 0; e--) {
      const entry = entries[e];
      if (!entry.content.some((b) => b.type === 'image')) continue;
      const tooDeep = depthTokens > 0 && entry.index < stripStart;
      entry.content = entry.content.map((block) => {
        if (block.type !== 'image') return block;
        const bytes = imageBlockBytes(block);
        const overCount = maxLive > 0 && keptImages >= maxLive;
        const overBytes = maxLiveBytes > 0 && keptImageBytes + bytes > maxLiveBytes;
        if (tooDeep || overCount || overBytes) {
          return { type: 'text', text: IMAGE_PLACEHOLDER } as ContentBlock;
        }
        keptImages++;
        keptImageBytes += bytes;
        return block;
      });
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

function imageBlockBytes(block: unknown): number {
  const src = (block as { source?: { data?: string } }).source;
  return typeof src?.data === 'string' ? src.data.length : 0;
}

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
 * Surrogate-safe string slice. Avoids cutting between a UTF-16 surrogate pair
 * which would produce invalid JSON ("no low surrogate in string" API errors).
 */
function safeSlice(str: string, start: number, end: number): string {
  if (end >= str.length) return str.slice(start);
  const code = str.charCodeAt(end);
  if (code >= 0xDC00 && code <= 0xDFFF) {
    return str.slice(start, end - 1);
  }
  return str.slice(start, end);
}

/**
 * Truncate a message's text / string tool-result content to fit within
 * `maxTokens` — the autobiographical strategy's `truncateContent`, verbatim
 * in behavior: text blocks are cut with a `[truncated — original was N
 * tokens]` marker; tool_result blocks are always kept (the API requires a
 * result for every tool_use), with their content cut or replaced by an
 * omission notice; every other block passes through. Returns the original
 * array when nothing needed cutting.
 */
function truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
  if (maxTokens <= 0) return content;
  if (estimateTextOnlyTokens(content) <= maxTokens) return content;

  const maxChars = maxTokens * 4;
  const result: ContentBlock[] = [];
  let remaining = maxChars;

  for (const block of content) {
    if (block.type === 'text') {
      if (remaining <= 0) continue;
      if (block.text.length <= remaining) {
        result.push(block);
        remaining -= block.text.length;
      } else {
        result.push({
          type: 'text',
          text: safeSlice(block.text, 0, remaining) + '\n\n[truncated — original was ' +
            Math.ceil(block.text.length / 4) + ' tokens]',
        });
        remaining = 0;
      }
    } else if (block.type === 'tool_result') {
      if (typeof block.content === 'string') {
        const text = block.content;
        if (remaining <= 0) {
          result.push({ ...block, content: '[content omitted — context budget exceeded]' });
        } else if (text.length > remaining) {
          result.push({
            ...block,
            content: safeSlice(text, 0, remaining) + '\n\n[truncated — original was ' +
              Math.ceil(text.length / 4) + ' tokens]',
          });
          remaining = 0;
        } else {
          result.push(block);
          remaining -= text.length;
        }
      } else {
        result.push(block);
      }
    } else {
      result.push(block);
    }
  }
  return result;
}
