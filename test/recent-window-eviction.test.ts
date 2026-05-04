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

  it('preserves the LATEST recent-window messages when budget is tight', async () => {
    cleanup();

    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000, // big — keep all messages in the recent zone
      maxMessageTokens: 0,
      hierarchical: true,
    });

    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    // 10 recent messages each padded to ~25 tokens (~100 chars) so that a
    // tight budget forces eviction of some of them.
    for (let i = 1; i <= 10; i++) {
      const tag = String(i).padStart(2, '0');
      manager.addMessage(
        'user',
        textBlock(`msg-${tag} ${'.'.repeat(80)} body`),
      );
    }

    // Tight budget: only ~3-4 messages worth of room out of 10.
    const compiled = await manager.compile({ maxTokens: 80, reserveForResponse: 0 });

    // The pre-fix loop iterated forward and emitted msg-01, msg-02, ... breaking
    // when budget ran out. Post-fix should keep the NEWEST messages.
    const lastEntry = compiled.messages[compiled.messages.length - 1];
    assert.ok(lastEntry, 'should have at least one compiled entry');
    const lastText = lastEntry.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ');
    assert.match(
      lastText,
      /msg-10/,
      `Latest compiled entry must contain msg-10, got: "${lastText}"`,
    );

    // And the compiled tail must be a strict tail: contain msg-10 but not the
    // oldest entries that wouldn't fit.
    const allText = compiled.messages
      .flatMap(m => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ');
    assert.ok(allText.includes('msg-10'), 'msg-10 (newest) must survive eviction');
    // Expect SOME oldest message to have been evicted.
    assert.ok(!allText.includes('msg-01'), 'msg-01 (oldest) should have been evicted');

    manager.close();
  });

  it('emits surviving messages in chronological order (not reversed)', async () => {
    cleanup();

    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      maxMessageTokens: 0,
      hierarchical: true,
    });

    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    for (let i = 1; i <= 5; i++) {
      const tag = String(i).padStart(2, '0');
      manager.addMessage('user', textBlock(`msg-${tag} body content`));
    }

    // Budget large enough to keep all 5.
    const compiled = await manager.compile({ maxTokens: 1000, reserveForResponse: 0 });

    const tags = compiled.messages
      .map(m => m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join(' '))
      .map(t => {
        const m = t.match(/msg-(\d+)/);
        return m ? m[1] : null;
      })
      .filter((x): x is string => x !== null);

    assert.deepStrictEqual(
      tags,
      ['01', '02', '03', '04', '05'],
      'compiled order must be chronological',
    );

    manager.close();
  });
});

describe('Synthesised summary turn respects maxMessageTokens (postmortem bug B)', () => {
  before(() => cleanup());
  after(() => cleanup());

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
