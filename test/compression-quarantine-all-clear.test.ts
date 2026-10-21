/**
 * The compression-quarantine alarm's all-clear says "quarantine empty, debt
 * paid", and a host routes it to its operators, so it isn't said while the
 * quarantine the alarm last sounded on may still hold debt: not when the
 * status read fails, and not while the strategy reads another branch or
 * namespace. A ledger entry with no usable record or generation holds no
 * chunk back, so the projection leaves it out and names it, and a compression
 * or a clear no longer throws on it; a ledger or legacy snapshot that holds no
 * list is read as holding nothing, a checkpoint that holds none replaces what
 * came before it with nothing, and each is named.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { CompressionQuarantineStatus, StrategyContext } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'quarantine-all-clear-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// An hour, so no real pause inside a test reaches it; `later` moves the clock past it.
const INTERVAL = 3_600_000;
const CONFIG = {
  compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
  autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, compressionRefusalCurveFallbacks: 0,
  quarantineAlarmIntervalMs: INTERVAL,
};

class ProbeStrategy extends AutobiographicalStrategy {
  closedChunks(): Chunk[] { return this.chunks; }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
  alarm(): Promise<void> {
    return (this as unknown as { soundQuarantineAlarmIfNeeded(): Promise<void> }).soundQuarantineAlarmIfNeeded();
  }
  get ledgerId(): string { return this.compressionRefusalQuarantineLedgerStateId; }
  get legacyId(): string { return this.compressionRefusalQuarantineStateId; }
  get nsName(): string { return this.ns; }
}

let membraneCalls = 0;
const refusing = {
  complete: async () => {
    membraneCalls += 1;
    return {
      content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 },
      raw: { response: { stop_details: { category: 'cyber' } } },
    };
  },
} as never;

function context(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

type Event = Record<string, unknown>;

/** A store whose summarizer refused its first closed chunk, so one quarantine record stands. */
async function refused(name: string) {
  const strategy = new ProbeStrategy(CONFIG as never);
  const manager = await ContextManager.open({ path: join(dir, name), strategy, membrane: refusing });
  for (let i = 0; i < 16; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `raw-${i} ${'substantive '.repeat(12)}` }]);
  await manager.compile();
  const chunks = strategy.closedChunks();
  assert.ok(chunks.length >= 2, 'setup: two closed chunks');
  await strategy.run(chunks[0]!, context(manager));
  assert.equal(strategy.getCompressionQuarantineStatus().count, 1, 'setup: one refusal, one record');
  const store = manager.getStore();
  const ledger = () => store.getStateJson(strategy.ledgerId) as Event[];
  const real = ledger().find((event) => event.kind === 'exhausted')!;
  const record = real.record as { key: string; chunkSourceHash: string };
  return {
    strategy, manager, store, ledger, real, key: record.key, hash: record.chunkSourceHash,
    append: (...events: Event[]) => { store.setStateJson(strategy.ledgerId, [...ledger(), ...events]); },
  };
}

/** The quarantine lines on stderr as the strategy's diagnostics write them, ` ns=<namespace>` after each message and before any error it carries, and the handler's calls, while `body` runs. */
async function heard(strategy: ProbeStrategy, body: () => Promise<void> | void) {
  const lines: string[] = [];
  const handled: CompressionQuarantineStatus[] = [];
  strategy.setQuarantineAlarmHandler((status) => handled.push(status));
  const { error, warn } = console;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await body();
  } finally {
    console.error = error;
    console.warn = warn;
  }
  return { lines: lines.filter((line) => line.startsWith('[compression-quarantine]')), handled };
}

/** Sound the alarm on the standing record, as a host would first hear it. */
async function sounding(strategy: ProbeStrategy): Promise<void> {
  const first = await heard(strategy, () => strategy.alarm());
  assert.deepEqual(first.handled.map((status) => status.count), [1], 'setup: the alarm sounds on the refused chunk');
}

const counts = (handled: CompressionQuarantineStatus[]) => handled.map((status) => status.count);
const allClear = (line: string) => line.includes('ALL CLEAR');
const ALL_CLEAR = '[compression-quarantine] ✅ ALL CLEAR — quarantine empty, debt paid; alarm stands down ns=default';
const outcome = { outcome: 'refusal' };

describe('the compression-quarantine all-clear is said only when the quarantine the alarm last sounded on is empty', () => {
  // The alarm reads Date.now(); a skew moves it past its interval without waiting.
  const realNow = Date.now;
  let skew = 0;
  const later = (ms: number) => { skew += ms; };
  before(() => { Date.now = () => realNow() + skew; });
  afterEach(() => { skew = 0; });
  after(() => { Date.now = realNow; });

  it('leaves out and names once each ledger entry it can\'t use, so the alarm stands on the usable ones and compression goes on', async () => {
    const fx = await refused('unusable');
    await sounding(fx.strategy);
    const answered = fx.strategy.getCompressionQuarantineStatus().spans[0]!.answeredAttempts;
    const usable = (key: string) => ({ key, chunkSourceHash: fx.hash, created: 1 });
    fx.append(
      // A checkpoint carrying the real entry, a null item, one with a null record, one whose record has no chunk
      // hash or a key that isn't a string, ones whose generation isn't a string or is empty, and a usable one whose
      // outcome list mixes in what isn't an outcome.
      {
        kind: 'checkpoint', key: '__checkpoint__', created: 1,
        active: [
          { generationId: fx.real.eventId, record: fx.real.record, outcomes: fx.real.outcomes, sentAlertKeys: [fx.key] },
          null,
          { generationId: 'null-record-generation', record: null, outcomes: [], sentAlertKeys: [] },
          { generationId: 'checkpoint-no-hash-generation', record: { key: 'checkpoint-no-hash', created: 1 }, outcomes: [], sentAlertKeys: [] },
          { generationId: 'checkpoint-numeric-key-generation', record: { key: 17, chunkSourceHash: fx.hash, created: 1 }, outcomes: [], sentAlertKeys: [] },
          { generationId: { not: 'a string' }, record: usable('checkpoint-object-generation'), outcomes: [], sentAlertKeys: [] },
          { generationId: '', record: usable('checkpoint-empty-generation'), outcomes: [], sentAlertKeys: [] },
          { generationId: 'checkpoint-mixed-generation', record: usable('checkpoint-mixed'), outcomes: [null, 'x', {}, outcome], sentAlertKeys: [] },
        ],
      },
      // A null event, and an exhaustion whose own key is a number, which are skipped, as events with no string key
      // always were.
      null as unknown as Event,
      { kind: 'exhausted', key: 5, eventId: 'g-numeric-event', record: usable('numeric-event'), outcomes: [], created: 1 },
      // A claim with no record and the exhaustion that targets it, and an exhaustion with neither a record nor a claim.
      { kind: 'claim', key: 'claim-no-record', eventId: 'claim-no-record-generation', created: 1 },
      { kind: 'exhausted', key: 'claim-no-record', targetClaimId: 'claim-no-record-generation', outcomes: [], created: 1 },
      { kind: 'exhausted', key: 'no-record-no-target', outcomes: [], created: 1 },
      // Exhaustions whose own record has no chunk hash, a key that isn't a string, or another entry's key.
      { kind: 'exhausted', key: 'exhausted-no-hash', eventId: 'g-no-hash', record: { key: 'exhausted-no-hash', created: 1 }, outcomes: [], created: 1 },
      { kind: 'exhausted', key: 'numeric-key', eventId: 'g-numeric', record: { key: 17, chunkSourceHash: fx.hash, created: 1 }, outcomes: [], created: 1 },
      { kind: 'exhausted', key: 'mismatched-key', eventId: 'g-mismatched', record: usable('other-key'), outcomes: [], created: 1 },
      // Exhaustions with a usable record but no generation, one that isn't a string, or an empty one.
      { kind: 'exhausted', key: 'no-generation', record: usable('no-generation'), outcomes: [], created: 1 },
      { kind: 'exhausted', key: 'object-generation', eventId: { not: 'a string' }, record: usable('object-generation'), outcomes: [], created: 1 },
      { kind: 'exhausted', key: 'empty-generation', eventId: '', record: usable('empty-generation'), outcomes: [], created: 1 },
      // A damaged exhaustion for the real entry's key, which stays in the quarantine as it was.
      { kind: 'exhausted', key: fx.key, eventId: 'g-damaged-real', record: { key: fx.key, created: 1 }, outcomes: [], created: 1 },
      // Usable: a claim and the exhaustion that targets it, outcomes that aren't a list, and a list mixing in what isn't an outcome.
      { kind: 'claim', key: 'claim-backed', eventId: 'claim-backed-generation', record: usable('claim-backed'), created: 1 },
      { kind: 'exhausted', key: 'claim-backed', targetClaimId: 'claim-backed-generation', outcomes: [], created: 1 },
      { kind: 'exhausted', key: 'outcomes-not-a-list', eventId: 'g-not-a-list', record: usable('outcomes-not-a-list'), outcomes: 'bad', created: 1 },
      { kind: 'exhausted', key: 'outcomes-mixed', eventId: 'g-mixed', record: usable('outcomes-mixed'), outcomes: [null, 'x', 7, {}, outcome], created: 1 },
    );

    let status: CompressionQuarantineStatus | undefined;
    const repeat = await heard(fx.strategy, async () => {
      status = fx.strategy.getCompressionQuarantineStatus();
      fx.strategy.getCompressionQuarantineStatus();
      later(INTERVAL);
      await fx.strategy.alarm();
    });
    assert.equal(status!.unreadable, undefined, 'the status reads');
    assert.deepEqual([...status!.keys].sort(), [fx.key, 'checkpoint-mixed', 'claim-backed', 'outcomes-mixed', 'outcomes-not-a-list'].sort());
    assert.equal(status!.count, 5);
    assert.equal(fx.strategy.getCompressionDebt().compressionQuarantineCount, 5, 'the debt read counts what the status counts');
    assert.deepEqual(
      status!.spans.map((span) => [span.chunkSourceHash, span.records, span.answeredAttempts]),
      [[fx.hash, 5, answered + 2]],
      'one span; of the mixed outcome lists, only the outcome in each is an answer',
    );

    const named = repeat.lines.filter((line) => line.includes("it can't use"));
    assert.deepEqual(named, [
      `[compression-quarantine] on branch '${fx.manager.currentBranch().name}', left out ledger entries it can't use ` +
        '(keys=checkpoint-n,checkpoint-o,checkpoint-e,claim-no-rec,no-record-no,exhausted-no,numeric-key,mismatched-k,no-generatio,object-gener,empty-genera): ' +
        'they no longer hold their chunks back, no clear reaches them, and they stay in the ledger ' +
        'until a checkpoint rewrites the ledger, which needs 256 events in it ns=default',
    ], `each key left out named once, however often the ledger is read, and no key still in the quarantine:\n${repeat.lines.join('\n')}`);
    assert.deepEqual(counts(repeat.handled), [5], 'the alarm repeats on what stands');
    assert.ok(!repeat.lines.some(allClear), repeat.lines.join('\n'));

    // A key damaged later is named on its own, and a new load names every key again, from its own read.
    fx.append({ kind: 'exhausted', key: 'later-damage', eventId: 'g-later', record: { created: 1 }, outcomes: [], created: 1 });
    const second = await heard(fx.strategy, () => { fx.strategy.getCompressionQuarantineStatus(); });
    assert.deepEqual(second.lines.map((line) => line.match(/keys=([^)]*)/)?.[1]), ['later-damage']);
    const reloaded = await heard(fx.strategy, () => fx.manager.setStrategy(fx.strategy));
    assert.deepEqual(
      reloaded.lines.map((line) => line.match(/keys=([^)]*)/)?.[1]),
      ['checkpoint-n,checkpoint-o,checkpoint-e,claim-no-rec,no-record-no,exhausted-no,numeric-key,mismatched-k,no-generatio,object-gener,empty-genera,later-damage'],
    );

    // On main, the quarantine check before a compression threw on a record-less entry.
    await fx.strategy.run(fx.strategy.closedChunks()[1]!, context(fx.manager));
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 6, 'the second chunk was tried, and refused');
    fx.manager.close();
  });

  it('skips a legacy snapshot record with no chunk hash, as one with no key always was', async () => {
    const fx = await refused('legacy');
    fx.store.registerState({ id: fx.strategy.legacyId, strategy: 'snapshot' });
    fx.store.setStateJson(fx.strategy.legacyId, [
      { key: 'legacy-usable', chunkSourceHash: fx.hash, created: 1 },
      { key: 'legacy-no-hash', created: 1 },
    ]);
    let status: CompressionQuarantineStatus | undefined;
    const read = await heard(fx.strategy, () => { status = fx.strategy.getCompressionQuarantineStatus(); });
    assert.deepEqual([...status!.keys].sort(), [fx.key, 'legacy-usable'].sort());
    assert.deepEqual(read.lines, [], 'the legacy snapshot is skipped without a line');
    fx.manager.close();
  });

  it('releases the chunk of an entry it leaves out, so the chunk is asked for again and a refusal records it afresh', async () => {
    const fx = await refused('release');
    // The chunk's only record loses its chunk hash, as a damaged ledger might leave it.
    const { chunkSourceHash: _hash, ...hashless } = fx.real.record as Record<string, unknown>;
    fx.store.setStateJson(fx.strategy.ledgerId, fx.ledger().map((event) =>
      event.kind === 'exhausted' && event.key === fx.key ? { ...event, record: hashless } : event));
    const exhaustions = () => fx.ledger().filter((event) => event.kind === 'exhausted' && event.key === fx.key).length;

    let left: CompressionQuarantineStatus | undefined;
    await heard(fx.strategy, () => { left = fx.strategy.getCompressionQuarantineStatus(); });
    assert.equal(left!.count, 0, 'the entry is left out');
    const debt = fx.strategy.getCompressionDebt();
    assert.deepEqual([debt.compressionQuarantineCount, debt.state], [0, 'healthy'], 'and a ledger holding only it leaves the debt read healthy');

    const asked = membraneCalls;
    await fx.strategy.run(fx.strategy.closedChunks()[0]!, context(fx.manager));
    const status = fx.strategy.getCompressionQuarantineStatus();
    assert.ok(membraneCalls > asked, 'a summary of the chunk was asked for again');
    assert.equal(exhaustions(), 2, 'and refused');
    assert.deepEqual([status.keys, status.spans.map((span) => span.chunkSourceHash)], [[fx.key], [fx.hash]], 'its fresh record stands');
    fx.manager.close();
  });

  it('a clear reaches no entry it left out, which stays in the ledger until a checkpoint at 256 events rewrites it', async () => {
    const fx = await refused('storage');
    fx.append(
      { kind: 'claim', key: 'claim-no-record', eventId: 'claim-no-record-generation', created: 1 },
      { kind: 'exhausted', key: 'claim-no-record', targetClaimId: 'claim-no-record-generation', outcomes: [], created: 1 },
    );
    const held = () => fx.ledger().filter((event) => event?.key === 'claim-no-record').length;

    // On main, the clear by key threw on such an entry, and so did the clear of every record.
    await heard(fx.strategy, async () => {
      await fx.strategy.clearCompressionRefusalQuarantine('claim-no-record');
      await fx.strategy.clearCompressionRefusalQuarantine();
    });
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0, 'clear-all cleared the real record');
    assert.equal(held(), 2, 'no clear reached the entry left out');

    fx.append(...Array.from({ length: 256 - fx.ledger().length }, (_, i) => ({ kind: 'clear', key: `padding-${i}`, targetClaimId: 'none', created: 1 })));
    assert.equal(fx.ledger().length, 256);
    await heard(fx.strategy, () => fx.strategy.clearCompressionRefusalQuarantine());
    assert.equal(held(), 0, 'the checkpoint left it out');
    assert.ok(fx.ledger().some((event) => event?.kind === 'checkpoint'), 'the ledger now starts from a checkpoint');
    fx.manager.close();
  });

  it('says a failed status read is unreadable, and the alarm stays as it was, saying so once an interval on its own clock', async () => {
    assert.deepEqual(new ProbeStrategy({} as never).getCompressionQuarantineStatus(), { count: 0, keys: [], spans: [] }, 'with no store, there is nothing to read');

    const fx = await refused('unreadable');
    await sounding(fx.strategy);
    const projection = fx.strategy as unknown as { readCompressionQuarantineProjection(): unknown };
    const read = projection.readCompressionQuarantineProjection;
    projection.readCompressionQuarantineProjection = () => { throw new Error('ledger unreadable (test)'); };

    let status: CompressionQuarantineStatus | undefined;
    const failing = await heard(fx.strategy, async () => {
      later(INTERVAL / 2);
      status = fx.strategy.getCompressionQuarantineStatus();
      await fx.strategy.alarm();
      await fx.strategy.alarm();
    });
    assert.deepEqual(status, { count: 0, keys: [], spans: [], unreadable: true });
    assert.deepEqual(failing.lines, [
      '[compression-quarantine] ⚠️ quarantine status unreadable; the alarm stays up until a read succeeds: ns=default Error: ledger unreadable (test)',
    ], 'one line, and no warning from the paid-off sweep');
    assert.deepEqual(failing.handled, [], 'no handler call, all-clear or alarm');

    // The read recovers an interval after the alarm last sounded, half an interval after the failure was said.
    projection.readCompressionQuarantineProjection = read;
    const readable = await heard(fx.strategy, async () => {
      later(INTERVAL / 2);
      await fx.strategy.alarm();
    });
    assert.deepEqual(counts(readable.handled), [1], 'the episode stood, and its repeat kept its time');
    assert.ok(!readable.lines.some(allClear), readable.lines.join('\n'));
    fx.manager.close();
  });

  it('an episode outlasts a failed read, and ends with one all-clear when the read finds its quarantine empty', async () => {
    const fx = await refused('outage');
    await sounding(fx.strategy);
    await fx.strategy.clearCompressionRefusalQuarantine();
    const projection = fx.strategy as unknown as { readCompressionQuarantineProjection(): unknown };
    const read = projection.readCompressionQuarantineProjection;
    projection.readCompressionQuarantineProjection = () => { throw new Error('ledger unreadable (test)'); };
    const outage = await heard(fx.strategy, async () => {
      later(INTERVAL);
      await fx.strategy.alarm();
      later(INTERVAL);
      await fx.strategy.alarm();
    });
    assert.equal(outage.lines.length, 2, outage.lines.join('\n'));
    assert.deepEqual(outage.handled, []);

    projection.readCompressionQuarantineProjection = read;
    const recovered = await heard(fx.strategy, async () => {
      await fx.strategy.alarm();
      later(INTERVAL);
      await fx.strategy.alarm();
    });
    assert.deepEqual(recovered.lines, [ALL_CLEAR]);
    assert.deepEqual(counts(recovered.handled), [0]);

    // With no episode open, a failed read says the alarm stays down.
    projection.readCompressionQuarantineProjection = () => { throw new Error('ledger unreadable (test)'); };
    const idle = await heard(fx.strategy, async () => {
      later(INTERVAL);
      await fx.strategy.alarm();
    });
    projection.readCompressionQuarantineProjection = read;
    assert.match(idle.lines.join('\n'), /quarantine status unreadable; the alarm stays down until a read succeeds/);
    fx.manager.close();
  });

  it('reads a ledger, a legacy snapshot or a checkpoint that holds no list as holding nothing, and names each once per load', async () => {
    const fx = await refused('not-a-list');
    await sounding(fx.strategy);
    const ledger = fx.ledger();
    const branch = fx.manager.currentBranch().name;
    const usable = (key: string): Event => ({
      kind: 'exhausted', key, eventId: `g-${key}`, record: { key, chunkSourceHash: fx.hash, created: 1 }, outcomes: [], created: 1,
    });
    const named = (lines: string[]) => lines.filter((line) => line.includes('no list')).map((line) => {
      const match = line.match(
        /^\[compression-quarantine\] on branch '([^']*)', (.*) holds? no list, so the quarantine reads no entry from (?:it|them) and has lost whatever (?:it|they) held ns=default$/,
      );
      assert.ok(match, line);
      assert.equal(match[1], branch, line);
      return match[2];
    });
    /** The status read twice and an alarm check, then a new load, whose own read names what it finds. */
    const read = async () => {
      let status: CompressionQuarantineStatus | undefined;
      const within = await heard(fx.strategy, async () => {
        status = fx.strategy.getCompressionQuarantineStatus();
        fx.strategy.getCompressionQuarantineStatus();
        later(INTERVAL);
        await fx.strategy.alarm();
      });
      const reload = await heard(fx.strategy, () => fx.manager.setStrategy(fx.strategy));
      return { status: status!, ...within, reloaded: named(reload.lines) };
    };

    // A legacy snapshot that holds no list hides nothing the ledger holds.
    fx.store.registerState({ id: fx.strategy.legacyId, strategy: 'snapshot' });
    fx.store.setStateJson(fx.strategy.legacyId, { not: 'a list' });
    const legacy = await read();
    assert.deepEqual([legacy.status.unreadable, legacy.status.keys], [undefined, [fx.key]], 'the ledger\'s record still counts');
    assert.deepEqual(named(legacy.lines), ['the legacy snapshot'], 'named once, however often the store is read');
    assert.deepEqual(legacy.reloaded, ['the legacy snapshot'], 'and once more by the next load');
    assert.deepEqual(counts(legacy.handled), [1], 'and the alarm repeats on it');
    fx.store.setStateJson(fx.strategy.legacyId, []);

    // A checkpoint replaces what came before it with its list, whatever its key.
    fx.store.setStateJson(fx.strategy.ledgerId, [
      ...ledger, usable('before-empty'), { kind: 'checkpoint', key: '__checkpoint__', eventId: 'cp-empty', active: [], created: 1 }, usable('after-empty'),
    ]);
    assert.deepEqual(fx.strategy.getCompressionQuarantineStatus().keys, ['after-empty'], 'an empty list clears what came before it');
    fx.store.setStateJson(fx.strategy.ledgerId, [
      ...ledger, usable('before-keyless'),
      { kind: 'checkpoint', eventId: 'cp-keyless', active: [{ generationId: 'g-restated', record: { key: 'restated', chunkSourceHash: fx.hash, created: 1 }, outcomes: [], sentAlertKeys: [] }], created: 1 },
    ]);
    assert.deepEqual(fx.strategy.getCompressionQuarantineStatus().keys, ['restated'], 'a checkpoint with no key is still a checkpoint');

    // One that holds no list replaces what came before it with nothing, and the entry after it applies. Its value can't
    // be iterated, and each such checkpoint is named by its index in the ledger.
    fx.store.setStateJson(fx.strategy.ledgerId, [
      ...ledger,
      { kind: 'checkpoint', key: '__checkpoint__', eventId: 'cp-object', active: { not: 'a list' }, created: 1 },
      { kind: 'checkpoint', key: '__checkpoint__', eventId: 'cp-null', active: null, created: 1 },
      usable('after-checkpoint'),
    ]);
    const checkpoint = await read();
    const checkpoints = `the ledger's checkpoint at index ${ledger.length} and the ledger's checkpoint at index ${ledger.length + 1}`;
    assert.deepEqual([checkpoint.status.unreadable, checkpoint.status.keys], [undefined, ['after-checkpoint']]);
    assert.deepEqual(named(checkpoint.lines), [checkpoints]);
    assert.deepEqual(checkpoint.reloaded, [checkpoints]);
    assert.deepEqual(counts(checkpoint.handled), [1]);

    // A legacy snapshot record a clear took stays cleared once the writer's redaction has removed the clear: a
    // checkpoint restates only what stood, and one that holds no list brings none of the snapshot's records back.
    const legacyRecord = (key: string) => ({ key, chunkSourceHash: fx.hash, created: 1 });
    fx.store.setStateJson(fx.strategy.legacyId, [legacyRecord('legacy-cleared'), legacyRecord('legacy-standing')]);
    fx.store.setStateJson(fx.strategy.ledgerId, [...ledger, { kind: 'clear', key: 'legacy-cleared', targetClaimId: 'legacy:legacy-cleared', created: 1 }]);
    assert.deepEqual([...fx.strategy.getCompressionQuarantineStatus().keys].sort(), [fx.key, 'legacy-standing'].sort(), 'the clear took its record');
    const standing = { generationId: 'legacy:legacy-standing', record: legacyRecord('legacy-standing'), outcomes: [], sentAlertKeys: ['legacy-standing'] };
    fx.store.setStateJson(fx.strategy.ledgerId, [{ kind: 'checkpoint', key: '__checkpoint__', eventId: 'cp-restating', active: [standing], created: 1 }]);
    assert.deepEqual(fx.strategy.getCompressionQuarantineStatus().keys, ['legacy-standing'], 'the checkpoint restates what stood');
    fx.store.setStateJson(fx.strategy.ledgerId, [{ kind: 'checkpoint', key: '__checkpoint__', eventId: 'cp-lost', active: null, created: 1 }]);
    const lost = await heard(fx.strategy, () => { assert.deepEqual(fx.strategy.getCompressionQuarantineStatus().keys, []); });
    assert.deepEqual(named(lost.lines), ["the ledger's checkpoint at index 0"]);

    // A ledger that holds no list holds nothing, the legacy snapshot it superseded included, so the alarm's quarantine
    // is empty, as after a clear.
    fx.store.setStateJson(fx.strategy.ledgerId, { not: 'a list' });
    const whole = await read();
    assert.deepEqual([whole.status.unreadable, whole.status.count], [undefined, 0]);
    assert.deepEqual(named(whole.lines), ['the ledger']);
    assert.deepEqual(whole.reloaded, ['the ledger']);
    assert.ok(whole.lines.includes(ALL_CLEAR), whole.lines.join('\n'));
    assert.deepEqual(counts(whole.handled), [0]);
    fx.manager.close();
  });

  it('keeps an episode up while the strategy reads another branch whose quarantine is empty, and ends it when its own branch reads empty', async () => {
    const fx = await refused('branch');
    const home = fx.manager.currentBranch().name;
    await sounding(fx.strategy);

    const early = fx.manager.branchAt(fx.manager.getAllMessages()[0]!.id, 'early');
    await fx.manager.switchBranch(early);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0, 'setup: no quarantine on the new branch');
    const away = await heard(fx.strategy, async () => {
      await fx.strategy.alarm();
      later(INTERVAL);
      await fx.strategy.alarm();
      await fx.strategy.alarm();
    });
    assert.deepEqual(away.lines, [
      `[compression-quarantine] ⚠️ the alarm for branch '${home}' stays up while the strategy reads branch '${early}', ` +
        `whose quarantine is empty; it ends with the all-clear when the strategy reads branch '${home}' empty ns=default`,
    ], 'said at the alarm\'s interval, not on the move, and once an interval');
    assert.deepEqual(away.handled, []);

    // Back on its own branch, within an interval of that line: no repeat yet, and the episode still stands.
    await fx.manager.switchBranch(home);
    const back = await heard(fx.strategy, () => fx.strategy.alarm());
    assert.deepEqual([back.lines, back.handled], [[], []]);
    await fx.strategy.clearCompressionRefusalQuarantine();
    const paid = await heard(fx.strategy, () => fx.strategy.alarm());
    assert.deepEqual(paid.lines, [ALL_CLEAR], 'the episode that opened on this branch ends');
    assert.deepEqual(counts(paid.handled), [0]);
    fx.manager.close();
  });

  it('moves an episode to the branch its alarm last sounded on, and ends it with that branch\'s all-clear', async () => {
    const fx = await refused('fork');
    const home = fx.manager.currentBranch().name;
    await sounding(fx.strategy);

    await fx.manager.fork('f1');
    const forked = await heard(fx.strategy, async () => {
      later(INTERVAL);
      await fx.strategy.alarm();
    });
    assert.deepEqual(counts(forked.handled), [1], 'the fork inherited the debt, and the alarm repeats there');

    await fx.strategy.clearCompressionRefusalQuarantine();
    const paid = await heard(fx.strategy, () => fx.strategy.alarm());
    assert.deepEqual(paid.lines, [ALL_CLEAR], "the episode is f1's now");
    assert.deepEqual(counts(paid.handled), [0]);

    await fx.manager.switchBranch(home);
    const back = await heard(fx.strategy, () => fx.strategy.alarm());
    assert.deepEqual(counts(back.handled), [1], "home's debt stands, and opens an episode of its own");
    fx.manager.close();
  });

  it('keeps an episode up when the strategy moves to another namespace whose quarantine is empty', async () => {
    const fx = await refused('namespace');
    const ns = fx.strategy.nsName;
    await sounding(fx.strategy);

    const other = await ContextManager.open({ store: fx.store, namespace: 'agents/other', strategy: new ProbeStrategy(CONFIG as never), membrane: refusing });
    await other.setStrategy(fx.strategy);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0, 'setup: no quarantine in the other namespace');
    const moved = await heard(fx.strategy, async () => {
      later(INTERVAL);
      await fx.strategy.alarm();
    });
    const branch = other.currentBranch().name;
    assert.deepEqual(moved.lines, [
      `[compression-quarantine] ⚠️ the alarm for branch '${branch}' of '${ns}' stays up while the strategy reads branch '${branch}' of 'agents/other', ` +
        `whose quarantine is empty; it ends with the all-clear when the strategy reads branch '${branch}' of '${ns}' empty ns=agents/other`,
    ]);
    assert.deepEqual(moved.handled, []);

    // Back in its own namespace, its quarantine paid: the episode that opened there ends.
    await fx.manager.setStrategy(fx.strategy);
    await fx.strategy.clearCompressionRefusalQuarantine();
    const paid = await heard(fx.strategy, () => fx.strategy.alarm());
    assert.deepEqual(paid.lines, [ALL_CLEAR]);
    assert.deepEqual(counts(paid.handled), [0]);
    other.close();
    fx.manager.close();
  });

  it('still says the all-clear once, through the handler, when the debt is paid on its branch', async () => {
    const fx = await refused('paid');
    await sounding(fx.strategy);
    await fx.strategy.clearCompressionRefusalQuarantine();
    const paid = await heard(fx.strategy, async () => {
      await fx.strategy.alarm();
      later(INTERVAL);
      await fx.strategy.alarm();
    });
    assert.deepEqual(paid.lines, [ALL_CLEAR]);
    assert.deepEqual(counts(paid.handled), [0]);
    fx.manager.close();
  });
});
