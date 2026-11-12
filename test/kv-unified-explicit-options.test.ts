// Each malformed value in an explicit kv-unified block is refused in its own words, which are what an operator
// reads to fix the block. The block's shape (its keys, sizes, adoptEpsilon and forest flags) is checked before the
// first solve does any work; the policy's ranges are checked when the solve reads the policy.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const STORE = './test-kv-unified-explicit-options-store';

afterEach(() => {
  if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });
});

const POLICY = {
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
};

const BLOCK = {
  tokenBucketSize: 100,
  continuityBucketSize: 100,
  fidelityBucketSize: 100,
  labelCeiling: 10_000,
  adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false,
  preserveGapBearingSummaries: false,
};

/** Compiles once under a kv-unified block changed by `change`, and returns how the compile ended. */
async function compileWith(change: (block: Record<string, unknown>, policy: Record<string, unknown>) => void): Promise<unknown> {
  const policy: Record<string, unknown> = { ...POLICY };
  const block: Record<string, unknown> = { ...BLOCK };
  change(block, policy);
  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-unified',
    headWindowTokens: 0,
    recentWindowTokens: 100,
    kvUnified: { ...block, policy } as never,
  });
  const manager = await ContextManager.open({ path: STORE, strategy });
  try {
    manager.addMessage('user', [{ type: 'text', text: 'hello' }]);
    manager.addMessage('assistant', [{ type: 'text', text: 'hello back' }]);
    await manager.compile({ maxTokens: 10_000, reserveForResponse: 0 });
    return 'compiled';
  } catch (error) {
    return error;
  } finally {
    manager.close();
  }
}

async function assertRefused(
  change: (block: Record<string, unknown>, policy: Record<string, unknown>) => void,
  message: string,
): Promise<void> {
  const outcome = await compileWith(change);
  assert.ok(outcome instanceof Error, `expected a refusal, got ${String(outcome)}`);
  assert.equal(outcome.message, message);
}

test('the block as written compiles', async () => {
  assert.equal(await compileWith(() => {}), 'compiled');
});

test('a policy without alpha is refused for the missing key', async () => {
  await assertRefused((_, policy) => { delete policy.alpha; }, 'kv-unified policy is missing alpha');
});

test('a labelCeiling of zero is refused as not positive', async () => {
  await assertRefused((block) => { block.labelCeiling = 0; }, 'kv-unified requires positive labelCeiling');
});

test('a negative adoptEpsilon is refused', async () => {
  await assertRefused((block) => { block.adoptEpsilon = -1; }, 'kv-unified requires non-negative adoptEpsilon');
});

test('both forest flags set is refused by the strategy, in its own words, before the forest is built', async () => {
  await assertRefused(
    (block) => { block.treeifyNonContiguousSummaries = true; block.preserveGapBearingSummaries = true; },
    'kv-unified treeifyNonContiguousSummaries and preserveGapBearingSummaries are mutually exclusive',
  );
});

test('a negative alpha is refused as not non-negative', async () => {
  await assertRefused((_, policy) => { policy.alpha = -0.1; }, 'alpha must be finite and non-negative');
});

test('a cacheScale of zero is refused as not positive', async () => {
  await assertRefused((_, policy) => { policy.cacheScale = 0; }, 'cacheScale must be finite and positive');
});

test('a continuityRecencyFloor over 1 is refused as outside [0, 1]', async () => {
  await assertRefused((_, policy) => { policy.continuityRecencyFloor = 1.5; }, 'continuityRecencyFloor must be in [0, 1]');
});

test('a continuityStableHalfLife of zero is refused as not positive', async () => {
  await assertRefused((_, policy) => { policy.continuityStableHalfLife = 0; }, 'continuityStableHalfLife must be finite and positive');
});
