/**
 * Level-scaled wide-span quarantine (2026-08-17) — regression tests.
 *
 * The flat `mergeMaxSourceSpanMessages` default (1500) silently forbade all
 * consolidation above the level whose healthy span exceeds it: on mythos,
 * every L4 legitimately spans 3.0k–6.9k messages, so all eight were
 * quarantined and an L5 was structurally impossible at any store state —
 * with no log, the merge queue simply read as empty while the fold floor sat
 * ~23k tokens above where one L5 puts it. The limit is now scaled
 * `base × mergeThreshold^(max(0, level − 3))` (L1–L3 unchanged), and every
 * exclusion — wide-span or unresolved-source — warns loudly, once per id.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import type { SummaryEntry } from '../src/types/strategy.js';

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

function summary(id: string, first: number, last: number, level = 2): SummaryEntry {
  return {
    id, level, content: `s ${id}`, tokens: 100, sourceLevel: level - 1,
    sourceIds: [`x-${id}`],
    sourceRange: { first: `m-${first}`, last: `m-${last}` },
    created: 1,
  } as SummaryEntry;
}

function probe(messages: number): Probe {
  const p = new Probe({ adaptiveResolution: true, autoTickOnNewMessage: false });
  p.setChunks(Array.from({ length: messages }, (_, i) => `m-${i}`));
  return p;
}

function captureWarns(fn: () => void): string[] {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.warn = orig; }
  return warns;
}

test('the mythos regression: six healthy L4s (span ~3k each) merge into an L5', () => {
  const p = probe(20000);
  // Contiguous L4 run with realistic spans (3032–3400 msgs each) — every one
  // of these exceeded the old flat 1500 limit and was silently quarantined.
  const unmerged = [
    summary('l4-a', 0, 3100, 4), summary('l4-b', 3101, 6200, 4),
    summary('l4-c', 6201, 9500, 4), summary('l4-d', 9501, 12600, 4),
    summary('l4-e', 12601, 15900, 4), summary('l4-f', 15901, 19000, 4),
  ];
  const picked = p.pick(unmerged, 6);
  assert.ok(picked, 'L4 run must be merge-eligible under the scaled limit');
  assert.deepEqual(picked.map((s) => s.id), ['l4-a', 'l4-b', 'l4-c', 'l4-d', 'l4-e', 'l4-f']);
});

test('a wide-FOR-ITS-LEVEL candidate is still quarantined (protection preserved)', () => {
  const p = probe(5000);
  // An L2 spanning 4000 messages is the replay-era bridge signature the
  // guard exists for; it must stay out even though an L4 of the same span
  // would be healthy.
  const unmerged = [
    summary('bridge', 0, 4000, 2),
    summary('a', 0, 200), summary('b', 201, 400), summary('c', 401, 600),
    summary('d', 601, 800), summary('e', 801, 1000), summary('f', 1001, 1200),
  ];
  const warns = captureWarns(() => {
    const picked = p.pick(unmerged, 6);
    assert.ok(picked);
    assert.ok(!picked.some((s) => s.id === 'bridge'), 'bridge must be excluded');
  });
  assert.ok(warns.some((w) => w.includes('wide-span quarantine') && w.includes('bridge')),
    `expected loud quarantine warn, got: ${warns.join(' | ')}`);
});

test('scaled boundary: L4 span at exactly base×k passes; one over is excluded', () => {
  const base = 1500, k = 6; // defaults → L4 limit 9000
  const p = probe(20000);
  const atLimit = [summary('ok', 0, base * k, 4)]; // span == 9000
  const overLimit = [summary('wide', 0, base * k + 1, 4)]; // span == 9001
  // threshold 1 so the single candidate reaches the exclusion loop
  // (unmerged.length < threshold short-circuits before it).
  const warnsOk = captureWarns(() => {
    assert.ok(p.pick(atLimit, 1), 'span==limit must be pickable');
  });
  assert.ok(!warnsOk.some((w) => w.includes('wide-span')), 'span==limit must pass');
  const warnsOver = captureWarns(() => {
    assert.equal(p.pick(overLimit, 1), null);
  });
  assert.ok(warnsOver.some((w) => w.includes('wide-span') && w.includes('wide')),
    'span>limit must warn');
});

test('unresolved source positions warn loudly instead of silently dropping', () => {
  const p = probe(1000);
  const unmerged = [summary('ghost', 5000, 5100)]; // m-5000 not in chunks
  const warns = captureWarns(() => {
    assert.equal(p.pick(unmerged, 1), null);
  });
  assert.ok(warns.some((w) => w.includes('source position unresolved') && w.includes('ghost')),
    `expected frontier-debt warn, got: ${warns.join(' | ')}`);
});

test('exclusion warns are deduped per summary id', () => {
  const p = probe(5000);
  const unmerged = [summary('bridge', 0, 4000, 2)];
  const warns = captureWarns(() => {
    p.pick(unmerged, 1);
    p.pick(unmerged, 1);
    p.pick(unmerged, 1);
  });
  assert.equal(warns.filter((w) => w.includes('bridge')).length, 1,
    'one warn per id per process');
});
