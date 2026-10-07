/**
 * Rendered layouts and fold receipts from the real AutobiographicalStrategy:
 * the summary annotations its emission sites carry, describeRenderedSummaries
 * expanding merged summaries to their leaves, and a receipt for a fold the
 * strategy actually rendered. Summaries are seeded directly (no LLM), as the
 * recall-envelope fixture does, so the covered set is exact.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { AutobiographicalOptions, LayoutUnit, SummaryEntry } from '../src/index.js';

class SeedableStrategy extends AutobiographicalStrategy {
  seed(entry: Omit<SummaryEntry, 'created'>): void {
    this.pushSummary({ ...entry, created: 0 });
  }
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const BUDGET = { maxTokens: 100_000, reserveForResponse: 0 };

async function withStore<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'zz-fold-autobio-'));
  try {
    return await run(join(dir, 'store'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function setup(path: string, options: AutobiographicalOptions = {}) {
  const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 8, ...options });
  const cm = await ContextManager.open({ path, strategy });
  const ids = [
    cm.addMessage('user', text('zz-turn-one')),
    cm.addMessage('user', text('zz-turn-two')),
    cm.addMessage('user', text('zz-turn-three')),
    cm.addMessage('user', text('zz-turn-four')),
    cm.addMessage('user', text('zz-turn-latest ' + 'Z'.repeat(60))),
  ];
  return { cm, strategy, ids };
}

function seedAll(strategy: SeedableStrategy, ids: string[]): void {
  const [a, b, c, d] = ids as [string, string, string, string];
  strategy.seed({ id: 'L1-0', level: 1, content: 'merged one', tokens: 6, sourceLevel: 0, sourceIds: [a], sourceRange: { first: a, last: a }, mergedInto: 'L2-100', parentId: 'L2-100' });
  strategy.seed({ id: 'L1-1', level: 1, content: 'merged two', tokens: 6, sourceLevel: 0, sourceIds: [b], sourceRange: { first: b, last: b }, mergedInto: 'L2-100', parentId: 'L2-100' });
  strategy.seed({ id: 'L2-100', level: 2, content: 'merged level covering one and two', tokens: 13, sourceLevel: 1, sourceIds: ['L1-0', 'L1-1'], sourceRange: { first: a, last: b } });
  strategy.seed({ id: 'L1-101', level: 1, content: 'plain prose three with more words to cut', tokens: 6, sourceLevel: 0, sourceIds: [c], sourceRange: { first: c, last: c } });
  strategy.seed({ id: 'L1-102', level: 1, content: 'plain prose four with even more words to cut away', tokens: 6, sourceLevel: 0, sourceIds: [d], sourceRange: { first: d, last: d } });
}

function summaryUnits(units: LayoutUnit[]): Array<[string, string, string[]]> {
  return units
    .filter((u): u is Extract<LayoutUnit, { k: 's' }> => u.k === 's')
    .map((u) => [u.ai, u.bi, u.sm.map((s) => `${s[0]}@${s[1]}${s[3] ? '~' : ''}`)]);
}

describe('autobiographical rendered layout', () => {
  it('names each positioned recall pair and expands a merged summary to its leaves', async () => {
    await withStore(async (path) => {
      const { cm, strategy, ids } = await setup(path);
      seedAll(strategy, ids);
      const result = await cm.compile(BUDGET);
      const layout = result.provenance?.layout;
      assert.ok(layout, 'autobiographical reports a layout');
      assert.deepEqual(summaryUnits(layout.units), [
        [ids[0], ids[1], ['L2-100@2']],
        [ids[2], ids[2], ['L1-101@1']],
        [ids[3], ids[3], ['L1-102@1']],
      ]);
      const tail = layout.units[layout.units.length - 1]!;
      assert.equal(tail.k, 'r');
      assert.equal((tail as { id: string }).id, ids[4]);
      // Each recall question and answer names its summary.
      const kinds = result.provenance!.messages.map((m) => m.kind);
      assert.equal(kinds.filter((k) => k === 'summary').length, 6);
      cm.close();
    });
  });

  it('writes a receipt for a fold the strategy rendered', async () => {
    await withStore(async (path) => {
      const { cm, strategy, ids } = await setup(path);
      const first = await cm.compile(BUDGET);
      assert.equal(cm.acceptRound({ provenance: first.provenance! })?.kind, 'baseline');
      seedAll(strategy, ids);
      const second = await cm.compile(BUDGET);
      const receipt = cm.acceptRound({ provenance: second.provenance!, usage: { inputTokens: 900 } });
      assert.ok(receipt, 'the fold is recorded');
      assert.equal(receipt.strategy, 'autobiographical');
      const afterIds = receipt.changes!.map((c) => (c.after.form === 'summary' ? c.after.summaries.map((s) => s.id) : [c.after.form]));
      assert.deepEqual(afterIds, [['L2-100'], ['L1-101'], ['L1-102']]);
      assert.equal(receipt.changes![0]!.first.messageId, ids[0]);
      assert.equal(receipt.changes![0]!.last.messageId, ids[1]);
      for (const change of receipt.changes!) {
        assert.equal((change.after as { summaries: Array<{ method: string }> }).summaries[0]!.method, 'unknown');
      }
      cm.close();
    });
  });

  it('never claims a summary the combined answer\'s cap dropped, and marks the one it cut', async () => {
    for (const recallEnvelope of ['none', 'xml'] as const) {
      await withStore(async (path) => {
        const { cm, strategy, ids } = await setup(path, { positionedRecallPairs: false, maxMessageTokens: 12, recallEnvelope });
        seedAll(strategy, ids);
        const result = await cm.compile(BUDGET);
        const units = result.provenance!.layout!.units.map((u) =>
          u.k === 's' ? `s[${u.sm.map((x) => x[0] + (x[3] ? '~' : '')).join(',')}]` : u.k === 'o' ? `omit ${u.ai}..${u.bi}` : `raw ${u.s}`,
        );
        // L2-100 whole, L1-101 cut by the cap, L1-102 dropped: its message is omitted.
        assert.deepEqual(units.slice(0, 3), ['s[L2-100]', 's[L1-101~]', `omit ${ids[3]}..${ids[3]}`], recallEnvelope);
        cm.close();
      });
    }
  });

  it('attributes a summary whose thinking block survived the cap after its text was dropped', async () => {
    await withStore(async (path) => {
      const { cm, strategy, ids } = await setup(path, { positionedRecallPairs: false, maxMessageTokens: 3, recallEnvelope: 'none' });
      const [a, b] = ids as [string, string];
      strategy.seed({ id: 'L1-a', level: 1, content: 'first summary text that the cap shortens', tokens: 8, sourceLevel: 0, sourceIds: [a], sourceRange: { first: a, last: a } });
      strategy.seed({
        id: 'L1-b', level: 1, content: 'second summary text', tokens: 6, sourceLevel: 0, sourceIds: [b], sourceRange: { first: b, last: b },
        responseContent: [
          { type: 'thinking', thinking: 'retained reasoning', signature: 'sig-b' } as ContentBlock,
          { type: 'text', text: 'second summary text' },
        ],
      });
      const result = await cm.compile(BUDGET);
      const answer = JSON.stringify(result.messages);
      assert.ok(answer.includes('retained reasoning'), 'the truncator kept B\'s thinking block');
      assert.ok(!answer.includes('second summary text'), 'and dropped its text');
      const named = summaryUnits(result.provenance!.layout!.units).flatMap(([, , sm]) => sm);
      assert.ok(named.includes('L1-b@1~'), `B is named as partially rendered: ${JSON.stringify(named)}`);
      assert.ok(named.includes('L1-a@1~'), 'A was cut');
      cm.close();
    });
  });
});
