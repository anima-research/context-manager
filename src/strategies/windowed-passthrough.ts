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
import type { JsStore } from '@animalabs/chronicle';

/**
 * Options for {@link WindowedPassthroughStrategy}.
 */
export interface WindowedPassthroughOptions {
  /**
   * When the window no longer fits the budget, the anchor jumps forward so
   * the new window is roughly this fraction of the usable budget (default
   * 0.5). Between jumps the anchor never moves, so compiled output between
   * re-anchors is a byte-stable prefix plus pure appends — one accepted
   * cache invalidation per jump, amortized over ~(1 - fraction) × budget of
   * appended tokens, instead of the per-turn prefix churn a naively sliding
   * front produces.
   */
  reAnchorFraction?: number;
  /**
   * Override the chronicle state id used to persist the anchor.
   * Default: `${namespace}/windowed:anchor`.
   */
  anchorStateId?: string;
  /**
   * Per-message token ceiling, surfaced as ContextStrategy.maxMessageTokens
   * (the framework truncates oversized tool results / attachments against
   * it, at storage and in-flight). Side-process agents should mirror their
   * principal's value so the two see the same truncation policy.
   */
  maxMessageTokens?: number;
}

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
 * The anchor persists in a chronicle snapshot slot, so it survives restarts
 * and follows branches like every other piece of durable state.
 */
export class WindowedPassthroughStrategy implements ContextStrategy {
  readonly name = 'windowed-passthrough';
  readonly maxMessageTokens?: number;

  private readonly reAnchorFraction: number;
  private readonly anchorStateIdOverride?: string;

  private anchor: Sequence = 0;
  private store: JsStore | null = null;
  private stateId: string | null = null;

  constructor(options: WindowedPassthroughOptions = {}) {
    const fraction = options.reAnchorFraction ?? 0.5;
    if (!(fraction > 0 && fraction <= 1)) {
      throw new Error(`reAnchorFraction must be in (0, 1], got ${fraction}`);
    }
    this.reAnchorFraction = fraction;
    this.anchorStateIdOverride = options.anchorStateId;
    this.maxMessageTokens = options.maxMessageTokens;
  }

  async initialize(ctx: StrategyContext): Promise<void> {
    this.store = ctx.store;
    this.stateId = this.anchorStateIdOverride ?? `${ctx.namespace}/windowed:anchor`;
    try {
      this.store.registerState({ id: this.stateId, strategy: 'snapshot' });
    } catch {
      /* already registered */
    }
    const persisted = this.store.getStateJson(this.stateId) as { anchor?: number } | null;
    if (persisted && typeof persisted.anchor === 'number') {
      this.anchor = persisted.anchor;
    }
  }

  checkReadiness(): ReadinessState {
    return { ready: true };
  }

  async onNewMessage(_message: StoredMessage, _ctx: StrategyContext): Promise<void> {
    // No-op: the window is recomputed on select().
  }

  /** The current window start (inclusive), as a chronicle sequence. */
  getAnchor(): Sequence {
    return this.anchor;
  }

  /**
   * Move the window start explicitly and persist it. Movement is
   * unrestricted — callers own the policy (e.g. "start of the oldest
   * active tune-out"). Moving the anchor earlier deliberately accepts one
   * full prefix invalidation.
   */
  setAnchor(sequence: Sequence): void {
    if (sequence === this.anchor) return;
    this.anchor = sequence;
    this.persistAnchor();
  }

  select(
    store: MessageStoreView,
    _log: ContextLogView,
    budget: TokenBudget,
    opts?: SelectOptions,
  ): ContextEntry[] {
    const maxTokens = budget.maxTokens - budget.reserveForResponse;
    const messages = store.getAll();

    // The window: everything at or after the anchor.
    let start = 0;
    while (start < messages.length && messages[start].sequence < this.anchor) {
      start++;
    }

    let total = 0;
    for (let i = start; i < messages.length; i++) {
      total += store.estimateTokens(messages[i]);
    }

    if (total > maxTokens) {
      // Coarse re-anchor: jump forward so the window is ~fraction × budget,
      // then emit from the new anchor. One prefix invalidation, then
      // byte-stable prefix + appends again until the next overflow.
      const target = maxTokens * this.reAnchorFraction;
      let acc = 0;
      let newStart = messages.length;
      for (let i = messages.length - 1; i >= start; i--) {
        const tokens = store.estimateTokens(messages[i]);
        if (acc + tokens > target) break;
        acc += tokens;
        newStart = i;
      }
      // Always make progress: if even the newest message exceeds the
      // target, emit just that message rather than nothing.
      if (newStart === messages.length && messages.length > 0) {
        newStart = messages.length - 1;
      }
      start = newStart;
      if (!opts?.dryRun && start < messages.length) {
        const newAnchor = messages[start].sequence;
        if (newAnchor !== this.anchor) {
          this.anchor = newAnchor;
          this.persistAnchor();
        }
      }
    }

    const entries: ContextEntry[] = [];
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i];
      entries.push({
        index: i,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content: msg.content,
      });
    }
    return entries;
  }

  private persistAnchor(): void {
    if (!this.store || !this.stateId) return;
    this.store.setStateJson(this.stateId, { anchor: this.anchor });
  }
}
