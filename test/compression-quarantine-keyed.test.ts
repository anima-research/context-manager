/** Synthetic chronicle stores and fake providers only; no host or provider qualification. */
import { after, describe, it, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest } from '@animalabs/membrane';
import {
  AutobiographicalStrategy, ContextManager, PassthroughStrategy, isKeyedCompressionQuarantineStrategy,
  type CompressionQuarantineReleaseSelection,
} from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, CompressionQuarantineStatus } from '../src/types/index.js';

type Event = Record<string, any>;
const dir = mkdtempSync(join(tmpdir(), 'cm-keyed-quarantine-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const config = {
  compressionModel: 'fake-configured-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
  autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, compressionRefusalCurveFallbacks: 0,
  quarantineAlarmIntervalMs: 3_600_000,
};
class Probe extends AutobiographicalStrategy {
  closedChunks(): Chunk[] { return this.chunks; }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
  get ledgerId(): string { return this.compressionRefusalQuarantineLedgerStateId; }
  get legacyId(): string { return this.compressionRefusalQuarantineStateId; }
  get progressId(): string { return this.compressionFamilyProgressStateId; }
  alarm(): Promise<void> {
    return (this as unknown as { soundQuarantineAlarmIfNeeded(): Promise<void> }).soundQuarantineAlarmIfNeeded();
  }
  /** Exercise the SAME native lock as native exhaustion, not a host-side precheck. */
  exhaust(record: Event): Promise<unknown> {
    const native = this as unknown as {
      captureCompressionBranch(): unknown;
      exhaustCompressionRequestFamily(branch: unknown, record: Event, outcomes: Event[], open: () => boolean, inWindow: () => boolean): Promise<unknown>;
    };
    return native.exhaustCompressionRequestFamily(native.captureCompressionBranch(), record, [{ outcome: 'refusal' }], () => true, () => true);
  }
  gate(record: Event): unknown {
    const native = this as unknown as {
      readCompressionQuarantineProjection(): unknown;
      durableQuarantineFor(projection: unknown, record: Event): unknown;
    };
    return native.durableQuarantineFor(native.readCompressionQuarantineProjection(), record);
  }
}
function inspect(strategy: Probe, options?: { key?: string; limit?: number }) {
  const result = strategy.inspectCompressionRefusalQuarantine(options);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  return result;
}
function selection(strategy: Probe, key?: string): CompressionQuarantineReleaseSelection {
  const view = inspect(strategy, key ? { key } : undefined);
  const record = view.records[0]!;
  assert.ok(record?.generation);
  return { key: record.key, expectedGeneration: record.generation, expectedBinding: view.binding };
}
function bytes(path: string): [string, string][] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry): [string, string][] => {
    const p = join(path, entry.name);
    return entry.isDirectory() ? bytes(p) : [[p, createHash('sha256').update(readFileSync(p)).digest('hex')]];
  }).sort(([a], [b]) => a.localeCompare(b));
}
async function fixture(t: TestContext, name: string) {
  const path = join(dir, name);
  const strategy = new Probe(config);
  let answer = 'refusal';
  const calls: NormalizedRequest[] = [];
  const membrane = { complete: async (request: NormalizedRequest) => {
    calls.push(structuredClone(request));
    return {
      content: answer === 'refusal' ? [] : [{ type: 'text', text: 'The synthetic conversation discussed bounded implementation and its tests.' }],
      stopReason: answer, usage: { inputTokens: 100, outputTokens: answer === 'refusal' ? 0 : 20 },
      raw: { response: { stop_details: { category: 'not-authoritative-for-inspection' } } },
    };
  } };
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  t.after(() => manager.close());
  for (let i = 0; i < 16; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `DO-NOT-EXPOSE-RAW-${i} ${'substantive '.repeat(12)}` }]);
  await manager.compile();
  const chunk = strategy.closedChunks()[0]!;
  assert.ok(chunk);
  const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
  await strategy.run(chunk, ctx);
  const store = manager.getStore();
  const ledger = () => store.getStateJson(strategy.ledgerId) as Event[];
  const event = ledger().find((item) => item.kind === 'exhausted')!;
  assert.ok(event?.eventId, 'native exhaustion assigned an actual identity');
  assert.equal(inspect(strategy).totalRecords, 1);
  return {
    strategy, manager, store, ledger, event, chunk, ctx, path, calls,
    answer: (value: string) => { answer = value; },
    append: (...events: Event[]) => store.setStateJson(strategy.ledgerId, [...ledger(), ...events]),
    sibling: (label: string, familyKey = hash(label)) => {
      const key = hash(label);
      const sibling = { ...event, eventId: `${label}-generation`, key, record: { ...event.record, key, familyKey } };
      store.setStateJson(strategy.ledgerId, [...ledger(), sibling]);
      return sibling;
    },
  };
}

describe('metadata-only keyed L1 quarantine capability', () => {
  it('reads bounded per-record metadata without any bytes/writes/calls; unknown actual routing/category stays unknown', async (t) => {
    const fx = await fixture(t, 'metadata');
    const sibling = fx.sibling('shape-two');
    const before = bytes(fx.path);
    const calls = fx.calls.length;
    const sync = mock.method(fx.store, 'sync');
    const append = mock.method(fx.store, 'appendToStateJsonWithIdentity');
    const set = mock.method(fx.store, 'setStateJson');
    t.after(() => { sync.mock.restore(); append.mock.restore(); set.mock.restore(); });
    const limited = inspect(fx.strategy, { limit: 1 });
    assert.equal(limited.totalRecords, 2);
    assert.equal(limited.complete, false);
    assert.equal(limited.records.length, 1);
    const exact = inspect(fx.strategy, { key: fx.event.key });
    assert.equal(exact.complete, true);
    assert.equal(exact.totalRecords, 2);
    const record = exact.records[0]!;
    assert.equal(record.generation, fx.event.eventId);
    assert.equal(record.selectable, true);
    assert.equal(record.familyKey, fx.event.record.familyKey);
    assert.equal(record.recordedModel, 'fake-configured-model');
    assert.equal(exact.configuredModel, 'fake-configured-model');
    assert.equal(record.recordedCategory, null);
    assert.equal(record.recordedProvider, null);
    assert.equal(exact.configuredProvider, null);
    assert.equal(exact.configuredCredentialAlias, null);
    assert.equal(record.membership, 'recorded');
    assert.equal(record.loadedChunkMatch, true);
    assert.deepEqual(record.sourceIds, fx.chunk.messages.map((message) => message.id));
    assert.ok(record.outcomes.some((item) => item.outcome === 'refusal' && item.stopReason === 'refusal'));
    assert.equal(record.sameSourceRecords, 2);
    assert.deepEqual(record.siblingKeys, [sibling.key]);
    assert.equal(record.siblingKeysComplete, true);
    const serialized = JSON.stringify(exact);
    for (const forbidden of ['DO-NOT-EXPOSE-RAW', 'not-authoritative-for-inspection', 'signature', 'requestConfig', 'plan']) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
    assert.equal(sync.mock.callCount(), 0);
    assert.equal(append.mock.callCount(), 0);
    assert.equal(set.mock.callCount(), 0);
    assert.equal(fx.calls.length, calls);
    assert.deepEqual(bytes(fx.path), before);
    assert.equal(isKeyedCompressionQuarantineStrategy(fx.strategy), true);
    assert.equal(isKeyedCompressionQuarantineStrategy(new PassthroughStrategy()), false);
    assert.equal(isKeyedCompressionQuarantineStrategy(undefined), false);
    assert.equal(isKeyedCompressionQuarantineStrategy(null), false);
  });

  it('bounds all nested lists honestly; old source mapping is unknown, never inferred from latest aggregate', async (t) => {
    const fx = await fixture(t, 'bounds');
    const event = structuredClone(fx.event);
    delete event.record.sourceIds;
    event.record.chunkSourceHash = hash('no-loaded-chunk');
    event.outcomes = Array.from({ length: 33 }, () => ({ outcome: 'new-future-outcome', stopReason: 'unrecognized-private-details' }));
    fx.store.setStateJson(fx.strategy.ledgerId, [event]);
    let record = inspect(fx.strategy).records[0]!;
    assert.equal(record.membership, 'unknown');
    assert.equal(record.sourceIds, null);
    assert.equal(record.sourceIdsComplete, false);
    assert.equal(record.loadedChunkMatch, false);
    assert.equal(record.outcomes.length, 32);
    assert.equal(record.outcomesComplete, false);
    assert.deepEqual(record.outcomes[0], { outcome: 'unknown', stopReason: null, requestHash: null });
    event.record.sourceIds = Array.from({ length: 101 }, (_, i) => `synthetic-id-${i}`);
    event.record.chunkSourceHash = hash(event.record.sourceIds);
    fx.store.setStateJson(fx.strategy.ledgerId, [event]);
    record = inspect(fx.strategy).records[0]!;
    assert.equal(record.sourceIds!.length, 100);
    assert.equal(record.sourceIdsComplete, false);
    delete event.record.sourceIds;
    event.record.chunkSourceHash = fx.event.record.chunkSourceHash;
    fx.store.setStateJson(fx.strategy.ledgerId, [event]);
    assert.equal(inspect(fx.strategy).records[0]!.membership, 'loaded-chunk');
    const siblings = Array.from({ length: 101 }, (_, i) => {
      const key = hash(`bounded-sibling-${i}`);
      return { ...event, key, eventId: `bounded-generation-${i}`, record: { ...event.record, key } };
    });
    fx.store.setStateJson(fx.strategy.ledgerId, [event, ...siblings]);
    record = inspect(fx.strategy, { key: event.key }).records[0]!;
    assert.equal(record.sameSourceRecords, 102);
    assert.equal(record.siblingKeys.length, 100);
    assert.equal(record.siblingKeysComplete, false);
    assert.equal(inspect(fx.strategy, { limit: 100 }).complete, false);
  });

  it('rejects omitted/empty/all/prefix/wildcard release selectors; exact absent keys mean not-held', async (t) => {
    const fx = await fixture(t, 'invalid');
    const selected = selection(fx.strategy);
    const before = bytes(fx.path);
    for (const key of [undefined, '', 'all', '*', selected.key.slice(0, 12), `${selected.key}*`, ['x']]) {
      assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine({ ...selected, key } as never), { status: 'invalidSelection' });
    }
    for (const value of [undefined, null, {}, { ...selected, expectedGeneration: '' }, { ...selected, expectedBinding: null }]) {
      assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(value as never), { status: 'invalidSelection' });
    }
    for (const options of [{ key: '*' }, { limit: 0 }, { limit: 101 }, { limit: 1.1 }, null, []]) {
      assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(options as never), { status: 'invalidSelection' });
    }
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine({ ...selected, key: hash('absent') }), { status: 'not-held' });
    assert.deepEqual(inspect(fx.strategy, { key: hash('absent') }).records, []);
    assert.deepEqual(bytes(fx.path), before);
  });

  it('preserves actual claim/checkpoint identity but refuses synthetic legacy lineage without repairing it', async (t) => {
    const fx = await fixture(t, 'lineage');
    const selected = selection(fx.strategy);
    fx.store.setStateJson(fx.strategy.ledgerId, [{ kind: 'checkpoint', active: [{ generationId: selected.expectedGeneration, record: fx.event.record, outcomes: fx.event.outcomes }] }]);
    assert.equal(selection(fx.strategy).expectedGeneration, selected.expectedGeneration);
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selected)).status, 'released');
    fx.store.setStateJson(fx.strategy.ledgerId, [
      { ...fx.event, kind: 'claim', eventId: 'actual-old-claim' },
      { kind: 'exhausted', key: selected.key, targetClaimId: 'actual-old-claim', outcomes: fx.event.outcomes },
    ]);
    assert.equal(selection(fx.strategy).expectedGeneration, 'actual-old-claim');
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selection(fx.strategy))).status, 'released');
    fx.store.setStateJson(fx.strategy.ledgerId, []);
    fx.store.setStateJson(fx.strategy.legacyId, [fx.event.record]);
    const before = bytes(fx.path);
    const legacy = inspect(fx.strategy).records[0]!;
    assert.equal(legacy.generation, null);
    assert.equal(legacy.selectable, false);
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine({ ...selected, expectedGeneration: `legacy:${selected.key}` }), { status: 'unsupported' });
    assert.deepEqual(bytes(fx.path), before);
  });

  it('reports unreadable rather than empty on malformed or failed loaded-state reads, and writes nothing', async (t) => {
    const fx = await fixture(t, 'unreadable');
    const selected = selection(fx.strategy);
    for (const ledger of [{ bad: 'not-a-list' }, [null], [{ kind: 'checkpoint', active: null }],
      [{ ...fx.event, eventId: '' }], [{ ...fx.event, outcomes: [null] }], [{ ...fx.event, outcomes: null }],
      [{ ...fx.event, record: null }], [{ ...fx.event, record: { ...fx.event.record, sourceIds: [] } }],
      [{ ...fx.event, record: { ...fx.event.record, sourceIds: ['wrong-hash'] } }], [{ kind: 'future-event' }]]) {
      fx.store.setStateJson(fx.strategy.ledgerId, ledger);
      const before = bytes(fx.path);
      assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable' });
      assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'unreadable' });
      assert.deepEqual(bytes(fx.path), before);
    }
    const get = fx.store.getStateJson.bind(fx.store);
    const read = mock.method(fx.store, 'getStateJson', (id: string) => {
      if (id === fx.strategy.ledgerId) throw new Error('DO-NOT-EXPOSE-SECRET-error-payload');
      return get(id);
    });
    assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable' });
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'unreadable' });
    read.mock.restore();
    fx.strategy.detach();
    assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'branchUnavailable' });
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'branchUnavailable' });
    assert.deepEqual(new Probe(config).inspectCompressionRefusalQuarantine(), { status: 'branchUnavailable' });
  });
});

describe('one-key native compare-and-release', () => {
  it('clears exactly the selected active shape, forgets that entire family progress, retains siblings/history and changes no coverage', async (t) => {
    const fx = await fixture(t, 'selected');
    const selected = selection(fx.strategy);
    const sameFamily = fx.sibling('same-family', fx.event.record.familyKey);
    const otherFamily = fx.sibling('other-family');
    const progress = (familyKey: string) => ({ familyKey, chunkSourceHash: fx.event.record.chunkSourceHash, sourceIds: fx.event.record.sourceIds, outcomes: [{ outcome: 'refusal', requestHash: 'synthetic', curveLabel: 'canonical' }], updated: Date.now() });
    const untouchedProgress = progress(otherFamily.record.familyKey);
    fx.store.setStateJson(fx.strategy.progressId, [progress(fx.event.record.familyKey), untouchedProgress]);
    const hypothetical = { ...fx.event.record, key: hash('new-shape'), familyKey: hash('new-family') };
    assert.ok(fx.strategy.gate(hypothetical), 'three ACTIVE records fill the native shape cap');
    const beforeCalls = fx.calls.length;
    const beforeStats = fx.strategy.getStats();
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), {
      status: 'released', key: selected.key, generation: selected.expectedGeneration, remainingRecords: 2,
    });
    assert.equal(fx.strategy.gate(hypothetical), undefined, 'two active records no longer fill the cap; historical exhaustions do not count');
    const after = inspect(fx.strategy);
    assert.deepEqual(after.records.map((item) => item.key).sort(), [sameFamily.key, otherFamily.key].sort());
    assert.equal(after.records[0]!.sameSourceRecords, 2);
    assert.ok(fx.strategy.gate(sameFamily.record), 'an exact sibling still holds the span');
    assert.deepEqual(fx.store.getStateJson(fx.strategy.progressId), [untouchedProgress]);
    assert.ok(fx.ledger().some((item) => item.kind === 'exhausted' && item.eventId === selected.expectedGeneration), 'journal history retained');
    const clear = fx.ledger().find((item) => item.kind === 'clear')!;
    assert.equal(clear.targetClaimId, selected.expectedGeneration);
    assert.equal(clear.reason, 'operator-waiver');
    assert.equal(fx.calls.length, beforeCalls, 'a release itself calls no provider');
    assert.equal(fx.strategy.getStats().l1, beforeStats.l1, 'no L1 minted');
    assert.equal(fx.chunk.compressed, false);
  });

  it('rejects replaced generation with identical visible contents and same-key ABA release/recreate', async (t) => {
    const fx = await fixture(t, 'aba');
    const selected = selection(fx.strategy);
    fx.append({ ...fx.event, eventId: 'replacement-generation' });
    const before = bytes(fx.path);
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'stale' });
    assert.deepEqual(bytes(fx.path), before);
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selection(fx.strategy))).status, 'released');
    await fx.strategy.exhaust(fx.event.record);
    assert.notEqual(selection(fx.strategy).expectedGeneration, selected.expectedGeneration);
    const recreated = bytes(fx.path);
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'stale' });
    assert.deepEqual(bytes(fx.path), recreated);
  });

  it('fences namespace/branch/load but NOT ordinary append; a reinitialize invalidates the old load', async (t) => {
    const fx = await fixture(t, 'binding');
    const selected = selection(fx.strategy);
    for (const field of ['namespace', 'branch', 'loadId'] as const) {
      assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine({ ...selected, expectedBinding: { ...selected.expectedBinding, [field]: 'wrong' } }), { status: 'stale' });
    }
    fx.manager.addMessage('User', [{ type: 'text', text: 'ordinary append' }]);
    assert.deepEqual(inspect(fx.strategy).binding, selected.expectedBinding);
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selected)).status, 'released');
    await fx.strategy.exhaust(fx.event.record);
    const priorLoad = selection(fx.strategy);
    await fx.manager.setStrategy(fx.strategy);
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(priorLoad), { status: 'stale' });
    const current = selection(fx.strategy);
    const first = fx.manager.currentBranch().name;
    await fx.manager.switchBranch(fx.manager.branchAt(fx.chunk.messages[0]!.id, 'other'));
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(current), { status: 'stale' });
    await fx.manager.switchBranch(first);
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(current), { status: 'stale' });
    const onMain = selection(fx.strategy);
    await fx.strategy.initialize({ ...fx.ctx, namespace: 'other-namespace' });
    const before = bytes(fx.path);
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(onMain), { status: 'stale' });
    assert.deepEqual(bytes(fx.path), before, 'namespace replacement cannot write through the old selection');
  });

  it('serializes two releases and native replacement on the SAME state lock, and snapshots caller intent', async (t) => {
    const fx = await fixture(t, 'concurrency');
    let selected = selection(fx.strategy);
    const results = await Promise.all([fx.strategy.releaseCompressionRefusalQuarantine(selected), fx.strategy.releaseCompressionRefusalQuarantine(selected)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['not-held', 'released']);
    await fx.strategy.exhaust(fx.event.record);
    selected = selection(fx.strategy);
    // Enqueue all three before the first lock callback runs. The replacement
    // must win before the operator's comparison, not after a host precheck.
    const clearing = fx.strategy.clearCompressionRefusalQuarantine(selected.key);
    const replacing = fx.strategy.exhaust(fx.event.record);
    const releasing = fx.strategy.releaseCompressionRefusalQuarantine(selected);
    await clearing;
    await replacing;
    assert.deepEqual(await releasing, { status: 'stale' });
    const replacement = selection(fx.strategy);
    const mutable = structuredClone(replacement);
    const pending = fx.strategy.releaseCompressionRefusalQuarantine(mutable);
    mutable.key = hash('different-key');
    mutable.expectedGeneration = 'changed';
    mutable.expectedBinding.namespace = 'changed';
    assert.equal((await pending).status, 'released', 'the invocation, not later caller edits, is authorized');
  });

  it('propagates write uncertainty even if a clear landed and the key is already absent', async (t) => {
    const fx = await fixture(t, 'uncertain');
    const selected = selection(fx.strategy);
    const append = fx.store.appendToStateJsonWithIdentity.bind(fx.store);
    const broken = mock.method(fx.store, 'appendToStateJsonWithIdentity', (...args: Parameters<typeof append>) => {
      const result = append(...args);
      if ((args[1] as Event).kind === 'clear') throw new Error('synthetic lost ACK after append');
      return result;
    });
    await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(selected), /lost ACK/);
    broken.mock.restore();
    assert.equal(inspect(fx.strategy).records.length, 0, 'absence is NOT a released acknowledgement');
    await fx.strategy.exhaust(fx.event.record);
    const current = selection(fx.strategy);
    const sync = mock.method(fx.store, 'sync', () => { throw new Error('synthetic sync failure'); });
    await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(current), /sync failure/);
    sync.mock.restore();
    await fx.strategy.exhaust(fx.event.record);
    const postreadSelection = selection(fx.strategy);
    let landed = false;
    const track = mock.method(fx.store, 'appendToStateJsonWithIdentity', (...args: Parameters<typeof append>) => {
      const result = append(...args);
      if ((args[1] as Event).kind === 'clear') landed = true;
      return result;
    });
    const get = fx.store.getStateJson.bind(fx.store);
    const postread = mock.method(fx.store, 'getStateJson', (id: string) => {
      if (landed && id === fx.strategy.ledgerId) throw new Error('synthetic postread failure');
      return get(id);
    });
    await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(postreadSelection), /postread failure/);
    postread.mock.restore();
    track.mock.restore();
    assert.equal(inspect(fx.strategy).totalRecords, 0);
    await fx.strategy.exhaust(fx.event.record);
    const progressSelection = selection(fx.strategy);
    const progressRead = mock.method(fx.store, 'getStateJson', (id: string) => {
      if (id === fx.strategy.progressId) throw new Error('synthetic progress read failure');
      return get(id);
    });
    await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(progressSelection), /progress read failure/);
    progressRead.mock.restore();
    assert.equal(selection(fx.strategy).expectedGeneration, progressSelection.expectedGeneration, 'pre-clear failure left the hold');
  });

  it('separates waiver, a later actual fake refusal, and a later actual L1 commit; legacy optional-key API still works', async (t) => {
    const fx = await fixture(t, 'lifecycle');
    const selected = selection(fx.strategy);
    const calls = fx.calls.length;
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selected)).status, 'released');
    assert.equal(fx.calls.length, calls);
    assert.equal(fx.strategy.getStats().l1, 0);
    await fx.strategy.run(fx.chunk, fx.ctx);
    assert.ok(fx.calls.length > calls, 'native attempt observed only when explicitly driven later');
    assert.equal(fx.calls.at(-1)!.config!.model, 'fake-configured-model', 'fake observed request, not upstream model identity');
    assert.equal(fx.strategy.getStats().l1, 0, 'provider refusal is not a commit');
    assert.notEqual(selection(fx.strategy).expectedGeneration, selected.expectedGeneration);
    await fx.strategy.clearCompressionRefusalQuarantine(selected.key);
    fx.answer('end_turn');
    await fx.strategy.run(fx.chunk, fx.ctx);
    assert.equal(fx.strategy.getStats().l1, 1, 'successful fake response committed through native L1 machinery');
    assert.equal(fx.chunk.compressed, true);
    assert.equal(inspect(fx.strategy).totalRecords, 0);
    fx.sibling('legacy-one');
    fx.sibling('legacy-two');
    await fx.strategy.clearCompressionRefusalQuarantine();
    assert.equal(inspect(fx.strategy).totalRecords, 0, 'legacy omitted-key clear-all remains a LIBRARY API only');
  });

  it('keeps same-instance alarm counts on raw siblings and ends once without claiming operator waiver paid debt', async (t) => {
    const fx = await fixture(t, 'alarm');
    fx.sibling('alarm-sibling');
    const lines: string[] = [];
    const heard: CompressionQuarantineStatus[] = [];
    const error = mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    t.after(() => error.mock.restore());
    fx.strategy.setQuarantineAlarmHandler((status) => heard.push(status));
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    await fx.strategy.alarm();
    assert.deepEqual(heard.map((status) => status.count), [2]);
    const first = selection(fx.strategy, fx.event.key);
    await fx.strategy.releaseCompressionRefusalQuarantine(first);
    mock.timers.tick(3_600_001);
    await fx.strategy.alarm();
    assert.deepEqual(heard.map((status) => status.count), [2, 1]);
    assert.equal(heard[1]!.spans[0]!.records, 1);
    assert.equal(fx.chunk.compressed, false, 'native sweep retained the raw sibling');
    assert.ok(!lines.some((line) => /ALL CLEAR|debt paid|already compressed|orphaned/.test(line)));
    await fx.strategy.releaseCompressionRefusalQuarantine(selection(fx.strategy));
    await fx.strategy.alarm();
    await fx.strategy.alarm();
    assert.deepEqual(heard.map((status) => status.count), [2, 1, 0]);
    assert.equal(lines.filter((line) => /quarantine empty after operator waiver request/.test(line)).length, 1);
    assert.ok(!lines.some((line) => /ALL CLEAR|debt paid/.test(line)));
    assert.equal(fx.strategy.getStats().l1, 0);
  });
});
