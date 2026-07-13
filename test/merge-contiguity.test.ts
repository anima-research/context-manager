/**
 * Merge-grouping contiguity (2026-07-12 fix) — regression tests.
 *
 * The old rule merged "whatever N are unmerged" in creation order, which
 * minted merge groups bridging months of already-merged history (mythos
 * L3-415 spanning 0-3853 of 3995 live messages). Such a group straddles the
 * recent window, and group-atomic folding then blocks its entire lineage —
 * the fold floor stops fitting the budget.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import type { SummaryEntry } from '../src/types/strategy.js';

/** Expose the protected candidate selector + injectable chunks. */
class Probe extends AutobiographicalStrategy {
  setChunks(messageIds: string[]): void {
    (this as unknown as { chunks: unknown[] }).chunks = [
      { messages: messageIds.map((id) => ({ id })) },
    ];
  }
  pick(unmerged: SummaryEntry[], threshold: number): SummaryEntry[] | null {
    return this.contiguousMergeCandidates(unmerged, threshold);
  }
}

function summary(id: string, first: number, last: number): SummaryEntry {
  return {
    id, level: 2, content: `s ${id}`, tokens: 100, sourceLevel: 1,
    sourceIds: [`x-${id}`],
    sourceRange: { first: `m-${first}`, last: `m-${last}` },
    created: 1,
  } as SummaryEntry;
}

function probe(): Probe {
  const p = new Probe({ adaptiveResolution: true, autoTickOnNewMessage: false });
  p.setChunks(Array.from({ length: 4000 }, (_, i) => `m-${i}`));
  return p;
}

test('contiguous run merges; a cross-era candidate is left out', () => {
  const p = probe();
  // Six contiguous June-era candidates + one July-era outlier that the old
  // creation-order rule would have grouped in.
  const unmerged = [
    summary('july', 3800, 3900), // creation-order FIRST — old code took it
    summary('a', 0, 50), summary('b', 51, 170), summary('c', 171, 290),
    summary('d', 291, 350), summary('e', 351, 512), summary('f', 513, 572),
  ];
  const run = p.pick(unmerged, 6);
  assert.ok(run, 'a qualifying run exists');
  assert.deepEqual(run!.map((s) => s.id).sort(), ['a','b','c','d','e','f'], 'contiguous six, no bridge');
});

test('small holes bridge; interior runs consolidate early; the newest run waits', () => {
  const p = probe();
  const unmerged = [
    summary('a', 0, 50), summary('b', 120, 200),   // 70-message hole: fine
    summary('c', 201, 300), summary('d', 301, 400),
    summary('e', 401, 500),
    summary('f', 3000, 3100),                       // 2500-message gap: breaks
  ];
  // The a–e run is INTERIOR (f's run is newer). Summaries are only produced
  // at the live end, so a stranded interior run can never reach threshold —
  // it consolidates as soon as it has 2 members (2026-07-12 starvation fix;
  // mythos froze on exactly this shape after poison-node surgery).
  const interior = p.pick(unmerged, 6);
  assert.ok(interior, 'interior run consolidates without reaching threshold');
  assert.deepEqual(interior!.map((s) => s.id).sort(), ['a', 'b', 'c', 'd', 'e'], 'the stranded five, not f');
  assert.ok(p.pick(unmerged, 5), 'the contiguous five qualify at threshold 5');
  // The NEWEST run can still grow — below threshold it waits.
  assert.equal(p.pick(unmerged.slice(0, 5), 6), null, 'newest run below threshold waits');
});

test('wide-span (replay-era) candidates are quarantined from any run', () => {
  const p = probe();
  const unmerged = [
    summary('replay', 0, 3853), // spans the whole chronicle — the L2-411 shape
    summary('a', 0, 50), summary('b', 51, 170), summary('c', 171, 290),
    summary('d', 291, 350), summary('e', 351, 512),
  ];
  // Without quarantine the replay span would bridge everything into a run of
  // six; with it there are only five eligible → no merge.
  assert.equal(p.pick(unmerged, 6), null, 'wide-span candidate cannot complete a run');
  const five = p.pick(unmerged, 5);
  assert.ok(five && !five.some((s) => s.id === 'replay'), 'replay stays on the frontier');
});
