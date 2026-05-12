/**
 * Tests for the search API (audit gap #7).
 *
 * Substring + regex search over summary content, plus single-summary
 * lookup by id. Exposed through ContextManager passthrough so callers
 * (e.g. agent-framework MCPL host) can build `memory_search` /
 * `memory_read` agent tools on top.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { SummaryEntry, SummaryLevel } from '../src/types/index.js';

const TEST_STORE_PATH = './test-search';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}
function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

class SeedableStrategy extends AutobiographicalStrategy {
  seedSummary(content: string, level: SummaryLevel = 1, mergedInto?: string): SummaryEntry {
    const entry: SummaryEntry = {
      id: `L${level}-${this.nextSummaryIdCounter()}`,
      level,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 0,
      sourceIds: ['x'],
      sourceRange: { first: 'x', last: 'x' },
      created: Date.now(),
      ...(mergedInto ? { mergedInto } : {}),
    };
    this.pushSummary(entry);
    return entry;
  }
}

describe('AutobiographicalStrategy — search (gap #7)', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('returns empty when no summaries match the substring', async () => {
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    strategy.seedSummary('first memory about cats');
    strategy.seedSummary('second memory about dogs');

    const results = manager.searchSummaries({ text: 'unicorns' });
    assert.equal(results.length, 0);
    manager.close();
  });

  it('case-insensitive substring search returns matches sorted by hit count', async () => {
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    strategy.seedSummary('a meditation on cats and CATS and cats');  // 3 hits
    strategy.seedSummary('one note about Cats');                       // 1 hit
    strategy.seedSummary('something about dogs');                      // 0 hits

    const results = manager.searchSummaries({ text: 'cats' });
    assert.equal(results.length, 2, 'two summaries should match');
    assert.equal(results[0].matches, 3, 'highest hit count first');
    assert.equal(results[1].matches, 1);
    manager.close();
  });

  it('regex search supports patterns and counts global matches', async () => {
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    strategy.seedSummary('found errors at 14:23 and 16:45 and 18:00');
    strategy.seedSummary('no times here');

    const results = manager.searchSummaries({ regex: /\d{2}:\d{2}/ });
    assert.equal(results.length, 1);
    assert.equal(results[0].matches, 3, 'should count all 3 timestamps');
    manager.close();
  });

  it('level filter restricts to chosen levels', async () => {
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    strategy.seedSummary('shared word here', 1);
    strategy.seedSummary('shared word also', 2);
    strategy.seedSummary('shared word too', 3);

    const l2only = manager.searchSummaries({ text: 'shared', levels: [2] });
    assert.equal(l2only.length, 1);
    assert.equal(l2only[0].summary.level, 2);

    const l1andL3 = manager.searchSummaries({ text: 'shared', levels: [1, 3] });
    assert.equal(l1andL3.length, 2);
    assert.ok(l1andL3.every(r => r.summary.level === 1 || r.summary.level === 3));
    manager.close();
  });

  it('excludes merged summaries by default; includeMerged opts in', async () => {
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    strategy.seedSummary('alive content', 1);
    strategy.seedSummary('folded content', 1, 'L2-99'); // already merged

    const live = manager.searchSummaries({ text: 'content' });
    assert.equal(live.length, 1, 'merged summaries hidden by default');
    assert.equal(live[0].summary.content, 'alive content');

    const all = manager.searchSummaries({ text: 'content', includeMerged: true });
    assert.equal(all.length, 2, 'includeMerged should reveal both');
    manager.close();
  });

  it('limit caps the result count', async () => {
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    for (let i = 0; i < 10; i++) {
      strategy.seedSummary(`hit ${i} hit hit`);
    }
    const results = manager.searchSummaries({ text: 'hit', limit: 3 });
    assert.equal(results.length, 3);
  });

  it('getSummary returns an entry by id', async () => {
    const strategy = new SeedableStrategy();
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });
    const seeded = strategy.seedSummary('lookup me');

    const got = manager.getSummary(seeded.id);
    assert.ok(got, 'should find the seeded summary');
    assert.equal(got?.content, 'lookup me');
    assert.equal(manager.getSummary('nonexistent'), null);
    manager.close();
  });
});
