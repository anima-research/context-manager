/** Offline only. Run with Bun so the pinned runtime's TypeScript is loaded.
 * --capture --runtime PATH --store-copy PATH --recipe PATH --fixture PATH
 * --fixture PATH [--baseline] [--report PATH]
 * --compile --runtime PATH --store-copy PATH --recipe PATH [--report PATH]
 * Capture stops before the original solver runs. No provider is instantiated.
 * Always pass a disposable, checksum-verified store copy, never a live store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { CanonicalSummaryForest } from '../src/adaptive/kv-unified.ts';
import { ParetoKvUnifiedPolicySolver } from '../src/adaptive/kv-unified-pareto.ts';
import { certifyCarriedLayout } from '../src/adaptive/kv-unified-certificate.ts';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const fixturePath = arg('--fixture');
const compiling = process.argv.includes('--compile');
if (!fixturePath && !compiling) throw new Error('--fixture PATH is required');
const replacer = (key, value) => {
  if (key === 'content' || key === 'responseContent') return undefined;
  if (value instanceof Map) return { $map: [...value] };
  if (value instanceof Set) return { $set: [...value] };
  return value;
};
const reviver = (_key, value) => value?.$map ? new Map(value.$map) : value?.$set ? new Set(value.$set) : value;

let fixture;
if (process.argv.includes('--capture') || compiling) {
  const runtime = arg('--runtime');
  const storePath = arg('--store-copy');
  const recipePath = arg('--recipe');
  if (!runtime || !storePath || !recipePath) throw new Error('capture requires --runtime, --store-copy, --recipe');
  if (!compiling && fs.existsSync(fixturePath)) throw new Error('refusing to overwrite an existing fixture');
  const load = (relative) => import(pathToFileURL(path.join(runtime, relative)).href);
  const { ContextManager } = await load('context-manager/src/context-manager.ts');
  const { AutobiographicalStrategy } = await load('context-manager/src/strategies/autobiographical.ts');
  const { ParetoKvUnifiedPolicySolver: PinnedSolver } = await load('context-manager/src/adaptive/kv-unified-pareto.ts');
  const { buildFrameworkStrategy } = await load('forking-knowledge-miner/src/framework-strategy.ts');
  const { validateRecipe } = await load('forking-knowledge-miner/src/recipe.ts');
  const recipe = validateRecipe(JSON.parse(fs.readFileSync(recipePath, 'utf8')));
  const configured = buildFrameworkStrategy(recipe, recipe.agent.model, 'America/Los_Angeles');
  const strategy = new AutobiographicalStrategy(configured.config);
  const stop = new Error('offline solver inputs captured');
  const compileSolves = [];
  const original = PinnedSolver.prototype.solve;
  PinnedSolver.prototype.solve = function (options) {
    if (compiling) {
      const started = performance.now();
      const result = process.argv.includes('--general')
        ? new ParetoKvUnifiedPolicySolver(this.inputs, this.forest).solve({ ...options, hysteresisCertificate: false })
        : certifyCarriedLayout(this.inputs, this.forest, options);
      if (!result) throw new Error('compile reached an uncertified solve; expensive fallback was not run');
      compileSolves.push({ ms: performance.now() - started,
        certificate: result.certificate ?? null, propagation: result.propagation ?? null });
      return result;
    }
    fixture = {
      inputs: this.inputs, options,
      forestOptions: { preserveGapBearingSummaries: true },
    };
    throw stop;
  };
  const manager = await ContextManager.open({ path: storePath, strategy, namespace: 'agents/Sill' });
  let compileReport;
  try {
    const started = performance.now();
    const result = await manager.compile({ maxTokens: 560000, reserveForResponse: 32000 });
    if (!compiling) throw new Error('expected to stop at the policy solver');
    compileReport = { compileMs: performance.now() - started,
      messages: result.messages.length, rssMB: process.memoryUsage().rss / 1e6,
      solves: compileSolves };
  } catch (error) {
    if (error !== stop) throw error;
  } finally {
    PinnedSolver.prototype.solve = original;
    await manager.close();
  }
  if (compiling) {
    if (arg('--report')) fs.writeFileSync(arg('--report'), JSON.stringify(compileReport, null, 2));
    console.log(JSON.stringify(compileReport, null, 2));
    process.exit(0);
  }
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, replacer));
  // Benchmark the same structural-only payload used for future replays.
}
fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'), reviver);
const { inputs, options, forestOptions } = fixture;
const digest = (frontier) => createHash('sha256')
  .update(JSON.stringify([...frontier].sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
const report = { chunks: inputs.chunks.length, summaries: inputs.summaries.size,
  maxTokens: options.maxTokens,
  savedFrontierHash: digest(new Map(inputs.chunks.map((chunk) => [chunk.id, chunk.currentResolution ?? 0]))),
  runs: [] };
for (let repeat = 0; repeat < 3; repeat++) {
  const started = performance.now();
  const forest = new CanonicalSummaryForest(inputs, forestOptions);
  const built = performance.now();
  const result = certifyCarriedLayout(inputs, forest, options);
  const finished = performance.now();
  if (!result) throw new Error('repro did not certify; original solver was not run');
  report.runs.push({
    forestMs: built - started, certificateMs: finished - built, totalMs: finished - started,
    rssMB: process.memoryUsage().rss / 1e6,
    tokens: result.selected.renderedTokens, frontierHash: digest(result.selected.frontier),
    ...result.certificate,
  });
}
report.matchesSavedFrontier = report.runs.every((run) => run.frontierHash === report.savedFrontierHash);
// Preserve completed certificate measurements even if an optional expensive
// baseline is interrupted. Its final result is appended only on completion.
if (arg('--report')) fs.writeFileSync(arg('--report'), JSON.stringify(report, null, 2));
if (process.argv.includes('--baseline')) {
  const started = performance.now();
  const forest = new CanonicalSummaryForest(inputs, forestOptions);
  const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve(options);
  if (!result.feasible) throw new Error('baseline is infeasible');
  report.baseline = {
    ms: performance.now() - started, rssMB: process.memoryUsage().rss / 1e6,
    tokens: result.selected.renderedTokens, score: result.selected.score,
    frontierHash: digest(result.selected.frontier), propagation: result.propagation,
  };
  if (report.baseline.frontierHash !== report.runs[0].frontierHash) {
    throw new Error('baseline and certificate selected different frontiers');
  }
}
if (arg('--report')) fs.writeFileSync(arg('--report'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
