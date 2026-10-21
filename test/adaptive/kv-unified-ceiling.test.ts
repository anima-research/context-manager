// The label ceiling bounds a search; it doesn't fail the compile (#252). A live
// solve past it takes the minimum-token cut, a latent-demand search past it
// measures nothing (a conservative what-if's candidate isn't demanded, and a
// joint forest's candidates are ranked one at a time), and a base re-solve past
// it leaves the demand undecided, each reported in the strategy's timings.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import { ParetoKvUnifiedPolicySolver, type ParetoSolveOptions } from '../../src/adaptive/kv-unified-pareto.js';
import { CanonicalSummaryForest, SparseLabelCeilingError } from '../../src/adaptive/kv-unified.js';
import {
  KvUnifiedStrategy,
  ceilingMark,
  type KvUnifiedCeilingHit,
  type KvUnifiedOptions,
  type KvUnifiedReuse,
} from '../../src/adaptive/strategies/kv-unified.js';
import { MockChronicle } from './harness.js';

// Six leaves, each under its own L1, so the latent-demand candidates are the
// L2 merges of neighbouring pairs (the joint-failure tests' fixture).
function fixture(): PickerInputs {
  const chronicle = new MockChronicle({ recallPairTokens: 60, mergeThreshold: 2 });
  const raw = [90, 130, 70, 160, 110, 140];
  const recall = [40, 75, 55, 90, 65, 80];
  for (let index = 0; index < 6; index++) {
    const id = `latent-${index}`;
    chronicle.addChunk({ id, rawTokens: raw[index] });
    chronicle.chunks[index].salience = 0.4 + 0.1 * index;
    const l1 = chronicle.produceL1([id]);
    chronicle.recallPairTokens.set(l1.id, recall[index]);
  }
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

const GRID = { tokenBucketSize: 10, continuityBucketSize: 10, fidelityBucketSize: 10 };
const DEMAND = { mergeThreshold: 2, fallbackRecallTokens: 30, maxCandidates: 4 };
// Budget pressure that makes every cut fold to its L1s: the live solve peaks
// at 27 labels per state and the individual what-ifs at up to 35.
const POLICY = { alpha: 0.7, budgetLowRatio: 0, budgetHighRatio: 0.5, budgetUnderLambda: 0, budgetOverLambda: 100_000, cacheLambda: 0, continuityLambda: 0 };
const WALL = { totalBudget: 500, targetBudget: 450, slack: 0.1 };

const frontierOf = (solution: { frontier: ReadonlyMap<string, number> }): Map<string, number> => new Map(solution.frontier);
// A what-if solve is one whose inputs carry a latent candidate; a joint one
// carries more than one.
const latentCandidates = (solver: ParetoKvUnifiedPolicySolver): number =>
  [...(solver as unknown as { inputs: PickerInputs }).inputs.summaries.keys()].filter((id) => id.startsWith('__latent:')).length;
const isWhatIf = (solver: ParetoKvUnifiedPolicySolver): boolean => latentCandidates(solver) > 0;

// A carried layout at every leaf's L1 that the certificate proves, so the live
// solve is certified, and a merge then passes the gate against it, which the
// base solved without the certificate decides.
function certifiedBase(mode: 'individual' | 'joint', reuse: KvUnifiedReuse): KvUnifiedOptions {
  const forest = new CanonicalSummaryForest(fixture());
  const leaves = new Map(forest.orderedLeaves().map((leaf) => {
    const id = leaf.summaryIds.find((summaryId) => forest.summary(summaryId)!.level === 1);
    return [leaf.id, { level: 1, repHash: `summary:${id}`, lastChangedSeq: 1 }];
  }));
  return {
    policy: POLICY, ...GRID, labelCeiling: 200, hysteresisCertificate: true, presentation: { currentSeq: 3, leaves }, adoptEpsilon: 100,
    reuse, latentDemand: { ...DEMAND, mode },
  };
}
const CERTIFIED_WALL = { totalBudget: 700, targetBudget: 630, slack: 0.1 };

test('a live solve past the label ceiling takes the minimum-token cut instead of failing the compile, on every engine', () => {
  // A policy that keeps some leaves raw under a 600-token wall, so its cut
  // isn't the minimum-token one and the two can be told apart.
  const policy = { ...POLICY, budgetHighRatio: 0.9, budgetOverLambda: 10 };
  const wall = { totalBudget: 600, targetBudget: 540, slack: 0.1 };
  const minimum = new CanonicalSummaryForest(fixture()).minimumTokens(600);
  assert.ok(minimum.feasible);
  const roomy = new KvUnifiedStrategy({ policy, ...GRID, labelCeiling: 1_000_000 }).solve(fixture(), wall);
  assert.notDeepEqual(frontierOf(roomy), new Map(minimum.frontier), "premise: the policy's cut isn't the minimum-token one");

  const engines: Array<[string, KvUnifiedOptions]> = [
    ['packed, after subtree', {}],
    ['subtree', { engine: 'subtree' }],
    ['packed', { engine: 'dag' }],
    ['objects', { storage: 'objects' }],
    ['leaf', { engine: 'leaf' }],
  ];
  for (const [engine, options] of engines) {
    // The solver's own refusal, for the labels the report must carry.
    let own: unknown;
    try {
      new ParetoKvUnifiedPolicySolver(fixture()).solve({ policy, ...GRID, labelCeiling: 10, maxTokens: 600, ...options });
    } catch (error) {
      own = error;
    }
    assert.ok(own instanceof SparseLabelCeilingError, `${engine}: premise: the solver refuses`);
    const hits: KvUnifiedCeilingHit[] = [];
    const strategy = new KvUnifiedStrategy({
      policy, ...GRID, labelCeiling: 10, ...options,
      latentDemand: { ...DEMAND, mode: 'joint' },
      onCeilingFallback: (hit) => hits.push(hit),
    });
    const solution = strategy.solve(fixture(), wall);
    assert.deepEqual(frontierOf(solution), new Map(minimum.frontier), `${engine}: the minimum-token cut`);
    assert.equal(solution.exhausted, false, `${engine}: it fits the wall`);
    assert.deepEqual(solution.produced, [], `${engine}: and nothing is demanded against it`);
    assert.equal(strategy.lastTimings?.demandSolves, 0, `${engine}: no what-if is solved`);
    assert.deepEqual(
      strategy.lastTimings?.ceiling,
      { live: { ceiling: 10, labels: own.labelsCreated, engine }, whatIfs: 0, gate: false, joint: false },
      `${engine}: the fallback is reported with the labels the search stopped at`,
    );
    assert.deepEqual(hits, [strategy.lastTimings!.ceiling!.live], `${engine}: and the host is told once`);
  }
});

test('the solver itself still refuses past the ceiling: only the live compile falls back', () => {
  assert.throws(
    () => new ParetoKvUnifiedPolicySolver(fixture()).solve({ policy: POLICY, ...GRID, labelCeiling: 10, maxTokens: 500 }),
    SparseLabelCeilingError,
  );
});

test('a latent-demand what-if past the ceiling leaves its candidate undemanded, and the compile goes on with the live cut and the rest', () => {
  for (const mode of ['individual', 'joint'] as const) {
    const run = (labelCeiling: number) => {
      const strategy = new KvUnifiedStrategy({ policy: POLICY, ...GRID, labelCeiling, latentDemand: { ...DEMAND, mode } });
      return { strategy, solution: strategy.solve(fixture(), WALL) };
    };
    const ranges = (solution: { produced: readonly { range: { firstChunkId: string } }[] }) =>
      solution.produced.map((request) => request.range.firstChunkId).sort();
    // At 35 every individual what-if fits; at 30 the live solve (27) still
    // does, and two of the three individual what-ifs don't. The joint forest,
    // holding every candidate at once, needs more than either, so in joint
    // mode the candidates are ranked one at a time at both.
    const joint = mode === 'joint';
    const roomy = run(35);
    assert.deepEqual(ranges(roomy.solution), ['latent-0', 'latent-2', 'latent-4'], `${mode}: premise: three merges demanded`);
    assert.deepEqual(
      roomy.strategy.lastTimings?.ceiling,
      joint ? { whatIfs: 0, gate: false, joint: true } : undefined,
      `${mode}: premise: no individual what-if stopped`,
    );
    const tight = run(30);
    assert.deepEqual(frontierOf(tight.solution), frontierOf(roomy.solution), `${mode}: the live cut is the policy's`);
    assert.deepEqual(ranges(tight.solution), ['latent-4'], `${mode}: the candidate whose what-if fits is still demanded`);
    assert.deepEqual(tight.strategy.lastTimings?.ceiling, { whatIfs: 2, gate: false, joint }, `${mode}: and the two stopped are reported`);
  }
});

test("a what-if the ceiling stopped isn't solved again while the inputs hold, and a changed input is a new question", (t) => {
  // The solver's own what-if calls are counted, not the strategy's counter.
  let solved = 0;
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, options: ParetoSolveOptions) {
    if (isWhatIf(this)) solved++;
    return original.call(this, options);
  });
  const reuse: KvUnifiedReuse = {};
  const options = (labelCeiling: number): KvUnifiedOptions => ({
    policy: POLICY, ...GRID, labelCeiling, reuse, latentDemand: { ...DEMAND, mode: 'individual' },
  });
  // One strategy for every compile at 30, as a host could keep one: nothing of
  // a compile's report or digest may reach the next.
  const strategy = new KvUnifiedStrategy(options(30));
  const run = (inputs: PickerInputs = fixture(), using = strategy) => {
    solved = 0;
    const solution = using.solve(inputs, WALL);
    return { solved, ceiling: using.lastTimings!.ceiling, demanded: solution.produced.length };
  };
  const stopped = { solved: 3, ceiling: { whatIfs: 2, gate: false, joint: false }, demanded: 1 };
  const remembered = { ...stopped, solved: 1 };
  assert.deepEqual(run(), stopped, 'three what-ifs solved, two stopped');
  assert.deepEqual(run(), remembered, 'the two stopped are remembered, not solved');
  assert.deepEqual(run(), remembered, 'and still remembered at the compile after');
  // A salience a 4096th apart is another input.
  const nudged = fixture();
  nudged.chunks[0].salience! += 1 / 4096;
  assert.deepEqual(run(nudged), stopped, 'a changed salience is a new question');
  assert.deepEqual(run(), stopped, 'and so is the salience it had');
  // So is a leaf's owning L1 alone: latent-5 loses its L1, and with it the
  // latent-4 merge; the two remembered candidates are solved again.
  const disowned = fixture();
  disowned.chunks[5].l1Id = undefined;
  assert.equal(run(disowned).solved, 2, 'a changed owner is a new question');
  assert.deepEqual(run(fixture(), new KvUnifiedStrategy(options(31))), stopped, 'and so is another ceiling');
});

test("one candidate's joint what-if is its own, so once stopped it isn't solved again as one", (t) => {
  let solved = 0;
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, options: ParetoSolveOptions) {
    if (isWhatIf(this)) solved++;
    return original.call(this, options);
  });
  const strategy = new KvUnifiedStrategy({
    policy: POLICY, ...GRID, labelCeiling: 27, reuse: {}, latentDemand: { ...DEMAND, maxCandidates: 1, mode: 'joint' },
  });
  const solution = strategy.solve(fixture(), WALL);
  assert.deepEqual(solution.produced, []);
  assert.equal(solved, 1, 'the joint attempt alone');
  assert.deepEqual(strategy.lastTimings?.ceiling, { whatIfs: 1, gate: false, joint: true });
});

test("a base re-solve past the ceiling demands nothing, and the joint ranking doesn't take it for the joint forest's failure", (t) => {
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  for (const mode of ['individual', 'joint'] as const) {
    const free = new KvUnifiedStrategy(certifiedBase(mode, {}));
    assert.ok(free.solve(fixture(), CERTIFIED_WALL).produced.length > 0, `${mode}: premise: a merge passes the gate`);
    assert.ok(free.lastResult?.feasible && free.lastResult.certificate, `${mode}: premise: against a certified base`);

    const inputs = fixture();
    const reuse: KvUnifiedReuse = {};
    // The base solved without the certificate exceeds the ceiling; every
    // other solve runs as it would.
    const mocked = t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, solveOptions: ParetoSolveOptions) {
      if (solveOptions.hysteresisCertificate === false && (this as unknown as { inputs: PickerInputs }).inputs === inputs) {
        throw new SparseLabelCeilingError(200, 201);
      }
      return original.call(this, solveOptions);
    });
    const strategy = new KvUnifiedStrategy(certifiedBase(mode, reuse));
    const solution = strategy.solve(inputs, CERTIFIED_WALL);
    mocked.mock.restore();
    assert.deepEqual(solution.produced, [], `${mode}: nothing is demanded`);
    assert.deepEqual(strategy.lastTimings?.ceiling, { whatIfs: 0, gate: true, joint: false }, `${mode}: and the gate is reported`);
    assert.ok(
      ![...(reuse.whatIf?.values() ?? [])].some((holder) => holder.ceilingFailure !== undefined),
      `${mode}: no what-if is remembered as stopped`,
    );
  }
});

test('an error other than the ceiling still fails the solve, wherever it is thrown', (t) => {
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  const failure = new Error('not the ceiling');
  const jointReuse: KvUnifiedReuse = {};
  const sites: Array<[string, (solver: ParetoKvUnifiedPolicySolver, options: ParetoSolveOptions) => boolean, () => KvUnifiedOptions, typeof WALL]> = [
    ['the live solve', (solver) => !isWhatIf(solver), () => ({ policy: POLICY, ...GRID, labelCeiling: 1_000, latentDemand: { ...DEMAND, mode: 'individual' } }), WALL],
    ['a what-if', (solver) => isWhatIf(solver), () => ({ policy: POLICY, ...GRID, labelCeiling: 1_000, reuse: {}, latentDemand: { ...DEMAND, mode: 'individual' } }), WALL],
    // The joint forest's solve alone, so the ranking one at a time that a
    // ceiling stop falls back to would succeed.
    ['the joint forest', (solver) => latentCandidates(solver) > 1, () => ({ policy: POLICY, ...GRID, labelCeiling: 1_000, reuse: jointReuse, latentDemand: { ...DEMAND, mode: 'joint' } }), WALL],
    ['the base the gate decides on', (solver, options) => !isWhatIf(solver) && options.hysteresisCertificate === false, () => certifiedBase('individual', {}), CERTIFIED_WALL],
  ];
  for (const [site, throwsHere, options, wall] of sites) {
    const mocked = t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, solveOptions: ParetoSolveOptions) {
      if (throwsHere(this, solveOptions)) throw failure;
      return original.call(this, solveOptions);
    });
    const strategy = new KvUnifiedStrategy(options());
    assert.throws(() => strategy.solve(fixture(), wall), (error) => error === failure, site);
    mocked.mock.restore();
  }
  assert.ok(
    ![...(jointReuse.whatIf?.values() ?? [])].some((holder) => holder.ceilingFailure !== undefined),
    'and the joint forest the error stopped is not remembered as past the ceiling',
  );
});

test("a strategy solved again reports only that compile's stops", (t) => {
  // Each stop is made to happen once, by throwing the ceiling's own error,
  // and the same strategy then solves again with nothing stopped.
  const original = ParetoKvUnifiedPolicySolver.prototype.solve;
  const cases: Array<[string, (solver: ParetoKvUnifiedPolicySolver, options: ParetoSolveOptions) => boolean, KvUnifiedOptions, typeof WALL]> = [
    ['live', (solver) => !isWhatIf(solver), { policy: POLICY, ...GRID, labelCeiling: 1_000_000 }, WALL],
    ['joint and what-ifs', (solver) => isWhatIf(solver), { policy: POLICY, ...GRID, labelCeiling: 1_000_000, latentDemand: { ...DEMAND, mode: 'joint' } }, WALL],
    ['gate', (solver, options) => !isWhatIf(solver) && options.hysteresisCertificate === false, { ...certifiedBase('individual', {}), reuse: undefined }, CERTIFIED_WALL],
  ];
  for (const [stop, stopsHere, options, wall] of cases) {
    const strategy = new KvUnifiedStrategy(options);
    const mocked = t.mock.method(ParetoKvUnifiedPolicySolver.prototype, 'solve', function (this: ParetoKvUnifiedPolicySolver, solveOptions: ParetoSolveOptions) {
      if (stopsHere(this, solveOptions)) throw new SparseLabelCeilingError(1_000, 1_001);
      return original.call(this, solveOptions);
    });
    strategy.solve(fixture(), wall);
    mocked.mock.restore();
    assert.ok(strategy.lastTimings?.ceiling, `${stop}: premise: the ceiling stopped something`);
    strategy.solve(fixture(), wall);
    assert.equal(strategy.lastTimings?.ceiling, undefined, `${stop}: nothing is left of it at the next solve`);
  }
});

test('the ceiling mark names what the ceiling stopped', () => {
  const hit: KvUnifiedCeilingHit = { ceiling: 10, labels: 16, engine: 'packed' };
  assert.equal(ceilingMark(undefined), undefined);
  assert.equal(ceilingMark({ whatIfs: 0, gate: false, joint: false }), undefined);
  assert.equal(ceilingMark({ live: hit, whatIfs: 0, gate: false, joint: false }), 'live');
  assert.equal(ceilingMark({ whatIfs: 1, gate: false, joint: false }), 'whatIfs:1');
  assert.equal(ceilingMark({ whatIfs: 0, gate: true, joint: false }), 'gate');
  assert.equal(ceilingMark({ whatIfs: 2, gate: true, joint: true }), 'joint+gate+whatIfs:2');
});
