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
import { markStoreBranchSwitch } from '../src/branch-generation.js';
import { compressionQuarantineHolds } from '../src/strategies/autobiographical.js';
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
    const beforeReadFailure = bytes(fx.path);
    assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable', reason: 'store-read' });
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'unreadable', reason: 'store-read' });
    assert.deepEqual(bytes(fx.path), beforeReadFailure);
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
    appendCompressionQuarantineEvent(event: Event, source: unknown): unknown;
    captureCompressionBranch(): unknown;
    checkpointCompressionQuarantineIfNeeded(branch: unknown): void;
  };
}
function pad(fx: Awaited<ReturnType<typeof fixture>>) {
  while ((fx.store.getStateLen(fx.strategy.ledgerId) ?? 0) < 256) {
    native(fx.strategy).appendCompressionQuarantineEvent({ kind: 'alert_pending', key: fx.event.key,
      targetClaimId: fx.event.eventId, alertKey: 'fake-padding', created: Date.now() }, native(fx.strategy).captureCompressionBranch());
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

  for (const phase of ['projection', 'progress'] as const) {
    it(`round 7 preserves both branches when ${phase} read changes the release binding`, async (t) => {
      const fx = await fixture(t, `review-first-write-${phase}`);
      const selected = selection(fx.strategy);
      const originalBranch = fx.store.currentBranch().name;
      const progress = [{ familyKey: fx.event.record.familyKey, chunkSourceHash: fx.event.record.chunkSourceHash,
        sourceIds: fx.event.record.sourceIds, outcomes: [{ outcome: 'refusal', requestHash: 'synthetic', curveLabel: 'canonical' }], updated: Date.now() }];
      fx.store.setStateJson(fx.strategy.progressId, progress);
      fx.store.createBranch('elsewhere');
      fx.store.switchBranch('elsewhere');
      fx.store.setStateJson(fx.strategy.progressId, progress);
      const otherLedger = fx.ledger();
      fx.store.switchBranch(originalBranch);
      const originalLedger = fx.ledger();
      const get = fx.store.getStateJson.bind(fx.store);
      let moved = false;
      const hook = mock.method(fx.store, 'getStateJson', (id: string) => {
        const result = get(id);
        if (!moved && id === (phase === 'projection' ? fx.strategy.ledgerId : fx.strategy.progressId)) {
          fx.store.switchBranch('elsewhere');
          moved = true;
        }
        return result;
      });
      try {
        if (phase === 'projection') assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'branchUnavailable' });
        else await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(selected), /uncertain/);
        assert.equal(moved, true);
        assert.deepEqual(get(fx.strategy.progressId), progress, 'other branch progress must not be rewritten');
        assert.deepEqual(fx.ledger(), otherLedger, 'other branch ledger is untouched');
      } finally {
        hook.mock.restore();
        fx.store.switchBranch(originalBranch);
      }
      assert.deepEqual(get(fx.strategy.progressId), progress, 'authorized branch progress is untouched');
      assert.deepEqual(fx.ledger(), originalLedger);
    });
  }

  for (const phase of ['clear', 'checkpoint', 'redaction', 'compaction', 'sync', 'postread'] as const) {
    it(`14 rejects uncertain release after a reentrant branch move during ${phase}`, async (t) => {
      const fx = await fixture(t, `review-binding-${phase}`);
      const selected = selection(fx.strategy);
      pad(fx);
      const originalBranch = fx.store.currentBranch().name;
      fx.store.createBranch('elsewhere');
      let moved = false;
      let synced = false;
      const move = () => {
        fx.store.switchBranch('elsewhere');
        moved = true;
      };
      const append = fx.store.appendToStateJsonWithIdentity.bind(fx.store);
      const redact = fx.store.redactStateItems.bind(fx.store);
      const compact = fx.store.compactState.bind(fx.store);
      const sync = fx.store.sync.bind(fx.store);
      const get = fx.store.getStateJson.bind(fx.store);
      const hooks = [
        mock.method(fx.store, 'appendToStateJsonWithIdentity', (...args: Parameters<typeof append>) => {
          const result = append(...args);
          if ((args[1] as Event).kind === phase) move();
          return result;
        }),
        mock.method(fx.store, 'redactStateItems', (...args: Parameters<typeof redact>) => {
          const result = redact(...args);
          if (phase === 'redaction') move();
          return result;
        }),
        mock.method(fx.store, 'compactState', (...args: Parameters<typeof compact>) => {
          const result = compact(...args);
          if (phase === 'compaction') move();
          return result;
        }),
        mock.method(fx.store, 'sync', () => {
          sync();
          synced = true;
          if (phase === 'sync') move();
        }),
        mock.method(fx.store, 'getStateJson', (id: string) => {
          const result = get(id);
          if (phase === 'postread' && synced && id === fx.strategy.ledgerId) move();
          return result;
        }),
      ];
      try {
        await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(selected), /uncertain/);
        assert.equal(moved, true, 'fault injection reached the selected post-write phase');
      } finally {
        for (const hook of hooks) hook.mock.restore();
        fx.store.switchBranch(originalBranch);
      }
      assert.ok(fx.ledger().some((event) => event?.kind === 'clear' || event?.kind === 'checkpoint'),
        'the mutation landed; branch loss must not become a no-mutation status');
    });
  }

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

describe('Anima Review regressions', () => {
  it('4 reads records and checkpoints emitted by the pre-sourceIds writer', async (t) => {
    // Captured from 274f7a88bb323699324994fefbe878f275b10aed with a refusing
    // fake provider, then its own 256-event checkpoint writer (which sliced
    // at 1,024). No current record builder or checkpoint writer creates these.
    const historical = JSON.parse(readFileSync('test/fixtures/quarantine-pre-source-ids.json', 'utf8'));
    const fx = await fixture(t, 'review-historical');
    const event = historical.events.find((entry: Event) => entry.kind === 'exhausted');
    assert.equal('sourceIds' in event.record, false);
    for (const ledger of [historical.events, historical.checkpoint, [
      { ...event, kind: 'claim', eventId: 'historical-claim' },
      { kind: 'exhausted', key: event.key, targetClaimId: 'historical-claim', outcomes: event.outcomes },
    ]]) {
      fx.store.setStateJson(fx.strategy.ledgerId, ledger);
      const selected = selection(fx.strategy);
      assert.equal(selected.key, event.key);
      assert.equal(selected.expectedGeneration, ledger[0].kind === 'claim' ? 'historical-claim' : event.eventId);
      assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selected)).status, 'released');
    }
    fx.store.setStateJson(fx.strategy.ledgerId, []);
    fx.store.setStateJson(fx.strategy.legacyId, [event.record]);
    const legacy = inspect(fx.strategy).records[0]!;
    assert.equal(legacy.generation, null);
    assert.equal(legacy.selectable, false);
  });

  it('2 ignores superseded damaged legacy snapshots, but still validates checkpoints', async (t) => {
    const fx = await fixture(t, 'review-legacy-damage');
    const old = selection(fx.strategy);
    for (const legacy of [[null], { damaged: true }]) {
      fx.store.setStateJson(fx.strategy.legacyId, legacy);
      fx.store.setStateJson(fx.strategy.ledgerId, [fx.event]);
      assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable', reason: 'ledger-entry' });
      pad(fx);
      native(fx.strategy).checkpointCompressionQuarantineIfNeeded(native(fx.strategy).captureCompressionBranch());
      assert.equal(selection(fx.strategy).expectedGeneration, old.expectedGeneration);
      assert.deepEqual(fx.store.getStateJson(fx.strategy.legacyId), legacy, 'no legacy rewrite');
      assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(old)).status, 'released');
    }
    fx.store.setStateJson(fx.strategy.ledgerId, [{ kind: 'checkpoint', active: [null] }]);
    assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable', reason: 'ledger-entry' });
  });

  it('round 4b ends the alarm after reopening the same path with the same strategy', async (t) => {
    const fx = await fixture(t, 'review-alarm-reopen');
    const heard: CompressionQuarantineStatus[] = [];
    fx.strategy.setQuarantineAlarmHandler((status) => heard.push(status));
    await fx.strategy.alarm();
    assert.equal(heard.length, 1);
    await fx.manager.close();
    const reopened = await ContextManager.open({ path: fx.path, strategy: fx.strategy });
    t.after(() => reopened.close());
    assert.notEqual(reopened.getStore(), fx.store, 'reopen replaces the native handle');
    assert.equal(inspect(fx.strategy).totalRecords, 1);
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selection(fx.strategy))).status, 'released');
    await fx.strategy.alarm();
    assert.equal(heard.length, 2, 'empty quarantine clears before the next repeat');
    assert.equal(heard[1]!.clearReason, 'operator-waiver-requested');
    await fx.strategy.alarm();
    assert.equal(heard.length, 2, 'all-clear fires only once');
  });

  for (const checkpoints of [1, 2]) it(`round 4 resolves legacy claims across ${checkpoints} checkpoints`, async (t) => {
    const fx = await fixture(t, `review-claim-checkpoints-${checkpoints}`);
    const old = selection(fx.strategy);
    const claimId = 'pre-checkpoint-claim';
    const ledger = [
      null, // Unrelated superseded damage must remain ignored.
      { ...fx.event, kind: 'claim', eventId: 'unused-damaged-claim', record: null },
      { ...fx.event, kind: 'claim', eventId: claimId },
      ...Array.from({ length: checkpoints }, () => ({ kind: 'checkpoint', active: [] })),
      { kind: 'exhausted', key: old.key, targetClaimId: claimId, outcomes: fx.event.outcomes },
    ];
    fx.store.setStateJson(fx.strategy.ledgerId, ledger);
    assert.ok(fx.strategy.gate(fx.event.record));
    assert.equal(compressionQuarantineHolds(ledger as never, []).holds(fx.event.record.sourceIds), true);
    assert.equal(selection(fx.strategy).expectedGeneration, claimId);
    assert.deepEqual(fx.ledger(), ledger, 'inspection does not rewrite the below-threshold ledger');
    assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine({
      ...old, expectedGeneration: claimId,
    })).status, 'released');
    assert.equal(inspect(fx.strategy).totalRecords, 0);

    // Referenced damage is still rejected, unlike unrelated superseded damage.
    ledger[2] = { ...fx.event, kind: 'claim', eventId: claimId, record: null };
    fx.store.setStateJson(fx.strategy.ledgerId, ledger);
    assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable', reason: 'ledger-entry' });
    assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine({
      ...old, expectedGeneration: claimId,
    }), { status: 'unreadable', reason: 'ledger-entry' });
  });

  for (const operation of ['inspection', 'release'] as const) it(`round 3 ${operation} reads the checkpoint before redaction`, async (t) => {
    const fx = await fixture(t, `review-before-redaction-${operation}`);
    const old = selection(fx.strategy);
    fx.store.setStateJson(fx.strategy.ledgerId, [null, fx.event]);
    pad(fx);
    const redact = mock.method(fx.store, 'redactStateItems', () => { throw new Error('stop before redaction'); });
    assert.throws(() => native(fx.strategy).checkpointCompressionQuarantineIfNeeded(native(fx.strategy).captureCompressionBranch()), /stop before redaction/);
    redact.mock.restore();
    assert.equal(fx.ledger()[0], null, 'damage remains before checkpoint');
    const ledger = fx.ledger();
    assert.throws(() => compressionQuarantineHolds([], () => { throw new Error('needed snapshot'); }), /needed snapshot/);
    for (const legacy of [{ damaged: true }, () => { throw new Error('superseded snapshot read'); }]) {
      const projection = compressionQuarantineHolds(ledger, legacy);
      assert.deepEqual(projection.unlisted, []);
      assert.equal(projection.holds(fx.event.record.sourceIds), true);
    }
    // Each operation gets its own interrupted ledger: release must not depend
    // on a preceding successful inspection (or reopen's startup hygiene).
    assert.equal(fx.ledger()[0], null, 'malformed prefix still exists at the strict operation');
    assert.equal(fx.ledger().at(-1)?.kind, 'checkpoint');
    if (operation === 'release') {
      assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(old)).status, 'released');
      assert.equal(inspect(fx.strategy).totalRecords, 0);
      return;
    }
    assert.equal(selection(fx.strategy).expectedGeneration, old.expectedGeneration);
    assert.deepEqual(fx.ledger(), ledger, 'strict inspection does not perform hygiene');

    // Reopen is a persistence/startup-hygiene check, not proof of strict
    // replay over damage: startup may redact the malformed prefix.
    fx.manager.close();
    const strategy = new Probe(config);
    const manager = await ContextManager.open({ path: fx.path, strategy });
    t.after(() => manager.close());
    assert.equal(selection(strategy).expectedGeneration, old.expectedGeneration);
    assert.equal((await strategy.releaseCompressionRefusalQuarantine(selection(strategy))).status, 'released');
    manager.getStore().setStateJson(strategy.ledgerId, [...ledger, null]);
    assert.deepEqual(strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable', reason: 'ledger-entry' });
  });

  it('round 7 inspection rejects projection read branch changes', async (t) => {
    const fx = await fixture(t, 'review-inspection-binding');
    const branch = fx.store.currentBranch().name;
    fx.store.createBranch('elsewhere');
    const get = fx.store.getStateJson.bind(fx.store);
    const hook = mock.method(fx.store, 'getStateJson', (id: string) => {
      const result = get(id);
      if (id === fx.strategy.ledgerId) fx.store.switchBranch('elsewhere');
      return result;
    });
    const set = mock.method(fx.store, 'setStateJson');
    const append = mock.method(fx.store, 'appendToStateJsonWithIdentity');
    const sync = mock.method(fx.store, 'sync');
    try {
      assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'branchUnavailable' });
      assert.ok(hook.mock.calls.some((call) => call.arguments[0] === fx.strategy.ledgerId));
      assert.equal(fx.store.currentBranch().name, 'elsewhere');
      assert.deepEqual([set.mock.callCount(), append.mock.callCount(), sync.mock.callCount()], [0, 0, 0]);
    } finally {
      set.mock.restore(); append.mock.restore(); sync.mock.restore();
      hook.mock.restore(); fx.store.switchBranch(branch);
    }
  });

  it('round 7 stale below-threshold hygiene does not suppress the current load failure', async (t) => {
    const fx = await fixture(t, 'review-stale-warning');
    const source = native(fx.strategy).captureCompressionBranch();
    await fx.strategy.initialize(fx.ctx);
    assert.ok(fx.ledger().length < 256);
    const lines: string[] = [];
    const warn = mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      native(fx.strategy).checkpointCompressionQuarantineIfNeeded(source);
      assert.equal(lines.filter((line) => line.includes('obsolete checkpoint hygiene')).length, 0);
      assert.equal(lines.filter((line) => line.includes('checkpoint hygiene skipped')).length, 0, 'obsolete work must not use the current load warning');
      pad(fx);
      const compact = mock.method(fx.store, 'compactState', () => { throw new Error('checkpoint failed'); });
      try {
        assert.throws(() => native(fx.strategy).checkpointCompressionQuarantineIfNeeded(
          native(fx.strategy).captureCompressionBranch()), /checkpoint failed/);
      } finally { compact.mock.restore(); }
      assert.equal(lines.filter((line) => line.includes('checkpoint hygiene skipped')).length, 1);
    } finally { warn.mock.restore(); }
  });

  for (const sweep of [true, false]) it(`round 7 ${sweep ? 'sweep' : 'success clear'} reports landed clear uncertainty without store payloads`, async (t) => {
    const fx = await fixture(t, `review-clear-diagnostic-${sweep}`);
    const impl = fx.strategy as any;
    pad(fx);
    if (sweep) fx.store.setStateJson(impl.chunksStateId, [{ sourceIds: fx.event.record.sourceIds, compressed: true }]);
    const lines: string[] = [];
    const warn = mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.join(' ')); });
    const compact = mock.method(fx.store, 'compactState', () => { throw Object.assign(new Error('/private/store SECRET-payload'), { code: 'EACCES' }); });
    try {
      if (sweep) await impl.sweepPaidOffQuarantineRecords();
      else await impl.clearQuarantineForCompressedChunk(fx.chunk);
      assert.equal(inspect(fx.strategy).totalRecords, 0, 'clear landed before maintenance threw');
      assert.ok(lines.some((line) => line.includes('clear may have landed')));
      assert.ok(lines.some((line) => line.includes('maintenance failed: EACCES')));
      assert.ok(!lines.some((line) => /store operation failed|status will be reread/.test(line)));
      assert.ok(!lines.some((line) => /SECRET|private|records remain|klaxon persists/.test(line)));
    } finally { compact.mock.restore(); warn.mock.restore(); }
  });

  it('round 7 unreadable status does not log thrown store payloads', async (t) => {
    const fx = await fixture(t, 'review-status-diagnostic');
    const get = fx.store.getStateJson.bind(fx.store);
    const lines: string[] = [];
    const warn = mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.join(' ')); });
    const error = mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.join(' ')); });
    const hook = mock.method(fx.store, 'getStateJson', (id: string) => {
      if (id === fx.strategy.ledgerId) throw Object.assign(new Error('/private/store SECRET-payload'), { code: 'EACCES' });
      return get(id);
    });
    try {
      await fx.strategy.alarm();
      assert.ok(lines.some((line) => line.includes('quarantine status unreadable')));
      assert.ok(lines.some((line) => line.includes('status check failed: EACCES')));
      assert.ok(!lines.some((line) => /SECRET|private/.test(line)));
    } finally { hook.mock.restore(); warn.mock.restore(); error.mock.restore(); }
  });

  it('round 7 locked branch lookup failure returns branchUnavailable without writes', async (t) => {
    const fx = await fixture(t, 'review-locked-lookup');
    const selected = selection(fx.strategy);
    const current = fx.store.currentBranch.bind(fx.store);
    // Count the successful public precheck, then fail the same lookup under the lock.
    const counter = mock.method(fx.store, 'currentBranch');
    (fx.strategy as any).quarantineBinding();
    const precheckCalls = counter.mock.callCount();
    counter.mock.restore();
    let calls = 0;
    const hook = mock.method(fx.store, 'currentBranch', () => {
      if (++calls > precheckCalls) throw new Error('private locked lookup failure');
      return current();
    });
    try {
      await noWrites(fx, async () => {
        assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'branchUnavailable' });
      });
      assert.equal(calls, precheckCalls + 1, 'lookup failed inside the lock');
    } finally { hook.mock.restore(); }
  });

  it('round 7 an open episode retains waiver intent when a clear lands then throws', async (t) => {
    const fx = await fixture(t, 'review-open-waiver-uncertain');
    const heard: CompressionQuarantineStatus[] = [];
    fx.strategy.setQuarantineAlarmHandler((status) => heard.push(status));
    await fx.strategy.alarm();
    assert.equal(heard.length, 1);
    const selected = selection(fx.strategy);
    const append = fx.store.appendToStateJsonWithIdentity.bind(fx.store);
    const hook = mock.method(fx.store, 'appendToStateJsonWithIdentity', (...args: Parameters<typeof append>) => {
      const result = append(...args);
      if ((args[1] as Event).kind === 'clear') throw new Error('lost clear acknowledgement');
      return result;
    });
    try { await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(selected), /lost clear acknowledgement/); }
    finally { hook.mock.restore(); }
    await fx.strategy.alarm();
    assert.equal(heard.length, 2);
    assert.equal(heard[1]!.clearReason, 'operator-waiver-requested');
  });

  it('5 maps branch lookup failure consistently without writes', async (t) => {
    const fx = await fixture(t, 'review-branch-error');
    const old = selection(fx.strategy);
    const current = mock.method(fx.store, 'currentBranch', () => { throw new Error('private store failure'); });
    try {
      await noWrites(fx, async () => {
        assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'branchUnavailable' });
        assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(old), { status: 'branchUnavailable' });
      });
    } finally { current.mock.restore(); }
  });

  for (const sweep of [true, false]) it(`7 fences ${sweep ? 'paid-off sweep' : 'success clear'} decisions across earlier awaits`, async (t) => {
    const fx = await fixture(t, `review-generation-${sweep}`);
    const second = fx.sibling(`review-second-${sweep}`);
    const impl = fx.strategy as any;
    // Hook the shared clear boundary in both the old and fixed implementations.
    const method = typeof impl.clearObservedCompressionQuarantine === 'function'
      ? 'clearObservedCompressionQuarantine' : 'clearCompressionRefusalQuarantine';
    const clear = impl[method].bind(impl);
    let replaced = false;
    const hook = mock.method(impl, method, async (...args: any[]) => {
      await clear(...args);
      if (replaced) return;
      replaced = true;
      await fx.strategy.releaseCompressionRefusalQuarantine(selection(fx.strategy, second.key));
      await fx.strategy.exhaust(second.record);
    });
    try {
      if (sweep) {
        fx.store.setStateJson(impl.chunksStateId, [{ sourceIds: fx.chunk.messages.map((m) => m.id), compressed: true }]);
        await impl.sweepPaidOffQuarantineRecords();
      } else await impl.clearQuarantineForCompressedChunk(fx.chunk);
    } finally { hook.mock.restore(); }
    assert.equal(replaced, true);
    const remaining = inspect(fx.strategy).records;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.key, second.key);
    assert.notEqual(remaining[0]!.generation, second.eventId);
  });

  it('8 reopens after checkpoint redaction but before compaction', async (t) => {
    const fx = await fixture(t, 'review-interrupted-reopen');
    const old = selection(fx.strategy);
    pad(fx);
    const compact = mock.method(fx.store, 'compactState', () => { throw new Error('interrupted checkpoint'); });
    assert.throws(() => native(fx.strategy).checkpointCompressionQuarantineIfNeeded(native(fx.strategy).captureCompressionBranch()), /interrupted checkpoint/);
    compact.mock.restore();
    fx.manager.close();
    const strategy = new Probe(config);
    const manager = await ContextManager.open({ path: fx.path, strategy,
      membrane: { complete: async () => { throw new Error('no provider call'); } } as never });
    t.after(() => manager.close());
    const fresh = selection(strategy);
    assert.equal(fresh.expectedGeneration, old.expectedGeneration);
    assert.deepEqual(await strategy.releaseCompressionRefusalQuarantine(old), { status: 'stale' });
    assert.equal((await strategy.releaseCompressionRefusalQuarantine(fresh)).status, 'released');
  });
});

describe('round 8 binding and diagnostic regressions', () => {
  it('never checkpoints A into B when a projection read starts B initialization', async (t) => {
    const fx = await fixture(t, 'r8-checkpoint-binding');
    const a = fx.store.currentBranch().name;
    const source = native(fx.strategy).captureCompressionBranch();
    fx.store.createBranch('r8-b');
    fx.store.switchBranch('r8-b');
    fx.store.setStateJson(fx.strategy.ledgerId, []);
    fx.store.switchBranch(a);
    pad(fx);
    const get = fx.store.getStateJson.bind(fx.store);
    let initialization: Promise<void> | undefined;
    let moved = false;
    const hook = mock.method(fx.store, 'getStateJson', (id: string) => {
      const result = get(id);
      if (id === fx.strategy.ledgerId && !moved) {
        moved = true;
        fx.store.switchBranch('r8-b');
        initialization = fx.strategy.initialize(fx.ctx);
      }
      return result;
    });
    const append = mock.method(fx.store, 'appendToStateJsonWithIdentity');
    try {
      native(fx.strategy).checkpointCompressionQuarantineIfNeeded(source);
      await initialization;
      assert.equal(moved, true);
      assert.equal(append.mock.calls.filter((call) => (call.arguments[1] as Event).kind === 'checkpoint').length, 0);
      assert.deepEqual(fx.ledger(), [], 'B must not acquire A holds');
    } finally { hook.mock.restore(); append.mock.restore(); }
  });

  for (const shape of ['missing', 'legacy', 'replacement', 'matching']) {
    for (const reload of [false, true]) it(`classifies lost binding before ${shape} result (reload=${reload})`, async (t) => {
      const fx = await fixture(t, `r8-prewrite-${shape}-${reload}`);
      const selected = selection(fx.strategy);
      if (shape === 'missing') fx.store.setStateJson(fx.strategy.ledgerId, []);
      if (shape === 'legacy') {
        fx.store.setStateJson(fx.strategy.ledgerId, []);
        fx.store.setStateJson(fx.strategy.legacyId, [fx.event.record]);
      }
      if (shape === 'replacement') fx.store.setStateJson(fx.strategy.ledgerId, [{ ...fx.event, eventId: 'replacement' }]);
      const get = fx.store.getStateJson.bind(fx.store);
      if (!reload) fx.store.createBranch('r8-other');
      let moved = false;
      let initialization: Promise<void> | undefined;
      const hook = mock.method(fx.store, 'getStateJson', (id: string) => {
        const result = get(id);
        if (id === fx.strategy.ledgerId && !moved) {
          moved = true;
          if (reload) initialization = fx.strategy.initialize(fx.ctx);
          else fx.store.switchBranch('r8-other');
        }
        return result;
      });
      const append = mock.method(fx.store, 'appendToStateJsonWithIdentity');
      try {
        assert.deepEqual(await fx.strategy.releaseCompressionRefusalQuarantine(selected), { status: 'branchUnavailable' });
        await initialization;
        assert.equal(moved, true);
        assert.equal(append.mock.callCount(), 0);
      } finally { hook.mock.restore(); append.mock.restore(); }
    });
  }

  for (const operation of ['inspect', 'release']) it(`rejects reinitialization inside the final currentBranch lookup for ${operation}`, async (t) => {
    const fx = await fixture(t, `r8-final-lookup-${operation}`);
    const selected = selection(fx.strategy);
    const impl = fx.strategy as any;
    const read = impl.readCompressionQuarantineProjection.bind(impl);
    const current = fx.store.currentBranch.bind(fx.store);
    let armed = false;
    let cleared = false;
    let lookups = 0;
    let initialization: Promise<void> | undefined;
    const projection = mock.method(impl, 'readCompressionQuarantineProjection', (...args: any[]) => {
      const result = read(...args);
      // Inspection has one projection; release's final projection follows sync.
      if (operation === 'inspect' || cleared) armed = true;
      return result;
    });
    const sync = mock.method(fx.store, 'sync', () => { cleared = true; });
    const branch = mock.method(fx.store, 'currentBranch', () => {
      const result = current();
      // The sole observation reads the generation after this reentrant lookup.
      if (armed && ++lookups === 1) {
        armed = false;
        initialization = fx.strategy.initialize(fx.ctx);
      }
      return result;
    });
    try {
      if (operation === 'inspect') assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'branchUnavailable' });
      else await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(selected), /binding changed/);
      assert.ok(initialization, 'the reentrant lookup actually ran');
      await initialization;
    } finally { branch.mock.restore(); sync.mock.restore(); projection.mock.restore(); }
  });

  it('keeps a competing release outside a still-running lock callback', async (t) => {
    const fx = await fixture(t, 'r8-lock-reentry');
    const selected = selection(fx.strategy);
    const impl = fx.strategy as any;
    const read = impl.readCompressionQuarantineProjection.bind(impl);
    let competing: ReturnType<Probe['releaseCompressionRefusalQuarantine']> | undefined;
    let entered = 0;
    let readsBeforeUnlock: Promise<number> | undefined;
    const hook = mock.method(impl, 'readCompressionQuarantineProjection', (...args: any[]) => {
      entered++;
      if (entered === 1) {
        competing = fx.strategy.releaseCompressionRefusalQuarantine(selected);
        // Let an incorrectly unqueued competitor's microtask run, while the
        // first callback's await-work continuation has not released its gate.
        readsBeforeUnlock = Promise.resolve().then(() => entered);
      }
      return read(...args);
    });
    try {
      assert.equal((await fx.strategy.releaseCompressionRefusalQuarantine(selected)).status, 'released');
      assert.ok(competing);
      assert.equal(await readsBeforeUnlock, 2, 'only the first release initial/final reads run before unlock');
      assert.equal((await competing).status, 'not-held');
    } finally { hook.mock.restore(); }
  });
});


describe('round 9 append authorization', () => {
  for (const operation of ['clear', 'checkpoint']) it(`rejects ${operation} when its append lookup starts a new initializer`, async (t) => {
    const fx = await fixture(t, `r9-append-${operation}`);
    const selected = selection(fx.strategy);
    const source = native(fx.strategy).captureCompressionBranch();
    const a = fx.store.currentBranch().name;
    fx.store.createBranch('r9-b');
    fx.store.switchBranch('r9-b');
    fx.store.setStateJson(fx.strategy.ledgerId, []);
    fx.store.switchBranch(a);
    if (operation === 'checkpoint') pad(fx);
    const impl = fx.strategy as any;
    const appendEvent = impl.appendCompressionQuarantineEvent.bind(impl);
    const current = fx.store.currentBranch.bind(fx.store);
    let armed = false;
    let initialization: Promise<void> | undefined;
    const boundary = mock.method(impl, 'appendCompressionQuarantineEvent', (...args: any[]) => {
      // The caller has already checked its binding; move only in the
      // append helper's own branch lookup, not the earlier projection read.
      armed = true;
      return appendEvent(...args);
    });
    const branch = mock.method(fx.store, 'currentBranch', () => {
      if (armed) {
        armed = false;
        fx.store.switchBranch('r9-b');
        initialization = fx.strategy.initialize(fx.ctx);
      }
      return current();
    });
    const append = mock.method(fx.store, 'appendToStateJsonWithIdentity');
    try {
      if (operation === 'clear') await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(selected), /binding changed|stale branch/);
      else assert.throws(() => native(fx.strategy).checkpointCompressionQuarantineIfNeeded(source), /binding changed|stale branch/);
      assert.ok(initialization, 'reentered initialization during the append guard');
      await initialization;
      assert.equal(append.mock.callCount(), 0, 'no old event may reach the new branch');
      assert.deepEqual(fx.ledger(), []);
    } finally { branch.mock.restore(); boundary.mock.restore(); append.mock.restore(); }
  });
});


describe('round 9 progress authorization', () => {
  for (const operation of ['public-clear', 'success-clear', 'sweep', 'record', 'exhaust']) {
    it(`keeps B untouched when an A ${operation} read initializes B`, async (t) => {
      const fx = await fixture(t, `r9-progress-${operation}`);
      const impl = fx.strategy as any;
      const source = impl.captureCompressionBranch();
      const progress = [{ familyKey: fx.event.record.familyKey, chunkSourceHash: fx.event.record.chunkSourceHash,
        outcomes: fx.event.outcomes, sourceIds: fx.event.record.sourceIds, updated: 0 }];
      fx.store.setStateJson(fx.strategy.progressId, progress);
      const a = fx.store.currentBranch().name;
      fx.store.createBranch('r9-progress-b');
      fx.store.switchBranch('r9-progress-b');
      const bProgress = [{ ...progress[0], familyKey: hash('b-progress') }];
      fx.store.setStateJson(fx.strategy.progressId, bProgress);
      const bLedger = fx.ledger(); // A fork retaining the exact hold generation.
      fx.store.switchBranch(a);
      if (operation === 'sweep') fx.store.setStateJson(impl.chunksStateId, [{ sourceIds: fx.event.record.sourceIds, compressed: true }]);
      const get = fx.store.getStateJson.bind(fx.store);
      let initialization: Promise<void> | undefined;
      let moved = false;
      // Exhaustion reenters through its projection; the other operations
      // reenter through their progress read after capturing A authorization.
      const trigger = operation === 'exhaust' ? fx.strategy.ledgerId : fx.strategy.progressId;
      if (operation === 'exhaust') fx.store.setStateJson(fx.strategy.ledgerId, []);
      const hook = mock.method(fx.store, 'getStateJson', (id: string) => {
        const result = get(id);
        if (id === trigger && !moved) {
          moved = true;
          fx.store.switchBranch('r9-progress-b');
          initialization = fx.strategy.initialize(fx.ctx);
        }
        return result;
      });
      const set = mock.method(fx.store, 'setStateJson');
      const append = mock.method(fx.store, 'appendToStateJsonWithIdentity');
      try {
        if (operation === 'public-clear') await assert.rejects(fx.strategy.clearCompressionRefusalQuarantine(), /stale branch/);
        if (operation === 'success-clear') await impl.clearQuarantineForCompressedChunk(fx.chunk);
        if (operation === 'sweep') impl.sweepPaidOffCompressionProgress(fx.ctx);
        if (operation === 'record') impl.recordCompressionFamilyProgress(source, fx.event.record, fx.event.outcomes, undefined, undefined, []);
        if (operation === 'exhaust') await assert.rejects(impl.exhaustCompressionRequestFamily(source, fx.event.record, [], () => true, () => true), /stale branch/);
        assert.ok(moved);
        await initialization;
        assert.equal(set.mock.calls.filter((call) => call.arguments[0] === fx.strategy.progressId).length, 0);
        assert.equal(append.mock.callCount(), 0);
        assert.deepEqual(get(fx.strategy.progressId), bProgress);
        assert.deepEqual(fx.ledger(), bLedger);
      } finally { hook.mock.restore(); set.mock.restore(); append.mock.restore(); }
    });
  }

  it('observes a same-name manager switch during its sole branch lookup', async (t) => {
    const fx = await fixture(t, 'r9-same-name-generation');
    const impl = fx.strategy as any;
    const source = impl.captureCompressionBranch();
    const identity = impl.loadedBranchIdentity;
    const current = fx.store.currentBranch.bind(fx.store);
    let lookups = 0;
    const hook = mock.method(fx.store, 'currentBranch', () => {
      const result = current();
      if (++lookups === 1) markStoreBranchSwitch(fx.store);
      return result;
    });
    try {
      assert.equal(impl.isCompressionBranchCurrent(source), false);
      const freshIdentity = { ...identity, generation: impl.captureCompressionBranch().generation };
      lookups = 0;
      assert.equal(impl.isBranchIdentityCurrent(freshIdentity), false);
    } finally { hook.mock.restore(); }
  });

  it('refuses sync to either store when a landed progress write rebinds the strategy', async (t) => {
    const fx = await fixture(t, 'r9-progress-sync');
    const other = await fixture(t, 'r9-progress-sync-other');
    const impl = fx.strategy as any;
    const source = impl.captureCompressionBranch();
    const set = fx.store.setStateJson.bind(fx.store);
    const syncA = mock.method(fx.store, 'sync');
    const syncB = mock.method(other.store, 'sync');
    let initialization: Promise<void> | undefined;
    const hook = mock.method(fx.store, 'setStateJson', (...args: Parameters<typeof set>) => {
      set(...args);
      if (args[0] === fx.strategy.progressId) initialization = fx.strategy.initialize(other.ctx);
    });
    try {
      assert.throws(() => impl.writeCompressionFamilyProgress(new Map(), source), /stale|reinitializ/);
      assert.ok(initialization, 'the progress writer must rebind the strategy');
      assert.equal(syncA.mock.callCount(), 0, 'stale work must not dispatch sync even to its original store');
      assert.equal(syncB.mock.callCount(), 0, 'the replacement store must not receive old work');
      await initialization;
    } finally { hook.mock.restore(); syncA.mock.restore(); syncB.mock.restore(); }
  });
});

describe('round 10 operation source capture', () => {
  for (const operation of ['capture', 'public-clear', 'progress-sweep', 'success-clear', 'quarantine-sweep', 'mutation-guard']) {
    it(`does not authorize B when A ${operation} looks up its branch`, async (t) => {
      const fx = await fixture(t, `r10-capture-${operation}`);
      const impl = fx.strategy as any;
      const progress = [{ familyKey: fx.event.record.familyKey, chunkSourceHash: fx.event.record.chunkSourceHash,
        outcomes: fx.event.outcomes, sourceIds: fx.event.record.sourceIds, updated: 0 }];
      fx.store.setStateJson(fx.strategy.progressId, progress);
      fx.store.setStateJson(impl.chunksStateId, [{ sourceIds: fx.event.record.sourceIds, compressed: true }]);
      fx.store.createBranch('r10-b');
      const current = fx.store.currentBranch.bind(fx.store);
      let initialization: Promise<void> | undefined;
      let armed = true;
      let lookups = 0;
      const hook = mock.method(fx.store, 'currentBranch', () => {
        if (armed && ++lookups === (operation === 'public-clear' ? 2 : 1)) {
          armed = false;
          fx.store.switchBranch('r10-b');
          initialization = fx.strategy.initialize(fx.ctx);
        }
        return current();
      });
      try {
        if (operation === 'capture') {
          const source = impl.captureCompressionBranch();
          assert.equal(impl.isCompressionBranchCurrent(source), false);
        }
        if (operation === 'public-clear') await assert.rejects(fx.strategy.clearCompressionRefusalQuarantine(), /clear uncertain: branch\/load changed; earlier writes may have completed/);
        if (operation === 'progress-sweep') impl.sweepPaidOffCompressionProgress(fx.ctx);
        if (operation === 'quarantine-sweep') await impl.sweepPaidOffQuarantineRecords();
        if (operation === 'mutation-guard') assert.throws(() => impl.requireBranchMutation('test'), /stale branch/);
        if (operation === 'success-clear') await impl.clearQuarantineForCompressedChunk(fx.chunk);
        assert.ok(initialization);
        await initialization;
        assert.deepEqual(fx.store.getStateJson(fx.strategy.progressId), progress);
        assert.equal(fx.ledger().filter((event) => event.kind === 'clear').length, 0);
      } finally { hook.mock.restore(); }
    });
  }

  for (const operation of ['progress-sweep', 'success-clear']) {
    it(`contains branch lookup failure in ${operation} maintenance`, async (t) => {
      const fx = await fixture(t, `r10-throw-${operation}`);
      const impl = fx.strategy as any;
      const warn = mock.method(impl.diag, 'warn');
      const hook = mock.method(fx.store, 'currentBranch', () => { throw new Error('lookup failed'); });
      try {
        if (operation === 'progress-sweep') assert.doesNotThrow(() => impl.sweepPaidOffCompressionProgress(fx.ctx));
        else await assert.doesNotReject(impl.clearQuarantineForCompressedChunk(fx.chunk));
        assert.equal(warn.mock.callCount(), 1);
      } finally { hook.mock.restore(); warn.mock.restore(); }
    });
  }

  it('preserves the released alarm diagnostic history', () => {
    const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
    const entry = changelog.split('\n').find((line) => line.startsWith('- The compression-quarantine alarm no longer announces'))!;
    assert.ok(entry.includes("the alarm logs the read's error at most once an interval"));
    assert.ok(!entry.includes('payload-free'));
  });
});

  it('accepts callable keyed strategies', () => {
    const callable = Object.assign(() => {}, {
      inspectCompressionRefusalQuarantine() {}, releaseCompressionRefusalQuarantine() {},
    });
    assert.equal(isKeyedCompressionQuarantineStrategy(callable), true);
  });

  it('does not read a legacy snapshot beside a non-list ledger', async (t) => {
    const fx = await fixture(t, 'r10-non-list-ledger');
    fx.store.setStateJson(fx.strategy.ledgerId, { damaged: true });
    const get = fx.store.getStateJson.bind(fx.store);
    const hook = mock.method(fx.store, 'getStateJson', (id: string) => {
      if (id === fx.strategy.legacyId) throw new Error('must not read legacy snapshot');
      return get(id);
    });
    try {
      assert.equal((fx.strategy as any).readCompressionQuarantineProjection().size, 0);
      assert.deepEqual(fx.strategy.inspectCompressionRefusalQuarantine(), { status: 'unreadable', reason: 'ledger-entry' });
    } finally { hook.mock.restore(); }
  });

describe('round 10 nested maintenance sources', () => {
  for (const operation of ['progress-sweep', 'quarantine-sweep', 'success-clear']) {
    it(`retains the caller's source in ${operation}`, async (t) => {
      const fx = await fixture(t, `r10-nested-${operation}`);
      const impl = fx.strategy as any;
      const source = impl.requireLoadedBranch('test');
      const progress = [{ familyKey: fx.event.record.familyKey, chunkSourceHash: fx.event.record.chunkSourceHash,
        outcomes: fx.event.outcomes, sourceIds: fx.event.record.sourceIds, updated: 0 }];
      fx.store.setStateJson(fx.strategy.progressId, progress);
      fx.store.setStateJson(impl.chunksStateId, [{ sourceIds: fx.event.record.sourceIds, compressed: true }]);
      fx.store.createBranch('r10-nested-b');
      fx.store.switchBranch('r10-nested-b');
      await fx.strategy.initialize(fx.ctx);
      const ledger = fx.ledger();
      if (operation === 'progress-sweep') impl.sweepPaidOffCompressionProgress(fx.ctx, source);
      if (operation === 'quarantine-sweep') await impl.sweepPaidOffQuarantineRecords(source);
      if (operation === 'success-clear') await impl.clearQuarantineForCompressedChunk(fx.chunk, source);
      assert.deepEqual(fx.store.getStateJson(fx.strategy.progressId), progress);
      assert.deepEqual(fx.ledger(), ledger);
    });
  }
});

it('a missing progress writer refuses release without clearing its hold or progress', async (t) => {
  const fx = await fixture(t, 'missing-progress-writer');
  const selected = selection(fx.strategy);
  fx.store.setStateJson(fx.strategy.progressId, [{ familyKey: fx.event.record.familyKey,
    chunkSourceHash: fx.event.record.chunkSourceHash, outcomes: [], updated: Date.now() }]);
  const progress = fx.store.getStateJson(fx.strategy.progressId);
  const ledger = fx.ledger();
  const writer = fx.store.setStateJson;
  try {
    Object.defineProperty(fx.store, 'setStateJson', { configurable: true, writable: true, value: undefined });
    await assert.rejects(fx.strategy.releaseCompressionRefusalQuarantine(selected), /writer.*setStateJson/i);
    assert.deepEqual(fx.store.getStateJson(fx.strategy.progressId), progress);
    assert.deepEqual(fx.ledger(), ledger);
  } finally { fx.store.setStateJson = writer; }
});

it('checkpoint hygiene failure reports uncertainty after a landed append without exposing payloads', async (t) => {
  const fx = await fixture(t, 'hygiene-partial-write');
  fx.append(...Array.from({ length: 260 }, () => ({ kind: 'clear', key: 'unused', targetClaimId: 'unused', created: 1 })));
  const lines: string[] = [];
  const native = fx.strategy as any;
  native.diag = { warn(line: string) { lines.push(line); } };
  const redact = fx.store.redactStateItems;
  try {
    fx.store.redactStateItems = () => { throw new Error('DO-NOT-EXPOSE-STORED-PAYLOAD'); };
    assert.throws(() => native.checkpointCompressionQuarantineIfNeeded(native.loadedBranchIdentity), /DO-NOT-EXPOSE/);
    assert.equal(fx.ledger().at(-1)!.kind, 'checkpoint', 'append landed before redaction failed');
    assert.match(lines.join('\n'), /earlier writes may have landed.*inspect.*status.*unclassified/);
    assert.doesNotMatch(lines.join('\n'), /DO-NOT-EXPOSE|discarded/);
  } finally { fx.store.redactStateItems = redact; }
});

it('a missing-chunk sweep names its heuristic rather than claiming orphaned debt', async (t) => {
  const fx = await fixture(t, 'sweep-heuristic-diagnostic');
  const lines: string[] = [];
  const native = fx.strategy as any;
  native.diag = { error(line: string) { lines.push(line); }, warn() {} };
  fx.store.setStateJson(native.chunksStateId, [{ sourceIds: ['different-live-chunk'], compressed: false }]);
  await native.sweepPaidOffQuarantineRecords();
  assert.equal(inspect(fx.strategy).totalRecords, 0);
  assert.match(lines.join('\n'), /no matching chunk record.*heuristic.*live.*not ruled out/);
  assert.doesNotMatch(lines.join('\n'), /orphaned by/);
});

it('a success-clear diagnostic covers adoption without asserting a new provider request', async (t) => {
  const fx = await fixture(t, 'adoption-diagnostic');
  const lines: string[] = [];
  const native = fx.strategy as any;
  native.diag = { error(line: string) { lines.push(line); }, warn() {} };
  const calls = fx.calls.length;
  await native.clearQuarantineForCompressedChunk(fx.chunk);
  assert.equal(inspect(fx.strategy).totalRecords, 0);
  assert.equal(fx.calls.length, calls);
  assert.match(lines.join('\n'), /covered.*existing exact L1/);
  assert.doesNotMatch(lines.join('\n'), /newer request shape/);
});

it('a progress sweep acknowledges a landed write when sync fails', async (t) => {
  const fx = await fixture(t, 'progress-sync-diagnostic');
  const native = fx.strategy as any;
  const lines: string[] = [];
  native.diag = { warn(line: string) { lines.push(line); } };
  fx.store.setStateJson(fx.strategy.progressId, [{ familyKey: fx.event.record.familyKey,
    chunkSourceHash: fx.event.record.chunkSourceHash, outcomes: [], updated: 0 }]);
  fx.store.setStateJson(native.chunksStateId, []);
  const sync = fx.store.sync;
  try {
    fx.store.sync = () => { throw new Error('sync failed'); };
    native.sweepPaidOffCompressionProgress(fx.ctx);
    assert.deepEqual(fx.store.getStateJson(fx.strategy.progressId), []);
    assert.match(lines.join('\n'), /write may have landed.*inspect.*progress/);
    assert.doesNotMatch(lines.join('\n'), /progress remains/);
  } finally { fx.store.sync = sync; }
});
