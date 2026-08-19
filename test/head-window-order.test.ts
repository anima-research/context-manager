/**
 * Regression tests for the "68 initiations" confabulation incident
 * (Lena, 2026-06-29..07-02).
 *
 * Root cause: `compressChunkHierarchical` emitted the raw head window
 * AFTER the prior recall pairs, so the summarizer read the chronicle's
 * opening as the most recent live conversation. For thin chunks (silent
 * turns + heartbeat traffic) it then narrated the head as fresh events
 * ("Antra came to me to explore the transformation story again…"),
 * and L2/L3 merges compounded those into runaway false memories.
 *
 * Invariants pinned here:
 *   1. In every L1 compression request, head-window content precedes
 *      the first "[CM] Recall memory" pair (chronological order).
 *   2. Chunks with (almost) no substantive text are stubbed
 *      mechanically — no LLM call, non-empty stub content.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-head-window-order';
const TEST_COMPRESSION_MODEL = 'test-compression-model';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

interface ApiMessage { participant: string; content: ContentBlock[] }

function createCapturingMembrane() {
  const calls: Array<{ messages: ApiMessage[] }> = [];
  const membrane = {
    complete: async (request: { messages: ApiMessage[] }) => {
      calls.push({ messages: request.messages });
      const inputChars = request.messages
        .flatMap((m) => m.content)
        .map((b) => (b as { text?: string }).text ?? '')
        .join('').length;
      const summary = `[mock summary] ` + 'x '.repeat(Math.max(30, Math.floor(inputChars / 10)));
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: summary }],
        usage: { input_tokens: Math.ceil(inputChars / 4), output_tokens: Math.ceil(summary.length / 4) },
      };
    },
  };
  return { membrane, calls };
}

const t = (s: string): ContentBlock => ({ type: 'text', text: s });

function flatText(m: ApiMessage): string {
  return m.content.map((b) => (b as { text?: string }).text ?? '').join(' ');
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

describe('Compression prompt ordering (confabulation regression)', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('head window precedes recall pairs in every compression request', async () => {
    cleanup();
    const { membrane, calls } = createCapturingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 80,
      headWindowTokens: 60, // covers the two sentinel opening messages
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 100, // keep this test on pure L1 calls
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    // Distinctive chronicle opening — the identity anchor.
    manager.addMessage('user', [t('HEAD_SENTINEL_OPENING can you explore a story with me')]);
    manager.addMessage('agent', [t('HEAD_SENTINEL_REPLY yes let us explore that story together')]);

    // Enough substantive traffic for several chunks → several L1 calls,
    // later ones carrying recall pairs of earlier summaries.
    const filler = (i: number) => `event ${i} ` + 'substantive words about real happenings '.repeat(8);
    for (let i = 0; i < 40; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(filler(i))]);
    }

    await drain(manager);
    assert.ok(calls.length >= 2, `expected multiple L1 calls, got ${calls.length}`);

    let checked = 0;
    for (const call of calls) {
      const texts = call.messages.map(flatText);
      const headIdx = texts.findIndex((s) => s.includes('HEAD_SENTINEL_OPENING'));
      const recallIdx = texts.findIndex((s) => s.includes('[CM] Recall memory'));
      assert.ok(headIdx >= 0, 'head window must be present in every compression request');
      if (recallIdx >= 0) {
        checked++;
        assert.ok(
          headIdx < recallIdx,
          `head window (idx ${headIdx}) must precede recall pairs (idx ${recallIdx}) — ` +
            'head-after-recalls reads as fresh live conversation and causes confabulated memories',
        );
      }
    }
    assert.ok(checked >= 1, 'expected at least one call with recall pairs to verify ordering against');
    await manager.close();
  });

  it('keeps prior recalls in Chronicle order when decimal message IDs cross 99', async () => {
    cleanup();
    const { membrane, calls } = createCapturingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 80,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 1000,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    const filler = (i: number) => `event ${i} ` + 'chronological substantive history '.repeat(8);
    for (let i = 0; i < 150; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(filler(i))]);
    }

    await drain(manager);
    let crossedThreeDigits = false;
    for (const call of calls) {
      const recallIds = call.messages.flatMap((message) =>
        message.content.flatMap((block) => {
          const match = /^\[CM\] Recall memory (.+)\.$/.exec((block as { text?: string }).text ?? '');
          return match ? [match[1]] : [];
        }),
      );
      const sourceStarts = recallIds.map((id) => {
        const summary = manager.getSummary(id);
        assert.ok(summary, `recalled summary ${id} must exist`);
        return Number(summary.sourceRange.first);
      });
      if (sourceStarts.some((id) => id >= 100)) crossedThreeDigits = true;
      assert.deepStrictEqual(
        sourceStarts,
        [...sourceStarts].sort((a, b) => a - b),
        `recall pairs must follow Chronicle order, got ${sourceStarts.join(', ')}`,
      );
    }
    assert.ok(crossedThreeDigits, 'fixture must exercise the decimal-ID width transition');
    await manager.close();
  });

  it('thin chunks are stubbed mechanically — no LLM call, non-empty content', async () => {
    cleanup();
    const { membrane, calls } = createCapturingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 1000, // avoid merge calls; isolate L1 behavior
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    // Pure system-noise traffic: many near-empty turns. Each chunk's total
    // trimmed text stays far below the 200-char default threshold.
    for (let i = 0; i < 120; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(i % 3 === 0 ? 'hb' : ' ')]);
    }

    await drain(manager);

    const snap = strategy.getProgressSnapshot();
    assert.ok(snap.summaryCounts.l1 > 0, 'expected stub L1 summaries to be produced');
    assert.strictEqual(
      calls.length,
      0,
      `expected no LLM calls for pure-noise chunks, got ${calls.length} — ` +
        'asking a summarizer to memorize nothing produces confabulation',
    );

    const stubs = strategy.searchSummaries({ text: 'quiet stretch' });
    assert.ok(stubs.length > 0, 'stub summaries must carry non-empty "quiet stretch" content');
    for (const s of stubs) {
      assert.ok(s.summary.content.trim().length > 0, 'stub content must be non-empty (400 guard)');
    }
    await manager.close();
  });

  it('mixed traffic: substantive chunks still compress via LLM', async () => {
    cleanup();
    const { membrane, calls } = createCapturingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 60,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 1000,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    for (let i = 0; i < 30; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [
        t(`real event ${i} ` + 'meaningful discussion of concrete plans and decisions '.repeat(6)),
      ]);
    }

    await drain(manager);
    assert.ok(calls.length > 0, 'substantive chunks must still go through the LLM');
    await manager.close();
  });
});
