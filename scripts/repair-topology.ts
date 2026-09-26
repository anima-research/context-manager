/**
 * Repair crossed summary ownership in a store (see src/repair/topology.ts).
 * Dry-run by default. Run on a STOPPED store (or a copy): a live store's
 * on-disk state lags its process.
 *
 * Usage:
 *   node dist/scripts/repair-topology.js <store-path> --namespace <ns> [--apply] [--release-head[=moved|all]] [--mode lossless|compact] [--json]
 *
 * Both opens (verification, and the audit) are audit-only: they never mint
 * chunk records or enqueue merges. --release-head=all also releases
 * pre-existing unparented root L1s at the prefix (the head must be able to
 * take them back: CM ≥ #123 anchors it to coverage, bounded at 2× headWindowTokens).
 *
 * lossless (default) only detaches: no prose ever claims content it did not
 * see, but the pyramid unravels around each fragment (reported as leaves that
 * lost a fold level). compact adopts and re-homes as well: depth is kept, at
 * the price of prose gaps (reported as leaves). rebuild dissolves every
 * summary whose span touches a crossed region (and their ancestors) back to
 * L1s so the merge ladder re-folds the region with real summarizer calls —
 * run scripts/drain-autobiographical.ts on the stopped store afterwards.
 * --rebuild-since <messageId|ISO date> rebuilds only crossed summaries whose
 * span starts at or after that message and compacts the older ones, so
 * regions repaired by hand are never re-summarized.
 * None of the modes makes model calls itself.
 *
 * After --apply the store is reopened with topologyPolicy 'reject'; the run
 * fails if the audit still finds a crossed summary.
 * Exit 0 = clean (nothing to do, or applied and verified); 2 = plan incomplete
 * or verification failed; 1 = usage/open error.
 */

import { JsStore } from '@animalabs/chronicle';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { planTopologyRepair, type RepairRecord, type RepairSummary } from '../src/repair/topology.js';

const args = process.argv.slice(2);
const storePath = args.find((a) => !a.startsWith('--'));
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const namespace = flag('--namespace');
if (!storePath || !namespace) {
  console.error('usage: repair-topology <store-path> --namespace <ns> [--apply] [--release-head[=moved|all]] [--release-head-limit <n>] [--mode lossless|compact|rebuild] [--rebuild-since <messageId|ISO date>] [--json] [--messages-state <id>]');
  process.exit(1);
}
const apply = args.includes('--apply');
const json = args.includes('--json');
const releaseHead: false | 'moved' | 'all' = args.includes('--release-head=all') ? 'all' : (args.includes('--release-head') || args.includes('--release-head=moved')) ? 'moved' : false;
const rebuildSince = flag('--rebuild-since');
const releaseHeadLimit = flag('--release-head-limit') !== undefined ? Number(flag('--release-head-limit')) : undefined;
if (releaseHeadLimit !== undefined && !(releaseHeadLimit > 0)) { console.error('--release-head-limit must be a positive number of messages'); process.exit(1); }
const mode = (flag('--mode') ?? 'lossless') as 'lossless' | 'compact' | 'rebuild';
if (mode !== 'lossless' && mode !== 'compact' && mode !== 'rebuild') { console.error(`--mode must be lossless, compact or rebuild, got ${mode}`); process.exit(1); }
const messagesState = flag('--messages-state') ?? 'messages';

const store = JsStore.open({ path: storePath });
const sumsState = `${namespace}/autobio:summaries`;
const chunksState = `${namespace}/autobio:chunks`;
const resolutionsState = `${namespace}/autobio:resolutions`;
const summaries = (store.getStateJson(sumsState) as RepairSummary[] | null) ?? [];
const records = (store.getStateJson(chunksState) as RepairRecord[] | null) ?? [];
const resolutions = (store.getStateJson(resolutionsState) as Record<string, number> | null) ?? {};
const messages = (store.getStateJson(messagesState) as Array<{ id: string }> | null) ?? [];
if (messages.length === 0 || summaries.length === 0) {
  console.error(`nothing to repair: ${messages.length} messages, ${summaries.length} summaries under ${namespace} — check --namespace / --messages-state`);
  store.close();
  process.exit(1);
}

const plan = planTopologyRepair({ summaries, records, messages, resolutions }, { releaseHead, releaseHeadLimit, mode, ...(rebuildSince !== undefined ? { rebuildSince } : {}) });
const summary = {
  store: storePath, namespace, run: apply ? 'apply' : 'dry-run', mode, releaseHead,
  messages: messages.length, summaries: summaries.length, records: records.length,
  crossedBefore: plan.before.length, iterations: plan.iterations,
  adopted: plan.adopted, detached: plan.detached, rehomed: plan.rehomed, splitL1: plan.splitL1, dissolved: plan.dissolved, released: plan.released,
  rangeChanges: plan.rangeChanges, resolutionsClamped: plan.resolutionsClamped, resolutionsCleared: plan.resolutionsCleared,
  proseGapLeaves: plan.proseGapLeaves, depthLostLeaves: plan.depthLostLeaves, dissolvedForRebuild: plan.dissolvedForRebuild, exposedL1Leaves: plan.exposedL1Leaves, rebuildSince: plan.rebuildSince,
  remaining: plan.remaining,
  after: { summaries: plan.result.summaries.length, records: plan.result.records.length },
};
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`${storePath} (${namespace}): ${messages.length} messages, ${summaries.length} summaries, ${records.length} records — ${plan.before.length} crossed`);
  for (const c of plan.before) console.log(`  crossed L${c.level} ${c.id}: ${c.leafCount} leaves ${c.span.first}..${c.span.last}, ${c.holes} hole(s)`);
  console.log(`plan (${plan.iterations} pass${plan.iterations === 1 ? '' : 'es'}):`);
  for (const a of plan.adopted) console.log(`  adopt L${a.level} ${a.id} (${a.leaves} leaves) into ${a.into} — its prose does not cover them`);
  for (const d of plan.detached) console.log(`  detach L${d.level} ${d.id} (${d.leaves} leaves) from ${d.from}`);
  for (const r of plan.rehomed) console.log(`  re-home ${r.id} (${r.leaves} leaves) from ${r.from} into ${r.into}`);
  for (const s of plan.splitL1) console.log(`  split L1 ${s.id}: keep ${s.kept}, release ${s.released.join(',')}`);
  for (const d of plan.dissolved) console.log(`  dissolve L${d.level} ${d.id} (single source ${d.child})`);
  if (plan.rebuildSince) console.log(`  rebuild-since: message ${plan.rebuildSince.id} (store position ${plan.rebuildSince.position}) — ${plan.rebuildSince.rebuilt} crossed rebuilt, ${plan.rebuildSince.compacted} older ones compacted`);
  if (plan.dissolvedForRebuild.length) {
    const byLevel: Record<string, number> = {};
    for (const d of plan.dissolvedForRebuild) byLevel[`L${d.level}`] = (byLevel[`L${d.level}`] ?? 0) + 1;
    console.log(`  rebuild: dissolve ${plan.dissolvedForRebuild.length} summaries (${Object.entries(byLevel).map(([k, n]) => `${k}:${n}`).join(' ')}) — ${plan.exposedL1Leaves} leaves exposed at L1 until re-folded; ≈${plan.dissolvedForRebuild.length} summarizer merges to regenerate`);
  }
  for (const r of plan.released) console.log(`  release head record ${r.record}${r.summaryId ? ` + ${r.summaryId}` : ''}: ${r.leaves.join(',')}`);
  for (const r of plan.rangeChanges) console.log(`  range ${r.id}: ${r.from.first}..${r.from.last} → ${r.to.first}..${r.to.last}`);
  console.log(`  cost: ${plan.proseGapLeaves} leaves under prose that never covered them; ${plan.depthLostLeaves} leaves lost a fold level; resolutions ${plan.resolutionsClamped} clamped, ${plan.resolutionsCleared} cleared`);
  console.log(`  after: ${plan.result.summaries.length} summaries, ${plan.result.records.length} records, ${plan.remaining.length} still crossed`);
  for (const c of plan.remaining) console.log(`  STILL CROSSED L${c.level} ${c.id}: ${c.holes} hole(s)`);
}
if (plan.remaining.length > 0) { console.error('plan does not reach a clean store; nothing written'); store.close(); process.exit(2); }
const changes = plan.detached.length + plan.adopted.length + plan.rehomed.length + plan.splitL1.length + plan.dissolved.length + plan.released.length + plan.rangeChanges.length;
if (changes === 0) { console.error(plan.before.length === 0 ? 'store is clean; nothing to do' : 'nothing to change'); store.close(); process.exit(0); }
if (!apply) { console.error('DRY RUN — nothing written (add --apply)'); store.close(); process.exit(0); }
store.setStateJson(sumsState, plan.result.summaries);
store.setStateJson(chunksState, plan.result.records);
store.setStateJson(resolutionsState, plan.result.resolutions);
store.close();
if (mode === 'rebuild') console.error(`APPLIED (rebuild): ${plan.dissolvedForRebuild.length} summaries dissolved, ${plan.exposedL1Leaves} leaves at L1. Re-fold offline before restarting the resident:\n  node dist/scripts/drain-autobiographical.js ${storePath} ${namespace} --apply --model=<resident-model> --participant=<resident> --recipe=<recipe.json>`);
console.error('APPLIED; verifying with the load-time audit (topologyPolicy reject)…');
try {
  const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, topologyPolicy: 'reject', auditOnly: true });
  const manager = await ContextManager.open({ path: storePath, strategy, namespace, membrane: { complete: async () => ({ content: [] }) } as never });
  manager.close();
  console.error('VERIFIED: the store opens under topologyPolicy reject.');
} catch (error) {
  console.error(`VERIFICATION FAILED: ${(error as Error).message}`);
  process.exit(2);
}
