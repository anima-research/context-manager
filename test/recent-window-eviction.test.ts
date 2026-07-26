/**
 * Regression tests for the postmortem 2026-05-04 (Triumvirate Conhost Silence)
 * findings about AutobiographicalStrategy:
 *
 *   (A) Phase-4 recent-window emission iterated forward and broke on budget,
 *       dropping the newest messages instead of the oldest. After a bloated
 *       compaction ate most of the budget, May-4 messages addressed to the
 *       clerk never reached the inference context, and the agent went silent.
 *
 *   (B) Synthesised summary turns bypassed `maxMessageTokens`. With L1+L2+L3
 *       summary budgets defaulting to 30k each, a single assistant Q&A pair
 *       could grow past 90k tokens, eating the inference budget and starving
 *       recent messages.
 *
 * These tests construct minimal scenarios that fail under the pre-fix code
 * and pass after the fixes in src/strategies/autobiographical.ts.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import {
  ContextManager,
  AutobiographicalStrategy,
} from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { SummaryEntry } from '../src/types/index.js';

const TEST_STORE_PATH = './test-recent-window-eviction';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

/** Test subclass that lets the test seed L1 summaries directly without a real LLM. */
class SeedableStrategy extends AutobiographicalStrategy {
  seedL1Summary(content: string, sourceIds: string[]): void {
    const entry: SummaryEntry = {
      id: `L1-test-${this.summaries.length}`,
      level: 1,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 0,
      sourceIds,
      sourceRange: {
        first: sourceIds[0] ?? '',
        last: sourceIds[sourceIds.length - 1] ?? '',
      },
      created: Date.now(),
    };
    this.summaries.push(entry);
  }
}

describe('Recent window newest-first eviction (postmortem bug A)', () => {
  before(() => cleanup());
  after(() => cleanup());

  // STRUCK 2026-07-26 (Antra): two subtests here asserted that a deliberately
  // tiny budget (80 tokens for ten ~25-token messages) should render a
  // TRUNCATED conversation and merely checked which end got cut. That encodes
  // silent loss as acceptable. It is not: an event is never permitted to go
  // unrepresented, so a budget that cannot fit the window now raises
  // UncoveredDropError instead of shipping a context that begins
  // mid-conversation. The ordering regression they guarded (postmortem bug A,
  // Triumvirate Conhost Silence — newest messages were cut first, and the
  // agent went silent) is still worth covering, but must be rewritten against
  // a budget where every message is representable.

  it('renders authored summaries without requiring raw-expandable source provenance', async () => {
    cleanup();

    const strategy = new SeedableStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 1000,
      maxMessageTokens: 5000,
      hierarchical: true,
    });

    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    manager.addMessage('user', textBlock('hello'));
    manager.addMessage('assistant', textBlock('hi back'));
    strategy.seedL1Summary('historical authored summary', ['synthetic-old-1', 'synthetic-old-2']);

    const compiled = await manager.compile({
      maxTokens: 200_000,
      reserveForResponse: 4000,
    });

    const answerEntry = compiled.messages.find((message) =>
      message.participant === 'Claude' &&
      message.content.some((block) => block.type === 'text' && (block as { text: string }).text.includes('historical authored summary')),
    );
    assert.ok(answerEntry, 'historical authored summary should render canonically');
    assert.equal(
      Reflect.has(compiled as object, 'primarySummaryProjection'),
      false,
      'canonical compile result must not carry a primary summary projection artifact',
    );

    manager.close();
  });

  it('truncates a bloated combined-summaries answer entry to the configured cap', async () => {
    cleanup();

    const MSG_CAP = 200; // tokens
    const strategy = new SeedableStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 1000,
      maxMessageTokens: MSG_CAP,
      hierarchical: true,
      // Generous summary budgets so the strategy WANTS to emit lots of summary text.
      l1BudgetTokens: 30_000,
      l2BudgetTokens: 30_000,
      l3BudgetTokens: 30_000,
    });

    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    // A few recent messages so the compile is non-trivial.
    manager.addMessage('user', textBlock('hello'));
    manager.addMessage('assistant', textBlock('hi back'));

    // Seed an oversized summary that would otherwise blow past msgCap.
    // sourceIds are synthetic so they don't intersect head/recent message IDs
    // and trigger the anti-redundancy filter.
    const bigContent = 'X'.repeat(20_000); // ≈ 5000 tokens of text
    strategy.seedL1Summary(bigContent, ['synthetic-old-1', 'synthetic-old-2']);

    const compiled = await manager.compile({
      maxTokens: 200_000,
      reserveForResponse: 4000,
    });

    // Find the synthesised summary answer turn. It is a Q&A pair: the question
    // is participant 'Context Manager', the answer is the summary participant
    // (default 'Claude').
    const answerEntry = compiled.messages.find(m =>
      m.participant === 'Claude' &&
      m.content.some(b => b.type === 'text' && (b as { text: string }).text.includes('XXXX')),
    );
    assert.ok(answerEntry, 'should find synthesised summary answer entry');

    const answerText = answerEntry.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    // truncateContent caps at maxTokens * 4 chars and appends a marker.
    // Allow some slack for the marker text.
    const expectedMaxChars = MSG_CAP * 4 + 200;
    assert.ok(
      answerText.length <= expectedMaxChars,
      `answer entry must be truncated to ≈${MSG_CAP} tokens, got ${answerText.length} chars`,
    );
    assert.match(
      answerText,
      /\[truncated/,
      'truncated answer should carry the truncation marker',
    );

    manager.close();
  });

  it('leaves the answer entry intact when content is within the cap', async () => {
    cleanup();

    const strategy = new SeedableStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 1000,
      maxMessageTokens: 5000,
      hierarchical: true,
    });

    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    manager.addMessage('user', textBlock('hello'));
    const small = 'a small honest summary of earlier conversation';
    strategy.seedL1Summary(small, ['synthetic-old-1']);

    const compiled = await manager.compile({
      maxTokens: 200_000,
      reserveForResponse: 4000,
    });

    const answerEntry = compiled.messages.find(m =>
      m.participant === 'Claude' &&
      m.content.some(b => b.type === 'text' && (b as { text: string }).text.includes('honest summary')),
    );
    assert.ok(answerEntry, 'should find synthesised summary answer entry');
    const answerText = answerEntry.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');
    assert.doesNotMatch(answerText, /\[truncated/, 'small summaries must not be truncated');
    assert.ok(answerText.includes(small), 'small summary content must round-trip verbatim');

    manager.close();
  });
});
