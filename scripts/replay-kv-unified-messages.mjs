// Sequential message-prefix replay; no provider calls and no store writes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CanonicalSummaryForest } from '../src/adaptive/kv-unified.ts';
import { ParetoKvUnifiedPolicySolver } from '../src/adaptive/kv-unified-pareto.ts';
import { SummaryTree } from '../src/adaptive/summary-tree.ts';
import { renderLayout } from '../src/adaptive/render-offsets.ts';

const arg = (name) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const fixturePath = arg('--fixture');
const metadataPath = arg('--metadata');
const output = arg('--output');
if (!fixturePath || !metadataPath || !output) throw new Error('--fixture, --metadata and --output required');
if (fs.existsSync(output)) throw new Error('output directory must be new');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'), (_key, value) =>
  value?.$map ? new Map(value.$map) : value?.$set ? new Set(value.$set) : value);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const full = [...fixture.inputs.chunks].sort((a, b) => a.sequence - b.sequence);
const count = Number(arg('--count') ?? 500);
const limit = Number(arg('--limit') ?? count);
if (!Number.isInteger(count) || count < 1 || count >= full.length || !Number.isInteger(limit) || limit < 1 || limit > count) {
  throw new Error('invalid count/limit');
}
if (metadata.messages.length !== full.length || full.some((chunk, index) =>
  chunk.id !== metadata.messages[index].id || chunk.sequence !== index)) throw new Error('metadata does not match fixture order');
const first = full.length - count;
const indexById = new Map(full.map((chunk, index) => [chunk.id, index]));
const rawTokens = metadata.messages.map((message) => metadata.maxMessageTokens > 0
  ? Math.min(message.postStripTokens, metadata.maxMessageTokens + 50) : message.postStripTokens);
if (full.some((chunk, index) => chunk.rawTokens !== rawTokens[index])) throw new Error('exported costs differ from fixture');
const rawPrefix = [0];
for (const tokens of rawTokens) rawPrefix.push(rawPrefix.at(-1) + tokens);
const summaries = fixture.inputs.summaries;
const lastSource = new Map();
const visiting = new Set();
function lastSourceIndex(id) {
  if (lastSource.has(id)) return lastSource.get(id);
  if (visiting.has(id)) throw new Error('summary cycle');
  visiting.add(id);
  const summary = summaries.get(id);
  const end = !summary ? Infinity : summary.sourceIds.reduce((last, source) => Math.max(last,
    summary.level === 1 ? (indexById.get(source) ?? -1) : lastSourceIndex(source)), -1);
  visiting.delete(id);
  lastSource.set(id, end);
  return end;
}
for (const id of summaries.keys()) lastSourceIndex(id);
const l1Candidates = new Map();
for (const summary of summaries.values()) if (summary.level === 1) for (const id of summary.sourceIds) {
  const candidates = l1Candidates.get(id);
  if (candidates) candidates.push(summary.id); else l1Candidates.set(id, [summary.id]);
}

function inputsAt(length, previous) {
  let tailStart = 0;
  let tokens = 0;
  for (let i = length - 1; i >= 0; i--) {
    tokens += metadata.messages[i].postStripTokens;
    if (tokens > metadata.recentWindowTokens) {
      tailStart = i + 1;
      if (tailStart > 0 && tailStart < length && metadata.messages[tailStart].toolResult) tailStart--;
      break;
    }
  }
  tailStart = Math.max(tailStart, metadata.headEnd);
  const headIds = new Set(full.slice(metadata.headStart, metadata.headEnd).map((chunk) => chunk.id));
  const tailIds = new Set(full.slice(tailStart, length).map((chunk) => chunk.id));
  const available = new Set([...summaries.keys()].filter((id) => lastSource.get(id) < length));
  const visibleSummaries = new Map();
  for (const [id, summary] of summaries) if (available.has(id)) {
    const entry = { ...summary };
    if (entry.parentId && !available.has(entry.parentId)) delete entry.parentId;
    if (entry.mergedInto && !available.has(entry.mergedInto)) delete entry.mergedInto;
    visibleSummaries.set(id, entry);
  }
  const chunks = full.slice(0, length).map((chunk, index) => {
    const external = headIds.has(chunk.id) || tailIds.has(chunk.id);
    const meta = metadata.messages[index];
    const l1Id = available.has(chunk.l1Id) ? chunk.l1Id : l1Candidates.get(chunk.id)?.find((id) => available.has(id));
    return {
      ...chunk, rawTokens: rawTokens[index], currentResolution: external ? 0 : (previous?.get(chunk.id) ?? chunk.currentResolution),
      pinned: external || meta.pinned, l1Id: external ? undefined : l1Id,
      pinLevel: external ? undefined : meta.pinLevel, pinMaxLevel: external ? undefined : meta.pinMaxLevel,
      salience: external ? undefined : meta.salience,
    };
  });
  return {
    chunks, summaries: visibleSummaries, recallPairTokens: fixture.inputs.recallPairTokens,
    headChunkIds: headIds, tailChunkIds: tailIds,
    headTokens: rawPrefix[metadata.headEnd] - rawPrefix[metadata.headStart],
    tailTokens: rawPrefix[length] - rawPrefix[tailStart],
  };
}

// Match the host's token-weighted 33/66/100 history boundaries and tail end
// in the solver's atomic layout model, not provider wire bytes.
function markersFor(layout) {
  const end = layout.units.length;
  const historyEnd = end - (layout.units.at(-1)?.kind === 'tail' ? 1 : 0);
  const offset = (index) => index === end ? layout.totalTokens : layout.units[index]?.offset ?? 0;
  const marks = new Set();
  for (const fraction of [1 / 3, 2 / 3]) if (historyEnd > 0) {
    const target = offset(historyEnd) * fraction;
    let best = 1;
    for (let index = 2; index <= historyEnd; index++) if (Math.abs(offset(index) - target) < Math.abs(offset(best) - target)) best = index;
    marks.add(best);
  }
  if (historyEnd > 0) marks.add(historyEnd);
  if (end > 0) marks.add(end);
  return [...marks].sort((a, b) => a - b).map((unitIndex) => ({ unitIndex, offset: offset(unitIndex) }));
}

const finalInputs = inputsAt(full.length);
if (finalInputs.headTokens !== fixture.inputs.headTokens || finalInputs.tailTokens !== fixture.inputs.tailTokens ||
  [...finalInputs.tailChunkIds].some((id) => !fixture.inputs.tailChunkIds.has(id))) throw new Error('reconstructed final raw windows differ');
const finalForest = new CanonicalSummaryForest(finalInputs, fixture.forestOptions);
const saved = new Map(full.map((chunk) => [chunk.id, chunk.currentResolution]));
const originalForest = new CanonicalSummaryForest(fixture.inputs, fixture.forestOptions);
if (finalForest.tokensForFrontier(saved) !== originalForest.tokensForFrontier(saved)) throw new Error('reconstructed final accounting differs');

fs.mkdirSync(output, { recursive: true });
const config = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  kind: 'controlled-message-prefix-replay', requestedSamples: count, samplesToRun: limit,
  fromMessage: full[first].id, toMessage: full[first + limit - 1].id,
  fromTimestamp: new Date(metadata.messages[first].timestamp).toISOString(),
  toTimestamp: new Date(metadata.messages[first + limit - 1].timestamp).toISOString(),
  prefixMessages: first, snapshotMessages: full.length, maxTokens: fixture.options.maxTokens,
  tailWindowTokens: metadata.recentWindowTokens, certificateEnabled: false,
  presentation: 'one initial warm-up excluded; each successful message-prefix solve accepted before the next',
  cache: 'previous accepted atomic layout; fresh token-weighted markers; stable immutable prefix; no wall-clock TTL simulation',
  summaries: 'snapshot catalogue, exclude future-source summaries; not historical compression-time reconstruction',
  timing: 'canonical forest + solver construction + solve + selected frontier materialization; excludes input preparation and receipt construction',
  fixturePath, metadataPath, startedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify(config, null, 2));
console.log(JSON.stringify({ event: 'start', ...config }));
const rows = [];
let previous;
let presentation;
let cache;
let sequence = 0;
const prefixHash = 'offline-replay-stable-prefix';
let lastProgress = performance.now();
function summary() {
  const times = rows.filter((row) => row.ok).map((row) => row.solveMs).sort((a, b) => a - b);
  const quantile = (p) => times.length ? times[Math.max(0, Math.ceil(p * times.length) - 1)] : null;
  const histogram = [];
  let previousBound = 0;
  for (const upper of [1000, 2000, 5000, 10000, 20000, 30000, 60000, Infinity]) {
    histogram.push({ fromMs: previousBound, belowMs: Number.isFinite(upper) ? upper : null,
      count: times.filter((time) => time >= previousBound && time < upper).length });
    previousBound = upper;
  }
  return {
    completed: rows.length, successes: times.length, failures: rows.length - times.length,
    percentileMethod: 'nearest rank', minMs: times[0] ?? null,
    meanMs: times.length ? times.reduce((sum, value) => sum + value, 0) / times.length : null,
    medianMs: quantile(0.5), p90Ms: quantile(0.9), p95Ms: quantile(0.95), p99Ms: quantile(0.99), maxMs: times.at(-1) ?? null,
    histogram, maxRssMB: Math.max(0, ...rows.map((row) => row.rssMB)),
    movementSolves: rows.filter((row) => row.ok && row.moves > 0).length,
    slowest: rows.filter((row) => row.ok).sort((a, b) => b.solveMs - a.solveMs).slice(0, 10),
    updatedAt: new Date().toISOString(),
  };
}
for (let step = 0; step <= limit; step++) {
  const iterationStarted = performance.now();
  const length = first + step;
  const inputs = inputsAt(length, previous);
  const row = { step, warmup: step === 0, messageId: full[length - 1].id, visibleMessages: length,
    summaries: inputs.summaries.size, tailMessages: inputs.tailChunkIds.size, tailTokens: inputs.tailTokens };
  const solveStarted = performance.now();
  try {
    const forest = new CanonicalSummaryForest(inputs, fixture.forestOptions);
    const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({
      ...fixture.options, hysteresisCertificate: false, presentation, cache,
      currentImmutablePrefixHash: cache ? prefixHash : undefined,
      onProgress: (event) => {
        if (performance.now() - lastProgress > 30000) {
          console.log(JSON.stringify({ event: 'solving', step, ...event }));
          lastProgress = performance.now();
        }
      },
    });
    if (!result.feasible) throw new Error(`infeasible: ${JSON.stringify(result.feasibility)}`);
    const frontier = result.selected.frontier;
    row.solveMs = performance.now() - solveStarted;
    row.ok = true;
    row.tokens = result.selected.renderedTokens;
    row.moves = inputs.chunks.filter((chunk) => (frontier.get(chunk.id) ?? 0) !== chunk.currentResolution).length;
    row.labels = result.propagation?.terminalLabels;
    row.maxLabelsPerState = result.propagation?.maxLabelsPerState;
    sequence++;
    const leaves = new Map();
    for (const chunk of inputs.chunks) {
      const level = frontier.get(chunk.id) ?? 0;
      const id = level === 0 ? undefined : forest.leaf(chunk.id).summaryIds.find((id) => forest.summary(id).level === level);
      const repHash = level === 0 ? `raw:${chunk.id}` : `summary:${id}`;
      const prior = presentation?.leaves.get(chunk.id);
      leaves.set(chunk.id, { level, repHash,
        lastChangedSeq: prior?.level === level && prior?.repHash === repHash ? prior.lastChangedSeq : sequence });
    }
    presentation = { currentSeq: sequence, leaves };
    const layout = renderLayout(inputs, new SummaryTree(inputs), frontier);
    cache = { immutablePrefixHash: prefixHash, layout, markers: markersFor(layout) };
    previous = frontier;
  } catch (error) {
    row.ok = false;
    row.solveMs = performance.now() - solveStarted;
    row.error = String(error?.stack ?? error);
    console.error(JSON.stringify({ event: 'failure', ...row }));
  }
  row.iterationMs = performance.now() - iterationStarted;
  row.rssMB = process.memoryUsage().rss / 1e6;
  fs.appendFileSync(path.join(output, 'rows.jsonl'), JSON.stringify(row) + '\n');
  if (step === 0) {
    if (!row.ok) throw new Error('warm-up failed; no replay samples recorded');
    console.log(JSON.stringify({ event: 'warmup', ...row }));
  } else {
    rows.push(row);
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary(), null, 2));
    if (step % 5 === 0 || step === limit) {
      console.log(JSON.stringify({ event: 'progress', completed: step, lastSolveMs: row.solveMs,
        medianMs: summary().medianMs, p95Ms: summary().p95Ms, failures: summary().failures, rssMB: row.rssMB }));
      lastProgress = performance.now();
    }
  }
}
console.log(JSON.stringify({ event: 'complete', ...summary() }));
