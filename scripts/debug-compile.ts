/**
 * Debug: construct context via the real ContextManager.compile() — NO inference.
 *
 * Opens a real chronicle (a COPY, since compile() persists resolutions), selects
 * a folding strategy by name (kv-stable / flat-profile / oldest-first), and runs
 * one compile() over the whole conversation under a fixed budget. compile() only
 * SELECTS + RENDERS context — it never calls the model for an agent turn; the
 * mock Membrane is present only in case background compression triggers (it does
 * not here — we don't tick(), and the store already holds real summaries).
 *
 * Dumps the constructed context: per-message kind (raw / recall) + tokens +
 * cache breakpoints, the breakpoint positions, level distribution, and budget
 * fit — so you can see exactly what kv-stable builds on real data.
 *
 * Usage:
 *   node dist/scripts/debug-compile.js <store-path> [--strategy kv-stable] \
 *        [--cap 0.25] [--reach <tok>] [--ns <namespace>] [--full]
 */

import { cpSync, rmSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

function makeMockMembrane() {
  return { complete: async () => ({ content: [{ type: 'text', text: '[mock]' }] }) };
}

function estTokens(content: any[]): number {
  let t = 0;
  for (const b of content ?? []) {
    const k = b.type;
    if (k === 'text') t += Math.ceil(String(b.text ?? '').length / 4);
    else if (k === 'thinking') t += Math.ceil(String(b.thinking ?? '').length / 4);
    else if (k === 'tool_use') t += Math.ceil(JSON.stringify(b.input ?? {}).length / 4) + 20;
    else if (k === 'tool_result') {
      const c = b.content;
      t += typeof c === 'string' ? Math.ceil(c.length / 4) : 100;
    } else if (k === 'image') t += 1600;
    else t += 50;
  }
  return Math.max(t, 1);
}

async function main() {
  const args = process.argv.slice(2);
  const storePath = args[0];
  if (!storePath) {
    console.error('Usage: debug-compile <store-path> [--strategy kv-stable] [--cap 0.25] [--reach n] [--ns ns] [--full]');
    process.exit(1);
  }
  const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const strategyName = (opt('--strategy', 'kv-stable')) as 'kv-stable' | 'flat-profile' | 'oldest-first';
  const cap = Number(opt('--cap', '0.25'));
  const absBudget = opt('--budget') ? Number(opt('--budget')) : undefined; // absolute token budget; overrides --cap
  const reach = opt('--reach') ? Number(opt('--reach')) : undefined;
  const ns = opt('--ns');
  const full = args.includes('--full');
  const fresh = args.includes('--fresh'); // reset inherited resolutions → fold from raw

  // Work on a copy — compile() persists resolutions; never mutate the real store.
  const work = `/tmp/debug-compile-${strategyName}-${Date.now() % 100000}`;
  cpSync(storePath, work, { recursive: true });
  rmSync(`${work}/LOCK`, { force: true });

  const config = {
    adaptiveResolution: true,
    headWindowTokens: 4000,
    recentWindowTokens: 30000,
    maxMessageTokens: 10000,
    mergeThreshold: 6,
    compressionModel: 'mock',
    enforceBudget: false,
    foldingStrategy: strategyName,
    ...(reach !== undefined ? { kvStableReachTokens: reach } : {}),
  };
  const strategy = new AutobiographicalStrategy(config);
  const cm = await ContextManager.open({
    path: work,
    strategy: strategy as never,
    membrane: makeMockMembrane() as never,
    ...(ns ? { namespace: ns } : {}),
  });

  if (fresh) (strategy as unknown as { resolutions?: Map<string, number> }).resolutions?.clear();

  const messages = cm.getAllMessages();
  const rawTotal = messages.reduce((a, m) => a + estTokens((m as any).content), 0);
  const budget = absBudget !== undefined ? absBudget : Math.round(rawTotal * cap);

  // Construct context — NO inference.
  let result;
  try {
    result = await cm.compile({ maxTokens: budget, reserveForResponse: 0 });
  } catch (e: any) {
    const d = e?.diagnostics;
    console.log(`=== debug-compile: ${storePath} ===`);
    console.log(`strategy:   ${strategyName}${fresh ? ' (fresh)' : ''}`);
    console.log(`budget:     ${Math.round(budget).toLocaleString()} (${(cap*100).toFixed(0)}% of raw)`);
    console.log(`ESCALATED (OverBudgetError): cannot fit under the hard budget even fully folded.`);
    if (d) console.log(`  head=${d.headTokens} + tail=${d.tailTokens} + middle=${d.middleTokens} (${d.middleChunkCount} chunks, deepest L${d.deepestLevel}) = ${e.actual} > ${e.budget}`);
    rmSync(work, { recursive: true, force: true });
    return;
  }
  const msgs = result.messages as any[];

  // Classify + tokenize the constructed context.
  let total = 0, rawCount = 0, recallPairs = 0;
  const breakpoints: Array<{ idx: number; offsetTok: number }> = [];
  const rows = msgs.map((m: any, i: number) => {
    const tok = estTokens(m.content);
    const kind = m.participant === 'Context Manager' ? 'recall-Q'
      : (i > 0 && msgs[i - 1].participant === 'Context Manager') ? 'recall-A' : 'raw';
    if (kind === 'recall-Q') recallPairs++;
    else if (kind === 'raw') rawCount++;
    const offsetBefore = total;
    total += tok;
    if (m.cacheBreakpoint) breakpoints.push({ idx: i, offsetTok: offsetBefore + tok });
    return { i, participant: m.participant, kind, tok, marker: !!m.cacheBreakpoint };
  });

  // Level distribution from the committed resolutions.
  const resolutions = (strategy as unknown as { resolutions: Map<string, number> }).resolutions ?? new Map();
  const dist: Record<number, number> = {};
  for (const lvl of resolutions.values()) dist[lvl] = (dist[lvl] ?? 0) + 1;

  const fmt = (n: number) => Math.round(n).toLocaleString();
  console.log(`=== debug-compile: ${storePath} ===`);
  console.log(`strategy:   ${strategyName}${fresh ? ' (fresh, from raw)' : ''}${reach !== undefined ? ` (reach ${fmt(reach)})` : ''}`);
  console.log(`messages:   ${messages.length} stored · raw total ${fmt(rawTotal)} tokens`);
  console.log(`budget:     ${fmt(budget)} (${(cap * 100).toFixed(0)}% of raw)`);
  console.log(`compiled:   ${msgs.length} messages · ${fmt(total)} tokens  → ${total <= budget ? 'FITS' : `OVER by ${fmt(total - budget)}`}`);
  console.log(`makeup:     ${rawCount} raw + ${recallPairs} recall pairs`);
  console.log(`resolutions: ${JSON.stringify(dist)} (L0=raw)`);
  console.log(`cache breakpoints (${breakpoints.length}, ≤4 expected):`);
  for (const b of breakpoints) {
    console.log(`  @msg ${String(b.idx).padStart(4)} — caches ${fmt(b.offsetTok)} tok (${(b.offsetTok / total * 100).toFixed(0)}% of context)`);
  }

  if (full) {
    console.log('\n--- constructed context (kind · tokens · ◆=breakpoint) ---');
    for (const r of rows) {
      console.log(`  ${String(r.i).padStart(4)} ${r.marker ? '◆' : ' '} ${r.kind.padEnd(8)} ${String(r.tok).padStart(6)}t  ${r.participant}`);
    }
  } else {
    console.log('\n(pass --full to dump every message)');
  }

  rmSync(work, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
