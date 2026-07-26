/**
 * Replay the kv-stable solve offline from a diagnose-oscillation --dump
 * snapshot, replicating KvStableStrategy.solve()'s zone construction exactly.
 * Combine with KV_DIAG_GROUP=<summaryId> to see per-stage level histograms.
 *
 * Usage:
 *   KV_DIAG_GROUP=L4-936 node dist/scripts/replay-plan.js /tmp/prof/mythos-picker-inputs.json \
 *     [--budget 283616] [--slack 0.1] [--reach 400000]
 */

import { readFileSync } from 'node:fs';
import { SummaryTree } from '../src/adaptive/summary-tree.js';
import { planControlledFrontier } from '../src/adaptive/kv-control.js';
import type { PickerInputs, PickerChunk } from '../src/adaptive/picker.js';
import type { ChunkId } from '../src/adaptive/folding-strategy.js';

async function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const totalBudget = Number(opt('--budget', '283616'));
  const slack = Number(opt('--slack', '0.1'));
  const reach = Number(opt('--reach', '400000'));

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const inputs: PickerInputs = {
    chunks: raw.chunks as PickerChunk[],
    summaries: new Map(raw.summaries),
    recallPairTokens: new Map(raw.recallPairTokens),
    headChunkIds: new Set(raw.headChunkIds),
    tailChunkIds: new Set(raw.tailChunkIds),
    headTokens: raw.headTokens,
    tailTokens: raw.tailTokens,
  };
  const fPrev = new Map<string, number>(raw.fPrev);
  const dumpedTarget = new Map<string, number>(raw.target);

  const tree = new SummaryTree(inputs);

  // ---- replicate KvStableStrategy.solve() zone construction ----
  const rawZone = new Set<ChunkId>();
  const frozen = new Set<ChunkId>();
  const fixedLevels = new Map<ChunkId, number>();
  const pinCaps = new Map<ChunkId, number>();
  const fixedPins: Array<{ id: ChunkId; level: number }> = [];
  let now = 0;
  for (const c of inputs.chunks) {
    if (c.sequence > now) now = c.sequence;
    if (inputs.headChunkIds.has(c.id) || inputs.tailChunkIds.has(c.id) || c.pinned) {
      rawZone.add(c.id);
    } else if (c.pinLevel !== undefined) {
      if (c.pinLevel <= 0) rawZone.add(c.id);
      else fixedPins.push({ id: c.id, level: c.pinLevel });
    } else if (c.pinMaxLevel !== undefined) {
      if (c.pinMaxLevel <= 0) rawZone.add(c.id);
      else pinCaps.set(c.id, c.pinMaxLevel);
      if (c.lockedByAgent) frozen.add(c.id);
    } else if (c.lockedByAgent) {
      frozen.add(c.id);
    }
  }
  for (const { id, level } of fixedPins) {
    const eff = Math.min(level, tree.maxLevel(id));
    if (eff <= 0) { rawZone.add(id); continue; }
    const node = tree.ancestorAt(id, eff);
    if (!node) { fixedLevels.set(id, eff); continue; }
    for (const leaf of node.leafChunkIds) {
      if (rawZone.has(leaf)) continue;
      const prev = fixedLevels.get(leaf);
      fixedLevels.set(leaf, prev === undefined ? eff : Math.min(prev, eff));
    }
  }
  console.log(`zones: rawZone=${rawZone.size} frozen=${frozen.size} fixedLevels=${fixedLevels.size} pinCaps=${pinCaps.size} fixedPins=${fixedPins.length}`);

  const plan = planControlledFrontier(inputs, tree, {
    previous: fPrev,
    foldAtTokens: totalBudget,
    expandAtTokens: totalBudget * (1 - slack),
    targetTokens: totalBudget * (1 - slack),
    windowTokens: totalBudget,
    reachTokens: reach,
    rawZone,
    frozen,
    fixedLevels,
    pinCaps,
    now,
  });

  console.log(`plan: tokens=${plan.tokens} folded=${plan.folded} expanded=${plan.expanded} escalated=${plan.escalated} pert=${plan.perturbation} override=${plan.override ?? '-'} blocked=${plan.blocked ?? '-'}`);

  // sanity: does the replayed plan match the dumped target?
  let same = 0, diff = 0;
  for (const c of inputs.chunks) {
    if ((plan.resolutions.get(c.id) ?? 0) === (dumpedTarget.get(c.id) ?? 0)) same++;
    else diff++;
  }
  console.log(`vs dumped target: ${same} match, ${diff} differ`);

  // where do fixedLevels leaves land vs their pin?
  let pinViol = 0;
  for (const [id, k] of fixedLevels) {
    const got = plan.resolutions.get(id) ?? 0;
    if (got !== k) pinViol++;
  }
  console.log(`fixed-level leaves not at their pin in final plan: ${pinViol}/${fixedLevels.size}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
