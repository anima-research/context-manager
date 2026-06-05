/**
 * Real-strategy KV-cache replay (integration harness — step 2 of
 * `docs/kv-stable-context-control.md`).
 *
 * Drives the REAL `ContextManager` + `AutobiographicalStrategy` turn-by-turn —
 * real head/tail windows, real msgCap truncation, real pinned/locked handling,
 * real `cacheMarker` placement, real background production/merge (via a mock
 * Membrane that returns realistically-sized summaries) — with either the live
 * default `FlatProfileStrategy` or the new `KvStableStrategy` swapped in through
 * the `buildPicker` seam. Cache hits are measured on the ACTUAL compiled output
 * (content-hash byte identity + the strategy's real breakpoints) via the same
 * `CacheStore` the playground uses.
 *
 * Drive sizes come from the exported snapshot (`playground/data/<name>.json`):
 * messages are synthesized to each chunk's real `rawTokens`, summaries to the
 * snapshot's median summary size. Content is synthetic (irrelevant to cache /
 * token measurement); sizes, windows, production timing, and markers are real.
 *
 * Usage:
 *   node dist/scripts/replay-strategy.js <name> [--reach <tok>] [--cap <frac>]
 *        [--stride <n>] [--limit <n>] [--out-dir playground/data]
 *
 * Writes <name>-kv-trace.json and <name>-flat-trace.json and prints a summary.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { CacheStore, placeMarkers, type CacheMarker } from '../src/adaptive/index.js';
import type { RenderLayout } from '../src/adaptive/render-offsets.js';

// ---- mock Membrane: returns a summary of a fixed realistic size ----
function makeMockMembrane(summaryChars: number) {
  const text = 'm'.repeat(Math.max(4, summaryChars));
  return { complete: async () => ({ content: [{ type: 'text', text }] }) };
}

function hash(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return String(h >>> 0);
}
function estTokens(content: Array<{ type?: string; text?: string }>): number {
  let t = 0;
  for (const b of content) if (b.type === 'text') t += Math.ceil((b.text ?? '').length / 4);
  return Math.max(1, t);
}
function layoutOf(messages: Array<{ content: unknown[] }>): RenderLayout {
  let offset = 0;
  const units = messages.map((m) => {
    const content = m.content as Array<{ type?: string; text?: string }>;
    const tokens = estTokens(content);
    const u = { kind: 'raw' as const, key: hash(JSON.stringify(content)), tokens, offset };
    offset += tokens;
    return u;
  });
  return { units, totalTokens: offset };
}
function markersOf(messages: Array<{ cacheBreakpoint?: boolean }>, layout: RenderLayout): CacheMarker[] {
  const out: CacheMarker[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].cacheBreakpoint) {
      const unitIndex = i + 1;
      out.push({ unitIndex, offset: unitIndex < layout.units.length ? layout.units[unitIndex].offset : layout.totalTokens });
    }
  }
  return out; // the strategy's REAL breakpoints (always ≥1: head-last is marked)
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface TraceStep {
  turn: number; renderedTokens: number; cachedTokens: number; recomputedTokens: number;
  perturbation: number; markers: number; cacheAgeSteps: number; overBudget: boolean;
}
interface TraceResult {
  variant: string; steps: TraceStep[];
  totalRendered: number; totalRecomputed: number; overallHitRate: number;
  maxPerturbation: number; rmsPerturbation: number;
}

async function runVariant(opts: {
  name: string; useKvStable: boolean; reachTokens?: number;
  markerMode: 'strategy' | 'ideal';
  chunks: Array<{ rawTokens: number }>; medianSummaryTokens: number;
  budgetTokens: number; stride: number;
}): Promise<TraceResult> {
  const storePath = `/tmp/replay-strategy-${opts.name}-${opts.useKvStable ? 'kv' : 'flat'}`;
  rmSync(storePath, { recursive: true, force: true }); // openOrCreate makes it fresh

  // Real config path: select the KV-stable controller by name (the production
  // wiring), or the live default flat-profile.
  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    headWindowTokens: 4000,
    recentWindowTokens: 30000,
    maxMessageTokens: 10000,
    mergeThreshold: 6,
    compressionModel: 'mock',
    speculativeProduction: true,
    foldingStrategy: opts.useKvStable ? 'kv-stable' : 'flat-profile',
    kvStableReachTokens: opts.reachTokens,
  });

  const cm = await ContextManager.open({
    path: storePath,
    strategy: strategy as never,
    membrane: makeMockMembrane(opts.medianSummaryTokens * 4) as never,
  });

  const budget = { maxTokens: opts.budgetTokens, reserveForResponse: 0 };
  const cache = new CacheStore();
  const steps: TraceStep[] = [];
  let totalRendered = 0, totalRecomputed = 0, totalCached = 0, sumSq = 0, maxP = 0;
  let addedSinceSample = 0;

  for (let i = 0; i < opts.chunks.length; i++) {
    const tok = opts.chunks[i].rawTokens;
    const participant = i % 2 === 0 ? 'user' : 'assistant';
    cm.addMessage(participant, [{ type: 'text', text: 'x'.repeat(tok * 4) }] as never);
    addedSinceSample += tok;
    // Drive a little background production each turn (models realistic lag).
    for (let t = 0; t < 3; t++) await cm.tick();

    const lastTurn = i === opts.chunks.length - 1;
    if (i % opts.stride !== 0 && !lastTurn) continue;

    let overBudget = false;
    let result: { messages: Array<{ content: unknown[]; cacheBreakpoint?: boolean }> };
    try {
      result = (await cm.compile(budget)) as never;
    } catch {
      overBudget = true;
      addedSinceSample = 0;
      steps.push({ turn: i, renderedTokens: 0, cachedTokens: 0, recomputedTokens: 0, perturbation: 0, markers: 0, cacheAgeSteps: -1, overBudget });
      continue;
    }

    const layout = layoutOf(result.messages);
    const markers = opts.markerMode === 'ideal'
      ? placeMarkers(layout, 4)                       // ≤4 optimized breakpoints
      : markersOf(result.messages, layout);          // the strategy's real cacheMarkers
    const hit = cache.read(layout);
    const recompute = layout.totalTokens - hit.cachedTokens;
    const perturbation = Math.max(0, recompute - addedSinceSample);
    cache.write(layout, markers);
    cache.tick();

    steps.push({
      turn: i, renderedTokens: layout.totalTokens, cachedTokens: hit.cachedTokens,
      recomputedTokens: recompute, perturbation, markers: markers.length,
      cacheAgeSteps: hit.ageSteps, overBudget,
    });
    totalRendered += layout.totalTokens; totalRecomputed += recompute; totalCached += hit.cachedTokens;
    sumSq += perturbation * perturbation; if (perturbation > maxP) maxP = perturbation;
    addedSinceSample = 0;
  }

  rmSync(storePath, { recursive: true, force: true });
  return {
    variant: opts.useKvStable ? 'kv-stable' : 'flat-profile',
    steps,
    totalRendered, totalRecomputed,
    overallHitRate: totalRendered > 0 ? totalCached / totalRendered : 0,
    maxPerturbation: maxP,
    rmsPerturbation: Math.sqrt(sumSq / Math.max(1, steps.filter((s) => !s.overBudget).length)),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const name = args[0];
  if (!name) { console.error('Usage: replay-strategy <name> [--reach n] [--cap f] [--stride n] [--limit n] [--out-dir dir]'); process.exit(1); }
  const flag = (k: string, d: number) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
  const outDir = (() => { const i = args.indexOf('--out-dir'); return i >= 0 ? args[i + 1] : 'playground/data'; })();

  const ds = JSON.parse(readFileSync(`playground/data/${name}.json`, 'utf8'));
  let chunks: Array<{ rawTokens: number; sequence: number }> = ds.chunks.slice().sort((a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence);
  const limit = flag('--limit', 0);
  if (limit > 0) chunks = chunks.slice(0, limit);
  const rawTotal = chunks.reduce((a, c) => a + c.rawTokens, 0);
  const medianSummaryTokens = median((ds.summaries as Array<{ tokens: number }>).map((s) => s.tokens)) || 700;
  const budgetTokens = Math.round(rawTotal * flag('--cap', 0.25));
  const reachTokens = flag('--reach', 0) || undefined;
  const stride = flag('--stride', 5);

  console.log(`=== replay-strategy: ${name} ===`);
  console.log(`chunks ${chunks.length} · raw ${rawTotal.toLocaleString()} · budget ${budgetTokens.toLocaleString()} · median summary ${medianSummaryTokens}t · stride ${stride}${reachTokens ? ` · reach ${reachTokens}` : ''}`);

  const common = { chunks, medianSummaryTokens, budgetTokens, stride };
  const fmt = (n: number) => Math.round(n).toLocaleString();

  // 2×2: folding policy (flat / kv-stable) × marker placement (strategy / ideal).
  // Isolates the dominant lever (markers) from the folding-policy effect.
  const grid: Record<string, TraceResult> = {};
  for (const markerMode of ['strategy', 'ideal'] as const) {
    for (const useKvStable of [false, true]) {
      const r = await runVariant({ name, useKvStable, reachTokens, markerMode, ...common });
      const tag = `${useKvStable ? 'kv-stable' : 'flat-profile'} · ${markerMode}-markers`;
      grid[`${useKvStable ? 'kv' : 'flat'}_${markerMode}`] = r;
      console.log(`\n[${tag}] recompute=${fmt(r.totalRecomputed)} hit=${(r.overallHitRate * 100).toFixed(1)}% maxPert=${fmt(r.maxPerturbation)} rmsPert=${fmt(r.rmsPerturbation)} overBudget=${r.steps.filter((s) => s.overBudget).length}`);
    }
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const meta = { name, chunks: chunks.length, rawTotal, budgetTokens, medianSummaryTokens, stride, reachTokens: reachTokens ?? null };
  // The viewer compares the two policies under the better (ideal) marker placement.
  writeFileSync(`${outDir}/${name}-kv-trace.json`, JSON.stringify({ meta, ...grid.kv_ideal }));
  writeFileSync(`${outDir}/${name}-flat-trace.json`, JSON.stringify({ meta, ...grid.flat_ideal }));

  console.log(`\nMarker placement is the dominant lever:`);
  console.log(`  flat:  strategy-markers ${(grid.flat_strategy.overallHitRate * 100).toFixed(1)}% → ideal-markers ${(grid.flat_ideal.overallHitRate * 100).toFixed(1)}% hit`);
  console.log(`  kv:    strategy-markers ${(grid.kv_strategy.overallHitRate * 100).toFixed(1)}% → ideal-markers ${(grid.kv_ideal.overallHitRate * 100).toFixed(1)}% hit`);
  const dRe = grid.flat_ideal.totalRecomputed - grid.kv_ideal.totalRecomputed;
  const dMax = grid.flat_ideal.maxPerturbation - grid.kv_ideal.maxPerturbation;
  console.log(`Under ideal markers, kv-stable vs flat: recompute ${dRe >= 0 ? '−' : '+'}${fmt(Math.abs(dRe))}, max-perturb ${dMax >= 0 ? '−' : '+'}${fmt(Math.abs(dMax))}`);
  console.log(`wrote ${outDir}/${name}-{kv,flat}-trace.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
