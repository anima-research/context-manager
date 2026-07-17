/**
 * Tests for pins / documents / protected ranges (audit gap #3).
 *
 * Pinned messages are excluded from compression and render raw at their
 * original chronological position. Marks survive process restart and follow
 * Chronicle branches (state is persisted as a snapshot under
 * `${ns}/autobio:pins`).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { SummaryEntry } from '../src/types/index.js';

const TEST_STORE_PATH = './test-pins';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

class TestableStrategy extends AutobiographicalStrategy {
  seedL1Against(content: string, firstMsgId: string, lastMsgId: string): SummaryEntry {
    const sourceIds = firstMsgId === lastMsgId ? [firstMsgId] : [firstMsgId, lastMsgId];
    const entry: SummaryEntry = {
      id: `L1-${this.nextSummaryIdCounter()}`,
      level: 1,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 0,
      sourceIds,
      sourceRange: { first: firstMsgId, last: lastMsgId },
      created: Date.now(),
    };
    this.pushSummary(entry);
    return entry;
  }

  // Expose the protected getter for assertions
  exposeCompressibleIds(store: any): string[] {
    return this.getCompressibleMessages(store).map((m: any) => m.id);
  }
}

describe('AutobiographicalStrategy — pins / documents (gap #3)', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('pinned messages are excluded from the compressible set', async () => {
    const strategy = new TestableStrategy({ headWindowTokens: 0, recentWindowTokens: 5 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const m1 = manager.addMessage('user', textBlock('one'));
    const m2 = manager.addMessage('user', textBlock('two'));
    const m3 = manager.addMessage('user', textBlock('three'));
    manager.addMessage('user', textBlock('latest ' + 'X'.repeat(50)));

    // Without any pins, all old messages are compressible.
    const beforePin = strategy.exposeCompressibleIds((manager as any).messageStore.createView());
    assert.ok(beforePin.includes(m2), 'm2 should be compressible before pin');

    manager.pinRange(m2, m2);

    const afterPin = strategy.exposeCompressibleIds((manager as any).messageStore.createView());
    assert.ok(!afterPin.includes(m2), 'm2 must NOT be compressible after pin');
    assert.ok(afterPin.includes(m1), 'm1 still compressible');
    assert.ok(afterPin.includes(m3), 'm3 still compressible');

    manager.close();
  });

  it('renders pinned messages raw at their chronological position', async () => {
    const strategy = new TestableStrategy({ headWindowTokens: 0, recentWindowTokens: 5 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const m1 = manager.addMessage('user', textBlock('alpha'));
    const m2 = manager.addMessage('user', textBlock('PINNED-DOCUMENT-CONTENT'));
    const m3 = manager.addMessage('user', textBlock('gamma'));
    manager.addMessage('user', textBlock('latest ' + 'X'.repeat(50)));

    // Seed summaries that cover m1 and m3 (NOT m2 — m2 is pinned).
    strategy.seedL1Against('summary about alpha', m1, m1);
    strategy.seedL1Against('summary about gamma', m3, m3);

    manager.markDocument(m2, { name: 'big-doc' });

    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });

    const allTexts = compiled.messages.map(m =>
      m.content.filter(c => c.type === 'text').map(c => (c as any).text).join('|'),
    );

    // The pinned message's full content should be rendered raw, not via a summary.
    const pinIdx = allTexts.findIndex(t => t.includes('PINNED-DOCUMENT-CONTENT'));
    assert.ok(pinIdx >= 0, 'pinned message text should be visible verbatim in output');

    // The two summaries should also be present.
    const alphaIdx = allTexts.findIndex(t => t.includes('summary about alpha'));
    const gammaIdx = allTexts.findIndex(t => t.includes('summary about gamma'));
    assert.ok(alphaIdx >= 0, 'alpha summary should appear');
    assert.ok(gammaIdx >= 0, 'gamma summary should appear');

    // Chronological order: alpha summary < pinned m2 < gamma summary
    assert.ok(alphaIdx < pinIdx, `alpha summary should come before pinned m2 (alpha=${alphaIdx} pin=${pinIdx})`);
    assert.ok(pinIdx < gammaIdx, `pinned m2 should come before gamma summary (pin=${pinIdx} gamma=${gammaIdx})`);

    manager.close();
  });

  it('persists pins across close/reopen', async () => {
    let pinId: string;
    {
      const strategy = new TestableStrategy({ headWindowTokens: 0, recentWindowTokens: 5 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });
      const m1 = manager.addMessage('user', textBlock('survive me'));
      manager.addMessage('user', textBlock('latest'));

      pinId = manager.pinRange(m1, m1, { name: 'first-test-pin' });
      assert.equal(manager.listPins().length, 1);
      manager.sync();
      manager.close();
    }
    {
      const strategy = new TestableStrategy({ headWindowTokens: 0, recentWindowTokens: 5 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });
      const pins = manager.listPins();
      assert.equal(pins.length, 1, 'pin should reload from chronicle');
      assert.equal(pins[0].id, pinId);
      assert.equal(pins[0].name, 'first-test-pin');
      manager.close();
    }
  });

  it('unpin removes the protection and persists', async () => {
    const strategy = new TestableStrategy({ headWindowTokens: 0, recentWindowTokens: 5 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    const m1 = manager.addMessage('user', textBlock('toggle me'));
    manager.addMessage('user', textBlock('latest'));

    const pinId = manager.pinRange(m1, m1);
    assert.equal(manager.listPins().length, 1);

    const removed = manager.unpin(pinId);
    assert.equal(removed, true);
    assert.equal(manager.listPins().length, 0);

    // Re-unpinning is a no-op (returns false)
    assert.equal(manager.unpin(pinId), false);

    manager.close();
  });

  it('multiple pins isolate per Chronicle branch (via fork)', async () => {
    const strategy = new TestableStrategy({ headWindowTokens: 0, recentWindowTokens: 5 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    const m1 = manager.addMessage('user', textBlock('shared'));
    manager.addMessage('user', textBlock('latest'));
    const sharedPin = manager.pinRange(m1, m1, { name: 'shared' });

    const mainBranch = manager.currentBranch().name;

    await manager.fork('experimental');
    // Adding a pin only on the experimental branch
    const m2 = manager.addMessage('user', textBlock('only on fork'));
    manager.addMessage('user', textBlock('latest 2'));
    const forkPin = manager.pinRange(m2, m2, { name: 'fork-only' });

    assert.equal(manager.listPins().length, 2, 'fork should have shared + fork-only pin');

    await manager.switchBranch(mainBranch);
    const mainPins = manager.listPins();
    assert.equal(mainPins.length, 1, 'main should only have the shared pin');
    assert.equal(mainPins[0].id, sharedPin);
    assert.ok(!mainPins.some(p => p.id === forkPin), 'main must NOT see the fork-only pin');

    manager.close();
  });

  // ---- V2 dynamic pins: pin-at-level-k / pin-max-level (additive, opt-in) ----

  it('pinAtLevel / level / maxLevel round-trip through listPins and validate', async () => {
    const strategy = new TestableStrategy({ headWindowTokens: 0, recentWindowTokens: 5 });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    const m1 = manager.addMessage('user', textBlock('fix me at L2'));
    const m2 = manager.addMessage('user', textBlock('cap me at L1'));
    manager.addMessage('user', textBlock('latest'));

    const atId = manager.pinAtLevel(m1, m1, 2, { name: 'at-2' });
    const capId = manager.pinRange(m2, m2, { maxLevel: 1 });
    // Invalid bounds are dropped (a classic raw pin), not persisted as junk.
    const rawId = manager.markDocument(m2, { level: -3 });

    const byId = new Map(manager.listPins().map((p) => [p.id, p]));
    assert.equal(byId.get(atId)?.level, 2, 'pin-at-level stores level');
    assert.equal(byId.get(atId)?.maxLevel, undefined, 'level suppresses maxLevel');
    assert.equal(byId.get(capId)?.maxLevel, 1, 'pin-max-level stores maxLevel');
    assert.equal(byId.get(capId)?.level, undefined, 'no fixed level on a cap pin');
    assert.equal(byId.get(rawId)?.level, undefined, 'invalid level dropped → classic pin');
    assert.equal(byId.get(rawId)?.maxLevel, undefined, 'invalid level dropped → classic pin');

    manager.close();
  });

  it('level bound survives close/reopen', async () => {
    let atId: string;
    {
      const strategy = new TestableStrategy({ headWindowTokens: 0, recentWindowTokens: 5 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const m1 = manager.addMessage('user', textBlock('survive at L3'));
      manager.addMessage('user', textBlock('latest'));
      atId = manager.pinAtLevel(m1, m1, 3);
      manager.sync();
      manager.close();
    }
    {
      const strategy = new TestableStrategy({ headWindowTokens: 0, recentWindowTokens: 5 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const pin = manager.listPins().find((p) => p.id === atId);
      assert.ok(pin, 'leveled pin reloads');
      assert.equal(pin!.level, 3, 'level bound persisted across reopen');
      manager.close();
    }
  });
});
