import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutobiographicalStrategy } from '../src/index.js';
import type { SummaryEntry } from '../src/types/index.js';

interface Internals {
  store: { getStateJson(stateId: string): unknown } | null;
  readonly summariesStateId: string;
  summaries: Array<SummaryEntry | null>;
  persistedCanonicalSummariesById(): Map<string, SummaryEntry>;
  sameAuthoredSummary(a: SummaryEntry, b: SummaryEntry): boolean;
}

function scanEachSummary(strategy: Internals, stored: unknown[]): Map<string, SummaryEntry> {
  const canonical = new Map<string, SummaryEntry>();
  for (const summary of strategy.summaries) {
    if (!summary || typeof summary.id !== 'string') continue;
    if (stored.some((alternate) => alternate && strategy.sameAuthoredSummary(summary, alternate as SummaryEntry))) {
      canonical.set(summary.id, summary);
    }
  }
  return canonical;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function forest(next: () => number): { stored: unknown[]; summaries: Array<SummaryEntry | null> } {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const entry = (): SummaryEntry => ({
    id: pick(['s1', 's2', 's3', 's4', '5', '', '__proto__', 'constructor']),
    level: pick([1, 2]),
    sourceLevel: pick([0, 1]),
    content: pick(['a', 'b']),
    tokens: pick([10, 12]),
    sourceIds: pick([['c1'], ['c1', 'c2'], ['c2']]),
    sourceRange: pick([{ first: 'm1', last: 'm2' }, { first: 'm1', last: 'm3' }, { first: 'm0', last: 'm2' }]),
    ...(next() < 0.5 ? { mergedInto: pick(['p1', 'p2']) } : {}),
  }) as SummaryEntry;
  const stored: unknown[] = [];
  const storedCount = Math.floor(next() * 12);
  for (let i = 0; i < storedCount; i++) {
    const roll = next();
    stored.push(
      roll < 0.08
        ? null
        : roll < 0.14
          ? pick([5, 0, '', false, 'text', [], { content: 'a' }, { id: 5, level: 1 }])
          : roll < 0.18
            ? { ...entry(), id: 5 }
            : entry(),
    );
  }
  const summaries: Array<SummaryEntry | null> = [];
  const summaryCount = Math.floor(next() * 8);
  for (let i = 0; i < summaryCount; i++) {
    const roll = next();
    const copy = stored.length > 0 ? (pick(stored) as SummaryEntry | null) : null;
    if (roll < 0.05) summaries.push(null);
    else if (roll < 0.6 && copy && typeof copy === 'object' && !Array.isArray(copy) && 'id' in copy) {
      summaries.push({ ...structuredClone(copy), mergedInto: pick(['p1', 'p2', undefined]) } as SummaryEntry);
    } else summaries.push(entry());
  }
  return { stored, summaries };
}

test('the persisted canonical map holds exactly the summaries a scan of every stored copy finds', () => {
  const strategy = new AutobiographicalStrategy({}) as unknown as Internals;
  let laterCopyMatches = 0;
  let idWithoutMatch = 0;
  let sameApartFromId = 0;
  let numericIdWithCopy = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    const { stored, summaries } = forest(random(seed));
    strategy.store = { getStateJson: (stateId) => (stateId === strategy.summariesStateId ? stored : null) };
    strategy.summaries = summaries;
    const expected = scanEachSummary(strategy, stored);
    const actual = strategy.persistedCanonicalSummariesById();
    assert.deepStrictEqual([...actual.keys()], [...expected.keys()], `seed ${seed}`);
    for (const [id, summary] of expected) assert.equal(actual.get(id), summary, `seed ${seed}: ${id}`);
    for (const summary of summaries) {
      if (!summary) continue;
      const copies = stored.filter((s): s is SummaryEntry => !!s && typeof s === 'object' && (s as SummaryEntry).id === summary.id);
      const matching = copies.map((copy) => strategy.sameAuthoredSummary(summary, copy));
      if (matching.length > 1 && !matching[0] && matching.includes(true)) laterCopyMatches++;
      if (copies.length > 0 && !matching.includes(true)) idWithoutMatch++;
      const others = stored.filter((s): s is SummaryEntry => !!s && typeof s === 'object' && !Array.isArray(s) && (s as SummaryEntry).id !== summary.id);
      if (typeof summary.id === 'string' && others.some((other) => strategy.sameAuthoredSummary({ ...other, id: summary.id }, summary))) sameApartFromId++;
      if (typeof summary.id === 'number' && copies.length > 0) numericIdWithCopy++;
    }
  }
  assert.ok(laterCopyMatches > 0, 'some summary matches only a later stored copy of its id');
  assert.ok(idWithoutMatch > 0, 'some summary has stored copies of its id, none of them authored the same');
  assert.ok(sameApartFromId > 0, 'some stored copy is authored the same as a held summary apart from its id');
  assert.ok(numericIdWithCopy > 0, 'some held summary with a numeric id has a stored copy of it');
});

test('each held summary is compared only with the stored copies of its own id', () => {
  const strategy = new AutobiographicalStrategy({}) as unknown as Internals;
  const held = Array.from({ length: 200 }, (_, i) => ({
    id: `s${i}`, level: 1, sourceLevel: 0, content: `c${i}`, tokens: 10, sourceIds: [`c${i}`], sourceRange: { first: `m${i}`, last: `m${i}` },
  }) as SummaryEntry);
  const stored = held.map((summary) => structuredClone(summary)).reverse();
  strategy.store = { getStateJson: (stateId) => (stateId === strategy.summariesStateId ? stored : null) };
  strategy.summaries = held;
  const compare = strategy.sameAuthoredSummary.bind(strategy);
  let comparisons = 0;
  strategy.sameAuthoredSummary = (a, b) => {
    comparisons++;
    return compare(a, b);
  };
  assert.equal(strategy.persistedCanonicalSummariesById().size, 200);
  assert.ok(comparisons <= 200, `${comparisons} comparisons`);
});
