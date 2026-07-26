/**
 * Diagnose the kv-stable fold-walk oscillation (`raise:L4-936` on Mythos).
 *
 * Hypothesis under test: the summary forest's UPWARD view (chunk.l1Id →
 * parentId/mergedInto chain — used by ancestorAt in the tree, the picker's
 * FoldingState, and nextOp) disagrees with the DOWNWARD view (root sourceIds
 * recursion — used by applyRaise/applyLower and leafChunkIds unanimity checks).
 * One chunk that is upward-connected to a root but absent from its downward
 * leaf set (or vice versa) makes the walk emit raise/lower ops that can never
 * converge.
 *
 * Usage: node dist/scripts/diagnose-oscillation.js <store-path> [--ns agents/mythos]
 * Run against a DISPOSABLE copy (compile persists resolutions).
 */

import { writeFileSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { KvStableStrategy } from '../src/adaptive/strategies/kv-stable.js';
import { SummaryTree } from '../src/adaptive/summary-tree.js';
import type { PickerInputs } from '../src/adaptive/picker.js';

function loudMockMembrane() {
  return { complete: async () => ({ content: [{ type: 'text', text: '[mock]' }] }) };
}

// ---- capture ----
let captured: {
  inputs: PickerInputs;
  target: Map<string, number>;
  fPrev: Map<string, number>;
} | null = null;
const emittedOps: string[] = [];

// Post-walk-retirement (refactor/retire-fold-walk): capture the solve itself.
// `emittedOps` stays for report-shape compatibility but is always empty now —
// there are no ops; the solved frontier IS what the picker applies.
const proto = KvStableStrategy.prototype as any;
const origSolve = proto.solve;
proto.solve = function (inputs: any, budget: any) {
  const solution = origSolve.call(this, inputs, budget);
  if (!captured) {
    captured = {
      inputs,
      target: new Map(solution.frontier),
      fPrev: new Map(inputs.chunks.map((c: any) => [c.id, c.currentResolution])),
    };
  }
  return solution;
};

async function main() {
  const args = process.argv.slice(2);
  const storePath = args[0];
  const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const ns = opt('--ns', 'agents/mythos');

  const config = {
    adaptiveResolution: true,
    headWindowTokens: 4000,
    recentWindowTokens: Number(opt('--tail', '80000')),
    maxMessageTokens: 10000,
    overBudgetGraceRatio: 0.35,
    compressionModel: 'claude-fable-5',
    enforceBudget: true,
    maxSpeculativeL1s: 0,
    summaryParticipant: 'mythos',
    foldingStrategy: 'kv-stable' as const,
    kvStableReachTokens: 400000,
    autoTickOnNewMessage: false,
  };
  const strategy = new AutobiographicalStrategy(config as any);
  const cm = await ContextManager.open({
    path: storePath, strategy: strategy as never, membrane: loudMockMembrane() as never, namespace: ns,
  } as any);

  try {
    await cm.compile({ maxTokens: Number(opt('--budget', '300000')), reserveForResponse: Number(opt('--reserve', '16384')) });
  } catch (e: any) {
    console.log(`compile outcome: ${String(e?.message ?? e).slice(0, 160)}`);
  }

  if (!captured) { console.error('no kv-stable solve captured'); process.exit(1); }
  const { inputs, target, fPrev } = captured;

  const dumpPath = opt('--dump');
  if (dumpPath) {
    writeFileSync(dumpPath, JSON.stringify({
      chunks: inputs.chunks,
      summaries: [...inputs.summaries.entries()],
      recallPairTokens: [...(inputs.recallPairTokens ?? new Map()).entries()],
      headChunkIds: [...inputs.headChunkIds],
      tailChunkIds: [...inputs.tailChunkIds],
      headTokens: inputs.headTokens,
      tailTokens: inputs.tailTokens,
      fPrev: [...fPrev.entries()],
      target: [...target.entries()],
    }));
    console.log(`[diag] dumped picker inputs → ${dumpPath}`);
  }
  const tree = new SummaryTree(inputs);
  const chunkById = new Map(inputs.chunks.map((c) => [c.id, c]));

  // ---- op trace ----
  const opCounts = new Map<string, number>();
  for (const o of emittedOps) opCounts.set(o, (opCounts.get(o) ?? 0) + 1);
  console.log(`\n=== ops emitted: ${emittedOps.length} total, ${opCounts.size} distinct ===`);
  for (const [k, n] of [...opCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(3)}×  ${k}`);
  }
  console.log(`  first 30: ${emittedOps.slice(0, 30).join(' ')}`);

  // ---- membership asymmetry scan ----
  // upward: for each chunk, record every (root, level) on its l1Id→parent chain
  // downward: node.leafChunkIds
  const downSets = new Map<string, Set<string>>();
  for (const n of tree.allSummaries()) downSets.set(n.id, new Set(n.leafChunkIds));

  type Mismatch = { chunk: string; seq: number; node: string; level: number; kind: string };
  const mismatches: Mismatch[] = [];
  for (const c of inputs.chunks) {
    // walk the upward chain
    const leaf = tree.leaf(c.id);
    if (!leaf?.l1Id) continue;
    let cur = tree.summary(leaf.l1Id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (!downSets.get(cur.id)!.has(c.id)) {
        mismatches.push({ chunk: c.id, seq: c.sequence, node: cur.id, level: cur.level, kind: 'up-not-down' });
      }
      cur = cur.parentId ? tree.summary(cur.parentId) : null;
    }
  }
  // downward: leaf in node's set whose ancestorAt(level) is a DIFFERENT node (or null)
  for (const n of tree.allSummaries()) {
    for (const lid of n.leafChunkIds) {
      if (!chunkById.has(lid)) {
        mismatches.push({ chunk: lid, seq: -1, node: n.id, level: n.level, kind: 'dead-leaf-id' });
        continue;
      }
      const up = tree.ancestorAt(lid, n.level);
      if (up?.id !== n.id) {
        mismatches.push({ chunk: lid, seq: chunkById.get(lid)!.sequence, node: n.id, level: n.level, kind: up ? 'down-not-up(other)' : 'down-not-up(null)' });
      }
    }
  }
  const byKind = new Map<string, number>();
  for (const m of mismatches) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
  console.log(`\n=== membership asymmetries: ${mismatches.length} ===`);
  for (const [k, n] of byKind) console.log(`  ${k}: ${n}`);

  // ---- mixed-target roots ----
  console.log('\n=== roots whose down-leaves carry MIXED target levels ===');
  const held = (id: string) => {
    const c = chunkById.get(id);
    return !c || c.pinned || c.lockedByAgent || inputs.headChunkIds.has(id) || inputs.tailChunkIds.has(id);
  };
  for (const n of tree.allSummaries()) {
    const lvls = new Map<number, number>();
    for (const lid of n.leafChunkIds) {
      if (held(lid)) continue;
      const t = target.get(lid) ?? 0;
      lvls.set(t, (lvls.get(t) ?? 0) + 1);
    }
    if (lvls.size > 1 && [...lvls.keys()].some((l) => l === n.level)) {
      console.log(`  ${n.id} (L${n.level}, ${n.leafChunkIds.length} leaves, seq ${n.firstSequence}..${n.lastSequence}): targets ${JSON.stringify([...lvls.entries()])}`);
    }
  }

  // ---- detail on the oscillating root(s): any root named in top ops ----
  const hotRoots = [...opCounts.entries()].filter(([, n]) => n >= 8).map(([k]) => k.split(':').slice(1).join(':'));
  for (const rootId of [...new Set(hotRoots)]) {
    const n = tree.summary(rootId);
    if (!n) { console.log(`\n=== hot root ${rootId}: NOT IN TREE ===`); continue; }
    console.log(`\n=== hot root ${n.id} (L${n.level}) — ${n.leafChunkIds.length} down-leaves, seq ${n.firstSequence}..${n.lastSequence} ===`);
    // relevant chunks: down-leaves + any chunk upward-linked to this root
    const rel = new Set<string>(n.leafChunkIds);
    for (const c of inputs.chunks) {
      const up = tree.ancestorAt(c.id, n.level);
      if (up?.id === n.id) rel.add(c.id);
    }
    let shown = 0;
    for (const id of rel) {
      const c = chunkById.get(id);
      const down = downSets.get(n.id)!.has(id);
      const up = c ? tree.ancestorAt(id, n.level)?.id === n.id : false;
      const flags = c
        ? [c.pinned && 'pin', c.lockedByAgent && 'lock', inputs.headChunkIds.has(id) && 'head', inputs.tailChunkIds.has(id) && 'tail', c.pinLevel !== undefined && `pinL${c.pinLevel}`, c.pinMaxLevel !== undefined && `pinMax${c.pinMaxLevel}`].filter(Boolean).join(',')
        : 'MISSING-FROM-CHUNKS';
      const mark = down !== up ? '  <-- ASYMMETRIC' : '';
      if (down !== up || shown < 8 || (target.get(id) ?? 0) !== n.level) {
        if (shown < 60) {
          console.log(`  ${id} seq=${c?.sequence ?? '?'} prev=${fPrev.get(id) ?? 0} tgt=${target.get(id) ?? 0} down=${down ? 'y' : 'N'} up=${up ? 'y' : 'N'} l1=${tree.leaf(id)?.l1Id ?? '-'} [${flags}]${mark}`);
        }
        shown++;
      }
    }
    if (shown > 60) console.log(`  … ${shown - 60} more`);
    // lineage of the node itself
    let cur = tree.summary(rootId);
    const chain: string[] = [];
    while (cur) { chain.push(`${cur.id}(L${cur.level})`); cur = cur.parentId ? tree.summary(cur.parentId) : null; }
    console.log(`  node parent chain: ${chain.join(' → ')}`);
  }
  console.log('\nDONE');
}

main().catch((e) => { console.error(e); process.exit(1); });
