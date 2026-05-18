/**
 * Tests for the shared recall-pair token-budget cap used by both
 * compressChunkHierarchical and executeMerge.
 *
 * The cap walks newest→oldest, skips any summary that would put the
 * running total over budget (rather than breaking on first oversized),
 * and returns the kept set re-sorted chronologically. This matters
 * because at 4000+ messages the unmerged frontier alone — let alone
 * the full L1 set — easily blows the 200k API window.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AutobiographicalStrategy } from '../src/index.js';
import type { SummaryEntry } from '../src/types/index.js';

class TestableStrategy extends AutobiographicalStrategy {
  capRecallPairsTest(
    summariesChronological: SummaryEntry[],
    maxTokens: number,
  ): { kept: SummaryEntry[]; keptTokens: number } {
    return this.capRecallPairs(summariesChronological, maxTokens);
  }
}

function mkSummary(id: string, tokens: number, content?: string): SummaryEntry {
  return {
    id,
    level: 1,
    content: content ?? 'x'.repeat(tokens * 4),
    tokens,
    sourceLevel: 0,
    sourceIds: [id],
    sourceRange: { first: id, last: id },
    created: Date.now(),
  };
}

describe('AutobiographicalStrategy — capRecallPairs', () => {
  const s = new TestableStrategy({});

  it('returns empty for empty input', () => {
    const r = s.capRecallPairsTest([], 1000);
    assert.equal(r.kept.length, 0);
    assert.equal(r.keptTokens, 0);
  });

  it('keeps everything when total is under budget', () => {
    const input = [mkSummary('a', 100), mkSummary('b', 200), mkSummary('c', 300)];
    const r = s.capRecallPairsTest(input, 100_000);
    assert.equal(r.kept.length, 3);
    // Chronological order preserved
    assert.deepEqual(r.kept.map((x) => x.id), ['a', 'b', 'c']);
  });

  it('drops oldest first when over budget', () => {
    // Each summary ~1000 tokens (1050 with overhead). Budget 3000 → 2 fit.
    const input = [
      mkSummary('old', 1000),
      mkSummary('mid', 1000),
      mkSummary('new', 1000),
    ];
    const r = s.capRecallPairsTest(input, 3000);
    assert.equal(r.kept.length, 2);
    // Newer two kept, in chronological order
    assert.deepEqual(r.kept.map((x) => x.id), ['mid', 'new']);
  });

  it('skips oversized summaries instead of stopping at the first one', () => {
    // Walk newest→oldest: small(100), HUGE(50000), small(100), small(100)
    // Budget 1000: keep newest small, skip HUGE, keep remaining small siblings.
    const input = [
      mkSummary('old', 100),
      mkSummary('mid', 100),
      mkSummary('HUGE', 50_000),
      mkSummary('new', 100),
    ];
    const r = s.capRecallPairsTest(input, 1000);
    // HUGE skipped; the three 100-token summaries all fit
    assert.deepEqual(r.kept.map((x) => x.id), ['old', 'mid', 'new']);
  });

  it('returns empty if every summary individually exceeds budget', () => {
    const input = [mkSummary('a', 10_000), mkSummary('b', 10_000)];
    const r = s.capRecallPairsTest(input, 100);
    assert.equal(r.kept.length, 0);
    assert.equal(r.keptTokens, 0);
  });

  it('estimates tokens from content.length / 4 when tokens field is absent', () => {
    const entry: SummaryEntry = {
      id: 'no-tokens',
      level: 1,
      content: 'x'.repeat(400), // ~100 tokens
      tokens: 0, // explicitly zero — falsy, so falls through to content length
      sourceLevel: 0,
      sourceIds: ['m1'],
      sourceRange: { first: 'm1', last: 'm1' },
      created: Date.now(),
    };
    // Override `tokens` to undefined so the estimator runs
    delete (entry as Partial<SummaryEntry>).tokens;
    const r = s.capRecallPairsTest([entry], 200);
    assert.equal(r.kept.length, 1);
    // 100 (content/4) + 50 overhead = 150 ≤ 200
    assert.ok(r.keptTokens >= 150 && r.keptTokens <= 160);
  });

  it('accounts for +50 per-summary overhead', () => {
    // Two summaries at exactly 100 tokens each. Budget 250.
    // Without overhead: 100+100 = 200 ≤ 250 → both fit.
    // With +50/summary: 150+150 = 300 > 250 → only newest fits.
    const r = s.capRecallPairsTest([mkSummary('a', 100), mkSummary('b', 100)], 250);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.id, 'b');
  });
});
