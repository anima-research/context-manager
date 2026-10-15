/**
 * A classic pin added over a message the greedy solvers (flat-profile,
 * oldest-first) had already folded, driven through the strategy: what renders,
 * what the strategy stores, and what happens when the pin is removed, for a
 * message the agent locked and one it didn't.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-greedy-pin-carry';
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };

class Seeded extends AutobiographicalStrategy {
  /** Two L1s over messages 0-5 and 6-11, so the solver has something to fold to. */
  seedL1s(ids: string[]): void {
    for (let group = 0; group < 2; group++) {
      const sourceIds = ids.slice(group * 6, group * 6 + 6);
      this.pushSummary({
        id: `L1-carry-${group}`, level: 1, sourceLevel: 0, sourceIds,
        sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
        content: `RECALL-${group}`, tokens: 10, created: 0,
      });
    }
  }
  carried(id: string): number { return this.resolutions.get(id) ?? 0; }
  stored(id: string): number {
    const state = this.store?.getStateJson(this.resolutionsStateId) as Record<string, number> | null | undefined;
    return state?.[id] ?? 0;
  }
}

const budget = (maxTokens: number) => ({ maxTokens, reserveForResponse: 0 });
const rendersRaw = (messages: { content: ContentBlock[] }[]) =>
  messages.some((m) => m.content.some((b) => b.type === 'text' && b.text.includes('RAW-0 ')));

describe('a pin added over a folded message, under the greedy solvers', () => {
  beforeEach(cleanup);
  after(cleanup);

  for (const foldingStrategy of ['flat-profile', 'oldest-first'] as const) {
    for (const locked of [false, true]) {
      it(`${foldingStrategy}, ${locked ? 'locked' : 'unlocked'}: renders raw while pinned; after the unpin, ${locked ? 'returns to its locked level' : 'stays raw until a fold takes it again'}`, async () => {
        const s = new Seeded({
          hierarchical: false, adaptiveResolution: true, headWindowTokens: 0, recentWindowTokens: 500,
          targetChunkTokens: 10_000, compressionModel: 'mock', autoTickOnNewMessage: false, foldingStrategy,
        } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
        const m = await ContextManager.open({ path: STORE, strategy: s });
        try {
          const ids = Array.from({ length: 12 }, (_, i) =>
            m.addMessage(i % 2 === 0 ? 'user' : 'assistant', [{ type: 'text', text: `RAW-${i} ` + 'x'.repeat(800) }]));
          s.seedL1s(ids);

          const folded = await m.compile(budget(1900));
          assert.equal(rendersRaw(folded.messages), false, 'pressure folds the first message');
          assert.equal(s.carried(ids[0]), 1);
          if (locked) s.lockChunk(ids[0]);

          const pin = m.pinRange(ids[0], ids[0]);
          const pinned = await m.compile(budget(100_000));
          assert.equal(rendersRaw(pinned.messages), true, 'the pinned message renders raw');
          // An unlocked message stores the 0, dropping the fold the pin replaced;
          // the strategy never stores a change to a locked one.
          assert.equal(s.carried(ids[0]), locked ? 1 : 0);
          assert.equal(s.stored(ids[0]), locked ? 1 : 0);

          m.unpin(pin);
          const unpinned = await m.compile(budget(100_000));
          assert.equal(rendersRaw(unpinned.messages), !locked, locked ? 'the lock\'s level returns' : 'the message stays raw without pressure');
          if (!locked) {
            const pressed = await m.compile(budget(1900));
            assert.equal(rendersRaw(pressed.messages), false, 'pressure folds it again');
          }
        } finally {
          await m.close();
        }
      });
    }
  }
});
