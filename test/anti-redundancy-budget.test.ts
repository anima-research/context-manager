/**
 * Bug 6.9: anti-redundancy × budget-cap = silent memory holes.
 *
 * `getAntiRedundantSummaries` excludes an L2 when ALL of its source L1s are
 * in the CANDIDATE shown-set — computed BEFORE budget selection. When the
 * budget cap (e.g. KnowledgeStrategy's research L1 cap) then drops some of
 * those L1s, their parent L2 was already excluded, so the covered history
 * appears at NEITHER level — unrecoverable until a later merge changes the
 * shown-set. Long research-heavy runs lose their oldest research memories
 * entirely and the agent re-researches (a token-burning feedback loop).
 *
 * Fix: a post-selection coverage-repair pass in selectHierarchical
 * re-includes an excluded L2/L3 whose children did not all survive budget
 * selection.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, KnowledgeStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { ContextEntry, SummaryEntry } from '../src/types/index.js';

const TEST_STORE_PATH = './test-anti-redundancy-budget';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

describe('Anti-redundancy vs budget cap (memory-hole repair)', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('re-includes an excluded L2 when the budget drops its L1 children', async () => {
    cleanup();
    const strategy = new KnowledgeStrategy({
      targetChunkTokens: 20, // research max = 40 → one tool pair per chunk
      headWindowTokens: 0,
      recentWindowTokens: 0,
      autoTickOnNewMessage: false,
      // Tight L1 budget: research cap = 0.3 * 1000 = 300 tokens → only 3 of
      // the 10 research L1s (100 tokens each) survive selection.
      l1BudgetTokens: 1000,
      l2BudgetTokens: 0,
      l3BudgetTokens: 0,
      researchL1BudgetCap: 0.3,
    });

    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    // 10 research tool pairs → 10 chunks of [tool_use, tool_result].
    for (let k = 0; k < 10; k++) {
      manager.addMessage('Claude', [
        { type: 'tool_use', id: `tu-${k}`, name: 'mcpl:search', input: { q: 'x'.repeat(120) } },
      ] as ContentBlock[]);
      manager.addMessage('User', [
        { type: 'tool_result', toolUseId: `tu-${k}`, content: 'r'.repeat(120) },
      ] as ContentBlock[]);
    }

    const s = strategy as unknown as {
      chunks: Array<{ messages: Array<{ id: string }> }>;
      summaries: SummaryEntry[];
      rebuildChunks: (store: unknown) => void;
    };
    const internals = manager as unknown as {
      messageStore: { createView(): unknown };
      contextLog: { createView(): unknown };
    };
    s.rebuildChunks(internals.messageStore);

    assert.ok(s.chunks.length >= 6, `need several chunks to exercise the cap, got ${s.chunks.length}`);

    // Inject one research L1 per chunk (sourceIds exactly matching the chunk
    // key, so rebuildChunks re-links them as compressed and the raw fallback
    // does NOT re-emit these messages), plus one L2 covering ALL the L1s.
    // The L1s are unmerged — the candidate shown-set contains all of them, so
    // pre-fix anti-redundancy excludes the L2 outright.
    const l1Ids: string[] = [];
    const allMsgIds: string[] = [];
    s.chunks.forEach((chunk, i) => {
      const msgIds = chunk.messages.map(m => m.id);
      allMsgIds.push(...msgIds);
      const id = `L1-${i}`;
      l1Ids.push(id);
      s.summaries.push({
        id,
        level: 1,
        content: `[[R${i}]] research memory ${i}`,
        tokens: 100,
        sourceLevel: 0,
        sourceIds: msgIds,
        sourceRange: { first: msgIds[0], last: msgIds[msgIds.length - 1] },
        created: Date.now(),
        phaseType: 'research',
      });
    });
    s.summaries.push({
      id: 'L2-0',
      level: 2,
      content: '[[L2COVER]] consolidated research memory',
      tokens: 150,
      sourceLevel: 1,
      sourceIds: l1Ids,
      sourceRange: { first: allMsgIds[0], last: allMsgIds[allMsgIds.length - 1] },
      created: Date.now(),
    });

    // Render with a generous overall budget — the hole is created by the
    // research cap, not by overall exhaustion.
    const entries = strategy.select(
      internals.messageStore.createView() as never,
      internals.contextLog.createView() as never,
      { maxTokens: 50000, reserveForResponse: 0 },
    ) as ContextEntry[];

    const renderedText = entries
      .map(e => e.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n'))
      .join('\n');
    const rawMsgIds = new Set(entries.map(e => e.sourceMessageId).filter(Boolean));

    // Which L1s made it?
    const shownL1Indexes = new Set<number>();
    for (let i = 0; i < l1Ids.length; i++) {
      if (renderedText.includes(`[[R${i}]]`)) shownL1Indexes.add(i);
    }
    assert.ok(
      shownL1Indexes.size < l1Ids.length,
      'test setup: the research cap should drop at least one L1 (else nothing to repair)',
    );

    // The core assertion: every source message is represented at SOME level —
    // raw, via its L1, or via the L2 that covers everything.
    const l2Shown = renderedText.includes('[[L2COVER]]');
    s.chunks.forEach((chunk, i) => {
      for (const m of chunk.messages) {
        const represented =
          rawMsgIds.has(m.id as never) || shownL1Indexes.has(i) || l2Shown;
        assert.ok(
          represented,
          `message ${m.id} (chunk ${i}) is represented at no level — silent memory hole`,
        );
      }
    });

    // And specifically: since the cap dropped some L1s, the parent L2 must
    // have been re-included.
    assert.ok(l2Shown, 'excluded L2 must be re-included when its children are budget-dropped');

    await manager.close();
  });
});
