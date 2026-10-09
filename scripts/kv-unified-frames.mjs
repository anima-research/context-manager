// Latent-demand benefit under different floor frames, on a public synthetic fixture.
//
// Each solve measures its penalties from its own pool's floors, so subtracting
// two solves' selected scores compares different frames. This prints the
// benefit of one what-if merge under every frame, with exact enumeration on
// both forests as ground truth. Run after `npm run build`:
//
//   node scripts/kv-unified-frames.mjs [fixture.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(process.argv[2] ?? path.join(here, '../test/fixtures/kv-unified-frames.public.json'));
const value = JSON.parse(fs.readFileSync(fixture, 'utf8'), (_k, v) => v?.$map ? new Map(v.$map) : v?.$set ? new Set(v.$set) : v);
const { ParetoKvUnifiedPolicySolver: Solver } = await import('../dist/src/adaptive/kv-unified-pareto.js');
const { KvUnifiedStrategy: Adapter } = await import('../dist/src/adaptive/strategies/kv-unified.js');
const { ExactKvUnifiedPolicySolver: Exact, policyScore, normalizePolicy, normalizeContinuityMultiplier } =
  await import('../dist/src/adaptive/kv-unified-policy.js');

const trace = [];
const original = Solver.prototype.solve;
Solver.prototype.solve = function (options) {
  const result = original.call(this, options);
  trace.push({ result, forest: this.forest, inputs: this.inputs, options });
  return result;
};
let solution;
try { solution = new Adapter(value.options).solve(value.inputs, value.budget); } finally { Solver.prototype.solve = original; }
const [base, ...whatIfs] = trace;
const whatIf = whatIfs[0];
if (!base?.result.feasible || !whatIf?.result.feasible) throw new Error('expected a feasible base and what-if solve');

const policy = normalizePolicy(value.options.policy);
const multiplier = normalizeContinuityMultiplier(value.options.continuityMultiplier);
const score = (c, kf, cf) => policyScore(c.fidelityLoss, c.budgetPenalty, c.cacheChurn, c.continuityLoss, kf, cf, policy, multiplier);
const bestUnder = (candidates, kf, cf) => Math.min(...candidates.map((c) => score(c, kf, cf)));
const exactOptions = (o) => ({ ...o, maxLeaves: 1_000_000, maxCandidates: 1_000_000, candidateSource: 'recursive' });
const exactBase = new Exact(base.inputs, base.forest).solve(exactOptions(base.options));
const exactWhatIf = new Exact(whatIf.inputs, whatIf.forest).solve(exactOptions(whatIf.options));
if (!exactBase.feasible || !exactWhatIf.feasible) throw new Error('exact enumeration infeasible');

const b = base.result, w = whatIf.result;
const sharedK = Math.min(exactBase.cacheFloor, exactWhatIf.cacheFloor);
const sharedC = Math.min(exactBase.continuityFloor, exactWhatIf.continuityFloor);
const frames = {
  'cross-solve (selected scores, own floors)': b.selected.score - w.selected.score,
  'exact cross-solve (exact floors per forest)': exactBase.selected.score - exactWhatIf.selected.score,
  'incumbent repriced under what-if floors': score(b.selected, w.cacheFloor, w.continuityFloor) - w.selected.score,
  'exact, shared floors': bestUnder(exactBase.candidates, sharedK, sharedC) - bestUnder(exactWhatIf.candidates, sharedK, sharedC),
  'pareto pools rescored under shared floors (strategy)': bestUnder(b.candidates, Math.min(b.cacheFloor, w.cacheFloor), Math.min(b.continuityFloor, w.continuityFloor))
    - bestUnder(w.candidates, Math.min(b.cacheFloor, w.cacheFloor), Math.min(b.continuityFloor, w.continuityFloor)),
  'exact, base floors': bestUnder(exactBase.candidates, exactBase.cacheFloor, exactBase.continuityFloor) - bestUnder(exactWhatIf.candidates, exactBase.cacheFloor, exactBase.continuityFloor),
};
console.log(JSON.stringify({
  fixture: path.relative(process.cwd(), fixture),
  requests: solution.produced.length,
  floors: { base: [b.cacheFloor, b.continuityFloor], whatIf: [w.cacheFloor, w.continuityFloor], exactBase: [exactBase.cacheFloor, exactBase.continuityFloor], exactWhatIf: [exactWhatIf.cacheFloor, exactWhatIf.continuityFloor] },
  pools: { base: b.candidates.length, whatIf: w.candidates.length, exactBase: exactBase.candidates.length, exactWhatIf: exactWhatIf.candidates.length },
  frames,
}, null, 2));
