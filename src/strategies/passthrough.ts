import type {
  ContextStrategy,
  StrategyContext,
  ReadinessState,
  MessageStoreView,
  ContextLogView,
  TokenBudget,
  ContextEntry,
  StoredMessage,
} from '../types/index.js';

/**
 * Simple passthrough strategy that copies all messages to context.
 * No compression, no background work. Always ready.
 * Good for testing and simple use cases.
 */
export class PassthroughStrategy implements ContextStrategy {
  readonly name = 'passthrough';
  /** Renders history raw; when it cannot all fit, the oldest is not rendered. */
  readonly renderedForms = ['raw', 'omitted'] as const;

  checkReadiness(): ReadinessState {
    return { ready: true };
  }

  async onNewMessage(message: StoredMessage, ctx: StrategyContext): Promise<void> {
    // No-op: context is rebuilt on select()
  }

  select(
    store: MessageStoreView,
    _log: ContextLogView,
    budget: TokenBudget
  ): ContextEntry[] {
    const messages = store.getAll();
    const entries: ContextEntry[] = [];
    let totalTokens = 0;
    const maxTokens = budget.maxTokens - budget.reserveForResponse;

    // Add messages until we hit the budget
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const tokens = store.estimateTokens(msg);

      if (totalTokens + tokens > maxTokens) {
        // If we're over budget, start from the end and work backwards
        break;
      }

      entries.push({
        index: i,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content: msg.content,
      });

      totalTokens += tokens;
    }

    // If we hit the limit before adding all messages,
    // keep the most recent ones that fit
    if (entries.length < messages.length) {
      return this.selectFromEnd(store, maxTokens);
    }

    return entries;
  }

  /**
   * Select messages from the end when we can't fit everything.
   */
  private selectFromEnd(store: MessageStoreView, maxTokens: number): ContextEntry[] {
    const messages = store.getAll();
    const entries: ContextEntry[] = [];
    let totalTokens = 0;

    // Work backwards from the most recent
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const tokens = store.estimateTokens(msg);

      if (totalTokens + tokens > maxTokens) {
        break;
      }

      entries.unshift({
        index: i,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content: msg.content,
      });

      totalTokens += tokens;
    }

    return entries;
  }
}
