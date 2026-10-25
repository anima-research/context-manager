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
} from '../types/index.js';
import { OverBudgetError } from '../adaptive/picker.js';
import { holdsSystemChange, systemChangePositions } from '../system-changes.js';

/**
 * Simple passthrough strategy that copies all messages to context.
 * No compression, no background work. Always ready.
 * Good for testing and simple use cases.
 */
export class PassthroughStrategy implements ContextStrategy {
  readonly name = 'passthrough';
  /**
   * Renders history raw; when it cannot all fit, the oldest is not rendered,
   * but for its system changes, and when those alone, or those and the
   * newest conversation message, can't fit, a committing select refuses with
   * OverBudgetError.
   */
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
    budget: TokenBudget,
    opts?: SelectOptions,
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
      return this.selectFromEnd(store, maxTokens, opts);
    }

    return entries;
  }

  /**
   * Select messages from the end when we can't fit everything. A system
   * change before the cut is kept too, in its order ahead of the rest: it
   * changes the tools and system text everything after it was read with
   * (system-changes.ts). Its tokens are set aside first, and when they alone
   * exceed the budget a committing select refuses: only the caller, by
   * consolidating its changes, can clear that. A change is no conversation
   * message, so when the newest conversation message doesn't fit beside
   * them a committing select refuses too, as the windowed strategy does: a
   * budget refusal, which a newer conversation message that fits clears
   * while they leave room. Without changes, a select that fits no message
   * sends nothing, as on main. Where a change can go in a request is
   * membrane's to say (after a user turn): this strategy can't tell a user
   * participant from another, and membrane refuses a request holding a
   * change it can't place.
   */
  private selectFromEnd(store: MessageStoreView, maxTokens: number, opts?: SelectOptions): ContextEntry[] {
    const messages = store.getAll();
    const changes = systemChangePositions(messages);
    let changeTokens = 0;
    for (const i of changes) changeTokens += store.estimateTokens(messages[i]!);
    let totalTokens = changeTokens;
    if (totalTokens > maxTokens && changes.length > 0 && !opts?.dryRun) {
      throw new OverBudgetError({
        budget: maxTokens,
        actual: totalTokens,
        stageId: 'passthrough-system-changes',
        clearedBy: [],
        diagnostics: { headTokens: totalTokens, tailTokens: 0, middleTokens: 0, middleChunkCount: 0, deepestLevel: 0 },
      });
    }

    // Work backwards from the most recent
    let start = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (holdsSystemChange(msg.content)) continue; // counted above
      const tokens = store.estimateTokens(msg);

      if (totalTokens + tokens > maxTokens) {
        break;
      }

      totalTokens += tokens;
      start = i;
    }
    // A store of changes alone gets here only when they're over the budget:
    // select() sends every message when all fit. A committing select refused
    // them above, and a dry one skips this refusal too.
    if (start === messages.length && changes.length > 0 && !opts?.dryRun) {
      let newest = messages.length - 1;
      while (holdsSystemChange(messages[newest]!.content)) newest--;
      const newestTokens = store.estimateTokens(messages[newest]!);
      throw new OverBudgetError({
        budget: maxTokens,
        actual: changeTokens + newestTokens,
        stageId: 'passthrough-changes-and-newest-message',
        clearedBy: changeTokens < maxTokens ? ['newer-message'] : [],
        diagnostics: { headTokens: changeTokens, tailTokens: newestTokens, middleTokens: 0, middleChunkCount: 0, deepestLevel: 0 },
      });
    }

    const entries: ContextEntry[] = [];
    const add = (i: number): void => {
      const msg = messages[i]!;
      entries.push({
        index: i,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content: msg.content,
      });
    };
    for (const i of changes) if (i < start) add(i);
    for (let i = start; i < messages.length; i++) add(i);
    return entries;
  }
}
