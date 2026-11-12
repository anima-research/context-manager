import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, OverBudgetError, WindowedPassthroughStrategy } from '../src/index.js';

const dirs: string[] = [];
function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cm-windowed-'));
  dirs.push(dir);
  return join(dir, 'store');
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const texts = (r: { messages: Array<{ content: ContentBlock[] }> }): string[] =>
  r.messages.map((m) => (m.content[0] as { text: string }).text);
const breakpoints = (r: { messages: Array<{ cacheBreakpoint?: boolean }> }): number[] =>
  r.messages.map((m, i) => (m.cacheBreakpoint ? i : -1)).filter((i) => i >= 0);
const BUDGET = { maxTokens: 1000, reserveForResponse: 50 };

function overflow(manager: ContextManager): void {
  for (let i = 0; i < 24; i++) manager.addMessage('u', text(`m${i}-${'x'.repeat(200)}`));
}

describe('WindowedPassthroughStrategy: a dry select', () => {
  it('neither moves nor persists the anchor where a compile that sends would move it', async () => {
    const anchorStateId = 'test/windowed:anchor';
    const strategy = new WindowedPassthroughStrategy({ reAnchorFraction: 0.5, anchorStateId });
    const manager = await ContextManager.open({ path: freshPath(), strategy });
    overflow(manager);
    const persisted = manager.getStore().getStateJson(anchorStateId);

    const dry = await manager.compile(BUDGET, undefined, { dryRun: true });
    assert.equal(strategy.getAnchor(), 0);
    assert.deepEqual(manager.getStore().getStateJson(anchorStateId), persisted);

    const sent = await manager.compile(BUDGET);
    assert.ok(strategy.getAnchor() > 0, 'a compile that sends moves it');
    assert.deepEqual(texts(dry), texts(sent), 'the dry select returned the window the compile then sent');
    await manager.close();
  });

  it('places no cache markers and leaves the measurement the next compile marks from', async () => {
    const manager = await ContextManager.open({ path: freshPath(), strategy: new WindowedPassthroughStrategy() });
    manager.addMessage('u', text('a'));
    manager.addMessage('u', text('b'));
    assert.deepEqual(breakpoints(await manager.compile()), [1]);
    manager.addMessage('u', text('c'));
    manager.addMessage('u', text('d'));

    const dry = await manager.compile(undefined, undefined, { dryRun: true });
    assert.deepEqual(texts(dry), ['a', 'b', 'c', 'd']);
    assert.deepEqual(breakpoints(dry), []);
    assert.deepEqual(breakpoints(await manager.compile()), [1, 3], 'the previous sent endpoint, then the end');
    await manager.close();
  });

  it('reports the window rather than refusing it when the newest message alone is over the budget', async () => {
    const manager = await ContextManager.open({ path: freshPath(), strategy: new WindowedPassthroughStrategy() });
    const oversized = 'x'.repeat(8000);
    manager.addMessage('u', text(oversized));
    const budget = { maxTokens: 500, reserveForResponse: 50 };

    const dry = await manager.compile(budget, undefined, { dryRun: true });
    assert.deepEqual(dry.messages.map((m) => m.content), [text(oversized)]);
    await assert.rejects(manager.compile(budget), OverBudgetError);
    await manager.close();
  });
});

describe('WindowedPassthroughStrategy: a branch change', () => {
  it('forgets the previous compile\'s cache measurement, so the first compile on the branch marks the end only', async () => {
    const manager = await ContextManager.open({ path: freshPath(), strategy: new WindowedPassthroughStrategy() });
    manager.addMessage('u', text('a'));
    const b = manager.addMessage('u', text('b'));
    assert.deepEqual(breakpoints(await manager.compile()), [1]);
    const alt = manager.branchAt(b, 'alt');

    await manager.switchBranch(alt);
    manager.addMessage('u', text('c'));
    assert.deepEqual(breakpoints(await manager.compile()), [2]);
    await manager.close();
  });
});

describe('WindowedPassthroughStrategy: the selection cause', () => {
  it('is \'window\' for a compile that moved the anchor, as its accepted round\'s receipt says', async () => {
    const strategy = new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 });
    const manager = await ContextManager.open({ path: freshPath(), strategy });
    overflow(manager);

    const moved = await manager.compile(BUDGET);
    assert.ok(strategy.getAnchor() > 0);
    assert.equal(manager.acceptRound({ provenance: moved.provenance! })?.cause, 'window');
    await manager.close();
  });

  it('is cleared by the read that takes it', async () => {
    const strategy = new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 });
    const manager = await ContextManager.open({ path: freshPath(), strategy });
    overflow(manager);

    await manager.compile(BUDGET);
    assert.ok(strategy.getAnchor() > 0, 'the compile moved the anchor, and took its cause');
    assert.equal(strategy.takeSelectionCause(), undefined);
    await manager.close();
  });
});
