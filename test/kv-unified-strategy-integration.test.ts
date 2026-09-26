import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy, OverBudgetError } from '../src/index.js';
import type { ContextEntry } from '../src/types/index.js';
import type { KvUnifiedReceiptChain } from '../src/adaptive/kv-unified-receipts.js';

const STORE = './test-kv-unified-integration-store';

afterEach(() => {
  if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });
});

function strategy(overrides: Record<string, unknown> = {}): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-unified',
    headWindowTokens: 0,
    recentWindowTokens: 100,
    kvUnified: {
      policy: {
        alpha: 0.7,
        budgetLowRatio: 0.5,
        budgetHighRatio: 0.9,
        budgetUnderLambda: 10,
        budgetOverLambda: 10,
        cacheLambda: 1,
        cacheScale: 1000,
        cacheReadPrice: 0.1,
        cacheWritePrice: 1.25,
        continuityLambda: 1,
        continuityScale: 1000,
        continuityRecencyHalfLifeTokens: 1000,
        continuityRecencyFloor: 0.2,
        continuityStableHalfLife: 10,
        continuityStableFloor: 0.25,
      },
      tokenBucketSize: 100,
      continuityBucketSize: 100,
      fidelityBucketSize: 100,
      labelCeiling: 10_000,
      adoptEpsilon: 0,
      treeifyNonContiguousSummaries: false,
      preserveGapBearingSummaries: false,
    },
    ...overrides,
  });
}

function receipts(strategy: AutobiographicalStrategy): KvUnifiedReceiptChain {
  return (strategy as unknown as { kvUnifiedReceipts: KvUnifiedReceiptChain }).kvUnifiedReceipts;
}

test('kv-unified presentation commits only after acceptance and survives restart', async () => {
  const first = strategy();
  const manager = await ContextManager.open({ path: STORE, strategy: first });
  manager.addMessage('user', [{ type: 'text', text: 'hello continuity' }]);
  await manager.compile(
    { maxTokens: 10_000, reserveForResponse: 0 },
    undefined,
    { kvUnifiedImmutablePrefixHash: 'immutable-v1' },
  );
  assert.equal(receipts(first).head, null, 'compile creates a draft only');
  first.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
  assert.equal(receipts(first).head, null, 'submission is not acceptance');
  const markerCount = (
    first as unknown as { kvUnifiedPendingMarkerUnitIndices: number[] }
  ).kvUnifiedPendingMarkerUnitIndices.length;
  first.reportKvUnifiedAccepted({
    submissionId: 's1',
    acceptedAt: 123,
    wireReceipt: {
      requestHash: 'wire1',
      markers: Array.from({ length: markerCount }, (_, ordinal) => ({
        ordinal,
        prefixHash: `prefix-${ordinal}`,
        estimatedOffset: ordinal + 1,
      })),
    },
  });
  assert.equal(receipts(first).head?.sequence, 1);
  assert.equal(receipts(first).cache?.immutablePrefixHash, 'immutable-v1');
  manager.close();

  const second = strategy();
  const reopened = await ContextManager.open({ path: STORE, strategy: second });
  assert.equal(receipts(second).head?.sequence, 1);
  assert.ok(receipts(second).leaves.size > 0);
  reopened.close();
});

test('kv-unified failed submission clears single flight without committing', async () => {
  const selected = strategy();
  const manager = await ContextManager.open({ path: STORE, strategy: selected });
  manager.addMessage('user', [{ type: 'text', text: 'not accepted' }]);
  await manager.compile(
    { maxTokens: 10_000, reserveForResponse: 0 },
    undefined,
    { kvUnifiedImmutablePrefixHash: 'immutable-v1' },
  );
  selected.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
  selected.reportKvUnifiedFailed('s1');
  assert.equal(receipts(selected).head, null);
  assert.equal(receipts(selected).inFlightSubmissionId, null);
  manager.close();
});

test('kv-unified places token-weighted 33/66/100 history markers plus tail', () => {
  const selected = strategy();
  const entries = Array.from({ length: 12 }, (_, index) => ({
    index,
    sourceMessageId: `m${index}`,
    sourceRelation: 'copy' as const,
    participant: 'user',
    content: [{ type: 'text' as const, text: 'x'.repeat(index === 2 ? 400 : 40) }],
  }));
  (
    selected as unknown as {
      placeCacheMarkers: (
        entries: ContextEntry[],
        head: ReadonlySet<string>,
        tail: ReadonlySet<string>,
      ) => void;
    }
  ).placeCacheMarkers(entries as ContextEntry[], new Set(['m0']), new Set(['m9', 'm10', 'm11']));
  assert.deepEqual(
    entries.flatMap((entry, index) =>
      (entry as { cacheMarker?: boolean }).cacheMarker ? [index] : []),
    [1, 2, 8, 11],
  );
});

test('kv-unified reconciles folded, composite, and tail markers to atomic layout units', () => {
  const selected = strategy() as unknown as {
    reconcileKvUnifiedMarkerIndices: (
      entries: ContextEntry[],
      layout: { units: Array<{ kind: 'head' | 'raw' | 'recall' | 'tail'; key: string; tokens: number; offset: number }>; totalTokens: number },
      head: ReadonlySet<string>,
      tail: ReadonlySet<string>,
    ) => number[];
  };
  const entries: ContextEntry[] = [
    {
      index: 0,
      participant: 'user',
      content: [{ type: 'text', text: 'head' }],
      sourceMessageId: 'h',
      sourceRelation: 'copy',
      cacheMarker: true,
    },
    {
      index: 1,
      participant: 'user',
      content: [{ type: 'text', text: 'composite' }],
      sourceMessageIds: ['a', 'b'],
      cacheLayoutKey: 'b',
      sourceRelation: 'copy',
      cacheMarker: true,
    },
    {
      index: 2,
      participant: 'Context Manager',
      content: [{ type: 'text', text: 'recall' }],
      sourceRelation: 'derived',
    },
    {
      index: 3,
      participant: 'resident',
      content: [{ type: 'text', text: 'summary' }],
      cacheLayoutKey: 'L2-7',
      sourceRelation: 'derived',
      cacheMarker: true,
    },
    {
      index: 4,
      participant: 'user',
      content: [{ type: 'text', text: 'tail' }],
      sourceMessageId: 't',
      sourceRelation: 'copy',
      cacheMarker: true,
    },
  ];
  const layout = {
    units: [
      { kind: 'head' as const, key: 'head', tokens: 10, offset: 0 },
      { kind: 'raw' as const, key: 'a', tokens: 10, offset: 10 },
      { kind: 'raw' as const, key: 'b', tokens: 10, offset: 20 },
      { kind: 'recall' as const, key: 'L2-7', tokens: 10, offset: 30 },
      { kind: 'tail' as const, key: 'tail', tokens: 10, offset: 40 },
    ],
    totalTokens: 50,
  };
  assert.deepEqual(
    selected.reconcileKvUnifiedMarkerIndices(entries, layout, new Set(['h']), new Set(['t'])),
    [1, 3, 4, 5],
  );
});

test('kv-unified fails closed when the treeification policy is omitted', async () => {
  const configured = strategy() as unknown as {
    config: { kvUnified?: { treeifyNonContiguousSummaries?: boolean } };
  };
  delete configured.config.kvUnified!.treeifyNonContiguousSummaries;
  const manager = await ContextManager.open({ path: STORE, strategy: configured as unknown as AutobiographicalStrategy });
  manager.addMessage('user', [{ type: 'text', text: 'fail closed' }]);
  await assert.rejects(
    manager.compile({ maxTokens: 10_000, reserveForResponse: 0 }),
    /requires an explicit treeifyNonContiguousSummaries boolean/,
  );
  manager.close();
});

test('kv-unified fails closed when the gap-bearing policy is omitted', async () => {
  const configured = strategy() as unknown as {
    config: {
      kvUnified?: {
        treeifyNonContiguousSummaries?: boolean;
        preserveGapBearingSummaries?: boolean;
      };
    };
  };
  delete configured.config.kvUnified!.preserveGapBearingSummaries;
  const manager = await ContextManager.open({
    path: STORE,
    strategy: configured as unknown as AutobiographicalStrategy,
  });
  manager.addMessage('user', [{ type: 'text', text: 'fail closed' }]);
  await assert.rejects(
    manager.compile({ maxTokens: 10_000, reserveForResponse: 0 }),
    /requires an explicit preserveGapBearingSummaries boolean/,
  );
  manager.close();
});

test('kv-unified continuity relaxation is audited, expiring, and fail-closed', () => {
  const selected = strategy() as unknown as {
    kvUnifiedContinuityMultiplier: (value?: {
      reason: 'surgery' | 'budget-transition' | 'infrastructure';
      multiplier: number;
      expiresAt: number;
    }) => number;
  };
  assert.equal(selected.kvUnifiedContinuityMultiplier(), 1);
  assert.equal(selected.kvUnifiedContinuityMultiplier({
    reason: 'surgery',
    multiplier: 0.25,
    expiresAt: Date.now() + 60_000,
  }), 0.25);
  assert.equal(selected.kvUnifiedContinuityMultiplier({
    reason: 'budget-transition',
    multiplier: 0,
    expiresAt: Date.now() - 1,
  }), 1);
  assert.equal(selected.kvUnifiedContinuityMultiplier({
    reason: 'infrastructure',
    multiplier: Number.NaN,
    expiresAt: Date.now() + 60_000,
  }), 1);
});

test('a non-kv-unified folding strategy supersedes a persisted kv-unified receipt when it presents, not when it loads (#97)', async () => {
  const first = strategy();
  const manager = await ContextManager.open({ path: STORE, strategy: first });
  manager.addMessage('user', [{ type: 'text', text: 'presented by kv-unified' }]);
  await manager.compile(
    { maxTokens: 10_000, reserveForResponse: 0 },
    undefined,
    { kvUnifiedImmutablePrefixHash: 'immutable-v1' },
  );
  first.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
  const markerCount = (
    first as unknown as { kvUnifiedPendingMarkerUnitIndices: number[] }
  ).kvUnifiedPendingMarkerUnitIndices.length;
  first.reportKvUnifiedAccepted({
    submissionId: 's1',
    acceptedAt: 123,
    wireReceipt: {
      requestHash: 'wire1',
      markers: Array.from({ length: markerCount }, (_, ordinal) => ({
        ordinal,
        prefixHash: `prefix-${ordinal}`,
        estimatedOffset: ordinal + 1,
      })),
    },
  });
  assert.equal(receipts(first).head?.sequence, 1);
  manager.close();

  const stableStrategy = () => new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    headWindowTokens: 0,
    recentWindowTokens: 100,
  });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.includes('superseded a persisted kv-unified presentation receipt')) warnings.push(line);
    else originalWarn(...args);
  };
  try {
    // Opening is not presenting, and neither is a `dryRun` compile: the
    // receipt must survive both untouched. (A preview that goes through a
    // NON-dry-run compile is a presentation as far as the strategy can tell.)
    const inspector = await ContextManager.open({ path: STORE, strategy: stableStrategy() });
    await inspector.compile({ maxTokens: 10_000, reserveForResponse: 0 }, undefined, { dryRun: true });
    inspector.close();
    assert.equal(warnings.length, 0, 'a load or a dry-run compile must not supersede');
    const inspected = strategy();
    const stillThere = await ContextManager.open({ path: STORE, strategy: inspected });
    assert.equal(receipts(inspected).head?.sequence, 1, 'receipt intact after a kv-stable load and dry run');
    stillThere.close();

    // Presenting is: the first kv-stable compile supersedes it, exactly once.
    const viaStable = await ContextManager.open({ path: STORE, strategy: stableStrategy() });
    viaStable.addMessage('user', [{ type: 'text', text: 'presented by kv-stable' }]);
    await viaStable.compile({ maxTokens: 10_000, reserveForResponse: 0 });
    assert.equal(warnings.length, 1, 'first presentation supersedes');
    viaStable.addMessage('user', [{ type: 'text', text: 'presented again by kv-stable' }]);
    await viaStable.compile({ maxTokens: 10_000, reserveForResponse: 0 });
    assert.equal(warnings.length, 1, 'later presentations do not warn again');
    viaStable.close();

    const back = strategy();
    const reopened = await ContextManager.open({ path: STORE, strategy: back });
    assert.equal(receipts(back).head, null, 'switching back starts from an empty receipt chain');
    assert.equal(receipts(back).leaves.size, 0);
    reopened.close();
  } finally {
    console.warn = originalWarn;
  }
});

test('a failed compile by a non-kv-unified strategy keeps the persisted kv-unified receipt (#98 review)', async () => {
  const first = strategy();
  const manager = await ContextManager.open({ path: STORE, strategy: first });
  manager.addMessage('user', [{ type: 'text', text: 'presented by kv-unified' }]);
  await manager.compile(
    { maxTokens: 10_000, reserveForResponse: 0 },
    undefined,
    { kvUnifiedImmutablePrefixHash: 'immutable-v1' },
  );
  first.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
  const markerCount = (
    first as unknown as { kvUnifiedPendingMarkerUnitIndices: number[] }
  ).kvUnifiedPendingMarkerUnitIndices.length;
  first.reportKvUnifiedAccepted({
    submissionId: 's1',
    acceptedAt: 123,
    wireReceipt: {
      requestHash: 'wire1',
      markers: Array.from({ length: markerCount }, (_, ordinal) => ({
        ordinal,
        prefixHash: `prefix-${ordinal}`,
        estimatedOffset: ordinal + 1,
      })),
    },
  });
  assert.equal(receipts(first).head?.sequence, 1);
  manager.close();

  const stable = new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    headWindowTokens: 0,
    recentWindowTokens: 100,
  });
  const viaStable = await ContextManager.open({ path: STORE, strategy: stable });
  for (let i = 0; i < 4; i++) {
    viaStable.addMessage('user', [{ type: 'text', text: `unsummarized filler ${i} ${'x'.repeat(1200)}` }]);
  }
  await assert.rejects(
    viaStable.compile({ maxTokens: 300, reserveForResponse: 0 }),
    (error: unknown) => error instanceof OverBudgetError,
    'an over-budget compile must fail, not present',
  );
  viaStable.close();

  const back = strategy();
  const reopened = await ContextManager.open({ path: STORE, strategy: back });
  assert.equal(receipts(back).head?.sequence, 1, 'no presentation replaced the receipt, so it survives');
  reopened.close();
});

test('a failed supersede write is retried by the next presentation (#98 review)', async () => {
  const first = strategy();
  const manager = await ContextManager.open({ path: STORE, strategy: first });
  manager.addMessage('user', [{ type: 'text', text: 'presented by kv-unified' }]);
  await manager.compile(
    { maxTokens: 10_000, reserveForResponse: 0 },
    undefined,
    { kvUnifiedImmutablePrefixHash: 'immutable-v1' },
  );
  first.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
  const markerCount = (
    first as unknown as { kvUnifiedPendingMarkerUnitIndices: number[] }
  ).kvUnifiedPendingMarkerUnitIndices.length;
  first.reportKvUnifiedAccepted({
    submissionId: 's1',
    acceptedAt: 123,
    wireReceipt: {
      requestHash: 'wire1',
      markers: Array.from({ length: markerCount }, (_, ordinal) => ({
        ordinal,
        prefixHash: `prefix-${ordinal}`,
        estimatedOffset: ordinal + 1,
      })),
    },
  });
  assert.equal(receipts(first).head?.sequence, 1);
  manager.close();

  const stable = new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    headWindowTokens: 0,
    recentWindowTokens: 100,
  });
  const viaStable = await ContextManager.open({ path: STORE, strategy: stable });
  const store = (stable as unknown as { store: { setStateJson(id: string, value: unknown): void } }).store;
  const originalSet = store.setStateJson.bind(store);
  let failures = 0;
  store.setStateJson = (id: string, value: unknown) => {
    if (id.endsWith('/kvunified:presentation-receipt') && failures === 0) {
      failures++;
      throw new Error('injected receipt write failure');
    }
    originalSet(id, value);
  };
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (!args.map(String).join(' ').includes('superseded a persisted kv-unified presentation receipt')) {
      originalWarn(...args);
    }
  };
  try {
    viaStable.addMessage('user', [{ type: 'text', text: 'presented by kv-stable' }]);
    await assert.rejects(
      viaStable.compile({ maxTokens: 10_000, reserveForResponse: 0 }),
      /injected receipt write failure/,
    );
    // The flag must still be raised: the same instance retries and succeeds.
    await viaStable.compile({ maxTokens: 10_000, reserveForResponse: 0 });
    assert.equal(failures, 1);
  } finally {
    console.warn = originalWarn;
    store.setStateJson = originalSet;
  }
  viaStable.close();

  const back = strategy();
  const reopened = await ContextManager.open({ path: STORE, strategy: back });
  assert.equal(receipts(back).head, null, 'the retried supersede emptied the chain');
  reopened.close();
});

test('kv-unified tail markers resolve through selectAdaptive to per-message tail units, including a sharded tail message', async () => {
  const selected = strategy({ targetChunkTokens: 200, recentWindowTokens: 100_000 });
  const manager = await ContextManager.open({ path: STORE, strategy: selected });
  manager.addMessage('user', [{ type: 'text', text: 'first question' }]);
  manager.addMessage('assistant', [{ type: 'text', text: 'paragraph. '.repeat(1000) }]);
  const all = manager.getAllMessages();
  const shards = all.filter((message) => message.bodyGroupId);
  assert.ok(shards.length > 1, 'the last message is sharded');
  const host = selected as unknown as { mergeAdjacentBodyGroupRaw: (...args: unknown[]) => ContextEntry[] };
  const merge = host.mergeAdjacentBodyGroupRaw.bind(selected);
  let emitted: ContextEntry[] = [];
  host.mergeAdjacentBodyGroupRaw = (...args) => (emitted = merge(...args));
  await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 }, undefined, { kvUnifiedImmutablePrefixHash: 'v1' });
  const draft = (selected as unknown as {
    kvUnifiedDraft: { layout: { units: Array<{ kind: string; key: string }> }; markerUnitIndices: number[] };
  }).kvUnifiedDraft;
  // Every tail message, each shard included, is its own unit; nothing falls
  // back to the opaque 'tail' block.
  assert.deepEqual(draft.layout.units.map((unit) => unit.key), all.map((message) => message.id));
  assert.ok(draft.layout.units.every((unit) => unit.kind !== 'tail'));
  // The shards render as ONE entry, which carries the marker...
  const shardIds = shards.map((message) => message.id);
  const composite = emitted.filter((entry) => entry.sourceMessageIds?.some((id) => shardIds.includes(id)) ||
    (entry.sourceMessageId !== undefined && shardIds.includes(entry.sourceMessageId)));
  assert.equal(composite.length, 1, 'the sharded message is one emitted entry');
  assert.deepEqual(composite[0].sourceMessageIds, shardIds);
  assert.equal(composite[0].cacheMarker, true);
  // ...and that marker lands on the last shard's unit.
  const markedKeys = draft.markerUnitIndices.map((index) => draft.layout.units[index - 1].key);
  assert.ok(markedKeys.includes(shards.at(-1)!.id), `markers on ${markedKeys.join(',')}`);
  manager.close();
});

test('kv-unified latent demand keeps no ranking between compiles', async () => {
  // A cross-compile ranking cache replayed stale demand after appends and
  // policy changes, shared one slot with the production-budget shadow pick, and
  // survived branch switches. The host passes none.
  const selected = strategy();
  const manager = await ContextManager.open({ path: STORE, strategy: selected });
  manager.addMessage('user', [{ type: 'text', text: 'hello' }]);
  await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
  const solver = (selected as unknown as { _lastKvUnified: { options: { latentDemand?: Record<string, unknown> } } })._lastKvUnified;
  assert.ok(solver.options.latentDemand, 'the live adapter ranks latent demand');
  // Stateless knobs may be added; a ranking cache needs somewhere to hold state.
  const latent = solver.options.latentDemand;
  assert.ok(!('cache' in latent), 'latent demand must not carry a ranking cache between compiles');
  for (const [key, value] of Object.entries(latent)) {
    assert.ok(value === null || typeof value !== 'object', `latentDemand.${key} holds state across compiles`);
  }
  manager.close();
});
