/**
 * Within one adaptive compile, the recall pairs stand for different
 * messages, earlier ones first, and none includes another: each stored
 * message is either sent raw or stood for by exactly one pair, in store
 * order. A host's words around a recall pair ("these summaries follow in
 * order, each of different earlier messages") rest on this.
 *
 * Across compiles it doesn't hold: a later compile can stand one merged
 * summary for what an earlier compile showed as several.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { AutobiographicalOptions, SummaryEntry } from '../src/types/index.js';

const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'read_file', input: {} } as ContentBlock);
const result = (id: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: 'ok' } as ContentBlock);

async function withStore<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'zz-recall-disjoint-'));
  try {
    return await run(join(dir, 'store'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const membrane = {
  complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'zz-memory of an earlier stretch' }] }),
};

type Item = { kind: 'raw'; at: number } | { kind: 'pair'; id: string; level: number; from: number; to: number };

/** What each compiled message stands for, in the order sent: a raw message's
 *  store position, or a recall pair's summary and the store positions it covers. */
function layout(manager: ContextManager, strategy: AutobiographicalStrategy, compiled: Awaited<ReturnType<ContextManager['compile']>>): Item[] {
  const held = new Map((strategy as unknown as { summaries: SummaryEntry[] }).summaries.map((s) => [s.id, s] as const));
  const at = new Map(manager.getAllMessages().map((m, i) => [m.id, i] as const));
  const items: Item[] = [];
  compiled.messages.forEach((m, i) => {
    const source = compiled.provenance!.messages[i]!;
    if (source.kind === 'raw') {
      for (const body of source.bodies) items.push({ kind: 'raw', at: at.get(body.messageId)! });
    } else if (source.kind === 'summary' && m.participant === 'Context Manager') {
      const s = held.get(source.summaries[0]!.id)!;
      items.push({ kind: 'pair', id: s.id, level: s.level, from: at.get(s.sourceRange.first)!, to: at.get(s.sourceRange.last)! });
    }
  });
  return items;
}

describe('recall pairs within one compile', () => {
  for (const foldingStrategy of ['flat-profile', 'kv-stable'] as const) {
    it(`${foldingStrategy}: stand for different messages, in store order, with no raw message inside a pair`, async () => {
      await withStore(async (path) => {
        const options: AutobiographicalOptions = {
          compressionModel: 'zz-mock-model',
          targetChunkTokens: 100,
          recentWindowTokens: 200,
          headWindowTokens: 0,
          mergeThreshold: 3,
          compressionSlackRatio: 0.1,
          adaptiveResolution: true,
          foldingStrategy,
        };
        const strategy = new AutobiographicalStrategy(options);
        const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
        manager.setToolDefinitions([{ name: 'read_file', description: 'zz', inputSchema: { type: 'object' } }]);
        for (let r = 0; r < 30; r++) {
          manager.addMessage('Claude', [{ type: 'text', text: `zz-step-${r} ` + 'zzzz '.repeat(40) }, call(`tu-${r}`)]);
          manager.addMessage('User', [result(`tu-${r}`)]);
        }
        for (let tick = 0; tick < 300 && !manager.isReady(); tick++) await manager.tick();
        assert.ok(manager.isReady(), 'premise: compression and merging drained');

        let sawMerged = false;
        for (const maxTokens of [700, 900, 1400, 2400]) {
          const items = layout(manager, strategy, await manager.compile({ maxTokens, reserveForResponse: 0 }));
          const pairs = items.filter((x): x is Extract<Item, { kind: 'pair' }> => x.kind === 'pair');
          assert.ok(pairs.length >= 2, `premise at ${maxTokens}: the compile folds into recall pairs (${pairs.length})`);
          assert.ok(items.some((x) => x.kind === 'raw'), `premise at ${maxTokens}: some messages are sent raw`);
          if (pairs.some((p) => p.level >= 2)) sawMerged = true;

          // In the order sent, every item starts after the one before ends:
          // pairs don't overlap each other or a raw message, and come in store order.
          let end = -1;
          for (const x of items) {
            const [from, to] = x.kind === 'raw' ? [x.at, x.at] : [x.from, x.to];
            assert.ok(from > end, `at ${maxTokens}: ${x.kind === 'raw' ? `raw message ${x.at}` : `pair ${x.id} (${x.from}..${x.to})`} starts after what precedes it ends (${end})`);
            end = to;
          }
          assert.equal(new Set(pairs.map((p) => p.id)).size, pairs.length, `at ${maxTokens}: each summary is one pair`);
        }
        assert.ok(sawMerged, 'premise: a merged summary renders beside others in some compile');
        manager.close();
      });
    });
  }
});
