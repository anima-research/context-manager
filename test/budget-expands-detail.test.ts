/**
 * Raising the budget expands detail when finer material exists: the whole
 * path (compile maxTokens → folding budget → kv-stable plan → rendered
 * context), not just the solver.
 *
 * A store is filled and compressed (L1s, then L2 merges, via a stand-in
 * summarizer), then compiled at increasing budgets. Each larger budget must
 * render at least as many tokens and at least as much fine material (raw
 * messages + L1 summaries), strictly more once finer material is available,
 * and never exceed its own wall. (Sol, 2026-09-26: a migration's budget was
 * chosen on the premise that this holds.)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const STORE = './test-zz-budget-expands';
const t = (text: string): ContentBlock => ({ type: 'text', text });
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };

function summarizer() {
  return {
    complete: async (_request: NormalizedRequest) => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'A memory of this stretch, kept brief: ' + 'detail '.repeat(12) }],
      usage: { input_tokens: 1000, output_tokens: 40 },
    }),
  };
}

function strategy() {
  return new AutobiographicalStrategy({
    compressionModel: 'zz-model',
    targetChunkTokens: 120,
    headWindowTokens: 0,
    recentWindowTokens: 400,
    hierarchical: true,
    mergeThreshold: 3,
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
}

interface Detail { tokens: number; raw: number; l1: number; l2: number; l3: number }
function detailOf(rs: any): Detail {
  return {
    tokens: rs.total.tokens,
    raw: rs.head.messages + rs.tail.messages + rs.middleRaw.messages,
    l1: rs.summaries.l1?.count ?? 0,
    l2: rs.summaries.l2?.count ?? 0,
    l3: rs.summaries.l3?.count ?? 0,
  };
}

describe('budget expands detail', () => {
  before(cleanup);
  after(cleanup);

  it('larger budgets render more detail, never beyond their wall', async () => {
    // 1. Build and compress a history (generous budget so every chunk mints).
    const manager = await ContextManager.open({ path: STORE, strategy: strategy(), membrane: summarizer() as any });
    for (let i = 0; i < 160; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent',
        [t(`turn ${i}: steady substantive traffic about the ongoing work, with specifics `.repeat(4))]);
      for (let k = 0; k < 200 && !manager.isReady(); k++) await manager.tick();
    }
    await manager.compile({ maxTokens: 4_000, reserveForResponse: 0 }); // force deep folding + merges
    for (let k = 0; k < 500 && !manager.isReady(); k++) await manager.tick();
    await manager.close();

    // 2. Compile the same store at increasing budgets (fresh open each time,
    //    as a restart with a new recipe would).
    const budgets = [4_000, 8_000, 16_000, 32_000];
    const results: Array<Detail & { budget: number }> = [];
    for (const budget of budgets) {
      const m = await ContextManager.open({ path: STORE, strategy: strategy(), membrane: summarizer() as any });
      await m.compile({ maxTokens: budget, reserveForResponse: 0 });
      results.push({ budget, ...detailOf(m.getRenderStats()) });
      await m.close();
    }

    const fine = (d: Detail) => d.raw + d.l1;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      assert.ok(r.tokens <= r.budget, `budget ${r.budget}: rendered ${r.tokens} tokens, over its wall`);
      if (i > 0) {
        const p = results[i - 1]!;
        assert.ok(r.tokens >= p.tokens, `budget ${r.budget} rendered fewer tokens (${r.tokens}) than ${p.budget} (${p.tokens})`);
        assert.ok(fine(r) >= fine(p), `budget ${r.budget} shows less fine material (${fine(r)}) than ${p.budget} (${fine(p)})`);
      }
    }
    // Finer material exists (the history was compressed), so detail must
    // actually grow across the sweep, not merely hold.
    const first = results[0]!, last = results[results.length - 1]!;
    assert.ok(last.tokens > first.tokens, `no expansion at all: ${JSON.stringify(results)}`);
    assert.ok(fine(last) > fine(first), `no finer material rendered: ${JSON.stringify(results)}`);
  });
});
