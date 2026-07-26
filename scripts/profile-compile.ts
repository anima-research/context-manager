/**
 * Profile: repeated real ContextManager.compile() over a production store copy,
 * with per-method wall timers (monkey-patched, instance-safe) + KV_TIMING.
 * Run under `node --cpu-prof` for full attribution; see analyze-cpuprofile.mjs.
 *
 * Mirrors Mythos production config (recipes/mythos.json strategy block +
 * runtime overrides from chronicle framework/state: contextBudgetTokens 300000,
 * tailTokens 80000, reserveForResponse = agent.maxTokens 16384).
 * Differences from prod, deliberate:
 *   - maxSpeculativeL1s 0 + autoTickOnNewMessage false (no background
 *     compression polluting the profile; steady-state store is compressed)
 *   - membrane is a loud mock (any .complete call is a bug in the run)
 *
 * Usage:
 *   node --cpu-prof --cpu-prof-dir=/tmp/mythos-prof dist/scripts/profile-compile.js \
 *        <store-path> [--ns agents/mythos] [--budget 300000] [--reserve 16384] \
 *        [--tail 80000] [--runs 4]
 *
 * NOTE: compile() persists resolutions — run against a disposable copy only.
 */

import { performance } from 'node:perf_hooks';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

function loudMockMembrane() {
  return {
    complete: async () => {
      console.error('[profile] UNEXPECTED membrane.complete call — compression fired during profiling');
      return { content: [{ type: 'text', text: '[mock]' }] };
    },
  };
}

const bucket: Record<string, number> = {};
const counts: Record<string, number> = {};
function timeMethod(proto: any, name: string): void {
  const orig = proto[name];
  if (typeof orig !== 'function') { console.error(`[profile] no method ${name} to wrap`); return; }
  proto[name] = function (...a: unknown[]) {
    const t = performance.now();
    try { return orig.apply(this, a); }
    finally {
      bucket[name] = (bucket[name] ?? 0) + (performance.now() - t);
      counts[name] = (counts[name] ?? 0) + 1;
    }
  };
}
function resetBucket(): void {
  for (const k of Object.keys(bucket)) delete bucket[k];
  for (const k of Object.keys(counts)) delete counts[k];
}
function printBucket(label: string): void {
  const rows = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  console.log(`  method timings (${label}):`);
  for (const [k, v] of rows) console.log(`    ${k.padEnd(28)} ${v.toFixed(1).padStart(9)} ms  ×${counts[k]}`);
}

async function main() {
  const args = process.argv.slice(2);
  const storePath = args[0];
  if (!storePath) { console.error('Usage: profile-compile <store-path> [--ns ns] [--budget n] [--reserve n] [--tail n] [--runs n]'); process.exit(1); }
  const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const ns = opt('--ns', 'agents/mythos');
  const budget = Number(opt('--budget', '300000'));
  const reserve = Number(opt('--reserve', '16384'));
  const tail = Number(opt('--tail', '80000'));
  const runs = Number(opt('--runs', '4'));

  // Production config: recipes/mythos.json agent.strategy, with the live
  // runtime tailTokens override applied to recentWindowTokens.
  const config = {
    adaptiveResolution: true,
    headWindowTokens: 4000,
    recentWindowTokens: tail,
    maxMessageTokens: 10000,
    overBudgetGraceRatio: 0.35,
    compressionModel: 'claude-fable-5',
    enforceBudget: true,
    maxSpeculativeL1s: 0,
    summaryParticipant: 'mythos',
    foldingStrategy: 'kv-stable' as const,
    kvStableReachTokens: 400000,
    compressionRefusalCurveFallbacks: 7,
    compressionContextBudgetTokens: 350000,
    autoTickOnNewMessage: false,
  };

  // Wall timers on the interesting phases (protected methods live on the prototype).
  const proto = AutobiographicalStrategy.prototype as any;
  for (const m of ['rebuildChunks', 'postStripEstimates', 'getCompressibleMessages', 'selectAdaptive', 'select', 'pinnedPositions', 'applyImageStripping']) {
    timeMethod(proto, m);
  }

  const rss = () => (process.memoryUsage().rss / 1048576).toFixed(0);
  console.log(`[profile] opening ${storePath} ns=${ns} rss=${rss()}MB`);
  let t = performance.now();
  const strategy = new AutobiographicalStrategy(config as any);
  const cm = await ContextManager.open({
    path: storePath,
    strategy: strategy as never,
    membrane: loudMockMembrane() as never,
    namespace: ns,
  } as any);
  console.log(`[profile] open: ${(performance.now() - t).toFixed(0)} ms rss=${rss()}MB`);
  printBucket('open');
  resetBucket();

  const s: any = strategy;
  console.log(`[profile] store: msgs=${cm.getAllMessages().length} chunks=${s.chunks?.length} summaries=${s.summaries?.length} records=${s.chunkRecords?.length}`);
  resetBucket(); // getAllMessages may have re-triggered wrapped methods

  for (let i = 0; i < runs; i++) {
    t = performance.now();
    let outcome = 'ok';
    let nMsgs = 0;
    try {
      const req: any = await cm.compile({ maxTokens: budget, reserveForResponse: reserve });
      nMsgs = (req.messages ?? []).length;
    } catch (e: any) {
      outcome = `ERR ${String(e?.message ?? e).slice(0, 120)}`;
    }
    const ms = performance.now() - t;
    console.log(`[profile] compile#${i} (${i === 0 ? 'cold' : 'warm'}): ${ms.toFixed(0)} ms  msgs=${nMsgs} rss=${rss()}MB ${outcome === 'ok' ? '' : outcome}`);
    printBucket(`compile#${i}`);
    resetBucket();
  }
  console.log('[profile] DONE');
}

main().catch((e) => { console.error(e); process.exit(1); });
