import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { SummaryEntry, AutobiographicalOptions } from '../src/types/strategy.js';
import type { KvUnifiedReceiptChain } from '../src/adaptive/kv-unified-receipts.js';
import {
  buildSyntheticChain,
  migrateToStable,
  migrateToUnified,
  readFlavor,
  slotIds,
  synthesizePresentation,
  validateStoreForKvUnified,
} from '../src/migration/folding-migration.js';
import { VALIDATION_KV_UNIFIED_CONFIG } from '../src/migration/folding-migration.js';

const STORES: string[] = [];
function storePath(name: string): string {
  const p = `./test-folding-migration-${name}`;
  STORES.push(p);
  return p;
}

afterEach(() => {
  for (const p of STORES.splice(0)) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

function l1(id: string, sourceIds: string[]): SummaryEntry {
  return {
    id,
    level: 1,
    content: `summary ${id} covering ${sourceIds.join(',')}`,
    tokens: 10,
    sourceLevel: 0,
    sourceIds,
    sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
    created: 1,
  };
}

const KV_STABLE_CONFIG: AutobiographicalOptions = {
  adaptiveResolution: true,
  foldingStrategy: 'kv-stable',
  headWindowTokens: 0,
  recentWindowTokens: 100,
};

const KV_UNIFIED_CONFIG: AutobiographicalOptions = {
  adaptiveResolution: true,
  foldingStrategy: 'kv-unified',
  headWindowTokens: 0,
  recentWindowTokens: 100,
  kvUnified: {
    ...VALIDATION_KV_UNIFIED_CONFIG,
    treeifyNonContiguousSummaries: false,
    preserveGapBearingSummaries: false,
  },
};

function receipts(strategy: AutobiographicalStrategy): KvUnifiedReceiptChain {
  return (strategy as unknown as { kvUnifiedReceipts: KvUnifiedReceiptChain }).kvUnifiedReceipts;
}

// ============================================================================
// synthesizePresentation (pure)
// ============================================================================

test('synthesizePresentation: raw-only store yields all-raw leaves', () => {
  const out = synthesizePresentation(['m1', 'm2'], new Map(), [], []);
  assert.equal(out.leaves.size, 2);
  assert.equal(out.foldedCount, 0);
  assert.equal(out.warnings.length, 0);
  assert.deepEqual(out.leaves.get('m1'), { repHash: 'raw:m1', level: 0, lastChangedSeq: 1 });
});

test('synthesizePresentation: folded leaves point at their L1 via the chunk-record ledger', () => {
  const out = synthesizePresentation(
    ['m1', 'm2', 'm3'],
    new Map([['m1', 1], ['m2', 1]]),
    [l1('L1-0', ['m1', 'm2'])],
    [{ id: 'c-0', sourceIds: ['m1', 'm2'], compressed: true, summaryId: 'L1-0' }],
  );
  assert.equal(out.foldedCount, 2);
  assert.deepEqual(out.leaves.get('m1'), { repHash: 'summary:L1-0', level: 1, lastChangedSeq: 1 });
  assert.deepEqual(out.leaves.get('m3'), { repHash: 'raw:m3', level: 0, lastChangedSeq: 1 });
});

test('synthesizePresentation: L1 sourceIds are the coverage fallback when the ledger has no pointer', () => {
  const out = synthesizePresentation(
    ['m1'],
    new Map([['m1', 1]]),
    [l1('L1-9', ['m1'])],
    [],
  );
  assert.deepEqual(out.leaves.get('m1'), { repHash: 'summary:L1-9', level: 1, lastChangedSeq: 1 });
});

test('synthesizePresentation: unreachable level degrades to deepest available with a warning', () => {
  const out = synthesizePresentation(
    ['m1'],
    new Map([['m1', 2]]),
    [l1('L1-0', ['m1'])],
    [],
  );
  assert.deepEqual(out.leaves.get('m1'), { repHash: 'summary:L1-0', level: 1, lastChangedSeq: 1 });
  assert.deepEqual(out.warnings, [
    { messageId: 'm1', requestedLevel: 2, usedLevel: 1, reason: 'no-summary-at-level' },
  ]);
});

// ============================================================================
// buildSyntheticChain (pure)
// ============================================================================

test('buildSyntheticChain: deterministic for identical inputs, sensitive to acceptedAt', () => {
  const presentation = synthesizePresentation(['m1', 'm2'], new Map(), [], []);
  const a = buildSyntheticChain(presentation, 1234);
  const b = buildSyntheticChain(presentation, 1234);
  const c = buildSyntheticChain(presentation, 5678);
  assert.ok(a.head);
  assert.equal(a.head.sequence, 1);
  assert.equal(a.head.receiptHash, b.head?.receiptHash);
  assert.notEqual(a.head.receiptHash, c.head?.receiptHash);
  assert.equal(a.leaves.size, 2);
  assert.equal(a.cache, null);
  assert.equal(a.inFlightSubmissionId, null);
});

// ============================================================================
// to-unified / to-stable on a real store (first cross-strategy coverage)
// ============================================================================

test('to-unified synthesizes a chain the kv-unified strategy loads and compiles from', async () => {
  const path = storePath('to-unified');
  {
    const manager = await ContextManager.open({
      path,
      strategy: new AutobiographicalStrategy(KV_STABLE_CONFIG),
    });
    manager.addMessage('user', [{ type: 'text', text: 'first message' }]);
    manager.addMessage('agent', [{ type: 'text', text: 'second message' }]);
    manager.addMessage('user', [{ type: 'text', text: 'third message' }]);
    await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
    manager.close();
  }

  const dry = await migrateToUnified({ path, acceptedAt: 1234, apply: false });
  assert.equal(dry.applied, false);
  assert.equal(dry.messageCount, 3);
  {
    const store = JsStore.open({ path });
    assert.equal(readFlavor(store, 'default').hasReceiptChain, false);
    store.close();
  }

  const applied = await migrateToUnified({ path, acceptedAt: 1234, apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.messageCount, 3);
  assert.ok(applied.receiptHeadHash);
  // Deterministic: the dry run predicted exactly what apply wrote.
  assert.equal(dry.receiptHeadHash, applied.receiptHeadHash);

  const strategy = new AutobiographicalStrategy(KV_UNIFIED_CONFIG);
  const manager = await ContextManager.open({ path, strategy });
  const chain = receipts(strategy);
  assert.ok(chain.head, 'kv-unified loaded the synthesized chain');
  assert.equal(chain.head.sequence, 1);
  assert.equal(chain.head.receiptHash, applied.receiptHeadHash);
  assert.equal(chain.leaves.size, 3);
  for (const [id, leaf] of chain.leaves) {
    assert.equal(leaf.repHash, `raw:${id}`);
    assert.equal(leaf.level, 0);
  }
  // The migrated store must actually compile under kv-unified.
  const result = await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
  assert.ok(result.messages.length > 0);
  manager.close();
});

test('to-unified refuses an existing chain unless overwrite is set', async () => {
  const path = storePath('refuse');
  {
    const manager = await ContextManager.open({
      path,
      strategy: new AutobiographicalStrategy(KV_STABLE_CONFIG),
    });
    manager.addMessage('user', [{ type: 'text', text: 'hello' }]);
    await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
    manager.close();
  }
  await migrateToUnified({ path, acceptedAt: 1, apply: true });

  const refused = await migrateToUnified({ path, acceptedAt: 2, apply: true });
  assert.equal(refused.applied, false);
  assert.ok(refused.refusedExistingChain);
  assert.equal(refused.refusedExistingChain.headSequence, 1);

  const overwritten = await migrateToUnified({ path, acceptedAt: 2, apply: true, overwrite: true });
  assert.equal(overwritten.applied, true);
  assert.equal(overwritten.refusedExistingChain, undefined);
});

test('to-stable clears the receipt chain and is idempotent', async () => {
  const path = storePath('to-stable');
  {
    const manager = await ContextManager.open({
      path,
      strategy: new AutobiographicalStrategy(KV_STABLE_CONFIG),
    });
    manager.addMessage('user', [{ type: 'text', text: 'hello' }]);
    await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
    manager.close();
  }
  await migrateToUnified({ path, acceptedAt: 1, apply: true });

  const store = JsStore.open({ path });
  assert.equal(readFlavor(store, 'default').hasReceiptChain, true);

  const dry = migrateToStable({ store, apply: false });
  assert.equal(dry.applied, false);
  assert.deepEqual(dry.cleared, { headSequence: 1, leafCount: 1 });
  assert.equal(readFlavor(store, 'default').hasReceiptChain, true, 'dry run wrote nothing');

  const applied = migrateToStable({ store, apply: true });
  assert.equal(applied.applied, true);
  assert.equal(readFlavor(store, 'default').hasReceiptChain, false);

  const again = migrateToStable({ store, apply: true });
  assert.equal(again.cleared, null, 'already-empty slot is a no-op');
  store.close();
});

// ============================================================================
// validate
// ============================================================================

test('validate: clean store canonicalizes strictly', async () => {
  const path = storePath('validate-clean');
  {
    const manager = await ContextManager.open({
      path,
      strategy: new AutobiographicalStrategy(KV_STABLE_CONFIG),
    });
    manager.addMessage('user', [{ type: 'text', text: 'hello there' }]);
    manager.addMessage('agent', [{ type: 'text', text: 'general kenobi' }]);
    await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
    manager.close();
  }
  const result = await validateStoreForKvUnified({ path });
  assert.equal(result.strictIssues.length, 0);
  assert.equal(result.recommendation, 'strict');
});

test('validate: non-contiguous summary fails strict, passes treeify', async () => {
  const path = storePath('validate-scarred');
  let ids: string[] = [];
  {
    const manager = await ContextManager.open({
      path,
      strategy: new AutobiographicalStrategy(KV_STABLE_CONFIG),
    });
    // Big enough that the first two leave the 100-token recent window — tail
    // chunks carry no l1Id, so a summary over tail-resident messages never
    // enters the forest's ownership graph at all.
    manager.addMessage('user', [{ type: 'text', text: 'one '.repeat(200) }]);
    manager.addMessage('agent', [{ type: 'text', text: 'two '.repeat(200) }]);
    manager.addMessage('user', [{ type: 'text', text: 'three '.repeat(200) }]);
    await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
    ids = manager.getAllMessages().map((m) => m.id);
    manager.close();
  }
  // Scar the store the way kv-stable-era surgery could: an L1 whose ownership
  // skips the message between its sources.
  {
    const store = JsStore.open({ path });
    store.setStateJson(slotIds.summaries('default'), [l1('L1-scar', [ids[0], ids[2]])]);
    store.close();
  }
  const result = await validateStoreForKvUnified({ path, config: KV_STABLE_CONFIG });
  assert.ok(
    result.strictIssues.some((i) => i.code === 'non-contiguous-ownership'),
    `strict issues: ${JSON.stringify(result.strictIssues.map((i) => i.code))}`,
  );
  const strict = result.outcomes.find((o) => o.policy === 'strict');
  const treeify = result.outcomes.find((o) => o.policy === 'treeify');
  assert.equal(strict?.ok, false);
  assert.equal(treeify?.ok, true);
  assert.equal(result.recommendation, 'treeify');
});
