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
  setRegime(sourceOnly: boolean, toolProse?: { intoTool: string; fromTools: string[] }): void {
    this.config.compressionSourceOnlyFallback = sourceOnly;
    this.config.compressionToolProseFallback = toolProse;
  }
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
      assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable', reason: 'ledger-entry' });
      assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'unreadable', reason: 'ledger-entry' });
      assert.deepEqual(bytes(fx.path), before);
    }
    const get = fx.store.getStateJson.bind(fx.store);
    const read = mock.method(fx.store, 'getStateJson', (id: string) => {
      if (id === fx.strategy.ledgerId) throw new Error('DO-NOT-EXPOSE-SECRET-error-payload');
      return get(id);
    });
    assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable', reason: 'store-read' });
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'unreadable', reason: 'store-read' });
    read.mock.restore();
    fx.strategy.detach();
    assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'branchUnavailable' });
    await noWrites(fx, async () => {
      assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'branchUnavailable' });
    });
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
      await noWrites(fx, async () => {
        assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine({ ...selected, expectedBinding: { ...selected.expectedBinding, [field]: 'wrong' } }), { status: 'stale' });
      });
    }
    fx.manager.addMessage('User', [{ type: 'text', text: 'ordinary append' }]);
    assert.deepEqual(inspect(fx.strategy).binding, selected.expectedBinding);
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selected)).status, 'released');
    await fx.strategy.exhaust(fx.event.record);
    const priorLoad = selection(fx.strategy);
    await fx.manager.setStrategy(fx.strategy);
    await noWrites(fx, async () => {
      assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(priorLoad), { status: 'stale' });
    });
    const current = selection(fx.strategy);
    const first = fx.manager.currentBranch().name;
    await fx.manager.switchBranch(fx.manager.branchAt(fx.chunk.messages[0]!.id, 'other'));
    await noWrites(fx, async () => {
      assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(current), { status: 'stale' });
    });
    await fx.manager.switchBranch(first);
    await noWrites(fx, async () => {
      assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(current), { status: 'stale' });
    });
    const onMain = selection(fx.strategy);
    await fx.strategy.initialize({ ...fx.ctx, namespace: 'other-namespace' });
    const before = bytes(fx.path);
    await noWrites(fx, async () => {
      assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(onMain), { status: 'stale' });
    });
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
    assert.equal(heard[2]!.clearReason, 'operator-waiver-requested');
    assert.equal(lines.filter((line) => /quarantine empty after operator waiver request/.test(line)).length, 1);
    assert.ok(!lines.some((line) => /ALL CLEAR|debt paid/.test(line)));
    assert.equal(fx.strategy.getStats().l1, 0);
  });
});

// Adapted from the review's actual triage-native.test.js probes, reusing the
// existing fake-provider fixture rather than a new controller or writer.
function native(strategy: Probe) {
  return strategy as unknown as {
    appendCompressionQuarantineEvent(event: Event): unknown;
    captureCompressionBranch(): unknown;
    checkpointCompressionQuarantineIfNeeded(branch: unknown): void;
  };
}
function pad(fx: Awaited<ReturnType<typeof fixture>>) {
  while ((fx.store.getStateLen(fx.strategy.ledgerId) ?? 0) < 256) {
    native(fx.strategy).appendCompressionQuarantineEvent({ kind: 'alert_pending', key: fx.event.key,
      targetClaimId: fx.event.eventId, alertKey: 'fake-padding', created: Date.now() });
  }
}
async function noWrites(fx: Awaited<ReturnType<typeof fixture>>, operation: () => Promise<unknown>) {
  const before = bytes(fx.path);
  const append = mock.method(fx.store, 'appendToStateJsonWithIdentity');
  const set = mock.method(fx.store, 'setStateJson');
  const sync = mock.method(fx.store, 'sync');
  try {
    await operation();
    assert.deepEqual(bytes(fx.path), before);
    assert.deepEqual([append.mock.callCount(), set.mock.callCount(), sync.mock.callCount()], [0, 0, 0]);
  } finally {
    append.mock.restore(); set.mock.restore(); sync.mock.restore();
  }
}

describe('R1 native review regressions', () => {
  it('F2 requires a trustworthy native family before any write, never infers it or clears all progress', async (t) => {
    const fx = await fixture(t, 'r1-family');
    const selected = selection(fx.strategy);
    const progress = [{ familyKey: fx.event.record.familyKey, chunkSourceHash: fx.event.record.chunkSourceHash,
      sourceIds: fx.event.record.sourceIds, outcomes: [{ outcome: 'refusal' }], updated: Date.now() }];
    fx.store.setStateJson(fx.strategy.progressId, progress);
    for (const familyKey of [undefined, null, '', 'malformed-family', 'A'.repeat(64), {}, 22]) {
      const event = structuredClone(fx.event);
      if (familyKey === undefined) delete event.record.familyKey;
      else event.record.familyKey = familyKey;
      fx.store.setStateJson(fx.strategy.ledgerId, [event]);
      const record = inspect(fx.strategy).records[0]!;
      assert.equal(record.selectable, false);
      assert.equal(record.familyKey, null);
      await noWrites(fx, async () => {
        assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'unreadable', reason: 'ledger-entry' });
      });
      assert.deepEqual(fx.store.getStateJson(fx.strategy.progressId), progress);
    }
  });

  it('F3 native checkpoint writer preserves identity after redaction interruption and full compaction', async (t) => {
    for (const interrupted of [true, false]) {
      const fx = await fixture(t, `r1-checkpoint-${interrupted}`);
      const old = selection(fx.strategy);
      pad(fx);
      if (interrupted) {
        const compact = mock.method(fx.store, 'compactState', () => { throw new Error('fake stop before compact'); });
        assert.throws(() => native(fx.strategy).checkpointCompressionQuarantineIfNeeded(native(fx.strategy).captureCompressionBranch()), /fake stop/);
        compact.mock.restore();
      } else native(fx.strategy).checkpointCompressionQuarantineIfNeeded(native(fx.strategy).captureCompressionBranch());
      assert.equal(fx.ledger().length, 1, 'actual Chronicle redaction shape, not a fabricated checkpoint');
      assert.equal(fx.ledger()[0]!.kind, 'checkpoint');
      assert.equal(selection(fx.strategy).expectedGeneration, old.expectedGeneration);
      assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(old)).status, 'released');
    }
  });

  it('F3 reopen after native checkpoint preserves native and intentionally unsupported legacy lineage', async (t) => {
    const fx = await fixture(t, 'r1-reopen');
    const legacyKey = hash('legacy-extra');
    fx.store.setStateJson(fx.strategy.legacyId, [{ ...fx.event.record, key: legacyKey }]);
    pad(fx);
    native(fx.strategy).checkpointCompressionQuarantineIfNeeded(native(fx.strategy).captureCompressionBranch());
    fx.manager.close();
    const strategy = new Probe(config);
    const manager = await ContextManager.open({ path: fx.path, strategy,
      membrane: { complete: async () => { throw new Error('must not call fake on reopen'); } } as never });
    t.after(() => manager.close());
    const view = inspect(strategy);
    assert.equal(view.records.find((record) => record.key === fx.event.key)!.generation, fx.event.eventId);
    const legacy = view.records.find((record) => record.key === legacyKey)!;
    assert.equal(legacy.generation, null);
    assert.equal(legacy.selectable, false);
    assert.equal((await strategy.releaseCompressionRefusalQuarantine(selection(strategy, fx.event.key))).status, 'released');
    const before = bytes(fx.path);
    assert.equal((await strategy.releaseCompressionRefusalQuarantine({ key: legacy.key,
      expectedGeneration: `legacy:${legacy.key}`, expectedBinding: view.binding })).status, 'unsupported');
    assert.deepEqual(bytes(fx.path), before);
  });

  it('F5 validates native digests, not opaque generation/message IDs or free-form configured models', async (t) => {
    const fx = await fixture(t, 'r1-digests');
    const event = structuredClone(fx.event);
    event.eventId = '22'; // actual native identity format, NOT a SHA-256
    event.record.model = 'free-form recorded model / label';
    event.record.familyKey = 'FAKE-FAMILY-TEXT';
    event.record.frontierHash = 'FAKE-FRONTIER-TEXT';
    event.record.canonicalRequestHash = 'FAKE-REQUEST-TEXT';
    event.outcomes[0].requestHash = 'FAKE-OUTCOME-TEXT';
    fx.store.setStateJson(fx.strategy.ledgerId, [event]);
    const record = inspect(fx.strategy).records[0]!;
    assert.equal(record.generation, '22');
    assert.deepEqual(record.sourceIds, fx.chunk.messages.map((message) => message.id));
    assert.equal(record.recordedModel, event.record.model);
    assert.deepEqual([record.familyKey, record.frontierHash, record.canonicalRequestHash, record.outcomes[0]!.requestHash], [null, null, null, null]);
    const serialized = JSON.stringify(record);
    for (const label of ['FAKE-FAMILY-TEXT', 'FAKE-FRONTIER-TEXT', 'FAKE-REQUEST-TEXT', 'FAKE-OUTCOME-TEXT']) assert.ok(!serialized.includes(label));
    for (const field of ['key', 'chunkSourceHash']) {
      const damaged = structuredClone(fx.event);
      damaged.record[field] = 'FAKE-NONDIGEST';
      if (field === 'key') damaged.key = damaged.record.key;
      fx.store.setStateJson(fx.strategy.ledgerId, [damaged]);
      assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable', reason: 'ledger-entry' });
    }
    const sibling = { ...fx.event, key: 'FAKE-SIBLING-KEY', record: { ...fx.event.record, key: 'FAKE-SIBLING-KEY' } };
    fx.store.setStateJson(fx.strategy.ledgerId, [fx.event, sibling]);
    assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine({ key: fx.event.key }), { status: 'unreadable', reason: 'ledger-entry' });
  });

  it('F1/F6 generic legacy and other-instance clears are neutral, not payment receipts', async (t) => {
    for (const shared of [false, true]) {
      const fx = await fixture(t, `r1-neutral-${shared}`);
      const lines: string[] = [];
      const heard: CompressionQuarantineStatus[] = [];
      const log = mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.join(' ')); });
      try {
        fx.strategy.setQuarantineAlarmHandler((status) => heard.push(status));
        await fx.strategy.alarm();
        if (shared) {
          const other = new Probe(config);
          await other.initialize(fx.ctx);
          assert.equal((await other.releaseCompressionRefusalQuarantine(selection(other))).status, 'released');
        } else await fx.strategy.clearCompressionRefusalQuarantine();
        await fx.strategy.alarm();
        await fx.strategy.alarm();
        assert.deepEqual(heard.map((status) => status.count), [1, 0]);
        assert.equal(heard[0]!.clearReason, undefined);
        assert.deepEqual(heard[1], { count: 0, keys: [], spans: [], clearReason: 'quarantine-empty' });
        assert.equal(fx.strategy.getStats().l1, 0);
        assert.ok(lines.some((line) => line.includes('coverage and debt payment not established')));
        assert.ok(!lines.some((line) => /debt paid|ALL CLEAR/.test(line)));
      } finally { log.mock.restore(); }
    }
  });

  it('F7 new native refusal before the empty check retains known waiver intent across a repeated alarm', async (t) => {
    const fx = await fixture(t, 'r1-new-refusal');
    const heard: CompressionQuarantineStatus[] = [];
    fx.strategy.setQuarantineAlarmHandler((status) => heard.push(status));
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.after(() => mock.timers.reset());
    await fx.strategy.alarm();
    await fx.strategy.releaseCompressionRefusalQuarantine(selection(fx.strategy));
    await fx.strategy.run(fx.chunk, fx.ctx);
    assert.equal(inspect(fx.strategy).totalRecords, 1);
    mock.timers.tick(3_600_001);
    await fx.strategy.alarm();
    await fx.strategy.clearCompressionRefusalQuarantine();
    await fx.strategy.alarm();
    assert.deepEqual(heard.map((status) => status.count), [1, 1, 0]);
    assert.equal(heard[2]!.clearReason, 'operator-waiver-requested');
  });

  it('F8/F10 a real replacement instance rejects old binding, and detached rejects without bytes or writes', async (t) => {
    const fx = await fixture(t, 'r1-replacement');
    const old = selection(fx.strategy);
    const replacement = new Probe(config);
    await fx.manager.setStrategy(replacement);
    assert.notEqual(inspect(replacement).binding.loadId, old.expectedBinding.loadId);
    await noWrites(fx, async () => {
      assert.equal((await replacement.releaseCompressionRefusalQuarantine(old)).status, 'stale');
    });
    const current = selection(replacement);
    replacement.detach();
    await noWrites(fx, async () => {
      assert.equal((await replacement.releaseCompressionRefusalQuarantine(current)).status, 'branchUnavailable');
    });
  });

  it('F11 selected release checkpoints at the native threshold without changing retained sibling generations', async (t) => {
    const fx = await fixture(t, 'r1-threshold');
    const sibling = fx.sibling('threshold-sibling', fx.event.record.familyKey);
    const old = selection(fx.strategy, sibling.key);
    pad(fx);
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selection(fx.strategy, fx.event.key))).status, 'released');
    assert.equal(fx.ledger().length, 1);
    assert.equal(fx.ledger()[0]!.kind, 'checkpoint');
    assert.equal(selection(fx.strategy, sibling.key).expectedGeneration, old.expectedGeneration);
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(old)).status, 'released');
  });

  it('R1-1/F11 repeated native writes compact damaged history from the gate projection', async (t) => {
    const fx = await fixture(t, 'r1-damaged-hygiene');
    const sibling = fx.sibling('damage-sibling');
    const original = selection(fx.strategy, sibling.key);
    const orphanKey = hash('orphan-exhaustion');
    fx.append({ kind: 'exhausted', key: orphanKey, eventId: 'orphan-generation', outcomes: [] });
    assert.equal(fx.strategy.inspectCompressionRefusalQuarantine().status, 'unreadable');
    for (let round = 0; round < 3; round++) {
      pad(fx);
      await fx.strategy.clearCompressionRefusalQuarantine(hash('absent'));
      assert.ok(fx.ledger().length < 256, 'damage must not disable future native compaction');
      assert.equal(fx.ledger()[0]!.kind, 'checkpoint');
      assert.equal(inspect(fx.strategy).totalRecords, 2);
      assert.equal(selection(fx.strategy, sibling.key).expectedGeneration, original.expectedGeneration);
      assert.ok(fx.strategy.gate(fx.event.record), 'the same enforced hold survives');
    }
  });

  it('R1-1/F11 repeated native writes checkpoint more than 1024 holds losslessly', async (t) => {
    const fx = await fixture(t, 'r1-preservation');
    const siblings = Array.from({ length: 1025 }, (_, index) => {
      const key = hash(`oversized-${index}`);
      return { ...fx.event, key, eventId: `opaque-${index}`, record: { ...fx.event.record, key } };
    });
    fx.store.setStateJson(fx.strategy.ledgerId, [fx.event, ...siblings]);
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selection(fx.strategy, fx.event.key))).status, 'released');
    for (let round = 0; round < 3; round++) {
      assert.ok(fx.ledger().length < 256, 'large hold sets must not disable native compaction');
      assert.equal(inspect(fx.strategy).totalRecords, 1025);
      assert.equal(fx.ledger()[0]!.kind, 'checkpoint');
      assert.deepEqual(fx.ledger()[0]!.active.map((item: Event) => [item.record.key, item.generationId]).sort(),
        siblings.map((event) => [event.key, event.eventId]).sort());
      pad(fx);
      await fx.strategy.clearCompressionRefusalQuarantine(hash('absent'));
    }
    assert.ok(fx.ledger().length < 256);
  });

  it('R1-1 skipped hygiene logs once per load and still propagates uncertainty', async (t) => {
    const fx = await fixture(t, 'r1-skipped-hygiene');
    const lines: string[] = [];
    const warn = mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.join(' ')); });
    const fail = () => {
      const broken = mock.method(fx.store, 'getStateLen', () => { throw new Error('private-store-details'); });
      try {
        for (let i = 0; i < 2; i++) assert.throws(() => native(fx.strategy).checkpointCompressionQuarantineIfNeeded(
          native(fx.strategy).captureCompressionBranch()), /private-store-details/);
      } finally { broken.mock.restore(); }
    };
    try {
      fail();
      assert.equal(lines.filter((line) => line.includes('checkpoint hygiene skipped')).length, 1);
      await fx.strategy.initialize(fx.ctx);
      fail();
      assert.equal(lines.filter((line) => line.includes('checkpoint hygiene skipped')).length, 2);
      assert.ok(!lines.some((line) => line.includes('private-store-details')));
    } finally { warn.mock.restore(); }
  });

  it('R1-2 unexpected projection errors propagate instead of masquerading as unreadable data', async (t) => {
    const fx = await fixture(t, 'r1-programmer-error');
    const selected = selection(fx.strategy);
    const projection = fx.strategy as unknown as { readCompressionQuarantineProjection(): unknown };
    const bug = new TypeError('fake projection bug');
    const broken = mock.method(projection, 'readCompressionQuarantineProjection', () => { throw bug; });
    try {
      await noWrites(fx, async () => {
        assert.throws(() => fx.strategy.inspectCompressionRefusalQuarantine(), (error) => error === bug);
        await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(selected), (error) => error === bug);
      });
    } finally { broken.mock.restore(); }
  });

  it('R1-3 reports the gate shape-cap regime counts under current configuration', async (t) => {
    const fx = await fixture(t, 'r1-shape-counts');
    const base = fx.event.record.normalizedConfig;
    const events: Event[] = [];
    const add = (label: string, count: number, normalizedConfig: Event) => {
      for (let i = 0; i < count; i++) {
        const key = hash(`${label}-${i}`);
        events.push({ ...fx.event, key, eventId: `${label}-${i}`, record: { ...fx.event.record, key,
          familyKey: hash(`${label}-family-${i}`), normalizedConfig } });
      }
    };
    add('current', 3, base);
    add('old-accounting', 3, { ...base, accountingVersion: -1 });
    add('source-a', 2, { ...base, sourceOnlyFallbackEnabled: true, sourceOnlyFallbackRequestHash: hash('request-a') });
    add('source-b', 3, { ...base, sourceOnlyFallbackEnabled: true, sourceOnlyFallbackRequestHash: hash('request-b') });
    const toolProse = { intoTool: 'private_reasoning', fromTools: ['original_tool'] };
    // Use the gate's normalized defaults, with deliberately reordered keys.
    const options = fx.strategy as unknown as { toolProseHoistOptions(): Event | undefined };
    fx.strategy.setRegime(false, toolProse);
    const normalizedTool = Object.fromEntries(Object.entries(options.toolProseHoistOptions()!).reverse());
    add('tool', 3, { ...base, toolProseFallback: normalizedTool });
    fx.store.setStateJson(fx.strategy.ledgerId, events);
    for (const [sourceOnly, tool, matching] of [[false, undefined, ['current']], [true, undefined, ['source-a', 'source-b']],
      [false, toolProse, ['tool']]] as const) {
      fx.strategy.setRegime(sourceOnly, tool);
      const view = inspect(fx.strategy);
      for (const event of events) {
        const record = view.records.find((item) => item.key === event.key)!;
        const label = event.eventId.replace(/-\d+$/, '');
        const counts = (matching as readonly string[]).includes(label);
        assert.equal(record.countsTowardShapeCap, counts, event.eventId);
        const expectedCount = !counts ? 0 : label === 'source-a' ? 2 : 3;
        assert.equal(record.sameRegimeRecords, expectedCount, event.eventId);
        assert.equal(record.sameSourceRecords, events.length);
        if (counts) {
          const candidate = { ...event.record, key: hash('new-shape'), familyKey: hash('new-family') };
          assert.equal(Boolean(fx.strategy.gate(candidate)), expectedCount >= 3, 'same predicate as the native gate');
        }
      }
    }
    // Releasing an out-of-regime record does not reduce the current cap.
    fx.strategy.setRegime(false);
    const current = events.find((event) => event.eventId === 'current-0')!;
    const old = events.find((event) => event.eventId === 'old-accounting-0')!;
    await fx.strategy.releaseCompressionRefusalQuarantine(selection(fx.strategy, old.key));
    const currentView = inspect(fx.strategy, { key: current.key }).records[0]!;
    assert.equal(currentView.sameRegimeRecords, 3);
    await fx.strategy.releaseCompressionRefusalQuarantine(selection(fx.strategy, current.key));
    const candidate = { ...current.record, key: hash('new-shape'), familyKey: hash('new-family') };
    assert.equal(fx.strategy.gate(candidate), undefined);
  });

  it('F11 a transient checkpoint read failure throws even if a later postread would succeed', async (t) => {
    const fx = await fixture(t, 'r1-checkpoint-read');
    const old = selection(fx.strategy);
    pad(fx);
    const get = fx.store.getStateJson.bind(fx.store);
    let reads = 0;
    const broken = mock.method(fx.store, 'getStateJson', (id: string) => {
      if (id === fx.strategy.ledgerId && ++reads === 2) throw new Error('fake transient checkpoint read');
      return get(id);
    });
    await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(old), /fake transient checkpoint read/);
    broken.mock.restore();
    assert.equal(reads, 2, 'failed helper read never proceeds to success/ack');
    assert.equal(inspect(fx.strategy).totalRecords, 0, 'a later readable absence is not an acknowledgement');
  });

  it('F11 partial checkpoint/redaction/compaction exceptions remain uncertain, never released', async (t) => {
    for (const failure of ['checkpoint', 'redactStateItems', 'compactState'] as const) {
      const fx = await fixture(t, `r1-failure-${failure}`);
      const old = selection(fx.strategy);
      pad(fx);
      const append = fx.store.appendToStateJsonWithIdentity.bind(fx.store);
      const broken = failure === 'checkpoint'
        ? mock.method(fx.store, 'appendToStateJsonWithIdentity', (...args: Parameters<typeof append>) => {
            const result = append(...args);
            if ((args[1] as Event).kind === 'checkpoint') throw new Error('fake checkpoint failure after append');
            return result;
          })
        : mock.method(fx.store, failure, () => { throw new Error('fake checkpoint failure'); });
      await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(old), /fake checkpoint failure/);
      broken.mock.restore();
      assert.equal(inspect(fx.strategy).totalRecords, 0, 'absence after partial write is NOT an acknowledgement');
    }
  });
});
