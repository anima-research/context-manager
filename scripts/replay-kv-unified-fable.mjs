import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

// Aggregate-only historical replay for the Fable Phase-0/2 gate. The three
// inputs contain structural picker state, message timestamps, and per-call
// usage/shape metadata; raw request payload tapes remain on the Fable box.

import { CanonicalSummaryForest } from '../dist/src/adaptive/kv-unified.js';
import { ParetoKvUnifiedPolicySolver } from '../dist/src/adaptive/kv-unified-pareto.js';
import { SummaryTree } from '../dist/src/adaptive/summary-tree.js';
import { renderLayout } from '../dist/src/adaptive/render-offsets.js';

const fixtureDir = process.argv.find((arg) => arg.startsWith('--fixture-dir='))?.slice(14);
if (!fixtureDir) {
  throw new Error(
    'usage: node scripts/replay-kv-unified-fable.mjs --fixture-dir=<aggregate-directory> [options]',
  );
}
const fixture = (name) => path.resolve(fixtureDir, name);
const payload = JSON.parse(fs.readFileSync(fixture('fable-picker-live-cleanup-ready.json')));
const timeline = JSON.parse(fs.readFileSync(fixture('fable-message-timeline-20260831.json')));
const allCalls = JSON.parse(fs.readFileSync(fixture('fable-stream-call-metadata.json')));
const cutoff = Date.parse(process.argv.find((arg) => arg.startsWith('--to='))?.slice(5) ?? '2026-08-28T17:00:55Z');
const limit = Number(process.argv.find((arg) => arg.startsWith('--limit='))?.slice(8) ?? Infinity);
const W = Number(process.argv.find((arg) => arg.startsWith('--budget='))?.slice(9) ?? 400_000);
const cacheLambda = Number(process.argv.find((arg) => arg.startsWith('--cache-lambda='))?.slice(15) ?? 0);
const continuityLambda = Number(process.argv.find((arg) => arg.startsWith('--continuity-lambda='))?.slice(20) ?? 1);
const solveStride = Number(process.argv.find((arg) => arg.startsWith('--solve-stride='))?.slice(15) ?? 10);
const simulateKeepalives = !process.argv.includes('--no-keepalives');
const keepaliveMaxIdleHours = Number(
  process.argv.find((arg) => arg.startsWith('--keepalive-max-idle-hours='))?.slice(27) ?? 6,
);
const periodCalls = allCalls.filter((call) => call.start <= cutoff);
const calls = periodCalls.slice(0, limit);
if (calls.length === 0) throw new Error('no calls fall inside the requested replay period');

const fullChunks = payload.chunks;
const fullSummaries = payload.summaries;
const summaryById = new Map(fullSummaries.map((summary) => [summary.id, summary]));
const recallTokens = new Map(payload.recallPairTokens);
const messageIndex = new Map(fullChunks.map((chunk, index) => [chunk.id, index]));
const timestamps = timeline.map((entry) => entry.timestamp);

function parentId(summary) { return summary.parentId ?? summary.mergedInto; }

const spanMemo = new Map();
function spanOf(id, visiting = new Set()) {
  if (spanMemo.has(id)) return spanMemo.get(id);
  if (visiting.has(id)) return { first: Infinity, last: -Infinity };
  visiting.add(id);
  const summary = summaryById.get(id);
  let first = Infinity, last = -Infinity;
  if (summary?.level === 1) {
    for (const sourceId of summary.sourceIds) {
      const index = messageIndex.get(sourceId);
      if (index !== undefined) { first = Math.min(first, index); last = Math.max(last, index); }
    }
  } else if (summary) {
    for (const childId of summary.sourceIds) {
      const child = spanOf(childId, visiting);
      first = Math.min(first, child.first); last = Math.max(last, child.last);
    }
  }
  visiting.delete(id);
  const span = { first, last };
  spanMemo.set(id, span);
  return span;
}
for (const summary of fullSummaries) spanOf(summary.id);

function messageCountAt(time) {
  let lo = 0, hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, fullChunks.length);
}

function inputsAt(time, M, previousFrontier) {
  const visibleChunks = fullChunks.slice(0, M);
  const visibleHeadChunkIds = new Set();
  const visibleTailChunkIds = new Set();
  let headTokens = 0;
  for (const chunk of visibleChunks) {
    if (headTokens + chunk.rawTokens > 4_000) break;
    visibleHeadChunkIds.add(chunk.id); headTokens += chunk.rawTokens;
  }
  let tailTokens = 0;
  for (let index = visibleChunks.length - 1; index >= 0; index--) {
    const chunk = visibleChunks[index];
    if (visibleHeadChunkIds.has(chunk.id) || tailTokens + chunk.rawTokens > 30_000) break;
    visibleTailChunkIds.add(chunk.id); tailTokens += chunk.rawTokens;
  }
  const foldableChunks = visibleChunks.filter(
    (chunk) => !visibleHeadChunkIds.has(chunk.id) && !visibleTailChunkIds.has(chunk.id),
  );
  const firstFoldable = foldableChunks[0]?.sequence ?? Infinity;
  const lastFoldable = foldableChunks.at(-1)?.sequence ?? -Infinity;
  const availableIds = new Set();
  for (const summary of fullSummaries) {
    const span = spanMemo.get(summary.id);
    if (
      summary.created <= time && span &&
      span.first >= firstFoldable && span.last <= lastFoldable
    ) availableIds.add(summary.id);
  }
  const summaries = new Map();
  for (const summary of fullSummaries) {
    if (!availableIds.has(summary.id)) continue;
    const copy = { ...summary };
    const parent = parentId(summary);
    if (!parent || !availableIds.has(parent)) {
      delete copy.parentId;
      delete copy.mergedInto;
    }
    summaries.set(copy.id, copy);
  }
  const chunks = foldableChunks.map((chunk) => ({
    ...chunk,
    currentResolution: previousFrontier?.get(chunk.id) ?? 0,
    ...(chunk.l1Id && availableIds.has(chunk.l1Id) ? {} : { l1Id: undefined }),
  }));
  return {
    chunks,
    summaries,
    recallPairTokens: recallTokens,
    headTokens,
    tailTokens,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
    visibleChunks,
    visibleHeadChunkIds,
    visibleTailChunkIds,
  };
}

function representation(forest, chunkId, level) {
  if (level === 0) return `raw:${chunkId}`;
  const leaf = forest.leaf(chunkId);
  const summaryId = leaf?.summaryIds.find((id) => forest.summary(id)?.level === level);
  return `summary:${summaryId}`;
}

function acceptedPresentation(forest, inputs, frontier, previous, sequence) {
  const leaves = new Map();
  for (const chunk of inputs.visibleChunks) {
    const external = inputs.visibleHeadChunkIds.has(chunk.id) || inputs.visibleTailChunkIds.has(chunk.id);
    const level = external ? 0 : frontier.get(chunk.id) ?? 0;
    const repHash = external ? `raw:${chunk.id}` : representation(forest, chunk.id, level);
    const prior = previous?.leaves.get(chunk.id);
    leaves.set(chunk.id, {
      repHash,
      level,
      lastChangedSeq: prior && prior.repHash === repHash && prior.level === level
        ? prior.lastChangedSeq : sequence,
    });
  }
  return { currentSeq: sequence, leaves };
}

function chainFor(inputs, forest, frontier) {
  const units = [];
  const emitted = new Set();
  let historyEnd = 0;
  for (const chunk of inputs.visibleChunks) {
    const external = inputs.visibleHeadChunkIds.has(chunk.id) || inputs.visibleTailChunkIds.has(chunk.id);
    if (external || (frontier.get(chunk.id) ?? 0) === 0) {
      units.push({ id: `raw:${chunk.id}`, tokens: chunk.rawTokens, tail: inputs.visibleTailChunkIds.has(chunk.id) });
    } else {
      const level = frontier.get(chunk.id) ?? 0;
      const leaf = forest.leaf(chunk.id);
      const summaryId = leaf.summaryIds.find((id) => forest.summary(id)?.level === level);
      if (!summaryId || emitted.has(summaryId)) continue;
      emitted.add(summaryId);
      units.push({ id: `summary:${summaryId}`, tokens: forest.summary(summaryId).recallTokens, tail: false });
    }
    if (!inputs.visibleTailChunkIds.has(chunk.id)) historyEnd = units.length;
  }
  return { units, historyEnd };
}

function thirdsMarkers(chain) {
  const cumulative = [0];
  for (const unit of chain.units) cumulative.push(cumulative.at(-1) + unit.tokens);
  const history = chain.historyEnd;
  const marks = [];
  for (const fraction of [1 / 3, 2 / 3]) {
    const target = cumulative[history] * fraction;
    let best = 1;
    for (let index = 1; index <= history; index++) {
      if (Math.abs(cumulative[index] - target) < Math.abs(cumulative[best] - target)) best = index;
    }
    marks.push(best);
  }
  marks.push(history, chain.units.length);
  return [...new Set(marks)].sort((a, b) => a - b);
}

class CacheSim {
  entries = new Map();
  lineages = new Map();
  nextKeepaliveTick = null;
  keepalive = {
    enabled: simulateKeepalives,
    refreshAfterMs: 45 * 60_000,
    checkIntervalMs: 5 * 60_000,
    maxIdleMs: keepaliveMaxIdleHours * 60 * 60_000,
    refreshed: 0,
    ineffective: 0,
    expiredLineages: 0,
    readTokens: 0,
    writeTokens: 0,
  };

  advanceTo(now) {
    if (!simulateKeepalives || this.nextKeepaliveTick === null) return;
    while (this.nextKeepaliveTick <= now) {
      const tick = this.nextKeepaliveTick;
      for (const [key, lineage] of [...this.lineages]) {
        if (tick - lineage.lastRealAt >= this.keepalive.maxIdleMs) {
          this.lineages.delete(key);
          this.keepalive.expiredLineages++;
          continue;
        }
        if (tick - lineage.lastTouchAt < this.keepalive.refreshAfterMs) continue;
        const deepest = lineage.keys.at(-1);
        if (deepest && (this.entries.get(deepest) ?? -1) >= tick) {
          // An exact replay reads the accepted marked prefix. Model that read
          // as refreshing every breakpoint in that byte-identical request,
          // preserving the earlier fallback points for a later rotation.
          for (const markerKey of lineage.keys) this.entries.set(markerKey, tick + 3_600_000);
          lineage.lastTouchAt = tick;
          lineage.ineffective = 0;
          this.keepalive.refreshed++;
          this.keepalive.readTokens += lineage.tokens;
        } else {
          // Match membrane's self-check: the first write-instead-of-read is
          // observed and backed off, rather than silently called a refresh.
          for (const markerKey of lineage.keys) this.entries.set(markerKey, tick + 3_600_000);
          lineage.lastTouchAt = tick;
          lineage.ineffective++;
          this.keepalive.ineffective++;
          this.keepalive.writeTokens += lineage.tokens;
          if (lineage.ineffective >= 2) this.lineages.delete(key);
        }
      }
      this.nextKeepaliveTick += this.keepalive.checkIntervalMs;
    }
  }

  request(call, chain, markers) {
    this.advanceTo(call.start);
    const immutableTokens = Math.round(call.totalTokens * call.immutableCharFraction);
    const desiredContext = Math.max(0, call.totalTokens - immutableTokens);
    const estimatedContext = chain.units.reduce((sum, unit) => sum + unit.tokens, 0);
    const scale = desiredContext / Math.max(1, estimatedContext);
    const ids = [`immutable:${call.immutableHash}`, ...chain.units.map((unit) => unit.id)];
    const tokens = [immutableTokens, ...chain.units.map((unit) => Math.round(unit.tokens * scale))];
    const marked = markers.map((index) => index + 1);
    const prefixKeys = [null];
    const cumulative = [0];
    let hash = Buffer.alloc(0);
    for (let index = 0; index < ids.length; index++) {
      hash = crypto.createHash('sha256').update(hash).update(ids[index]).digest();
      prefixKeys.push(hash.toString('hex'));
      cumulative.push(cumulative.at(-1) + tokens[index]);
    }
    let hit = 0, hitKey = null;
    for (const marker of [...marked].sort((a, b) => b - a)) {
      for (let index = marker; index >= Math.max(1, marker - 20); index--) {
        const key = prefixKeys[index];
        if (key && (this.entries.get(key) ?? -1) >= call.start) {
          hit = index; hitKey = key; break;
        }
      }
      if (hitKey) break;
    }
    const last = Math.max(...marked, 0);
    const read = cumulative[hit];
    const write = Math.max(0, cumulative[last] - read);
    const fresh = Math.max(0, call.totalTokens - read - write);
    if (hitKey) this.entries.set(hitKey, call.start + 3_600_000);
    if (!call.refusal) for (const index of marked) this.entries.set(prefixKeys[index], call.start + 3_600_000);
    if (simulateKeepalives) {
      const lineageKey = call.immutableHash;
      const existing = this.lineages.get(lineageKey);
      this.lineages.delete(lineageKey);
      this.lineages.set(lineageKey, {
        keys: marked.map((index) => prefixKeys[index]),
        tokens: cumulative[last],
        lastRealAt: call.start,
        lastTouchAt: call.start,
        ineffective: existing?.ineffective ?? 0,
      });
      while (this.lineages.size > 4) this.lineages.delete(this.lineages.keys().next().value);
      if (this.nextKeepaliveTick === null) this.nextKeepaliveTick = call.start + this.keepalive.checkIntervalMs;
    }
    return { read, write, fresh, hit, last };
  }
}

const policy = {
  alpha: 0.7,
  budgetLowRatio: 0.7,
  budgetHighRatio: 0.935,
  budgetUnderLambda: 1_000,
  budgetOverLambda: 4_000,
  cacheLambda,
  cacheScale: 100_000,
  cacheReadPrice: 0.1,
  cacheWritePrice: 1.25,
  continuityLambda,
  continuityScale: 100_000,
  continuityRecencyHalfLifeTokens: 100_000,
  continuityRecencyFloor: 0.2,
  continuityStableHalfLife: 16,
  continuityStableFloor: 0.25,
};

let previousFrontier = new Map();
let presentation;
let receiptSequence = 0;
let previousSignature = '';
let previousImmutable = null;
let previousCallStart = null;
let previousRefusal = false;
let providerCache;
let lastChain;
let lastMarkers;
let lastInputs;
let lastForest;
let structureKey = '';
let lastSolveCall = -Infinity;
let solves = 0, solveMs = 0, maxSolveMs = 0, infeasible = 0;
let rotations = 0, holds = 0, rotationRecompute = 0;
const rotationDepthTokens = [];
const rotationDepthFractions = [];
const rotationHistoryDepthFractions = [];
const cache = new CacheSim();
const totals = { read: 0, write: 0, fresh: 0 };
const observed = { read: 0, write: 0, fresh: 0 };
const missEvents = {
  all: { writes: 0, full: 0, partial: 0 },
  rotations: { writes: 0, full: 0, partial: 0 },
  nonRotations: { writes: 0, full: 0, partial: 0 },
  nonRotationFullCauses: { initial: 0, immutableChange: 0, ttlGap: 0, previousRefusal: 0, noReusableMarker: 0 },
};

for (let callIndex = 0; callIndex < calls.length; callIndex++) {
  const call = calls[callIndex];
  let transitionKind = callIndex === 0 ? 'initial' : 'unchanged';
  const M = messageCountAt(call.start);
  const availableCount = fullSummaries.reduce((count, summary) => {
    const span = spanMemo.get(summary.id);
    return count + (summary.created <= call.start && span?.last < M ? 1 : 0);
  }, 0);
  const gapExpired = previousCallStart !== null && call.start - previousCallStart >= 3_600_000;
  const key = `${M}:${availableCount}:${call.immutableHash}:${gapExpired ? 1 : 0}`;
  if (key !== structureKey) {
    const inputs = inputsAt(call.start, M, previousFrontier);
    const forest = new CanonicalSummaryForest(inputs);
    const mustSolve =
      solves === 0 ||
      callIndex - lastSolveCall >= solveStride ||
      previousImmutable !== call.immutableHash ||
      (cacheLambda > 0 && gapExpired);
    if (mustSolve) {
      const options = {
        maxTokens: W,
        policy,
        presentation,
        ...(cacheLambda > 0 && providerCache && previousImmutable === call.immutableHash && !gapExpired
          ? { cache: providerCache, currentImmutablePrefixHash: call.immutableHash } : {}),
        tokenBucketSize: 10_000,
        continuityBucketSize: 50_000,
        fidelityBucketSize: 100_000,
        labelCeiling: 100_000,
        adoptEpsilon: 0.005 * W,
      };
      const started = performance.now();
      const result = new ParetoKvUnifiedPolicySolver(inputs, forest).solve(options);
      const elapsed = performance.now() - started;
      solves++; solveMs += elapsed; maxSolveMs = Math.max(maxSolveMs, elapsed);
      lastSolveCall = callIndex;
      if (!result.feasible) {
        infeasible++;
        previousFrontier = new Map(result.feasibility.frontier ?? []);
      } else previousFrontier = new Map(result.selected.frontier);
    }
    const chain = chainFor(inputs, forest, previousFrontier);
    const markers = thirdsMarkers(chain);
    const signature = chain.units.map((unit) => unit.id).join('|');
    if (lastChain) {
      let index = 0, depth = 0;
      while (index < lastChain.units.length && index < chain.units.length && lastChain.units[index].id === chain.units[index].id) {
        depth += chain.units[index].tokens; index++;
      }
      if (index >= lastChain.units.length) { holds++; transitionKind = 'hold'; }
      else {
        const contextTokens = chain.units.reduce((sum, unit) => sum + unit.tokens, 0);
        const historyTokens = chain.units
          .slice(0, chain.historyEnd)
          .reduce((sum, unit) => sum + unit.tokens, 0);
        rotations++;
        transitionKind = 'rotation';
        rotationRecompute += Math.max(0, contextTokens - depth);
        rotationDepthTokens.push(depth);
        rotationDepthFractions.push(depth / Math.max(1, contextTokens));
        rotationHistoryDepthFractions.push(Math.min(depth, historyTokens) / Math.max(1, historyTokens));
      }
    }
    if (!call.refusal) {
      if (signature !== previousSignature) receiptSequence++;
      presentation = acceptedPresentation(forest, inputs, previousFrontier, presentation, receiptSequence);
      const layout = renderLayout(inputs, new SummaryTree(inputs), previousFrontier);
      providerCache = {
        immutablePrefixHash: call.immutableHash,
        layout,
        markers: markers.map((unitIndex) => ({
          unitIndex: Math.min(unitIndex, layout.units.length),
          offset: unitIndex >= layout.units.length ? layout.totalTokens : layout.units[unitIndex]?.offset ?? 0,
        })),
      };
      previousSignature = signature;
    }
    lastChain = chain; lastMarkers = markers; lastInputs = inputs; lastForest = forest;
    structureKey = key;
  }
  const usage = cache.request(call, lastChain, lastMarkers);
  if (usage.write > 0) {
    const bucket = transitionKind === 'rotation' ? missEvents.rotations : missEvents.nonRotations;
    missEvents.all.writes++; bucket.writes++;
    if (usage.read === 0) {
      missEvents.all.full++; bucket.full++;
      if (transitionKind !== 'rotation') {
        if (callIndex === 0) missEvents.nonRotationFullCauses.initial++;
        else if (previousImmutable !== call.immutableHash) missEvents.nonRotationFullCauses.immutableChange++;
        else if (gapExpired) missEvents.nonRotationFullCauses.ttlGap++;
        else if (previousRefusal) missEvents.nonRotationFullCauses.previousRefusal++;
        else missEvents.nonRotationFullCauses.noReusableMarker++;
      }
    } else {
      missEvents.all.partial++; bucket.partial++;
    }
  }
  totals.read += usage.read; totals.write += usage.write; totals.fresh += usage.fresh;
  observed.read += call.cacheReadTokens; observed.write += call.cacheWriteTokens; observed.fresh += call.inputTokens;
  previousImmutable = call.immutableHash;
  previousCallStart = call.start;
  previousRefusal = call.refusal;
  if ((callIndex + 1) % 50 === 0) process.stderr.write(`calls=${callIndex + 1} solves=${solves} avgMs=${(solveMs / solves).toFixed(0)}\n`);
}

const legacySimWrite = 191_808_133; // matching 2026-08-11..28 legacy replay with 20-block lookback
const calibrationApplicable = calls.length === periodCalls.length;
const scaleToBilled = calibrationApplicable ? observed.write / legacySimWrite : null;
const scaledUnifiedWrite = scaleToBilled === null
  ? null
  : (totals.write + cache.keepalive.writeTokens) * scaleToBilled;
const savings = scaledUnifiedWrite === null ? null : observed.write - scaledUnifiedWrite;
function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
  return {
    min: sorted[0] ?? 0,
    p10: at(0.10), p25: at(0.25), p50: at(0.50), p75: at(0.75),
    p90: at(0.90), p95: at(0.95), p99: at(0.99),
    max: sorted.at(-1) ?? 0,
  };
}
const thirdsBins = {
  before33: rotationHistoryDepthFractions.filter((depth) => depth < 1 / 3).length,
  from33To66: rotationHistoryDepthFractions.filter((depth) => depth >= 1 / 3 && depth < 2 / 3).length,
  from66To100: rotationHistoryDepthFractions.filter((depth) => depth >= 2 / 3 && depth < 1).length,
  atOrAfterHistory: rotationHistoryDepthFractions.filter((depth) => depth >= 1).length,
};
console.log(JSON.stringify({
  period: [new Date(calls[0].start).toISOString(), new Date(calls.at(-1).start).toISOString()],
  calls: calls.length,
  W,
  policy: { cacheLambda, continuityLambda },
  solveStride,
  solves,
  solveMs: { total: Math.round(solveMs), mean: solveMs / Math.max(1, solves), max: maxSolveMs },
  infeasible,
  transitions: {
    holds,
    rotations,
    meanRotationRecompute: rotationRecompute / Math.max(1, rotations),
    depthTokens: quantiles(rotationDepthTokens),
    depthFraction: quantiles(rotationDepthFractions),
    historyDepthFraction: quantiles(rotationHistoryDepthFractions),
    thirdsBins,
  },
  missEvents,
  keepalive: cache.keepalive,
  observed,
  simulatedUnified: totals,
  calibration: { applicable: calibrationApplicable, legacySimWrite, scaleToBilled },
  estimated: savings === null ? null : {
      unifiedBilledWrite: scaledUnifiedWrite,
      savedWriteTokens: savings,
      savedFraction: savings / observed.write,
      savedPerDay: savings / ((calls.at(-1).start - calls[0].start) / 86_400_000),
      economicBaseInputEquivalent: savings * 1.15 - cache.keepalive.readTokens * 0.1,
    },
}, null, 2));
