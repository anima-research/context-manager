/**
 * Tests for per-region recall pair emission (audit gap #2).
 *
 * Pre-fix, AutobiographicalStrategy concatenated ALL selected summaries with
 * `\n\n---\n\n` separators into ONE Q/A pair placed between the head window
 * and the recent window. Per the spec audit, this is the structural
 * equivalent of Lena's dual-recall corruption pattern from Hermes: the agent
 * sees memories as a wall of summaries from another speaker, with no
 * positional or temporal coherence per individual summary.
 *
 * Post-fix, each selected summary emits as its own Q/A recall pair, sorted
 * chronologically by source-range position. The legacy combined-pair shape
 * is still available via `positionedRecallPairs: false`.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { SummaryEntry, SummaryLevel } from '../src/types/index.js';

const TEST_STORE_PATH = './test-recall-positioning';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

class TestableStrategy extends AutobiographicalStrategy {
  /** Seed an L1 against a specific source-message id. */
  seedL1Against(content: string, firstMsgId: string, lastMsgId: string): SummaryEntry {
    const entry: SummaryEntry = {
      id: `L1-${this.nextSummaryIdCounter()}`,
      level: 1,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 0,
      sourceIds: [firstMsgId, lastMsgId],
      sourceRange: { first: firstMsgId, last: lastMsgId },
      created: Date.now(),
    };
    this.pushSummary(entry);
    return entry;
  }
}

function recallEntries(
  messages: ReadonlyArray<{ participant: string; content: ContentBlock[] }>,
): Array<{ q: string; a: string }> {
  const pairs: Array<{ q: string; a: string }> = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const a = messages[i];
    const b = messages[i + 1];
    if (a.participant === 'Context Manager') {
      const q = a.content.map(c => (c.type === 'text' ? c.text : '')).join('');
      const ans = b.content.map(c => (c.type === 'text' ? c.text : '')).join('');
      pairs.push({ q, a: ans });
    }
  }
  return pairs;
}

describe('AutobiographicalStrategy — per-region recall pairs (gap #2)', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('emits one Q/A pair per selected summary, in chronological order', async () => {
    // recentWindowTokens deliberately small so the three "old" messages we
    // seed summaries against fall OUTSIDE the recent window — otherwise
    // anti-redundancy (correctly) hides summaries about messages that are
    // already shown verbatim in the recent window.
    const strategy = new TestableStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 8,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    // Three "old" messages whose summaries we'll test, plus one message
    // big enough to dominate the recent window so the older three fall out.
    const m1 = manager.addMessage('user', textBlock('first'));
    const m2 = manager.addMessage('user', textBlock('second'));
    const m3 = manager.addMessage('user', textBlock('third'));
    manager.addMessage('user', textBlock('latest message ' + 'X'.repeat(50)));

    // Seed three summaries. Seed in the *opposite* order from chronological
    // so we can verify the strategy sorts them by source position rather
    // than by creation order.
    strategy.seedL1Against('summary about THIRD', m3, m3);
    strategy.seedL1Against('summary about FIRST', m1, m1);
    strategy.seedL1Against('summary about SECOND', m2, m2);

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const pairs = recallEntries(compiled.messages);

    assert.equal(pairs.length, 3, 'should emit 3 distinct recall pairs');

    // Order should follow source position (m1 < m2 < m3), not seed order.
    assert.match(pairs[0].a, /FIRST/, 'first pair must cover m1');
    assert.match(pairs[1].a, /SECOND/, 'second pair must cover m2');
    assert.match(pairs[2].a, /THIRD/, 'third pair must cover m3');

    // No --- separators (the legacy concat-marker should be gone).
    for (const p of pairs) {
      assert.ok(!p.a.includes('---'), `pair ${p.q} unexpectedly contains '---' separator`);
    }

    manager.close();
  });

  it('renders the recall header template with summary id by default', async () => {
    const strategy = new TestableStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 8,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const m1 = manager.addMessage('user', textBlock('foo'));
    manager.addMessage('user', textBlock('latest ' + 'X'.repeat(50)));
    const seeded = strategy.seedL1Against('content', m1, m1);

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const pairs = recallEntries(compiled.messages);

    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].q, `[Recall ${seeded.id}]`, 'default template should be [Recall {id}]');
  });

  it('honors a custom recall header template with all substitutions', async () => {
    const strategy = new TestableStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 8,
      recallHeaderTemplate: 'memory {id} (L{level}) covering {first}..{last}',
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const m1 = manager.addMessage('user', textBlock('foo'));
    const m2 = manager.addMessage('user', textBlock('bar'));
    manager.addMessage('user', textBlock('latest ' + 'X'.repeat(50)));
    const seeded = strategy.seedL1Against('content', m1, m2);

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const pairs = recallEntries(compiled.messages);

    assert.equal(pairs[0].q, `memory ${seeded.id} (L1) covering ${m1}..${m2}`);
  });

  it('reverts to combined single-pair shape when positionedRecallPairs is false', async () => {
    const strategy = new TestableStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 8,
      positionedRecallPairs: false,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const m1 = manager.addMessage('user', textBlock('a'));
    const m2 = manager.addMessage('user', textBlock('b'));
    const m3 = manager.addMessage('user', textBlock('c'));
    manager.addMessage('user', textBlock('latest ' + 'X'.repeat(50)));
    strategy.seedL1Against('A', m1, m1);
    strategy.seedL1Against('B', m2, m2);
    strategy.seedL1Against('C', m3, m3);

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const pairs = recallEntries(compiled.messages);

    assert.equal(pairs.length, 1, 'legacy mode should emit a single combined pair');
    assert.equal(pairs[0].q, 'What do you remember from earlier?');
    assert.match(pairs[0].a, /A\n\n---\n\nB\n\n---\n\nC/);
  });

  it('refuses (OverBudgetError) rather than dropping recall pairs the budget cannot hold', async () => {
    // Pre-invariant this test asserted PARTIAL emission — some pairs silently
    // dropped under pressure. Each pair is the only representation of its
    // source message, so a dropped pair is a memory hole; the fatal coverage
    // invariant (76e95a0) forbids it. The select refuses the turn instead.
    const strategy = new TestableStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 8,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const m1 = manager.addMessage('user', textBlock('a'));
    const m2 = manager.addMessage('user', textBlock('b'));
    const m3 = manager.addMessage('user', textBlock('c'));
    manager.addMessage('user', textBlock('latest ' + 'X'.repeat(50)));

    // Each summary is ~400 chars (~100 tokens). Three pairs ≈ 300+ tokens of recall.
    const big = 'X'.repeat(400);
    strategy.seedL1Against(big + ' first', m1, m1);
    strategy.seedL1Against(big + ' second', m2, m2);
    strategy.seedL1Against(big + ' third', m3, m3);

    await assert.rejects(
      manager.compile({ maxTokens: 250, reserveForResponse: 0 }),
      (err: unknown) => (err as Error).name === 'OverBudgetError',
    );
    manager.close();
  });

  it('emits every recall pair within the grace window instead of dropping', async () => {
    cleanup();
    const strategy = new TestableStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 8,
      // Selection still targets maxTokens; emission may overshoot into the
      // grace window rather than silently dropping covered history.
      overBudgetGraceRatio: 1.0,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const m1 = manager.addMessage('user', textBlock('a'));
    const m2 = manager.addMessage('user', textBlock('b'));
    const m3 = manager.addMessage('user', textBlock('c'));
    manager.addMessage('user', textBlock('latest ' + 'X'.repeat(50)));

    const big = 'X'.repeat(400);
    strategy.seedL1Against(big + ' first', m1, m1);
    strategy.seedL1Against(big + ' second', m2, m2);
    strategy.seedL1Against(big + ' third', m3, m3);

    const compiled = await manager.compile({ maxTokens: 250, reserveForResponse: 0 });
    const pairs = recallEntries(compiled.messages);
    assert.equal(pairs.length, 3, 'grace window must admit all covering pairs');
    manager.close();
  });
});
