/**
 * kv-unified's change cost through the context manager and the memory
 * strategy: what the manager tells a select of the thinking the branch's
 * record still vouches for (`SelectOptions.thinkingStanding`), what the
 * strategy prices a change of layout at from it (`thinkingLambda`).
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '../src/index.js';
import type {
  ContextEntry, ContextLogView, MessageId, MessageStoreView, RequestIdentity, SelectOptions, ThinkingStanding, TokenBudget,
} from '../src/types/index.js';
import type { Picker, PickerInputs } from '../src/adaptive/picker.js';

const STORE = './test-kv-unified-change-cost-store';

afterEach(() => {
  if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });
});

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const thought = (n: number): ContentBlock =>
  ({ type: 'thinking', thinking: `zz-reasoning-${n} `.repeat(40), signature: `zz-sig-${n}-0123456789abcdef` }) as ContentBlock;
const identity = (over: Partial<RequestIdentity> = {}): RequestIdentity =>
  ({ system: 'zz-system-1', tools: 'zz-tools-1', model: 'zz-model-1', request: 'zz-request-1', ...over });
const bind = (over: { dropBlock?: boolean; identity?: Partial<RequestIdentity> } = {}): SelectOptions =>
  ({ thinkingBinding: { binds: true, dropBlock: over.dropBlock === true, participant: 'Claude' }, identity: identity(over.identity) });
const BIG: TokenBudget = { maxTokens: 1_000_000, reserveForResponse: 0 };

/** A passthrough strategy that keeps the options each select was given. */
class Listening extends PassthroughStrategy {
  seen: (SelectOptions | undefined)[] = [];
  override select(store: MessageStoreView, log: ContextLogView, budget: TokenBudget, opts?: SelectOptions): ContextEntry[] {
    this.seen.push(opts);
    return super.select(store, log, budget, opts);
  }
}

const standingOf = (opts: SelectOptions | undefined): { none: boolean; without: MessageId[]; recordedAfter?: number } | undefined => {
  const standing: ThinkingStanding | undefined = opts?.thinkingStanding;
  return standing && { none: standing.none, without: [...standing.without].sort(), ...(standing.recordedAfter !== undefined ? { recordedAfter: standing.recordedAfter } : {}) };
};

test('a binding compile tells its select what the record still vouches for, and no other compile does', async () => {
  const strategy = new Listening();
  const manager = await ContextManager.open({ path: STORE, strategy });
  manager.addMessage('User', [text('U1')]);
  const a1 = manager.addMessage('Claude', [thought(1), text('A1')]);
  manager.addMessage('User', [text('U2')]);
  const last = () => standingOf(strategy.seen.at(-1));

  // Not a binding compile: nothing is given, and a caller's value is dropped.
  await manager.compile(BIG);
  assert.equal(last(), undefined);
  await manager.compile(BIG, [], { thinkingStanding: { none: false, without: new Set() } });
  assert.equal(strategy.seen.at(-1)?.thinkingStanding, undefined);

  // No record yet. Without the drop control no reply keeps its thinking;
  // with it, each is left to the provider.
  await manager.compile(BIG, [], { ...bind(), dryRun: true });
  assert.deepEqual(last(), { none: true, without: [] });
  await manager.compile(BIG, [], { ...bind({ dropBlock: true }), dryRun: true, thinkingStanding: { none: true, without: new Set(['x']) } });
  assert.deepEqual(last(), { none: false, without: [] }, "the manager's own, whatever the caller passed");

  // A committing compile under the drop control keeps A1's thinking and
  // starts the record after it.
  const first = await manager.compile(BIG, [], bind({ dropBlock: true }));
  const began = first.thinkingRecordedAfter!;
  await manager.compile(BIG, [], { ...bind({ dropBlock: true }), dryRun: true });
  assert.deepEqual(last(), { none: false, without: [] });
  // Without the control, a reply stored before the record began keeps none.
  await manager.compile(BIG, [], { ...bind(), dryRun: true });
  assert.deepEqual(last(), { none: false, without: [], recordedAfter: began });

  // Another head: nothing survives, whatever is selected.
  await manager.compile(BIG, [], { ...bind({ dropBlock: true, identity: { tools: 'zz-tools-2' } }), dryRun: true });
  assert.deepEqual(last(), { none: true, without: [] });

  // A compile that leaves A1's thinking out records that it did.
  const stripped = await manager.compile(BIG, [], bind({ dropBlock: true, identity: { tools: 'zz-tools-2' } }));
  assert.deepEqual(stripped.thinkingStrip?.newly, [a1]);
  await manager.compile(BIG, [], { ...bind({ dropBlock: true, identity: { tools: 'zz-tools-2' } }), dryRun: true });
  assert.deepEqual(last(), { none: false, without: [a1] });
  manager.close();
});

const KV_UNIFIED = {
  policy: {
    alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
    cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25,
    continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10, continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000,
  adoptEpsilon: 0, treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
};

/** The memory strategy under kv-unified, keeping each solve's inputs. */
class Probe extends AutobiographicalStrategy {
  inputs: PickerInputs[] = [];
  constructor(kvUnified: Record<string, unknown> = {}, recentWindowTokens = 100) {
    super({
      adaptiveResolution: true, foldingStrategy: 'kv-unified', headWindowTokens: 0, recentWindowTokens,
      kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy }, ...kvUnified },
    });
  }
  price(content: ContentBlock[]): number { return this.estimateTokens(content); }
  protected override buildPicker(inputs: PickerInputs, ...rest: unknown[]): Picker {
    this.inputs.push(inputs);
    return (AutobiographicalStrategy.prototype as unknown as { buildPicker: (...args: unknown[]) => Picker }).buildPicker.call(this, inputs, ...rest);
  }
}

const penaltyOf = (manager: ContextManager): number | undefined => manager.getRenderStats()?.planVsActual?.changePenalty;

test('thinkingLambda prices a change at the thinking the record still vouches for, less the further back it is', async (t) => {
  const planLines: string[] = [];
  const original = console.error.bind(console);
  t.mock.method(console, 'error', (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[plan-vs-actual]')) planLines.push(line);
    else original(...args);
  });
  const strategy = new Probe({ thinkingLambda: 2, thinkingHalfLifeTokens: 200 }, 100_000);
  const manager = await ContextManager.open({ path: STORE, strategy });
  manager.addMessage('User', [text('U1')]);
  manager.addMessage('Claude', [thought(1), text('A1')]);
  manager.addMessage('User', [text('U2')]);

  // Not a binding compile: thinking costs nothing.
  await manager.compile(BIG);
  assert.equal(penaltyOf(manager), undefined);
  assert.ok(!planLines.at(-1)!.includes('changePenalty='));

  // Under the drop control A1's thinking is in play: its tokens at the
  // store's price, twice over, weighted for the few tokens after it.
  await manager.compile(BIG, [], bind({ dropBlock: true }));
  const near = penaltyOf(manager)!;
  const thinkingTokens = strategy.price([thought(1)]);
  assert.ok(thinkingTokens > 20, 'the fixture has thinking to price');
  assert.ok(near > 1.5 * thinkingTokens && near <= 2 * thinkingTokens, `${near} for ${thinkingTokens} tokens of thinking`);
  assert.match(planLines.at(-1)!, new RegExp(` changePenalty=${near}( |$)`));

  // The same thinking with a long message after it weighs less.
  manager.addMessage('User', [text('zz-later '.repeat(120))]);
  await manager.compile(BIG, [], bind({ dropBlock: true }));
  const far = penaltyOf(manager)!;
  assert.ok(far > 0 && far < near / 2, `${far} after a long message, ${near} before it`);

  // Without the control, a reply stored before the record began keeps no
  // thinking, so nothing is at stake.
  await manager.compile(BIG, [], { ...bind(), dryRun: true });
  assert.equal(penaltyOf(manager), far, 'a dry pass leaves the live stats');
  const dry = await manager.compile(BIG, [], { ...bind(), dryRun: true });
  assert.equal(dry.renderStats?.planVsActual?.changePenalty, undefined);

  // Under another head every block goes anyway: a change costs nothing more.
  await manager.compile(BIG, [], bind({ dropBlock: true, identity: { system: 'zz-system-2' } }));
  assert.equal(penaltyOf(manager), undefined);
  // And that compile left A1's thinking out, so it stays out of the count.
  await manager.compile(BIG, [], bind({ dropBlock: true, identity: { system: 'zz-system-2' } }));
  assert.equal(penaltyOf(manager), undefined);

  // A reply stored since, which the record's compile didn't leave out, counts again.
  manager.addMessage('Claude', [thought(2), text('A2')]);
  await manager.compile(BIG, [], bind({ dropBlock: true, identity: { system: 'zz-system-2' } }));
  assert.ok(penaltyOf(manager)! > 1.5 * thinkingTokens);
  manager.close();
});

test('without thinkingLambda, or with one that is not above 0, thinking costs nothing', async () => {
  for (const thinkingLambda of [undefined, 0, -1, Number.NaN]) {
    if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });
    const manager = await ContextManager.open({ path: STORE, strategy: new Probe(thinkingLambda === undefined ? {} : { thinkingLambda }, 100_000) });
    manager.addMessage('User', [text('U1')]);
    manager.addMessage('Claude', [thought(1), text('A1')]);
    await manager.compile(BIG, [], bind({ dropBlock: true }));
    assert.equal(penaltyOf(manager), undefined, String(thinkingLambda));
    manager.close();
  }
});
