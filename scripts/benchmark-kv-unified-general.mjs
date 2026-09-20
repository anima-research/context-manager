// Offline structural fixture only. The certificate is always disabled.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CanonicalSummaryForest } from '../src/adaptive/kv-unified.ts';
import { ParetoKvUnifiedPolicySolver } from '../src/adaptive/kv-unified-pareto.ts';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
if (!arg('--fixture')) throw new Error('--fixture PATH required');
const fixture = JSON.parse(fs.readFileSync(arg('--fixture'), 'utf8'), (_key, value) =>
  value?.$map ? new Map(value.$map) : value?.$set ? new Set(value.$set) : value);
const { inputs } = fixture;
const changes = [];
if (process.argv.includes('--pin')) {
  const chunk = inputs.chunks.find((chunk, index) => index > inputs.chunks.length / 2 &&
    chunk.currentResolution > 0 && !inputs.headChunkIds.has(chunk.id) && !inputs.tailChunkIds.has(chunk.id));
  if (!chunk) throw new Error('no folded middle leaf available to pin');
  chunk.pinned = true;
  changes.push({ pinned: chunk.id });
}
if (arg('--append-tokens')) {
  let remaining = Number(arg('--append-tokens'));
  let sequence = inputs.chunks.at(-1).sequence;
  while (remaining > 0) {
    const rawTokens = Math.min(10000, remaining);
    const id = `__benchmark_append_${++sequence}`;
    inputs.chunks.push({ id, sequence, rawTokens, currentResolution: 0, lockedByAgent: false, pinned: false });
    inputs.tailChunkIds.add(id);
    inputs.tailTokens += rawTokens;
    remaining -= rawTokens;
  }
  changes.push({ appendedTokens: Number(arg('--append-tokens')) });
}
const phases = [];
const diagnosticStop = new Error('diagnostic stopped after propagation; no layout selected');
const options = {
  ...fixture.options, hysteresisCertificate: false,
  ...(arg('--budget') ? { maxTokens: Number(arg('--budget')) } : {}),
  ...(process.argv.includes('--warm') ? { currentImmutablePrefixHash: fixture.options.cache?.immutablePrefixHash } : {}),
  ...(process.argv.includes('--initial') ? { presentation: undefined, cache: undefined } : {}),
  onProgress: (event) => {
    const data = { ...event, rssMB: process.memoryUsage().rss / 1e6 };
    phases.push(data);
    console.error(JSON.stringify(data));
    if (event.phase === 'propagated' && process.argv.includes('--stop-after-propagation')) throw diagnosticStop;
  },
};
const started = performance.now();
const forest = new CanonicalSummaryForest(inputs, fixture.forestOptions);
try {
  const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve(options);
  const report = { ms: performance.now() - started, rssMB: process.memoryUsage().rss / 1e6,
    feasible: result.feasible, phases, maxTokens: options.maxTokens,
    warm: Boolean(options.cache && options.currentImmutablePrefixHash === options.cache.immutablePrefixHash),
    initial: !options.presentation, changes, certificateEnabled: false };
  if (result.feasible) {
    const frontier = [...result.selected.frontier].sort(([a], [b]) => a.localeCompare(b));
    Object.assign(report, {
      tokens: result.selected.renderedTokens, score: result.selected.score,
      cacheFloor: result.cacheFloor, continuityFloor: result.continuityFloor,
      moves: inputs.chunks.filter((chunk) => (result.selected.frontier.get(chunk.id) ?? 0) !== (chunk.currentResolution ?? 0)).length,
      frontierHash: createHash('sha256').update(JSON.stringify(frontier)).digest('hex'),
      propagation: result.propagation,
    });
  }
  if (arg('--report')) fs.writeFileSync(arg('--report'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (error !== diagnosticStop) throw error;
  console.log(JSON.stringify({ diagnosticOnly: true, ms: performance.now() - started, phases }));
}
