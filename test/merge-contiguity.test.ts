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

test('a quarantined oldest group does not block later history from merging', () => {
  // Librarian 2026-09-08 → 09-24: the oldest six L1s were refused and
  // quarantined; the selector re-offered exactly that group on every pass,
  // enqueueMerge declined it, and 322 newer L1s were never attempted.
  const p = new QuarantineProbe({ adaptiveResolution: true, autoTickOnNewMessage: false });
  p.setChunks(Array.from({ length: 5000 }, (_, i) => `m-${i}`));
  const oldest = Array.from({ length: 6 }, (_, i) => summary(`q${i}`, i * 10, i * 10 + 9));
  const later = Array.from({ length: 7 }, (_, i) => summary(`n${i}`, 60 + i * 10, 60 + i * 10 + 9));
  p.seedQuarantine(oldest.map((s) => s.id));
  const run = p.pick([...oldest, ...later], 6);
  assert.deepEqual(run?.map((s) => s.id), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
});

test('operator merge holds split the frontier like a hole', () => {
  const p = new Probe({
    adaptiveResolution: true,
    autoTickOnNewMessage: false,
    mergeHoldSummaryIds: ['h2'],
  });
  p.setChunks(Array.from({ length: 5000 }, (_, i) => `m-${i}`));
  const all = Array.from({ length: 9 }, (_, i) => summary(`h${i}`, i * 10, i * 10 + 9));
  // h0,h1 are an interior run (consolidates at 2); the held h2 is never offered.
  assert.deepEqual(p.pick(all, 6)?.map((s) => s.id), ['h0', 'h1']);
  const withoutInterior = all.slice(3);
  assert.deepEqual(p.pick(withoutInterior, 6)?.map((s) => s.id), ['h3', 'h4', 'h5', 'h6', 'h7', 'h8']);
});

// ---- Review follow-ups (#117): one eligibility gate for every scheduler ----

/** Probe that can drive the enqueue paths without a loaded store branch. */
class GateProbe extends QuarantineProbe {
  constructor(config: ConstructorParameters<typeof AutobiographicalStrategy>[0]) {
    super(config);
    // Unit harness only: the branch guard is exercised by the integration suites.
    (this as unknown as { requireBranchMutation: () => void }).requireBranchMutation = () => {};
  }
  produce(level: number, first: string, last: string): void {
    this.handleProducedOps([{ level, range: { firstChunkId: first, lastChunkId: last } }] as never);
  }
  enqueue(level: number, sourceIds: string[]): void { this.enqueueMerge({ level: level as never, sourceIds }); }
  queue(): Array<{ level: number; sourceIds: string[] }> {
    return (this as unknown as { mergeQueue: Array<{ level: number; sourceIds: string[] }> }).mergeQueue;
  }
}

function l1(id: string, first: number, last: number): SummaryEntry {
  return { ...summary(id, first, last), level: 1, sourceLevel: 0 } as SummaryEntry;
}

function gateProbe(extra: Record<string, unknown> = {}): GateProbe {
  const p = new GateProbe({ adaptiveResolution: true, autoTickOnNewMessage: false, mergeThreshold: 6, ...extra });
  p.setChunks(Array.from({ length: 5000 }, (_, i) => `m-${i}`));
  return p;
}

test('adaptive produce ops never merge a held source, nor span one', () => {
  const p = gateProbe({ mergeHoldSummaryIds: ['h2'] });
  p.setSummaries(Array.from({ length: 9 }, (_, i) => l1(`h${i}`, i * 10, i * 10 + 9)));
  p.produce(2, 'm-0', 'm-89');
  assert.deepEqual(p.queue().map((m) => m.sourceIds), [['h0', 'h1']], 'first eligible run before the hold');
});

test('adaptive produce ops cannot re-request a quarantined group or a superset of it', () => {
  const p = gateProbe();
  const q = Array.from({ length: 6 }, (_, i) => l1(`q${i}`, i * 10, i * 10 + 9));
  const n = Array.from({ length: 6 }, (_, i) => l1(`n${i}`, 60 + i * 10, 69 + i * 10));
  p.setSummaries([...q, ...n]);
  p.seedQuarantine(q.map((s) => s.id));
  p.enqueue(2, ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'n0']); // superset: refused at the gate
  assert.equal(p.queue().length, 0);
  p.produce(2, 'm-0', 'm-119'); // the picker asks for the whole range
  assert.deepEqual(p.queue().map((m) => m.sourceIds), [['n0', 'n1', 'n2', 'n3', 'n4', 'n5']]);
});

test('a persisted queue entry that now contains a held source is dropped on load', () => {
  const held = gateProbe({ mergeHoldSummaryIds: ['b'] });
  const kept = gateProbe();
  for (const p of [held, kept]) {
    p.setSummaries([summary('a', 0, 50), summary('b', 51, 100)]);
    p.setMergeQueue([{ level: 3, sourceIds: ['a', 'b'] }]);
    p.sanitizeQueue(Array.from({ length: 5000 }, (_, i) => `m-${i}`));
  }
  assert.equal(held.mergeQueueLength(), 0, 'held source → entry dropped');
  assert.equal(kept.mergeQueueLength(), 1, 'control: the same contiguous entry survives without the hold');
});

test('an interior run merges at 2 even when fewer than threshold are eligible overall', () => {
  const p = new Probe({ adaptiveResolution: true, autoTickOnNewMessage: false, mergeHoldSummaryIds: ['H'] });
  p.setChunks(Array.from({ length: 5000 }, (_, i) => `m-${i}`));
  const six = ['h0', 'h1', 'H', 'h3', 'h4', 'h5'].map((id, i) => summary(id, i * 10, i * 10 + 9));
  assert.deepEqual(p.pick(six, 6)?.map((s) => s.id), ['h0', 'h1'], 'five eligible, but [h0,h1] is interior');
});

test('the compression-debt report names held ids and quarantine keys', () => {
  const p = gateProbe({ mergeHoldSummaryIds: ['h1'] });
  p.seedQuarantine(['x', 'y']);
  const debt = p.getCompressionDebt();
  assert.deepEqual(debt.mergeHeldIds, ['h1']);
  assert.deepEqual(debt.mergeQuarantineKeys, ['q']);
});
