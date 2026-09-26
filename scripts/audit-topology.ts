/**
 * Audit a store's summary topology: every summary whose leaves are not
 * contiguous among chunk-owned messages in store order (crossed ownership —
 * issue #122 cross-era merges, restore/branch interleavings, hand surgery).
 * Read-only; the same audit `initialize` runs (topologyPolicy).
 *
 * Usage:
 *   node dist/scripts/audit-topology.js <store-path> [--namespace <ns>] [--json]
 *
 * Exit code 0 = clean, 2 = violations found, 1 = could not open.
 * Opens the store audit-only (no frontier chunking, no merge enqueue, no
 * queue rewrite). Run it on a stopped resident's store or a copy: opening a
 * chronicle store takes its lock and may rewrite its state index.
 */

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const storePath = args.find((a) => !a.startsWith('--'));
  if (!storePath) {
    console.error('Usage: audit-topology <store-path> [--namespace <ns>] [--json]');
    process.exit(1);
  }
  const nsAt = args.indexOf('--namespace');
  const namespace = nsAt >= 0 ? args[nsAt + 1] : undefined;
  const json = args.includes('--json');
  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    hierarchical: true,
    autoTickOnNewMessage: false,
    topologyPolicy: 'report',
    auditOnly: true,
  });
  const membrane = { complete: async () => ({ content: [{ type: 'text', text: '[audit]' }] }) };
  const manager = await ContextManager.open({
    path: storePath, strategy, membrane: membrane as never, ...(namespace ? { namespace } : {}),
  });
  try {
    const violations = strategy.getTopologyViolations();
    const debt = strategy.getCompressionDebt();
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
      console.log(JSON.stringify({ store: storePath, namespace, messages: manager.getMessageCount(), summaries: internals.summaries.length, levels, chunks: internals.chunks.length, linkedChunks: linked, violations, debt }, null, 2));
    } else {
      console.log(`${storePath}${namespace ? ` (${namespace})` : ''}: ${manager.getMessageCount()} messages, ${seen}, ` +
        `${violations.length} topology violation(s), compression debt ${debt.state}`);
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
