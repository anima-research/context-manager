/**
 * Audit a store's summary topology: every summary whose leaves are not
 * contiguous among chunk-owned messages in store order (crossed ownership —
 * issue #122 cross-era merges, restore/branch interleavings, hand surgery).
 * It runs the same audit as `initialize` (topologyPolicy).
 *
 * Usage:
 *   node dist/scripts/audit-topology.js <store-path> [--namespace <ns>] [--json] [run settings]
 *
 * It also lists the summaries no merge can take as the store stands
 * (`getStrandedSummaries()`), by the run rule, which reads the resident's run
 * settings; the store doesn't hold them, so pass them as the resident has
 * them (--merge-threshold, --merge-max-span and --merge-hold, each also as
 * --flag=value, and --no-speculative-production; see --help). The text
 * output prints the values it used.
 *
 * Exit code 0 = no topology violation, 2 = violations found, 1 = could not
 * open. Stranded summaries, and a stranded check that couldn't run, are
 * reported, not counted in the exit code.
 * Opens the store audit-only: no frontier chunking, no merge enqueue, and no
 * dropping of queued merges the grouping grammar refuses. The open still
 * writes. Opening a chronicle store takes its lock and may rewrite its state
 * index, and loading persists the strategy's repair of what readers can't
 * use (see `auditOnly`). So run it on a stopped resident's store, and on a
 * copy to keep the store as it was.
 */

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { flagValue, positionalArg, runsFromArgs, runsLine, RUN_VALUE_FLAGS, RUNS_USAGE } from './run-flags.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const usage = 'Usage: audit-topology <store-path> [--namespace <ns>] [--json]\n' +
    '  the stray list reads these resident settings (pass them as the resident has them):\n' + RUNS_USAGE;
  if (args.includes('--help')) { console.log(usage); process.exit(0); }
  const namespace = flagValue(args, '--namespace');
  if (typeof namespace === 'object') { console.error(namespace.error); process.exit(1); }
  const storePath = positionalArg(args, ['--namespace', ...RUN_VALUE_FLAGS]);
  if (typeof storePath === 'object') { console.error(storePath.error); process.exit(1); }
  if (!storePath) {
    console.error(usage);
    process.exit(1);
  }
  const runs = runsFromArgs(args);
  if ('error' in runs) { console.error(runs.error); process.exit(1); }
  const json = args.includes('--json');
  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    hierarchical: true,
    autoTickOnNewMessage: false,
    topologyPolicy: 'report',
    auditOnly: true,
    mergeThreshold: runs.mergeThreshold,
    mergeMaxSourceSpanMessages: runs.mergeMaxSourceSpanMessages,
    mergeHoldSummaryIds: runs.mergeHoldSummaryIds,
    speculativeProduction: runs.speculativeProduction,
  });
  const membrane = { complete: async () => ({ content: [{ type: 'text', text: '[audit]' }] }) };
  const manager = await ContextManager.open({
    path: storePath, strategy, membrane: membrane as never, ...(namespace ? { namespace } : {}),
  });
  try {
    const violations = strategy.getTopologyViolations();
    const debt = strategy.getCompressionDebt();
    const stranded = strategy.getStrandedSummaries();
    const internals = strategy as unknown as { summaries: Array<{ level: number }>; chunks: Array<{ summaryId?: string }> };
    const levels: Record<string, number> = {};
    for (const s of internals.summaries) levels[`L${s.level}`] = (levels[`L${s.level}`] ?? 0) + 1;
    const linked = internals.chunks.filter((c) => c.summaryId).length;
    const seen = `${internals.summaries.length} summaries (${Object.entries(levels).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'}), ` +
      `${internals.chunks.length} chunks (${linked} linked to an L1)`;
    if (internals.summaries.length === 0 || (internals.chunks.length > 0 && linked === 0)) {
      console.error(`⚠️ audit saw ${seen} — a store with no summaries or no chunk→L1 links has nothing to audit; ` +
        `check the namespace (--namespace agents/<Name>) and that the copy carries the strategy state.`);
    }
    if (json) {
      console.log(JSON.stringify({ store: storePath, namespace, messages: manager.getMessageCount(), summaries: internals.summaries.length, levels, chunks: internals.chunks.length, linkedChunks: linked, runs, violations, debt, stranded }, null, 2));
    } else {
      console.log(`${storePath}${namespace ? ` (${namespace})` : ''}: ${manager.getMessageCount()} messages, ${seen}, ` +
        `${violations.length} topology violation(s), compression debt ${debt.state}`);
      // What the report couldn't read, what that means and what to do, a line each.
      if (debt.error !== undefined) for (const line of debt.error.split('\n')) console.log(`  ${line}`);
      console.log(`  ${runsLine(runs)}`);
      if (stranded.summaries === null) {
        const same = stranded.error === debt.error;
        console.log(`  stranded summaries: not checked${same ? ' (see above)' : ':'}`);
        if (!same) for (const line of stranded.error.split('\n')) console.log(`    ${line}`);
      }
      for (const s of stranded.summaries ?? []) {
        const name = { 'compression-quarantine': 'quarantined chunk', 'merge-quarantine': 'quarantined merge', hold: 'operator hold on' } as const;
        const lift = (b: (typeof s.beside)[number]): string => ({
          'compression-quarantine': `quarantine ${b.id} is cleared (clearCompressionRefusalQuarantine, a strategy method connectome-host has no command for) and the chunk compresses`,
          'merge-quarantine': `merge ${b.id} is cleared (the strategy's clearMergeQuarantine, or a drain run with --clear-merge-quarantine=${b.id}) and runs`,
          hold: `the hold on ${b.id} is lifted (mergeHoldSummaryIds)`,
        })[b.kind];
        const sides: string[] = [];
        for (const side of ['before', 'after'] as const) {
          const here = s.beside.filter((b) => b.side === side);
          if (here.length === 0) continue;
          const names = `${side} it, ${here.map((b) => `${name[b.kind]} ${b.id}`).join(' and ')}`;
          const ownLevel = here.filter((b) => b.kind === 'merge-quarantine' && b.level === s.level);
          const lifts = here.map((b) => (ownLevel.includes(b) ? `merge ${b.id} is cleared (the strategy's clearMergeQuarantine, or a drain run with --clear-merge-quarantine=${b.id})` : lift(b)));
          sides.push(`${names}: once ${lifts.join(' and ')}, it may merge with what then stands there` +
            (ownLevel.length > 0 ? `, unless a clear queues ${ownLevel.map((b) => `${b.id}'s`).join(' or ')} own group again at once, which leaves this summary out` : ''));
        }
        const rebuild = 'a rebuild (repair-topology --mode rebuild) can give it partners where it can free a neighbour of its level, which its dry run shows';
        const beside = !(runs.mergeThreshold >= 2)
          ? `below a merge threshold of 2 no merge lands, so neither clearing what stands beside it nor a rebuild gives it a partner`
          : sides.length === 0
            ? `nothing quarantined or held beside it, so ${rebuild}`
            : `${sides.join('; ')}; if it is still listed after that, ${rebuild}`;
        console.log(`  stranded L${s.level} ${s.id}: ${s.tokens} tokens, ${beside}`);
      }
      for (const v of violations) {
        console.log(`  L${v.level} ${v.id}: ${v.leafCount} leaves ${v.span.first}..${v.span.last}, ` +
          `${v.holes} hole(s) e.g. ${v.holeSample.join(',')}` +
          `${v.holeOwners.length ? ` owned by ${v.holeOwners.join(',')}` : ''}`);
      }
    }
    process.exitCode = violations.length > 0 ? 2 : 0;
  } finally {
    manager.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
