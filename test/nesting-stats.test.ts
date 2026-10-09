/**
 * RenderStats.nesting: the summary-tree nesting invariant (one L1 per message)
 * and what the render actually did with an overlap. A non-nested tree whose
 * overlap renders through one lineage must report renderedTwice = 0.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AutobiographicalStrategy } from '../src/index.js';
import type { SummaryEntry } from '../src/types/index.js';

type Probe = { summaries: SummaryEntry[]; _emittedSummaryIds: Set<string>; computeNestingStats(): { overlapLeaves: number; renderedTwice: number; extraTokens: number } };

function l1(id: string, msgs: string[], tokens: number, parentId?: string): SummaryEntry {
  return { id, level: 1, content: 'x', tokens, sourceLevel: 0, sourceIds: msgs, sourceRange: { first: msgs[0]!, last: msgs[msgs.length - 1]! }, timestamp: 0, ...(parentId ? { parentId } : {}) } as unknown as SummaryEntry;
}
function l2(id: string, children: string[], tokens: number): SummaryEntry {
  return { id, level: 2, content: 'y', tokens, sourceLevel: 1, sourceIds: children, sourceRange: { first: 'm1', last: 'm9' }, timestamp: 0 } as unknown as SummaryEntry;
}
function probe(summaries: SummaryEntry[], emitted: string[]): Probe {
  const s = new AutobiographicalStrategy({ compressionModel: 'mock' }) as unknown as Probe;
  s.summaries = summaries;
  s._emittedSummaryIds = new Set(emitted);
  return s;
}

describe('RenderStats.nesting', () => {
  it('a nested tree reports no overlap and nothing rendered twice', () => {
    const n = probe([l1('L1-a', ['m1', 'm2', 'm3'], 100), l1('L1-b', ['m4', 'm5'], 80)], ['L1-a', 'L1-b']).computeNestingStats();
    assert.deepEqual(n, { overlapLeaves: 0, renderedTwice: 0, extraTokens: 0 });
  });

  it('overlapping L1s are counted, but only what is emitted twice is a double render', () => {
    // L1-b re-covers m2,m3 (overlap of 2); both merged into different L2s; only L2-a is emitted.
    const tree = [
      l1('L1-a', ['m1', 'm2', 'm3'], 100, 'L2-a'), l1('L1-b', ['m2', 'm3', 'm4'], 90, 'L2-b'), l1('L1-c', ['m5', 'm6'], 70, 'L2-b'),
      l2('L2-a', ['L1-a'], 60), l2('L2-b', ['L1-b', 'L1-c'], 65),
    ];
    const one = probe(tree, ['L2-a']).computeNestingStats();
    assert.deepEqual(one, { overlapLeaves: 2, renderedTwice: 0, extraTokens: 0 });
    const both = probe(tree, ['L2-a', 'L2-b']).computeNestingStats();
    assert.deepEqual(both, { overlapLeaves: 2, renderedTwice: 2, extraTokens: 65 });
  });
});
