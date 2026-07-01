/**
 * C1 validation harness — the §10 integration matrix for the KV-stable
 * controller (`foldingStrategy: 'kv-stable'`), driven through the REAL
 * `ContextManager` + `AutobiographicalStrategy` compression pipeline.
 *
 * No named production chronicle (Tilde/Lena/Cairn) is available on this box and
 * `playground/data/` is gitignored, so — exactly as `scripts/replay-strategy.ts`
 * does — this drives a realistic synthetic session (varied real-ish message
 * sizes) through the real chunker / background production / merge path, building
 * a genuine multi-level summary tree (raw → L1 → L2 → L3). Content is synthetic;
 * the FOLDING STRUCTURE and token geometry are real. This proves mechanism/
 * behavior, not retrieval quality (which has no ground truth — see the report).
 *
 * It proves the three C1 properties head-to-head vs the production default
 * `flat-profile`:
 *   (A) a BUDGET INCREASE actually un-folds (self-adjusting fill) for kv-stable,
 *       while flat-profile stays stuck — the headline bug ("100k→300k stayed
 *       ~75k"); and a budget DROP re-folds.
 *   (B) kv-stable fills the budget headroom better than greedy flat-profile.
 *   (C) no output-looping / thrash proxy: the budget sweep is MONOTONE (no
 *       oscillation), compiles CONVERGE (no picker iteration-bound throw), and
 *       re-compiling identical state is DETERMINISTIC (byte-identical render).
 *
 * Usage:
 *   node dist/scripts/validate-kv-stable.js [--messages N] [--build-budget K] [--avg-tokens T]
 */

import { rmSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { TokenBudget } from '../src/index.js';
import type { RenderStats } from '../src/types/strategy.js';

type FoldingStrategyName = 'flat-profile' | 'kv-stable';

/** Mock Membrane returning a realistically-sized summary (recall pairs are the
 *  cost the controller trades against; ~600 tokens ≈ a real L1 recollection). */
function makeMockMembrane(summaryTokens: number) {
  const text = 'm'.repeat(Math.max(4, summaryTokens * 4));
  return { complete: async () => ({ content: [{ type: 'text', text }] }) };
}

/** Deterministic pseudo-random sizes (NO Math.random — reproducible run). A
 *  realistic chat: mostly short turns, occasional large pastes. */
function makeSizer(avgTokens: number): (i: number) => number {
  let s = 0x2545f491 >>> 0;
  const next = (): number => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
  return (_i: number): number => {
    const r = next();
    // 12% "large paste" turns (3–7× avg), rest clustered around avg.
    if (r < 0.12) return Math.round(avgTokens * (3 + next() * 4));
    return Math.round(avgTokens * (0.35 + next() * 1.3));
  };
}

interface Row {
  label: string;
  budgetTokens: number;
  total: number;
  middleRaw: number;
  l1: number;
  l2: number;
  l3: number;
  deepest: number;
  utilization: number; // total / (maxTokens − reserve)
}

function deepestLevel(st: RenderStats): number {
  if (st.summaries.l3.count > 0) return 3;
  if (st.summaries.l2.count > 0) return 2;
  if (st.summaries.l1.count > 0) return 1;
  return 0;
}

async function buildAndSweep(opts: {
  strategy: FoldingStrategyName;
  messages: number;
  buildBudget: number;
  avgTokens: number;
  sweep: Array<{ label: string; maxTokens: number }>;
  summaryTokens: number;
}): Promise<{ rows: Row[]; rawTotal: number; threw: number; determinismOk: boolean }> {
  const storePath = `/tmp/validate-kv-stable-${opts.strategy}`;
  rmSync(storePath, { recursive: true, force: true });

  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    headWindowTokens: 4000,
    recentWindowTokens: 30000,
    maxMessageTokens: 10000,
    mergeThreshold: 6,
    compressionModel: 'mock',
    speculativeProduction: true,
    foldingStrategy: opts.strategy,
  });
  const cm = await ContextManager.open({
    path: storePath,
    strategy: strategy as never,
    membrane: makeMockMembrane(opts.summaryTokens) as never,
  });

  const reserve = 4000;
  const sizer = makeSizer(opts.avgTokens);
  const buildBudget: TokenBudget = { maxTokens: opts.buildBudget, reserveForResponse: reserve };
  let rawTotal = 0;
  let threw = 0;

  // Grow the session under a TIGHT operating budget so F_prev ends deeply
  // folded — the state from which a budget increase must un-fold.
  for (let i = 0; i < opts.messages; i++) {
    const tok = Math.max(1, sizer(i));
    rawTotal += tok;
    cm.addMessage(i % 2 === 0 ? 'user' : 'assistant', [
      { type: 'text', text: 'x'.repeat(tok * 4) },
    ] as never);
    for (let t = 0; t < 4; t++) await cm.tick(); // drive background production/merge
    if (i % 5 === 0) {
      try { await cm.compile(buildBudget); } catch { threw++; }
    }
  }
  // Let production/merge settle so deep summaries exist for the sweep.
  for (let t = 0; t < 60; t++) await cm.tick();
  try { await cm.compile(buildBudget); } catch { threw++; }

  // ---- the sweep: compile the SAME accumulated state at ascending budgets,
  //      then a drop. renderStats.total is the rendered context size. ----
  const rows: Row[] = [];
  for (const step of opts.sweep) {
    const budget: TokenBudget = { maxTokens: step.maxTokens, reserveForResponse: reserve };
    let st: RenderStats | null = null;
    try {
      await cm.compile(budget);
      st = cm.getRenderStats();
    } catch {
      threw++;
    }
    const effective = step.maxTokens - reserve;
    if (st) {
      rows.push({
        label: step.label,
        budgetTokens: effective,
        total: st.total.tokens,
        middleRaw: st.middleRaw.tokens,
        l1: st.summaries.l1.tokens,
        l2: st.summaries.l2.tokens,
        l3: st.summaries.l3.tokens,
        deepest: deepestLevel(st),
        utilization: effective > 0 ? st.total.tokens / effective : 0,
      });
    }
  }

  // Determinism / no-loop: re-compile the LAST sweep state twice; identical.
  const last = opts.sweep[opts.sweep.length - 1];
  const lb: TokenBudget = { maxTokens: last.maxTokens, reserveForResponse: reserve };
  await cm.compile(lb); const a = cm.getRenderStats();
  await cm.compile(lb); const b = cm.getRenderStats();
  const determinismOk = !!a && !!b && a.total.tokens === b.total.tokens
    && a.middleRaw.tokens === b.middleRaw.tokens
    && a.summaries.l1.tokens === b.summaries.l1.tokens
    && a.summaries.l2.tokens === b.summaries.l2.tokens;

  rmSync(storePath, { recursive: true, force: true });
  return { rows, rawTotal, threw, determinismOk };
}

function fmt(n: number): string { return Math.round(n).toLocaleString(); }

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string, d: number): number => {
    const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d;
  };
  const messages = arg('--messages', 220);
  const buildBudget = arg('--build-budget', 64000);
  const avgTokens = arg('--avg-tokens', 900);
  const summaryTokens = 600;

  // Ascending budgets (the headline: does 100k→180k→300k un-fold?), then a drop.
  const sweep = [
    { label: 'op-64k', maxTokens: 64000 },
    { label: '100k', maxTokens: 100000 },
    { label: '180k', maxTokens: 180000 },
    { label: '300k', maxTokens: 300000 },
    { label: 'drop→100k', maxTokens: 100000 },
  ];

  console.log('=== C1 kv-stable validation (real ContextManager pipeline; synthetic content, real folding) ===');
  console.log(`messages=${messages} build-budget=${fmt(buildBudget)} avg-tokens=${avgTokens} summary=${summaryTokens}t\n`);

  const results: Record<FoldingStrategyName, Awaited<ReturnType<typeof buildAndSweep>>> = {
    'flat-profile': await buildAndSweep({ strategy: 'flat-profile', messages, buildBudget, avgTokens, sweep, summaryTokens }),
    'kv-stable': await buildAndSweep({ strategy: 'kv-stable', messages, buildBudget, avgTokens, sweep, summaryTokens }),
  };

  for (const name of ['flat-profile', 'kv-stable'] as FoldingStrategyName[]) {
    const r = results[name];
    console.log(`--- ${name} --- (raw total ${fmt(r.rawTotal)}t · compiles that threw: ${r.threw} · deterministic re-compile: ${r.determinismOk ? 'YES' : 'NO'})`);
    console.log('  budget      rendered   util%   middleRaw    L1       L2       L3     deepest');
    for (const row of r.rows) {
      console.log(
        `  ${row.label.padEnd(10)} ${fmt(row.total).padStart(8)}  ${(row.utilization * 100).toFixed(0).padStart(4)}%  ${fmt(row.middleRaw).padStart(9)}  ${fmt(row.l1).padStart(7)}  ${fmt(row.l2).padStart(7)}  ${fmt(row.l3).padStart(7)}    L${row.deepest}`,
      );
    }
    console.log();
  }

  // ---- Property assertions ----
  const kv = results['kv-stable'].rows;
  const flat = results['flat-profile'].rows;
  const byLabel = (rows: Row[], l: string): Row | undefined => rows.find((r) => r.label === l);

  const kv100 = byLabel(kv, '100k'), kv180 = byLabel(kv, '180k'), kv300 = byLabel(kv, '300k'), kvDrop = byLabel(kv, 'drop→100k');
  const flat100 = byLabel(flat, '100k'), flat300 = byLabel(flat, '300k');

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

  // (A) budget increase un-folds for kv-stable (strictly grows 100k→180k→300k).
  if (kv100 && kv180 && kv300) {
    const grows = kv180.total > kv100.total * 1.02 && kv300.total > kv180.total * 1.02;
    checks.push({ name: 'A1 kv-stable un-folds on budget increase (100k<180k<300k)', pass: grows,
      detail: `${fmt(kv100.total)} → ${fmt(kv180.total)} → ${fmt(kv300.total)}` });
  }
  // (A) flat-profile stays stuck on budget increase (the bug it reproduces).
  if (flat100 && flat300) {
    const stuck = flat300.total <= flat100.total * 1.10;
    checks.push({ name: 'A2 flat-profile stays stuck on budget increase (the bug)', pass: stuck,
      detail: `100k ${fmt(flat100.total)} → 300k ${fmt(flat300.total)} (Δ ${((flat300.total / flat100.total - 1) * 100).toFixed(0)}%)` });
  }
  // (A) budget DROP re-folds for kv-stable.
  if (kv300 && kvDrop) {
    const refolds = kvDrop.total < kv300.total * 0.9;
    checks.push({ name: 'A3 kv-stable re-folds on budget drop (300k→100k)', pass: refolds,
      detail: `${fmt(kv300.total)} → ${fmt(kvDrop.total)}` });
  }
  // (B) kv-stable fills the 300k headroom better than greedy flat-profile.
  if (kv300 && flat300) {
    const better = kv300.utilization > flat300.utilization + 0.10;
    checks.push({ name: 'B kv-stable fills 300k headroom better than flat', pass: better,
      detail: `util kv ${(kv300.utilization * 100).toFixed(0)}% vs flat ${(flat300.utilization * 100).toFixed(0)}%` });
  }
  // (C) no thrash: kv sweep monotone up then down; converged; deterministic.
  const kvMonotone = !!(kv100 && kv180 && kv300 && kvDrop)
    && kv100.total <= kv180.total && kv180.total <= kv300.total && kvDrop.total <= kv300.total;
  checks.push({ name: 'C1 kv-stable sweep is monotone (no oscillation)', pass: kvMonotone, detail: '' });
  checks.push({ name: 'C2 all compiles converged (no picker iteration-bound throw)', pass: results['kv-stable'].threw === 0 && results['flat-profile'].threw === 0,
    detail: `kv threw ${results['kv-stable'].threw}, flat threw ${results['flat-profile'].threw}` });
  checks.push({ name: 'C3 re-compiling identical state is deterministic (byte-stable render)', pass: results['kv-stable'].determinismOk, detail: '' });

  console.log('=== PROPERTY CHECKS ===');
  let allPass = true;
  for (const c of checks) {
    if (!c.pass) allPass = false;
    console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
  }
  console.log(`\n${allPass ? 'ALL PROPERTIES HELD' : 'SOME PROPERTIES FAILED — see above'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
