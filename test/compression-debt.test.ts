/**
 * getCompressionDebt() — the single-authority reduction behind the
 * fleet-watch compression-debt alarm and the af #99 resident notice.
 * The 2026-08-06 five-resident wedge day is the motivating incident:
 * every outage was silently-failing compression surfacing weeks later
 * as a budget crisis. These tests pin the state thresholds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'node:util';

import { AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { SummaryEntry } from '../src/types/index.js';

const HOUR = 60 * 60 * 1000;

class Probe extends AutobiographicalStrategy {
  setChunks(chunks: Chunk[]): void {
    (this as unknown as { chunks: Chunk[] }).chunks = chunks;
  }
  seedSummary(entry: SummaryEntry): void {
    (this as unknown as { summaries: SummaryEntry[] }).summaries.push(entry);
  }
  setMergeQueue(entries: Array<{ attempts?: number }>): void {
    (this as unknown as { mergeQueue: Array<{ attempts?: number }> }).mergeQueue = entries;
  }
  setMergeQuarantine(keys: string[]): void {
    const m = (this as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine;
    m.clear();
    for (const k of keys) m.set(k, { key: k });
  }
  setTopologyViolations(count: number): void {
    (this as unknown as { topologyViolations: unknown[] }).topologyViolations = Array.from({ length: count }, (_, i) => ({ id: `L2-${i}` }));
  }
  /** The report reads the quarantine ledger only when there is a store, so this gives it one whose ledger read throws. */
  breakLedger(error: unknown = new Error('ledger unreadable (test)')): void {
    const self = this as unknown as { store: unknown; readCompressionQuarantineProjection(): unknown };
    self.store ??= {};
    self.readCompressionQuarantineProjection = () => { throw error; };
  }
  /** A store whose ledger reads, holding `records` quarantine records. */
  ledgerHolding(records: number): void {
    const self = this as unknown as { store: unknown; readCompressionQuarantineProjection(): unknown };
    self.store ??= {};
    self.readCompressionQuarantineProjection = () => new Map(Array.from({ length: records }, (_, i) => [`k${i}`, {}]));
  }
  mendLedger(): void {
    this.ledgerHolding(0);
  }
  /** The namespace its diagnostics name, as a store gives it. */
  setNamespace(ns: string): void {
    this.ns = ns;
  }
  private heldChunks: Chunk[] = [];
  /** Reading its chunks throws `thrown`, until mendChunks() puts them back. */
  breakChunks(thrown: unknown): void {
    this.heldChunks = (this as unknown as { chunks: Chunk[] }).chunks;
    Object.defineProperty(this, 'chunks', { get() { throw thrown; }, configurable: true });
  }
  mendChunks(): void {
    Object.defineProperty(this, 'chunks', { value: this.heldChunks, writable: true, configurable: true, enumerable: true });
  }
}

function chunk(opts: { compressed: boolean; lastMessageAt?: number }): Chunk {
  return {
    index: 0,
    startIndex: 0,
    endIndex: 1,
    messages: opts.lastMessageAt !== undefined
      ? ([{ timestamp: opts.lastMessageAt }] as never)
      : ([] as never),
    tokens: 100,
    compressed: opts.compressed,
  } as Chunk;
}

function fresh(): Probe {
  return new Probe({ hierarchical: true, autoTickOnNewMessage: false });
}

describe('getCompressionDebt', () => {
  const NOW = 1_800_000_000_000;

  it('empty strategy is healthy', () => {
    const d = fresh().getCompressionDebt(NOW);
    assert.equal(d.state, 'healthy');
    assert.equal(d.pendingChunks, 0);
    assert.equal(d.oldestPendingAgeMs, null);
    assert.equal(d.mergeQueueMaxAttempts, 0);
  });

  it('the open frontier chunk is life, not debt', () => {
    const s = fresh();
    s.setChunks([chunk({ compressed: true }), chunk({ compressed: false, lastMessageAt: NOW - 10 * HOUR })]);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.pendingChunks, 0, 'trailing uncompressed chunk excluded');
    assert.equal(d.state, 'healthy');
  });

  it('a closed chunk pending under an hour is healthy; over an hour is degraded', () => {
    const s = fresh();
    s.setChunks([chunk({ compressed: false, lastMessageAt: NOW - HOUR / 2 }), chunk({ compressed: true })]);
    assert.equal(s.getCompressionDebt(NOW).state, 'healthy');
    s.setChunks([chunk({ compressed: false, lastMessageAt: NOW - 2 * HOUR }), chunk({ compressed: true })]);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.state, 'degraded');
    assert.ok((d.oldestPendingAgeMs ?? 0) > HOUR);
  });

  it('a merge-quarantine record with another outcome isn\'t a refused crossed merge', () => {
    const s = fresh();
    const m = (s as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine;
    // Its group stands, every source present and unparented, so only its outcome keeps it from counting.
    for (const id of ['a', 'b']) s.seedSummary({ id, level: 1, content: id, tokens: 1, sourceLevel: 0, sourceIds: [], created: NOW } as unknown as SummaryEntry);
    m.set('k', { key: 'k', sourceIds: ['a', 'b'], lastOutcome: 'refusal' });
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.topologyRefusals, 0);
    assert.equal(d.state, 'degraded');
  });

  it('any quarantine record is at least degraded', () => {
    const s = fresh();
    s.setMergeQuarantine(['abc123']);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.state, 'degraded');
    assert.equal(d.mergeQuarantineCount, 1);
  });

  it('stale pending + quarantine escalates to critical', () => {
    const s = fresh();
    s.setChunks([chunk({ compressed: false, lastMessageAt: NOW - 7 * HOUR }), chunk({ compressed: true })]);
    s.setMergeQuarantine(['abc123']);
    assert.equal(s.getCompressionDebt(NOW).state, 'critical');
  });

  it('a 5+ chunk stale backlog is critical even without quarantines (the sonn5 freeze shape)', () => {
    const s = fresh();
    const stale = Array.from({ length: 5 }, () => chunk({ compressed: false, lastMessageAt: NOW - 7 * HOUR }));
    s.setChunks([...stale, chunk({ compressed: true })]);
    assert.equal(s.getCompressionDebt(NOW).state, 'critical');
  });

  it('Date timestamps (the live StoredMessage shape) age correctly', () => {
    // Production chunks hold StoredMessage objects whose timestamp is a
    // Date; the number-only filter made every such chunk age-invisible and
    // the staleness ladder unreachable. The live signature (2026-08-29):
    // pendingChunks > 0, oldestPendingAgeMs null, state healthy.
    const s = fresh();
    s.setChunks([
      { ...chunk({ compressed: false }), messages: [{ timestamp: new Date(NOW - 2 * HOUR) }] as never },
      chunk({ compressed: true }),
    ]);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.pendingChunks, 1);
    assert.ok((d.oldestPendingAgeMs ?? 0) > HOUR, 'Date timestamps must produce an age');
    assert.equal(d.state, 'degraded');
  });

  it('microsecond timestamps normalize (chronicle stores µs)', () => {
    const s = fresh();
    s.setChunks([chunk({ compressed: false, lastMessageAt: (NOW - 2 * HOUR) * 1000 }), chunk({ compressed: true })]);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.state, 'degraded');
    assert.ok((d.oldestPendingAgeMs ?? 0) < 3 * HOUR, 'µs value read as ms would be absurdly old');
  });

  it('reports a store with more summaries and merge groups than a call takes as spread arguments (#258)', () => {
    // A call takes about 125,000 spread arguments on node 22 and 24, so the
    // newest mint and the most merge attempts are folded, not spread; a spread
    // here would throw, and the report would come back `unknown` rather than
    // the store's. A failure of this premise means the runtime takes more spread
    // arguments, as with a larger stack (`node --stack-size`) or a newer V8, not
    // that the method changed: raise the count until a spread throws again.
    const count = 200_000;
    assert.throws(() => Math.max(...new Array<number>(count).fill(0)), RangeError,
      'premise: this runtime takes fewer spread arguments than there are summaries');
    const s = fresh();
    // The newest mint and the most attempts sit in the middle, so a fold that
    // kept the first or the last entry fails.
    for (let i = 0; i < count; i++) {
      s.seedSummary({
        id: `L1-${i}`, level: 1, content: 'x', tokens: 5, sourceLevel: 0,
        sourceIds: [], sourceRange: { first: 'a', last: 'b' }, created: NOW - HOUR - Math.abs(i - 123_456),
      } as SummaryEntry);
    }
    // Every fifth entry has never been tried, so it carries no attempts.
    s.setMergeQueue(Array.from({ length: count }, (_, i) => (i === 77_777 ? { attempts: 9 } : i % 5 === 0 ? {} : { attempts: i % 5 })));
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.unmergedFrontier?.l1, count, 'the report is the store\'s, not the empty one');
    assert.equal(d.lastMintAt, NOW - HOUR);
    assert.equal(d.mergeQueueDepth, count);
    assert.equal(d.mergeQueueMaxAttempts, 9);
  });

  it('lastMintAt reflects the newest summary', () => {
    const s = fresh();
    s.seedSummary({
      id: 'L1-1', level: 1, content: 'x', tokens: 5, sourceLevel: 0,
      sourceIds: [], sourceRange: { first: 'a', last: 'b' }, created: NOW - HOUR,
    } as SummaryEntry);
    assert.equal(s.getCompressionDebt(NOW).lastMintAt, NOW - HOUR);
  });
});

describe('getCompressionDebt when it can\'t read what it reports', () => {
  const NOW = 1_800_000_000_000;

  /** The [compression-debt] lines console.error and console.warn get while body runs, formatted as console formats them. */
  function logged(body: () => void): string[] {
    const lines: string[] = [];
    const { error, warn } = console;
    console.error = (...args: unknown[]) => { lines.push(format(...args)); };
    console.warn = (...args: unknown[]) => { lines.push(format(...args)); };
    try {
      body();
    } finally {
      console.error = error;
      console.warn = warn;
    }
    return lines.filter((line) => line.startsWith('[compression-debt]'));
  }

  it('a quarantine ledger it can\'t read is unknown where a record would decide the state, and its count is null', () => {
    const s = fresh();
    s.breakLedger();
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.state, 'unknown', 'with nothing else owed, one record would make it degraded and none healthy');
    assert.equal(d.compressionQuarantineCount, null, 'a count it couldn\'t read is null, never 0');
    assert.equal(d.error, [
      'Compression of new conversation has stalled.',
      "Cause: the store couldn't read this agent's compression quarantine ledger (ledger unreadable (test)).",
      'Effect: chunks that need the model go unsummarized, so in time its context fills and its turns fail until compression catches up.',
      'Fix: fix what the cause names; compression then resumes by itself.',
    ].join('\n'), 'what happened, what it means and what to do, a line each');
    assert.equal(d.failure, 'quarantine-ledger');
    assert.equal(d.pendingChunks, 0, 'what it could read is still reported');
    assert.equal(d.mergeQuarantineCount, 0);
  });

  it('a ledger that reads gives its record count, and any record makes it degraded', () => {
    const s = fresh();
    s.ledgerHolding(2);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.compressionQuarantineCount, 2);
    assert.equal(d.state, 'degraded');
    assert.equal(d.error, undefined);
    assert.equal(d.failure, undefined);
  });

  it('a ledger it can\'t read leaves the state that the rest decides', () => {
    const stale = fresh();
    stale.breakLedger();
    stale.setChunks([chunk({ compressed: false, lastMessageAt: NOW - 2 * HOUR }), chunk({ compressed: true })]);
    const staleDebt = stale.getCompressionDebt(NOW);
    assert.equal(staleDebt.state, 'degraded', 'waited between 1h and 6h: degraded with or without a record');
    assert.equal(staleDebt.pendingChunks, 1, 'the pending count it could read is kept');

    const merge = fresh();
    merge.breakLedger();
    merge.setMergeQuarantine(['abc123']);
    const mergeDebt = merge.getCompressionDebt(NOW);
    assert.equal(mergeDebt.state, 'degraded', 'a merge-quarantine record already makes it degraded');
    assert.equal(mergeDebt.mergeQuarantineCount, 1, 'the merge count it could read is kept');

    const crossed = fresh();
    crossed.breakLedger();
    crossed.setTopologyViolations(1);
    const d = crossed.getCompressionDebt(NOW);
    assert.equal(d.state, 'critical', 'crossed ownership is critical whatever the ledger holds');
    assert.equal(d.compressionQuarantineCount, null);
    assert.match(d.error ?? '', /^Compression of new conversation has stalled\.\nCause: the store couldn't read this agent's compression quarantine ledger \(/, 'the error is given with a decided state too');
    assert.equal(d.failure, 'quarantine-ledger');

    const old = fresh();
    old.breakLedger();
    old.setChunks([chunk({ compressed: false, lastMessageAt: NOW - 7 * HOUR }), chunk({ compressed: true })]);
    assert.equal(old.getCompressionDebt(NOW).state, 'unknown', 'waited over 6h with under 5 pending: a record would make it critical');
  });

  it('a report that fails outright is unknown, and every count is null', () => {
    const s = fresh();
    Object.defineProperty(s, 'chunks', { get() { throw new RangeError('chunks unreadable (test)'); }, configurable: true });
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.state, 'unknown');
    assert.equal(d.error, [
      'The compression debt report failed.',
      'Cause: chunks unreadable (test)',
      "Effect: the report can't say whether compression is keeping up. Compression itself may be running normally.",
      'Fix: this points to a fault in context-manager or in the options it was given. Report it.',
    ].join('\n'));
    assert.equal(d.failure, 'report');
    for (const [field, value] of Object.entries(d)) {
      if (field === 'state' || field === 'error' || field === 'failure') continue;
      assert.equal(value, null, `${field} is null, not a guess`);
    }
  });

  it('logs a failure once, and again only after a report succeeds or the failure changes', () => {
    assert.equal(logged(() => fresh().getCompressionDebt(NOW)).length, 0, 'a report that reads, with no failure before it, logs nothing');
    const s = fresh();
    s.setNamespace('agents/probe');
    s.breakLedger();
    assert.equal(logged(() => { s.getCompressionDebt(NOW); s.getCompressionDebt(NOW); }).length, 1, 'once across polls');
    s.breakLedger(new Error('another failure (test)'));
    assert.equal(logged(() => s.getCompressionDebt(NOW)).length, 1, 'a different failure logs');
    s.mendLedger();
    assert.deepEqual(logged(() => { s.getCompressionDebt(NOW); s.getCompressionDebt(NOW); }),
      ['[compression-debt] the report reads again ns=agents/probe'], 'the first report that reads again says so, once, through the strategy\'s diagnostics');
    s.breakLedger(new Error('another failure (test)'));
    const again = logged(() => s.getCompressionDebt(NOW));
    assert.equal(again.length, 1, 'the same failure logs again after a success');
    assert.match(again[0]!, /^\[compression-debt\] Compression of new conversation has stalled\. Cause: [^\n]*\(another failure \(test\)\)\. Effect: [^\n]+ Fix: fix what the cause names; compression then resumes by itself\. ns=agents\/probe Error: another failure \(test\)\n/,
      'the error whole on one line, the namespace at its end, then the thrown value');
  });

  it('an outright failure, a partial one and a report that reads log a line each', () => {
    const s = fresh();
    const lines = logged(() => {
      s.breakChunks(new Error('chunks unreadable (test)'));
      assert.equal(s.getCompressionDebt(NOW).state, 'unknown');
      s.mendChunks();
      s.breakLedger();
      assert.equal(s.getCompressionDebt(NOW).compressionQuarantineCount, null);
      s.mendLedger();
      assert.equal(s.getCompressionDebt(NOW).state, 'healthy');
    });
    assert.equal(lines.length, 3, lines.join('\n'));
    assert.match(lines[0]!, /^\[compression-debt\] The compression debt report failed\. Cause: chunks unreadable \(test\) Effect: [^\n]+ Fix: [^\n]+ Report it\. Error: chunks unreadable \(test\)\n/);
    assert.match(lines[1]!, /^\[compression-debt\] Compression of new conversation has stalled\. Cause: the store couldn't read this agent's compression quarantine ledger \(ledger unreadable \(test\)\)\. Effect: /);
    assert.equal(lines[2], '[compression-debt] the report reads again');
  });

  it('a failure while the report is being built logs once across polls', () => {
    // A recipe's mergeHoldSummaryIds that isn't a list fails as the report is
    // put together, after its state is worked out.
    const s = new Probe({ hierarchical: true, autoTickOnNewMessage: false, mergeHoldSummaryIds: {} as never });
    const lines = logged(() => {
      assert.equal(s.getCompressionDebt(NOW).state, 'unknown');
      assert.equal(s.getCompressionDebt(NOW).state, 'unknown');
    });
    assert.equal(lines.length, 1);
  });

  it('a \'%\' in a failure\'s text is logged as itself', () => {
    const s = fresh();
    s.breakLedger(new Error('100%s gone (test)'));
    const [line] = logged(() => s.getCompressionDebt(NOW));
    assert.match(line ?? '', /compression quarantine ledger \(100%s gone \(test\)\)\. Effect: /);
  });

  it('a cause with line breaks stays on the Cause line', () => {
    const s = fresh();
    s.breakLedger(new Error('first part\n  second part (test)'));
    const error = s.getCompressionDebt(NOW).error ?? '';
    assert.equal(error.split('\n').length, 4, error);
    assert.equal(error.split('\n')[1], "Cause: the store couldn't read this agent's compression quarantine ledger (first part second part (test)).");
  });

  it('an outright failure\'s cause with line breaks stays on its Cause line', () => {
    const s = fresh();
    Object.defineProperty(s, 'chunks', { get() { throw new Error('first part\n  second part (test)'); }, configurable: true });
    const error = s.getCompressionDebt(NOW).error ?? '';
    assert.equal(error.split('\n').length, 4, error);
    assert.equal(error.split('\n')[1], 'Cause: first part second part (test)');
  });

  it('a long cause is cut, so each message stays under 500 and keeps its Fix line', () => {
    const long = new Error(`${'x'.repeat(170)} end of a long path (test) ${'y'.repeat(100)}`);
    const s = fresh();
    s.breakLedger(long);
    const ledger = (s.getCompressionDebt(NOW).error ?? '').split('\n');
    assert.ok(ledger.join('\n').length < 500, `${ledger.join('\n').length} characters`);
    assert.equal(ledger.length, 4);
    assert.equal(ledger[1], `Cause: the store couldn't read this agent's compression quarantine ledger (${'x'.repeat(170)} end of a…).`);
    assert.equal(ledger[3], 'Fix: fix what the cause names; compression then resumes by itself.');
    const t = fresh();
    Object.defineProperty(t, 'chunks', { get() { throw long; }, configurable: true });
    const outright = (t.getCompressionDebt(NOW).error ?? '').split('\n');
    assert.ok(outright.join('\n').length < 500, `${outright.join('\n').length} characters`);
    assert.equal(outright[1], `Cause: ${'x'.repeat(170)} end of a…`);
    assert.equal(outright[3], 'Fix: this points to a fault in context-manager or in the options it was given. Report it.');
  });

  it('a cut cause never parts a surrogate pair', () => {
    const s = fresh();
    s.breakLedger(new Error(`${'a'.repeat(178)}\u{1F600}\u{1F600}\u{1F600}`));
    const cause = (s.getCompressionDebt(NOW).error ?? '').split('\n')[1] ?? '';
    assert.doesNotMatch(cause, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    assert.ok(cause.endsWith(`${'a'.repeat(178)}…).`), cause);
  });

  it('a thrown value that isn\'t an Error is the error\'s text', () => {
    const s = fresh();
    Object.defineProperty(s, 'chunks', { get() { throw 'chunks unreadable (test)'; }, configurable: true });
    assert.match(s.getCompressionDebt(NOW).error ?? '', /^The compression debt report failed\.\nCause: chunks unreadable \(test\)\n/);
  });

  it('a thrown value with no text still gives the report an error', () => {
    const s = fresh();
    // An Error whose message isn't a string, which no template or String() can turn into text.
    const odd = new Error('replaced');
    Object.defineProperty(odd, 'message', { value: Symbol('no text') });
    Object.defineProperty(s, 'chunks', { get() { throw odd; }, configurable: true });
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.state, 'unknown');
    assert.match(d.error ?? '', /^The compression debt report failed\.\nCause: an error that could not be described\n/);
  });

  it('a logger that throws doesn\'t make the report throw', () => {
    const s = fresh();
    s.breakLedger();
    const { error, warn } = console;
    let calls = 0;
    console.error = () => { calls += 1; throw new Error('logger down (test)'); };
    console.warn = () => { calls += 1; throw new Error('logger down (test)'); };
    try {
      assert.equal(s.getCompressionDebt(NOW).state, 'unknown');
      s.mendLedger();
      assert.equal(s.getCompressionDebt(NOW).state, 'healthy', 'nor when it reads again');
    } finally {
      console.error = error;
      console.warn = warn;
    }
    assert.equal(calls, 2, 'the report tried to log the failure and the recovery');
  });
});
