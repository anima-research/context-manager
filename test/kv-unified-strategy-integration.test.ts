import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy, KnowledgeStrategy, OverBudgetError, PassthroughStrategy } from '../src/index.js';
import type { ContextEntry, StoredMessage } from '../src/types/index.js';
import type { KvUnifiedReceiptChain } from '../src/adaptive/kv-unified-receipts.js';

const STORE = './test-kv-unified-integration-store';

afterEach(() => {
  if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });
});

const KV_UNIFIED = {
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
};

function strategy(overrides: Record<string, unknown> = {}): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-unified',
    headWindowTokens: 0,
    recentWindowTokens: 100,
    // A copy per strategy: a test below deletes a key from its own block.
    kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } },
    ...overrides,
  });
}

function receipts(strategy: AutobiographicalStrategy): KvUnifiedReceiptChain {
  return (strategy as unknown as { kvUnifiedReceipts: KvUnifiedReceiptChain }).kvUnifiedReceipts;
}

// #239: a superseded submission's line names the namespace it was logged for, after its fields, so
// one process's strategies' lines can be told apart.
test('a submission superseded before it settled is logged with its namespace', async (t) => {
  const logged: string[] = [];
  const original = console.error.bind(console);
  t.mock.method(console, 'error', (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[kv-unified]')) logged.push(line);
    else original(...args);
  });
  const first = strategy();
  const manager = await ContextManager.open({ path: STORE, strategy: first, namespace: 'agents/wren' });
  manager.addMessage('user', [{ type: 'text', text: 'hello continuity' }]);
  await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
  first.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
  await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
  first.beginKvUnifiedSubmission({ submissionId: 's2', requestHash: 'wire2', layoutHash: 'layout1' });
  assert.deepEqual(logged, [
    '[kv-unified] submission s1 was never settled (no usage event before the next provider call); ' +
      'superseded by s2 ns=agents/wren',
  ]);
  manager.close();
});

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

test('a dry compile leaves the last real compile\u2019s kv-unified draft markers alone', async () => {
  const selected = strategy();
  const manager = await ContextManager.open({ path: STORE, strategy: selected });
  for (let i = 0; i < 12; i++) {
    manager.addMessage(i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `turn ${i} ` + 'word '.repeat(30) }]);
  }
  const budget = { maxTokens: 10_000, reserveForResponse: 0 };
  await manager.compile(budget, undefined, { kvUnifiedImmutablePrefixHash: 'immutable-v1' });
  const draft = () => (selected as unknown as { kvUnifiedDraft: { markerUnitIndices: number[] } | null }).kvUnifiedDraft;
  const before = [...draft()!.markerUnitIndices];
  for (let i = 0; i < 6; i++) {
    manager.addMessage('user', [{ type: 'text', text: `later ${i} ` + 'word '.repeat(30) }]);
  }
  const draftBefore = draft();
  const layoutBefore = (draftBefore as unknown as { layout: unknown }).layout;
  await manager.compile(budget, undefined, { dryRun: true, kvUnifiedImmutablePrefixHash: 'immutable-v1' });
  assert.deepEqual(draft()!.markerUnitIndices, before, 'the submission would carry markers from a layout never sent');
  assert.strictEqual(draft(), draftBefore, 'the draft itself is the real compile\u2019s');
  assert.strictEqual((draft() as unknown as { layout: unknown }).layout, layoutBefore, 'and so is its layout');
  // A real compile at the same point moves the markers, or this test proves nothing.
  await manager.compile(budget, undefined, { kvUnifiedImmutablePrefixHash: 'immutable-v1' });
  assert.notDeepEqual(draft()!.markerUnitIndices, before, 'a real compile re-marks the new layout');
  manager.close();
});

test('a dry compile refuses a kv-unified plan that selects a level with no summary, as a real compile does', async () => {
  // A picker that selects L1 for the first chunk, which has no summary.
  class Unavailable extends AutobiographicalStrategy {
    protected buildPicker(...args: Parameters<AutobiographicalStrategy['buildPicker']>) {
      const picker = super.buildPicker(...args);
      const run = picker.run.bind(picker);
      return Object.assign(Object.create(picker), {
        run: (...runArgs: Parameters<typeof picker.run>) => {
          const result = run(...runArgs);
          const first = runArgs[0].chunks[0];
          if (!first) return result;
          const finalResolutions = new Map(result.finalResolutions);
          finalResolutions.set(first.id, 1);
          // The positional view (levelAt, levelsBySequence) describes the
          // original levels; a stub that replaces the map drops it so the
          // strategy reads the map.
          return { ...result, finalResolutions, levelAt: undefined, levelsBySequence: undefined };
        },
      });
    }
  }
  const base = strategy({ targetChunkTokens: 60 }) as unknown as { config: Record<string, unknown> };
  const selected = new Unavailable(base.config as never);
  const manager = await ContextManager.open({ path: STORE, strategy: selected });
  for (let i = 0; i < 12; i++) {
    manager.addMessage(i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `turn ${i} ` + 'word '.repeat(30) }]);
  }
  const budget = { maxTokens: 10_000, reserveForResponse: 0 };
  await assert.rejects(manager.compile(budget, undefined, { dryRun: true }), /kv-unified selected unavailable L1/);
  await assert.rejects(manager.compile(budget), /kv-unified selected unavailable L1/, 'a real compile refuses it too');
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

test('kv-unified measures where its entries first differ from the previous compile’s, as other strategies do, and marks them as before', () => {
  const selected = strategy() as unknown as {
    placeCacheMarkers: (
      entries: ContextEntry[],
      head: ReadonlySet<string>,
      tail: ReadonlySet<string>,
    ) => number | null;
  };
  const entries = (edited?: number) => Array.from({ length: 12 }, (_, index) => ({
    index,
    sourceMessageId: `m${index}`,
    sourceRelation: 'copy' as const,
    participant: 'user',
    content: [{ type: 'text' as const, text: (index === edited ? 'y' : 'x').repeat(index === 2 ? 400 : 40) }],
  })) as ContextEntry[];
  const place = (es: ContextEntry[]) => selected.placeCacheMarkers(es, new Set(['m0']), new Set(['m9', 'm10', 'm11']));
  const marks = (es: ContextEntry[]) => es.flatMap((entry, index) => (entry.cacheMarker ? [index] : []));
  const first = entries();
  assert.equal(place(first), null, 'no earlier compile');
  const second = entries(6); // the same length, other bytes
  assert.equal(place(second), 6);
  assert.deepEqual(marks(second), marks(first));
  assert.deepEqual(marks(first), [1, 2, 8, 11]);
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

test('a usage report inside the calibration dead band keeps the kv-unified forest derived across compiles', async () => {
  // Summaries matter here: an applied multiplier reprices every recall pair,
  // and a changed recall cost is what makes the forest decline to derive.
  const membrane = {
    complete: async () => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'summary ' + 'word '.repeat(20) }],
      usage: { inputTokens: 100, outputTokens: 30 },
    }),
  };
  const selected = strategy({ targetChunkTokens: 60, compressionModel: 'mock' });
  const internals = selected as unknown as {
    summaries: unknown[];
    _lastCompileEstimate: number;
    _calibration: number;
    _lastKvUnified: { lastTimings: { forestDerived: boolean } | null } | null;
  };
  const derived = () => internals._lastKvUnified?.lastTimings?.forestDerived;
  const manager = await ContextManager.open({ path: STORE, strategy: selected, membrane: membrane as never });
  let turn = 0;
  const add = () => {
    manager.addMessage(turn % 2 ? 'assistant' : 'user', [{ type: 'text', text: `turn ${turn} ` + 'word '.repeat(30) }]);
    turn++;
  };
  for (let i = 0; i < 12; i++) add();
  const budget = { maxTokens: 10_000, reserveForResponse: 0 };
  await manager.compile(budget);
  for (let i = 0; i < 6 && internals.summaries.length === 0; i++) await manager.tick();
  assert.ok(internals.summaries.length > 0, 'the fixture needs at least one summary');
  // Let production settle, then take two appends: the second derives.
  for (let i = 0; i < 6; i++) await manager.tick();
  await manager.compile(budget);
  add();
  await manager.compile(budget);
  assert.equal(derived(), true, 'control: an append derives the forest from the previous compile');

  // A host reports the real input total once per compile. A 0.5% miss is the
  // normal case; it must not reprice the store and force a full build.
  selected.reportRealInputTokens(internals._lastCompileEstimate * 1.005);
  assert.equal(internals._calibration, 1);
  add();
  await manager.compile(budget);
  assert.equal(derived(), true, 'a sample inside the dead band keeps cross-compile reuse');

  // A sustained 10% miss leaves the band, is applied, and reprices every
  // recall pair: that compile builds in full, as every compile did before.
  let applied = false;
  for (let i = 0; i < 6 && !applied; i++) {
    selected.reportRealInputTokens(internals._lastCompileEstimate * 1.1);
    applied = internals._calibration !== 1;
    add();
    await manager.compile(budget);
  }
  assert.equal(applied, true);
  assert.equal(derived(), false, 'an applied multiplier change is a full build');
  manager.close();
});

test('one live kv-unified compile stamps its own elapsed time on plan-vs-actual, with the solve inside it', async () => {
  const manager = await ContextManager.open({ path: STORE, strategy: strategy() });
  const added = ['time me', 'timing you', 'and again'];
  for (const [i, text] of added.entries()) manager.addMessage(i % 2 ? 'assistant' : 'user', [{ type: 'text', text }]);
  await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
  const pva = manager.getRenderStats()!.planVsActual!;
  assert.equal(pva.messages, added.length, 'messages= is the number of stored messages the compile read');
  assert.ok(Number.isInteger(pva.compileMs) && pva.compileMs! >= 0, `compileMs=${pva.compileMs}`);
  assert.ok(Number.isInteger(pva.solveMs) && pva.solveMs! >= 0, `solveMs=${pva.solveMs}`);
  assert.ok(pva.solveMs! <= pva.compileMs!, `solveMs=${pva.solveMs} exceeds compileMs=${pva.compileMs}`);
  manager.close();
});

test('the production shadow pick leaves plan-vs-actual on the live kv-unified solve', async () => {
  const selected = strategy({ productionBudgetTokens: 50 });
  const internals = selected as unknown as {
    buildPicker: (...args: unknown[]) => unknown;
    _lastKvUnified: unknown;
  };
  const built: unknown[] = [];
  const buildPicker = internals.buildPicker.bind(selected);
  internals.buildPicker = (...args) => {
    const picker = buildPicker(...args);
    built.push(internals._lastKvUnified);
    return picker;
  };
  const manager = await ContextManager.open({ path: STORE, strategy: selected });
  manager.addMessage('user', [{ type: 'text', text: 'live and shadow' }]);
  await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
  assert.equal(built.length, 2, 'control: the live pick and the shadow pick each built a kv-unified solver');
  assert.notEqual(built[0], built[1]);
  assert.equal(internals._lastKvUnified, built[0], 'the live solver, not the shadow one, backs the stats');
  manager.close();
});

test('the hysteresis certificate is on unless the recipe says false', async () => {
  // A kvUnified block without the key certifies the carried layout on an
  // append; the same block with `hysteresisCertificate: false` runs the full
  // solver, which leaves no certificate on the result.
  const certified = async (kvUnified: Record<string, unknown>) => {
    const selected = strategy({ kvUnified });
    const internals = selected as unknown as {
      _lastKvUnified: { lastResult: { certificate?: unknown } | null; lastTimings: { certificateMs: number } | null } | null;
    };
    const manager = await ContextManager.open({ path: STORE, strategy: selected });
    const budget = { maxTokens: 10_000, reserveForResponse: 0 };
    const prefix = { kvUnifiedImmutablePrefixHash: 'immutable-v1' };
    for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `turn ${i} ` + 'word '.repeat(30) }]);
    await manager.compile(budget, undefined, prefix);
    assert.equal(internals._lastKvUnified?.lastResult?.certificate, undefined, 'a blank-slate solve is never certified');
    // The carried layout is the last ACCEPTED presentation, so accept this one.
    selected.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
    const markerCount = (selected as unknown as { kvUnifiedPendingMarkerUnitIndices: number[] }).kvUnifiedPendingMarkerUnitIndices.length;
    selected.reportKvUnifiedAccepted({
      submissionId: 's1',
      acceptedAt: 1,
      wireReceipt: {
        requestHash: 'wire1',
        markers: Array.from({ length: markerCount }, (_, ordinal) => ({ ordinal, prefixHash: `prefix-${ordinal}`, estimatedOffset: ordinal + 1 })),
      },
    });
    manager.addMessage('user', [{ type: 'text', text: 'turn 12 ' + 'word '.repeat(30) }]);
    await manager.compile(budget, undefined, prefix);
    const result = {
      certificate: internals._lastKvUnified?.lastResult?.certificate !== undefined,
      certificateMs: internals._lastKvUnified?.lastTimings?.certificateMs ?? 0,
    };
    manager.close();
    rmSync(STORE, { recursive: true, force: true });
    return result;
  };
  // Epsilon 0 can never be proven: the bound subtracts a roundoff allowance.
  const byDefault = await certified({ ...KV_UNIFIED, adoptEpsilon: 50 });
  assert.equal(byDefault.certificate, true, 'no key: the append is certified');
  assert.ok(byDefault.certificateMs > 0, 'no key: the certificate ran');
  const off = await certified({ ...KV_UNIFIED, adoptEpsilon: 50, hysteresisCertificate: false });
  assert.equal(off.certificate, false, 'false: the full solver decides');
  assert.equal(off.certificateMs, 0, 'false: the certificate never ran');
});

test('the plan-vs-actual line keeps its old prefix, and marks dry runs', async () => {
  const manager = await ContextManager.open({ path: STORE, strategy: strategy() });
  manager.addMessage('user', [{ type: 'text', text: 'live then dry' }]);
  const budget = { maxTokens: 10_000, reserveForResponse: 0 };
  const lines: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[plan-vs-actual]')) lines.push(args[0]);
    else error(...args);
  };
  try {
    await manager.compile(budget);
    assert.equal(manager.getRenderStats()!.planVsActual!.dryRun, undefined, 'a live compile is not marked');
    await manager.compile(budget, undefined, { dryRun: true });
  } finally {
    console.error = error;
  }
  const shape = /^\[plan-vs-actual\] planned=\d+ actual=\d+ delta=[+-]\d+ \([+-]\d+\.\d%\) budgetMet=\w+ exhausted=\w+ moves=\d+ solver=kv-unified messages=1 compileMs=\d+ solveMs=\d+/;
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], shape);
  assert.doesNotMatch(lines[0], /dryRun/);
  assert.match(lines[1], shape);
  // Its namespace follows its fields (#239).
  assert.match(lines[1], / dryRun=true ns=default$/);
  manager.close();
});

test('messages= counts the strategy view under a strategy with its own chunker', async () => {
  // KnowledgeStrategy replaces the base chunker; the count must not depend on it.
  const manager = await ContextManager.open({
    path: STORE,
    strategy: new KnowledgeStrategy({ adaptiveResolution: true, headWindowTokens: 0, recentWindowTokens: 100 }),
  });
  for (const text of ['one', 'two', 'three']) manager.addMessage('user', [{ type: 'text', text }]);
  await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
  assert.equal(manager.getRenderStats()!.planVsActual!.messages, 3);
  manager.close();
});

/** The [plan-vs-actual] lines logged while `fn` runs, read through a stand-in
 *  console: the line goes to console.error, or to console.warn with an overrun
 *  note when the emitter overruns the plan. Lines opening with a tag in
 *  `quiet` are dropped; everything else goes to the real console. */
async function planVsActualLines(fn: () => Promise<void>, quiet: string[] = []): Promise<string[]> {
  const lines: string[] = [];
  const { error, warn } = console;
  const capture = (pass: (...args: unknown[]) => void) => (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('[plan-vs-actual]')) lines.push(first);
    else if (!(typeof first === 'string' && quiet.some((tag) => first.startsWith(tag)))) pass(...args);
  };
  console.error = capture(error);
  console.warn = capture(warn);
  try {
    await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
  return lines;
}

/** The fields every [plan-vs-actual] line opens with, through `moves=`. */
const PVA_OPENING =
  String.raw`^\[plan-vs-actual\] planned=\d+ actual=\d+ delta=[+-]\d+ \([+-]\d+\.\d%\) budgetMet=(true|false) exhausted=(true|false)` +
  String.raw` moves=\d+`;
/**
 * The note that ends the line's message when the emitter overruns the plan, then the namespace
 * the line names, which follows its fields and the note (#239).
 */
const PVA_OVERRUN = String.raw`( \u2014 emitter overran the plan; .*)? ns=default$`;

test('a kv-stable compile after a preview that solved with kv-unified logs no solveMs', async () => {
  // buildPicker's kv-stable branch leaves _lastKvUnified as the preview's pick
  // set it, so only the plan's solver keeps those timings off the live line.
  const lines = await planVsActualLines(async () => {
    const manager = await ContextManager.open({ path: STORE, strategy: strategy({ foldingStrategy: 'kv-stable' }) });
    for (const [i, text] of ['one', 'two', 'three'].entries()) manager.addMessage(i % 2 ? 'assistant' : 'user', [{ type: 'text', text }]);
    const budget = { maxTokens: 10_000, reserveForResponse: 0 };
    assert.ok(manager.previewContext(budget, { foldingStrategy: 'kv-unified' }), 'premise: the preview ran');
    await manager.compile(budget);
    manager.close();
  }, ['[picker-config-drift]']);
  assert.equal(lines.length, 2, `one line for each compile: ${JSON.stringify(lines)}`);
  assert.match(lines[0]!, new RegExp(PVA_OPENING + String.raw` solver=kv-unified messages=3 compileMs=\d+ solveMs=\d+ dryRun=true` + PVA_OVERRUN),
    'premise: the preview solved with kv-unified');
  assert.match(lines[1]!, new RegExp(PVA_OPENING + String.raw` solver=kv-stable messages=3 compileMs=\d+` + PVA_OVERRUN), 'the live kv-stable compile');
});

test('compileMs spans the select from its start, chunk rebuild included, and no more than the compile call', async () => {
  const selected = strategy();
  // A chunk rebuild that takes at least 30 ms: select() runs it before it plans.
  const internals = selected as unknown as { rebuildChunks: (store: unknown) => void };
  const rebuild = internals.rebuildChunks.bind(selected);
  internals.rebuildChunks = (store) => {
    const until = performance.now() + 30;
    while (performance.now() < until) { /* the rebuild's own time */ }
    rebuild(store);
  };
  const manager = await ContextManager.open({ path: STORE, strategy: selected });
  manager.addMessage('user', [{ type: 'text', text: 'slow to chunk' }]);
  const started = performance.now();
  await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
  const elapsed = performance.now() - started;
  const { compileMs } = manager.getRenderStats()!.planVsActual!;
  assert.ok(compileMs! >= 30, `compileMs=${compileMs} leaves out the chunk rebuild`);
  assert.ok(compileMs! <= Math.ceil(elapsed), `compileMs=${compileMs} is longer than the compile call, ${elapsed.toFixed(1)} ms`);
  manager.close();
});

test('a preview marks its plan-vs-actual line and its own stats dryRun, and a dry pass leaves the live stats as the live compile left them', async () => {
  let preview: ReturnType<ContextManager['previewContext']> = null;
  const lines = await planVsActualLines(async () => {
    const manager = await ContextManager.open({ path: STORE, strategy: strategy() });
    for (const [i, text] of ['one', 'two', 'three'].entries()) manager.addMessage(i % 2 ? 'assistant' : 'user', [{ type: 'text', text }]);
    const budget = { maxTokens: 10_000, reserveForResponse: 0 };
    await manager.compile(budget);
    await manager.compile(budget, undefined, { dryRun: true });
    preview = manager.previewContext(budget, undefined, { render: true });
    assert.equal(manager.getRenderStats()!.planVsActual!.dryRun, undefined, 'getRenderStats still describes the live compile');
    manager.close();
  });
  assert.equal(preview!.stats?.planVsActual?.dryRun, true, "the preview's own stats are marked");
  assert.equal(lines.length, 3, `one line for each compile: ${JSON.stringify(lines)}`);
  assert.match(lines[2]!, new RegExp(PVA_OPENING + String.raw` solver=kv-unified messages=3 compileMs=\d+ solveMs=\d+ dryRun=true` + PVA_OVERRUN),
    "the preview's line");
});

test('messages= counts the strategy view: auxiliary slots merged in, after the view filter', async () => {
  const shown = (message: StoredMessage) => !message.content.some((block) => block.type === 'text' && block.text.includes('hidden'));
  const main = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
  const reader = await ContextManager.open({
    store: main.getStore(),
    namespace: 'plan-vs-actual/reader',
    isolate: true,
    strategy: strategy(),
    auxiliaryMessageViews: [{}],
    viewFilter: shown,
  });
  for (const text of ['main one', 'main two', 'main hidden']) main.addMessage('user', [{ type: 'text', text }]);
  for (const text of ['reader one', 'reader hidden']) reader.addMessage('user', [{ type: 'text', text }]);
  await reader.compile({ maxTokens: 10_000, reserveForResponse: 0 });
  // Five stored across the two slots, two of them hidden. Unfiltered the view
  // would hold five, and without the merge two, or one once filtered.
  assert.equal(reader.getRenderStats()!.planVsActual!.messages, 3);
  reader.close();
  main.close();
});
