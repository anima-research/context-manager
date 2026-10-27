/**
 * Repair crossed summary ownership in a store (see src/repair/topology.ts).
 * Dry-run by default. Run on a STOPPED store (or a copy): a live store's
 * on-disk state lags its process.
 *
 * Usage:
 *   node dist/scripts/repair-topology.js <store-path> --namespace <ns> [--apply] [--release-head[=moved|all]] [--release-head-limit <n>] [--mode lossless|compact|rebuild] [--rebuild-since <messageId|ISO date>] [--json] [--messages-state <id>] [run settings]
 *
 * Both opens (verification, and the audit) are audit-only: they enqueue no
 * merges, and mint chunk records only as every open migrates a store that
 * has L1s and none. --release-head=all also releases
 * pre-existing unparented root L1s at the prefix (the head must be able to
 * take them back: CM ≥ #123 anchors it to coverage, bounded at 2× headWindowTokens).
 *
 * lossless (default) only detaches: no prose ever claims content it did not
 * see, but the pyramid unravels around each fragment (reported as leaves that
 * lost a fold level). compact adopts and re-homes as well: depth is kept, at
 * the price of prose gaps (reported as leaves). rebuild dissolves every
 * summary whose span touches a crossed region (and their ancestors) back to
 * L1s so the merge ladder re-folds the region with real summarizer calls —
 * run scripts/drain-autobiographical.ts on the stopped store afterwards. It
 * also gives a partner, where one can be freed, to each summary the store as
 * the plan leaves it would hold alone at its level once the drain has
 * re-folded it and the store has grown: by the run rule the strategy's
 * `getStrandedSummaries()` uses (src/strategies/merge-runs.ts), except that
 * a run with a summary of a higher level after it reads as one that can't
 * grow (cantGrowPast), and with no retry pending, as in a stopped store. That
 * covers a crossed summary's child, the messages a crossed L1 releases (each
 * run of them read as one L1 to come), a summary already stranded, and a
 * summary the re-fold would leave alone. It dissolves the tower over one
 * neighbour of that level, the side whose tower holds fewer leaves; so a
 * rebuild of a store with no crossing heals the strays it can. The plan lists
 * each as `partner …`, and each it can't partner as `STILL STRANDED …` with
 * why. --mode rebuild refuses --release-head: release the head in a pass of
 * its own first.
 * The rule reads the resident's run settings, which the store doesn't hold:
 * pass them as the resident has them (--merge-threshold, --merge-max-span and
 * --merge-hold, each also as --flag=value, and --no-speculative-production);
 * the plan prints the values it used. The stored merge queue and
 * merge-quarantine records are read as the strategy reads them at open, and
 * each queued merge that can still run is taken to land before the ladder
 * forms new merges, as it drains, and so is each chunk recorded and not yet
 * compressed that no compression quarantine holds, as an L1 to come. The
 * store is read as the strategy's loader keeps it (settle-summaries.ts):
 * its chunk records, its summaries settled over them, and each compressed
 * record whose L1 the settling drops made compressible again. The plan
 * prints what that settling repaired, in the loader's own line, with where
 * the text of each summary it dropped can still be read, and the apply
 * writes that store with the plan's changes, so what loads is what the plan
 * planned; the summary-id counter is raised past every stored id first, as
 * the loader raises it.
 * --rebuild-since <messageId|ISO date> rebuilds only crossed summaries whose
 * span starts at or after that message and compacts the older ones; strays
 * and released messages before it get no partner, and no tower that starts
 * before it is dissolved to partner one (a crossed summary rebuilt after it
 * still takes its ancestors with it). The L1 split still releases a crossed
 * L1's other runs there, as the compact treatment does; such a run is
 * listed as `STILL STRANDED …`.
 * None of the modes makes model calls itself.
 *
 * After --apply the store is reopened with topologyPolicy 'reject'; the run
 * fails if the audit still finds a crossed summary.
 * Exit 0 = nothing crossed is left, or a dry run's plan leaves nothing
 * crossed (nothing to do, a dry run, or applied and verified);
 * a summary listed as `STILL STRANDED …` doesn't change it. 2 = plan
 * incomplete or verification failed; 1 = usage/open error.
 */

import { JsStore } from '@animalabs/chronicle';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { loadedAsWritten, planTopologyRepair, type RepairInputs, type RepairRecord, type RepairSummary } from '../src/repair/topology.js';
import { compressionQuarantineHolds } from '../src/strategies/autobiographical.js';
import { releasedRecordsLine, summaryIdCounterPast } from '../src/strategies/settle-summaries.js';
import { flagValue, positionalArg, runsFromArgs, runsLine, RUN_VALUE_FLAGS, RUNS_USAGE } from './run-flags.js';

const args = process.argv.slice(2);
const positional = positionalArg(args, ['--namespace', '--release-head-limit', '--mode', '--rebuild-since', '--messages-state', ...RUN_VALUE_FLAGS]);
if (typeof positional === 'object') { console.error(positional.error); process.exit(1); }
const storePath = positional;
const flag = (name: string): string | undefined => {
  const value = flagValue(args, name);
  if (typeof value === 'object') { console.error(value.error); process.exit(1); }
  return value;
};
const namespace = flag('--namespace');
const USAGE = 'usage: repair-topology <store-path> --namespace <ns> [--apply] [--release-head[=moved|all]] [--release-head-limit <n>] [--mode lossless|compact|rebuild] [--rebuild-since <messageId|ISO date>] [--json] [--messages-state <id>]\n' +
  '  rebuild reads these resident settings, which change which summaries stand alone (pass them as the resident has them):\n' + RUNS_USAGE;
if (args.includes('--help')) { console.log(USAGE); process.exit(0); }
if (!storePath || !namespace) {
  console.error(USAGE);
  process.exit(1);
}
const runs = runsFromArgs(args);
if ('error' in runs) { console.error(runs.error); process.exit(1); }
const apply = args.includes('--apply');
const json = args.includes('--json');
const releaseHead: false | 'moved' | 'all' = args.includes('--release-head=all') ? 'all' : (args.includes('--release-head') || args.includes('--release-head=moved')) ? 'moved' : false;
const rebuildSince = flag('--rebuild-since');
const releaseHeadLimit = flag('--release-head-limit') !== undefined ? Number(flag('--release-head-limit')) : undefined;
if (releaseHeadLimit !== undefined && !(releaseHeadLimit > 0)) { console.error('--release-head-limit must be a positive number of messages'); process.exit(1); }
const mode = (flag('--mode') ?? 'lossless') as 'lossless' | 'compact' | 'rebuild';
if (mode !== 'lossless' && mode !== 'compact' && mode !== 'rebuild') { console.error(`--mode must be lossless, compact or rebuild, got ${mode}`); process.exit(1); }
if (mode === 'rebuild' && releaseHead) {
  console.error('--mode rebuild refuses --release-head: the rebuild partners strays before the head is released, so it could dissolve a tower to partner a summary the release then removes. Release the head in a pass of its own (--mode lossless or compact with --release-head), then rebuild.');
  process.exit(1);
}
const messagesState = flag('--messages-state') ?? 'messages';

const store = JsStore.open({ path: storePath });
const sumsState = `${namespace}/autobio:summaries`;
const chunksState = `${namespace}/autobio:chunks`;
const resolutionsState = `${namespace}/autobio:resolutions`;
const stateArray = <T>(id: string): T[] => { const value = store.getStateJson(id); return Array.isArray(value) ? value as T[] : []; };
const summaries = stateArray<RepairSummary>(sumsState);
const records = stateArray<RepairRecord>(chunksState);
const storedResolutions = store.getStateJson(resolutionsState);
const resolutions = (storedResolutions != null && typeof storedResolutions === 'object' && !Array.isArray(storedResolutions) ? storedResolutions : {}) as Record<string, number>;
const messages = stateArray<{ id: string }>(messagesState);
const mergeQueue = stateArray<{ level: number; sourceIds: string[] }>(`${namespace}/autobio:mergeQueue`);
const mergeQuarantine = stateArray<NonNullable<RepairInputs['mergeQuarantine']>[number]>(`${namespace}/autobio:merge-quarantine`);
const quarantine = compressionQuarantineHolds(
  store.getStateJson(`${namespace}/autobio:compression-refusal-quarantine-events`),
  store.getStateJson(`${namespace}/autobio:compression-refusal-quarantine`),
);
if (quarantine.dropped.length > 0 || quarantine.unlisted.length > 0) {
  console.error(`the compression quarantine's stored state holds what the strategy reads as no entry: ` +
    `${quarantine.dropped.length > 0 ? `entries left out [${quarantine.dropped.join(', ')}]` : ''}` +
    `${quarantine.dropped.length > 0 && quarantine.unlisted.length > 0 ? '; ' : ''}` +
    `${quarantine.unlisted.length > 0 ? `no list in ${quarantine.unlisted.join(' and ')}` : ''}; the plan reads as quarantined only what the entries it can read name`);
}
const listed = new Set(messages.map((m) => String(m?.id)));
const compressionQuarantined = records
  .filter((r) => r != null && Array.isArray(r.sourceIds) && typeof r.id === 'string' && quarantine.holds(r.sourceIds.filter((id) => listed.has(id))))
  .map((r) => r.id);
if (messages.length === 0 || summaries.length === 0) {
  console.error(`nothing to repair: ${messages.length} messages, ${summaries.length} summaries under ${namespace} — check --namespace / --messages-state`);
  store.close();
  process.exit(1);
}

const plan = planTopologyRepair({ summaries, records, messages, resolutions, mergeQueue, mergeQuarantine, compressionQuarantined }, { releaseHead, releaseHeadLimit, mode, runs, ...(rebuildSince !== undefined ? { rebuildSince } : {}) });
const summary = {
  store: storePath, namespace, run: apply ? 'apply' : 'dry-run', mode, releaseHead, ...(mode === 'rebuild' ? { runs } : {}),
  messages: messages.length, summaries: summaries.length, records: records.length,
  crossedBefore: plan.before.length, iterations: plan.iterations,
  adopted: plan.adopted, detached: plan.detached, rehomed: plan.rehomed, splitL1: plan.splitL1, dissolved: plan.dissolved, released: plan.released,
  rangeChanges: plan.rangeChanges, resolutionsClamped: plan.resolutionsClamped, resolutionsCleared: plan.resolutionsCleared,
  proseGapLeaves: plan.proseGapLeaves, depthLostLeaves: plan.depthLostLeaves, dissolvedForRebuild: plan.dissolvedForRebuild, exposedL1Leaves: plan.exposedL1Leaves, partnered: plan.partnered, strandedLeft: plan.strandedLeft, rebuildSince: plan.rebuildSince,
  remaining: plan.remaining,
  settled: { ...plan.settled, textAt: { stateId: sumsState, sequence: store.currentSequence(), branch: store.currentBranch().name } },
  resettled: plan.resettled,
  after: { summaries: plan.result.summaries.length, records: plan.result.records.length },
};
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`${storePath} (${namespace}): ${messages.length} messages, ${summaries.length} summaries, ${records.length} records — ${plan.before.length} crossed`);
  if (mode === 'rebuild') console.log(runsLine(runs));
  for (const c of plan.before) console.log(`  crossed L${c.level} ${c.id}: ${c.leafCount} leaves ${c.span.first}..${c.span.last}, ${c.holes} hole(s)`);
  if (plan.settled.line) console.log(`  settling the store as the loader does: ${plan.settled.line}`);
  if (plan.settled.dropped.length > 0) {
    const why = { unreadable: 'its sources or range can\'t be read', 'names-missing': 'it names a summary the store doesn\'t hold', 'names-not-below': 'it names a summary at its own level or above', 'names-non-child': 'it names a summary it isn\'t the parent of' } as const;
    console.log(`  the text of each summary dropped there stays in the store's history, in state ${summary.settled.textAt.stateId} ` +
      `at sequence ${summary.settled.textAt.sequence} on branch ${summary.settled.textAt.branch}: ` +
      plan.settled.dropped.map((d) => `${d.id} (${why[d.reason]}${d.tokens !== null ? `, ${d.tokens} tokens` : ''})`).join(', '));
  }
  if (plan.settled.filteredRecords > 0) console.log(`  settling the store as the loader does: left out ${plan.settled.filteredRecords} chunk record(s) with no id or no message ids`);
  if (plan.settled.releasedRecords > 0) console.log(`  settling the store as the loader does: ${releasedRecordsLine(plan.settled.releasedRecords)}`);
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
  const what = (x: { kind: 'stranded' | 'released' | 'pending' | 'refolded'; id: string; level: number }, stranded: string): string =>
    x.kind === 'stranded' ? `${stranded}L${x.level} ${x.id}`
      : x.kind === 'released' ? `the messages ${x.id} releases`
      : x.kind === 'pending' ? `the L1 the pending chunk ${x.id} compresses to`
      : `the L${x.level} the re-fold makes over ${x.id}`;
  for (const x of plan.partnered) console.log(`  partner ${what(x, 'stranded ')} (${x.leaves} leaves ${x.span.first}..${x.span.last}): dissolve ${x.dissolved} and what stands above`);
  for (const x of plan.strandedLeft) console.log(`  STILL STRANDED ${what(x, '')} (${x.leaves} leaves ${x.span.first}..${x.span.last}): ${x.reason}${x.stale ? ` (${x.stale.join(', ')}, an L1 no chunk record names, over messages another L1's record holds)` : ''}`);
  for (const r of plan.released) console.log(`  release head record ${r.record}${r.summaryId ? ` + ${r.summaryId}` : ''}: ${r.leaves.join(',')}`);
  for (const r of plan.rangeChanges) console.log(`  range ${r.id}: ${r.from.first}..${r.from.last} → ${r.to.first}..${r.to.last}`);
  console.log(`  cost: ${plan.proseGapLeaves} leaves under prose that never covered them; ${plan.depthLostLeaves} leaves lost a fold level; resolutions ${plan.resolutionsClamped} clamped, ${plan.resolutionsCleared} cleared`);
  if (plan.resettled.line || plan.resettled.filteredRecords > 0 || plan.resettled.releasedRecords > 0) {
    console.log(`  PLANNER FAULT: settled again before the write, the plan's own store is ` +
      [plan.resettled.line, plan.resettled.filteredRecords > 0 ? `${plan.resettled.filteredRecords} chunk record(s) the loader leaves out removed` : '',
        plan.resettled.releasedRecords > 0 ? releasedRecordsLine(plan.resettled.releasedRecords) : ''].filter(Boolean).join('; '));
  }
  console.log(`  after: ${plan.result.summaries.length} summaries, ${plan.result.records.length} records, ${plan.remaining.length} still crossed`);
  for (const c of plan.remaining) console.log(`  STILL CROSSED L${c.level} ${c.id}: ${c.holes} hole(s)`);
}
if (plan.remaining.length > 0) { console.error('plan does not reach a clean store; nothing written'); store.close(); process.exit(2); }
const counterState = `${namespace}/autobio:counter`;
const storedCounter = store.getStateJson(counterState);
const counterPast = summaryIdCounterPast(plan.settled.storedIds);
const counterBehind = counterPast > (typeof storedCounter === 'number' ? storedCounter : 0);
const changes = plan.detached.length + plan.adopted.length + plan.rehomed.length + plan.splitL1.length + plan.dissolved.length + plan.released.length + plan.rangeChanges.length + plan.dissolvedForRebuild.length +
  (plan.settled.line ? 1 : 0) + plan.settled.releasedRecords + plan.settled.filteredRecords + (counterBehind ? 1 : 0) +
  (plan.resettled.line ? 1 : 0) + plan.resettled.filteredRecords + plan.resettled.releasedRecords +
  plan.resolutionsClamped;
if (changes === 0) { console.error(plan.before.length === 0 && plan.strandedLeft.length === 0 ? 'store is clean; nothing to do' : 'nothing to change'); store.close(); process.exit(0); }
if (!apply) { console.error('DRY RUN — nothing written (add --apply)'); store.close(); process.exit(0); }
if (counterBehind) store.setStateJson(counterState, counterPast);
store.setStateJson(sumsState, plan.result.summaries);
store.setStateJson(chunksState, plan.result.records);
store.setStateJson(resolutionsState, plan.result.resolutions);
store.close();
if (mode === 'rebuild') {
  console.error(`APPLIED (rebuild): ${plan.dissolvedForRebuild.length} summaries dissolved, ${plan.exposedL1Leaves} leaves at L1. Re-fold offline before restarting the resident:\n` +
    `  node dist/scripts/drain-autobiographical.js ${storePath} ${namespace} --apply --model=<resident-model> --participant=<resident> --recipe=<recipe.json> [--tools-log=<log>]\n` +
    `  The drain merges by the plan's rule when the recipe holds the settings this plan read (its start event prints what it read): ${runsLine(runs)}.\n` +
    '  A summarizer that needs tool definitions (Fable, Mythos) compresses nothing without them: give --tools-log a log of the resident\'s requests.');
}
console.error('APPLIED; verifying with the load-time audit (topologyPolicy reject)…');
try {
  const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, topologyPolicy: 'reject', auditOnly: true });
  const manager = await ContextManager.open({ path: storePath, strategy, namespace, membrane: { complete: async () => ({ content: [] }) } as never });
  manager.close();
  const report = strategy.getLatestLoadRepairReport();
  if (report && report.dropped.length > 0) {
    console.error(`LOADER REPAIR: the open dropped ${report.dropped.length} summar${report.dropped.length === 1 ? 'y' : 'ies'} holding text (${report.droppedTokens} tokens): ` +
      `${report.dropped.map((d) => `${d.id} (${d.reason})`).join(', ')}. Their text is in ${report.stateId} at sequence ${report.sequenceBefore} on branch ${report.branch}.`);
  }
  const reread = JsStore.open({ path: storePath });
  let left: ReturnType<typeof loadedAsWritten>;
  try {
    left = loadedAsWritten(plan.result, { summaries: reread.getStateJson(sumsState), records: reread.getStateJson(chunksState) });
  } finally {
    reread.close();
  }
  const changed = [...(left.summariesChanged ? ['the summaries'] : []), ...(left.recordsChanged ? ['the chunk records'] : [])];
  if (changed.length > 0) {
    console.error(`VERIFICATION FAILED: the open changed ${changed.join(' and ')} the repair wrote, so the plan's store isn't the loader's (its warnings above say what it repaired).`);
    process.exit(2);
  }
  if (left.appendedRecords > 0) {
    console.error(`  the open appended ${left.appendedRecords} chunk record(s)`);
  }
  console.error('VERIFIED: the store opens under topologyPolicy reject, and the open changed nothing the repair wrote.');
} catch (error) {
  console.error(`VERIFICATION FAILED: ${(error as Error).message}`);
  process.exit(2);
}
