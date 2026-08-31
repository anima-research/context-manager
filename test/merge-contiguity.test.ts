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
  setSummaries(summaries: SummaryEntry[]): void {
    (this as unknown as { summaries: SummaryEntry[] }).summaries = summaries;
  }
  setMergeQueue(queue: Array<{ level: number; sourceIds: string[] }>): void {
    (this as unknown as { mergeQueue: unknown[] }).mergeQueue = queue;
  }
  sanitizeQueue(messageIds: string[]): void {
    this.sanitizePersistedMergeQueue({
      getAll: () => messageIds.map((id) => ({ id })),
    } as never);
  }
  mergeQueueLength(): number {
    return (this as unknown as { mergeQueue: unknown[] }).mergeQueue.length;
  }
}

class QuarantineProbe extends Probe {
  regrouped = 0;
  protected override checkMergeThreshold(): void { this.regrouped++; }
  seedQuarantine(sourceIds: string[]): void {
    (this as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine.set('q', {
      key: 'q',
      level: 2,
      sourceIds,
      attempts: 5,
      quarantinedAt: 1,
      lastOutcome: 'refusal',
    });
  }
  sweep(): void { this.sweepPaidOffMergeQuarantine(); }
  quarantineSize(): number {
    return (this as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine.size;
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
  p.setChunks(Array.from({ length: 5000 }, (_, i) => `m-${i}`));
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

test('any hole containing live messages splits merge runs', () => {
  const p = probe();
  const unmerged = [
    summary('a', 0, 50), summary('b', 120, 200),   // live hole: hard seam
    summary('c', 201, 300), summary('d', 301, 400),
    summary('e', 401, 500),
    summary('f', 3000, 3100),                       // 2500-message gap: breaks
  ];
  const interior = p.pick(unmerged, 6);
  assert.deepEqual(interior!.map((summary) => summary.id), ['b', 'c', 'd', 'e']);
  assert.ok(!interior!.some((summary) => summary.id === 'a' || summary.id === 'f'));
});

test('a small hole does not bridge while its lower-level group is still pending', () => {
  const p = probe();
  const unmerged = [
    summary('a', 0, 50), summary('b', 51, 100),
    summary('c', 101, 150), summary('d', 151, 200),
    // Only 216 live messages separate d and e; strict live adjacency treats
    // the represented middle as a hard seam.
    summary('e', 417, 470), summary('f', 471, 520),
  ];
  p.setSummaries([{
    id: 'pending-l1',
    level: 1,
    content: 'pending lower group',
    tokens: 100,
    sourceLevel: 0,
    sourceIds: ['m-201', 'm-416'],
    sourceRange: { first: 'm-201', last: 'm-416' },
    created: 1,
  } as SummaryEntry]);

  const picked = p.pick(unmerged, 6);
  assert.ok(picked, 'the now-interior older run can consolidate');
  assert.deepEqual(picked!.map((entry) => entry.id), ['a', 'b', 'c', 'd']);
  assert.ok(!picked!.some((entry) => entry.id === 'e' || entry.id === 'f'));
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

test('stranded interior runs merge at >=2; only the newest run waits for the threshold', () => {
  const p = probe();
  const msgs = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `m-${a + i}`);
  void msgs;
  // The mythos starvation shape: two runs, both BELOW threshold, separated by a
  // huge hole. Old code: no run reaches 6 → nothing ever merges → the pyramid
  // freezes and the fold floor grows without bound.
  const unmerged = [
    summary('a', 913, 922), summary('b', 923, 938), summary('c', 939, 957),
    summary('d', 958, 963), summary('e', 964, 981),        // interior run (5)
    summary('f', 4039, 4065), summary('g', 4066, 4083),
    summary('h', 4084, 4094), summary('i', 4095, 4105),
    summary('j', 4106, 4131),                              // newest run (5)
  ];
  const run = p.pick(unmerged, 6);
  assert.ok(run, 'the stranded interior run merges rather than waiting forever');
  assert.deepEqual(run!.map((s) => s.id), ['a','b','c','d','e'], 'oldest stranded run, all 5');

  // The newest run alone (nothing stranded) still waits for the full threshold.
  const onlyNewest = unmerged.slice(5);
  assert.equal(p.pick(onlyNewest, 6), null, 'the growable run waits for 6');
});

test('partially paid quarantine is stale and releases orphan regrouping', () => {
  const p = new QuarantineProbe({ adaptiveResolution: true, autoTickOnNewMessage: false });
  p.setSummaries([
    { ...summary('a', 0, 10), mergedInto: 'L3-paid' },
    summary('b', 11, 20),
  ]);
  p.seedQuarantine(['a', 'b']);

  p.sweep();

  assert.equal(p.quarantineSize(), 0);
  assert.equal(p.regrouped, 1, 'remaining orphan is reconsidered under the current grammar');
});

test('persisted merge queues from the old gap grammar are discarded', () => {
  const p = probe();
  const a = summary('a', 0, 50);
  const b = summary('b', 120, 200);
  p.setSummaries([a, b]);
  p.setMergeQueue([{ level: 3, sourceIds: [a.id, b.id] }]);

  p.sanitizeQueue(Array.from({ length: 5000 }, (_, index) => `m-${index}`));

  assert.equal(p.mergeQueueLength(), 0);
});
