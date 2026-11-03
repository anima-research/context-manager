import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy, UncoveredDropError } from '../src/index.js';
import type { AutobiographicalOptions } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { SummaryEntry } from '../src/types/index.js';

const TEST_STORE_PATH = './test-select-path-rules';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }];
}

class SeededStrategy extends AutobiographicalStrategy {
  remember(messageId: string, level: number, marker: string, tokens: number): void {
    let sources = [messageId];
    let child: SummaryEntry | undefined;
    for (let at = 1; at <= level; at++) {
      const top = at === level;
      const entry: SummaryEntry = {
        id: `L${at}-of-${messageId}`,
        level: at,
        content: top ? `${marker} remembered` : `merged at level ${at}`,
        tokens: top ? tokens : 10,
        sourceLevel: at - 1,
        sourceIds: sources,
        sourceRange: { first: messageId, last: messageId },
        created: Date.now(),
      };
      if (child) child.mergedInto = entry.id;
      this.summaries.push(entry);
      child = entry;
      sources = [entry.id];
    }
  }
}

async function open(options: AutobiographicalOptions): Promise<{ manager: ContextManager; strategy: SeededStrategy }> {
  cleanup();
  const strategy = new SeededStrategy({ headWindowTokens: 0, autoTickOnNewMessage: false, ...options });
  const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
  return { manager, strategy };
}

function rememberRemoved(manager: ContextManager, strategy: SeededStrategy, level: number, count: number, tokens: number): void {
  for (let i = 0; i < count; i++) {
    const messageId = manager.addMessage('User', text(`remembered ${level}-${i}`));
    strategy.remember(messageId, level, `[[L${level}-${i}]]`, tokens);
    manager.removeMessage(messageId);
  }
}

function countSent(sent: string, level: number, count: number): number {
  return [...Array(count).keys()].filter((i) => sent.includes(`[[L${level}-${i}]]`)).length;
}

function sentText(messages: Array<{ content: ContentBlock[] }>): string {
  return messages
    .flatMap((message) => message.content)
    .map((block) => (block.type === 'text' ? (block as { text: string }).text : ''))
    .join('\n');
}

describe('threshold select rules', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('a recent-window eviction is refused, and the refusal names the tool_result it leaves out with its evicted call', async () => {
    const { manager } = await open({ recentWindowTokens: 100_000 });
    const oldest = manager.addMessage('User', text('a'.repeat(400)));
    const call = manager.addMessage('Claude', [
      { type: 'tool_use', id: 'tu-1', name: 'read', input: { q: 'x'.repeat(4000) } },
    ] as ContentBlock[]);
    const result = manager.addMessage('User', [
      { type: 'tool_result', toolUseId: 'tu-1', content: 'r'.repeat(400) },
    ] as ContentBlock[]);
    manager.addMessage('Claude', text('b'.repeat(400)));
    manager.addMessage('User', text('c'.repeat(400)));

    await assert.rejects(manager.compile({ maxTokens: 1000, reserveForResponse: 0 }), (err: unknown) => {
      assert.ok(err instanceof UncoveredDropError, `expected UncoveredDropError, got ${String(err)}`);
      assert.deepEqual([...err.droppedIds].sort(), [oldest, call, result].sort());
      return true;
    });
    manager.close();
  });

  it("an L2 selection takes l2BudgetTokens plus what L3 left of l3BudgetTokens, and no more", async () => {
    const { manager, strategy } = await open({ recentWindowTokens: 1000, l3BudgetTokens: 15_000, l2BudgetTokens: 20_000 });
    manager.addMessage('User', text('hello'));
    rememberRemoved(manager, strategy, 3, 1, 10_000);
    rememberRemoved(manager, strategy, 2, 6, 5_000);

    const sent = sentText((await manager.compile({ maxTokens: 400_000, reserveForResponse: 0 })).messages);
    assert.equal(countSent(sent, 3, 1), 1);
    assert.equal(countSent(sent, 2, 6), 5);
    manager.close();
  });

  for (const [where, options] of [
    ['', {}],
    [' with hierarchical: false, where the select supplies them', { hierarchical: false }],
  ] as const) {
    it(`at the default budgets${where}, the L3 selection stops at 30,000, and so does L2's with nothing left over`, async () => {
      const { manager, strategy } = await open({ recentWindowTokens: 1000, ...options });
      manager.addMessage('User', text('hello'));
      rememberRemoved(manager, strategy, 3, 4, 10_000);
      rememberRemoved(manager, strategy, 2, 4, 10_000);

      const sent = sentText((await manager.compile({ maxTokens: 400_000, reserveForResponse: 0 })).messages);
      assert.equal(countSent(sent, 3, 4), 3);
      assert.equal(countSent(sent, 2, 4), 3);
      manager.close();
    });
  }
});
