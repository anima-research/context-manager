/**
 * Repair a contaminated autobiographical memory pyramid.
 *
 * Background (2026-07 fleet audit): the pre-chunk-persistence code minted
 * duplicate L1s — prefix-generation families from eager partial-tail
 * compression, and same-range siblings from restart re-consolidation
 * storms. All generations stayed in the log, rendered on the unmerged
 * frontier, and merged upward together, baking N-fold repetition into
 * L2/L3 prose (the redundancy amplifier behind the "68 initiations"
 * class of distortions).
 *
 * This script:
 *   1. Selects L1 KEEPERS — the UNION of `autobio:chunks` record-backed L1s
 *      and a coverage sweep (start asc, span desc; an L1 is stale only if it
 *      adds no live coverage). Records alone are NOT sufficient: they only
 *      exist since the chunk-persistence fix / lazy migration, and branch
 *      re-cuts can leave spans without records — trusting records
 *      exclusively pruned sole-coverage L1s and collapsed the folded floor
 *      to raw (mythos 2026-07-12; see the coverage-invariant guard below,
 *      which now refuses any repair that would shrink live L1 coverage).
 *   2. PRUNES all other L1s from the summaries log.
 *   3. WIPES every L2 with at least one pruned child, and every L3 with a
 *      wiped/pruned child — their prose was written from duplicates.
 *   4. Clears `mergedInto` on surviving children of wiped parents, so the
 *      normal merge machinery regenerates the pyramid from clean L1s
 *      (run scripts/drain-generic-style offline drain afterwards, or let
 *      the live agent re-merge gradually).
 *   5. Drops mergeQueue entries referencing pruned/wiped ids.
 *
 * DRY-RUN by default; pass --apply to write. Writes are full-array
 * Snapshots of the summaries + mergeQueue states (chronicle keeps the full
 * pre-repair history in the record log — nothing is destroyed, and the
 * repair itself is one more auditable state transition).
 *
 * ALWAYS back up the session dir first and validate on a copy.
 *
 * Usage:
 *   node dist/scripts/repair-pyramid.js <store-path> <namespace> [--apply]
 * e.g.
 *   node dist/scripts/repair-pyramid.js ~/mythos-cm/data/sessions/<id> agents/mythos
 */

import { JsStore } from '@animalabs/chronicle';
import { selectKeeperL1s } from '../src/strategies/keeper-selection.js';

interface SummaryEntry {
  id: string;
  level: number;
  content: string;
  tokens: number;
  sourceLevel: number;
  sourceIds: string[];
  sourceRange?: { first: string; last: string };
  parentId?: string;
  mergedInto?: string;
  created: number;
  phaseType?: string;
}

interface ChunkRecord {
  id: string;
  sourceIds: string[];
  compressed: boolean;
  summaryId?: string;
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const explicitlyRetired = new Set(
  args
    .filter((arg) => arg.startsWith('--retire='))
    .map((arg) => arg.slice('--retire='.length))
    .filter(Boolean),
);
/**
 * --frontier-only: the zero-LLM micro-repair. Prunes ONLY stale L1
 * generations that are still UNMERGED (on the frontier) — the ones future
 * merges would consume, writing fresh duplicated prose into new L2s.
 * Already-merged stale L1s and the contaminated L2/L3 prose they produced
 * are left untouched (no wipe, no unmerge, no drain needed afterwards).
 * Stops the propagation of existing duplicates at merge time; the full
 * repair remains available per-store where the baked echoes matter.
 */
const frontierOnly = args.includes('--frontier-only');
const [storePath, namespace] = args.filter(a => !a.startsWith('--'));
if (!storePath || !namespace) {
  console.error('usage: repair-pyramid <store-path> <namespace> [--apply] [--frontier-only]');
  process.exit(2);
}

const SUMS = `${namespace}/autobio:summaries`;
const CHUNKS = `${namespace}/autobio:chunks`;
const MERGEQ = `${namespace}/autobio:mergeQueue`;

const store = JsStore.open({ path: storePath });

// ---- load, mirroring loadPersistedState (empty filter + id dedupe) ----
const rawSums = store.getStateJson(SUMS);
const loaded: SummaryEntry[] = (Array.isArray(rawSums) ? rawSums : []).filter(
  (s: SummaryEntry | null) => s && typeof s.content === 'string' && s.content.trim().length > 0,
);
const parentOfForLoad = (summary: SummaryEntry): string | undefined =>
  summary.parentId ?? summary.mergedInto;
const byId = new Map<string, SummaryEntry>();
for (const s of loaded) {
  const prev = byId.get(s.id);
  if (!prev) byId.set(s.id, s);
  else if (!parentOfForLoad(prev) && parentOfForLoad(s)) byId.set(s.id, s);
}
const summaries = [...byId.values()];
const l1s = summaries.filter(s => s.level === 1 && Array.isArray(s.sourceIds) && s.sourceIds.length > 0);
const parentOf = parentOfForLoad;

const messages = store.getStateJson('messages');
const msgIndex = new Map<string, number>();
(Array.isArray(messages) ? messages : []).forEach((m: { id?: string }, i: number) => {
  if (m && typeof m.id === 'string') msgIndex.set(m.id, i);
});

// ---- 1. keepers ----
//
// KEEPER-LOGIC FIX (2026-07-12). The original logic trusted chunk records
// EXCLUSIVELY whenever any existed. But records only exist for chunks closed
// since the chunk-persistence fix (c3d4e51) or synthesized by the one-shot
// lazy migration — branch re-cuts, restores, and pre-migration history can
// leave whole spans with NO record. On such spans the records-only branch
// pruned sole-coverage L1s as "stale"; with their L2/L3 lineage wiped, those
// spans lost ALL summary coverage and the folded floor collapsed to raw
// (mythos 2026-07-12 01:28Z: middle 126k → 520k, agent down; reverted).
//
// Now: records are authoritative where they exist (their L1s are keepers and
// their spans are covered), and every span records do NOT cover falls back
// to the migration coverage sweep (start asc, span desc — longest generation
// per start wins, fully-covered generations are stale). An L1 is pruned only
// if it adds no live coverage beyond the keepers already selected.
const records = store.getStateJson(CHUNKS);
const chunkRecords: ChunkRecord[] = Array.isArray(records) ? records : [];
const keepers = new Set<string>();
const covered = new Set<string>();

for (const r of chunkRecords) {
  // Every record owns its span even before compression. If an uncompressed
  // repair record did not seed coverage, the sweep below could resurrect the
  // stale fused L1 that the record was created to replace.
  for (const id of r.sourceIds ?? []) covered.add(id);
  if (typeof r.summaryId !== 'string') continue;
  if (!byId.has(r.summaryId)) {
    console.error(`FATAL: chunk record points at missing summary ${r.summaryId} — reconcile before repairing`);
    process.exit(3);
  }
  keepers.add(r.summaryId);
  const s = byId.get(r.summaryId)!;
  for (const id of s.sourceIds ?? []) covered.add(id);
}
const recordKeepers = keepers.size;

// Coverage sweep over everything the records left uncovered — THE SAME
// function AutobiographicalStrategy.migrateChunkRecords uses (a hand-copied
// version drifted twice; see src/strategies/keeper-selection.ts). `covered`
// is pre-seeded from the records above and mutated by the sweep. Note the
// strategy's stale test is over ALL sourceIds (dead ids included): an L1
// whose live ids are covered but which carries uncovered orphaned ids is
// KEPT, exactly as the strategy would keep it.
const sweep = selectKeeperL1s(l1s.filter(s => !keepers.has(s.id)), msgIndex, covered);
for (const s of sweep.keepers) keepers.add(s.id);
const keeperSource =
  chunkRecords.length > 0
    ? `chunk records (${chunkRecords.length} → ${recordKeepers} keepers) ∪ coverage sweep (+${keepers.size - recordKeepers})`
    : 'coverage algorithm (no chunk records)';

// ---- 2..4. prune / wipe / unmerge ----
const prunedL1 = new Set(l1s.filter(s => !keepers.has(s.id)).map(s => s.id));
// Ghost L1s (no live sourceIds, not keepers) are pruned too.
for (const s of summaries.filter(x => x.level === 1 && !keepers.has(x.id))) prunedL1.add(s.id);

// Frontier-only mode: restrict the prune set to UNMERGED stale L1s and skip
// all wiping — merged stale L1s and their L2/L3 prose stay as they are.
// "Unmerged" means EFFECTIVELY unmerged: a dangling mergedInto (parent id
// not in the loaded set) is cleared by the strategy's loadPersistedState,
// reviving the L1 to the frontier where future merges would consume it —
// so it stays in the frontier prune set. Only an L1 merged into an
// EXISTING parent is off the frontier.
if (frontierOnly) {
  for (const id of [...prunedL1]) {
    const s = byId.get(id);
    const parentId = s ? parentOf(s) : undefined;
    if (parentId && byId.has(parentId)) prunedL1.delete(id);
  }
}

const wiped = new Set<string>();
if (!frontierOnly) {
  for (const id of explicitlyRetired) {
    const summary = byId.get(id);
    if (!summary) {
      console.error(`FATAL: --retire names missing summary ${id}`);
      process.exit(3);
    }
    if (summary.level === 1) {
      console.error(`FATAL: --retire=${id} is L1; replace its chunk ownership instead`);
      process.exit(3);
    }
    wiped.add(id);
  }
  // Authored `sourceIds` are the provenance authority. Mutable child→parent
  // pointers can be stale after an old partial merge/reparent race; following
  // only those backlinks leaves a parent alive after one of the children it
  // was actually authored from has been pruned. Close upward over BOTH edges.
  let grew = true;
  while (grew) {
    grew = false;
    for (const parent of summaries.filter((summary) => summary.level > 1)) {
      if (wiped.has(parent.id)) continue;
      const invalid = parent.sourceIds.some((childId) => {
        const child = byId.get(childId);
        return (
          !child ||
          prunedL1.has(childId) ||
          wiped.has(childId) ||
          child.level !== parent.level - 1 ||
          parentOf(child) !== parent.id
        );
      });
      if (invalid) {
        wiped.add(parent.id);
        grew = true;
      }
    }
  }
}

const survivors: SummaryEntry[] = [];
let unmerged = 0;
for (const s of summaries) {
  if (prunedL1.has(s.id) || wiped.has(s.id)) continue;
  const parentId = parentOf(s);
  if (parentId && (!byId.has(parentId) || wiped.has(parentId) || prunedL1.has(parentId))) {
    const copy = { ...s };
    delete copy.parentId;
    delete copy.mergedInto;
    survivors.push(copy);
    unmerged++;
  } else {
    survivors.push(s);
  }
}

// ---- structural closure invariant ----
// A full repair must leave one authored tree over the record-owned live
// messages. Coverage alone is insufficient: a summary can retain all of its
// raw messages while crossing an intervening live span, or its authored child
// set can differ from the L1 generation selected by the chunk ledger.
const structuralIssues: string[] = [];
if (!frontierOnly) {
  const survivorById = new Map(survivors.map((summary) => [summary.id, summary]));
  const liveLeavesMemo = new Map<string, string[]>();
  const expandLiveLeaves = (summary: SummaryEntry, visiting = new Set<string>()): string[] => {
    const cached = liveLeavesMemo.get(summary.id);
    if (cached) return cached;
    if (visiting.has(summary.id)) {
      structuralIssues.push(`${summary.id}: ownership cycle`);
      return [];
    }
    visiting.add(summary.id);
    let leaves: string[] = [];
    if (summary.level === 1) {
      leaves = summary.sourceIds.filter((id) => msgIndex.has(id));
    } else {
      for (const childId of summary.sourceIds) {
        const child = survivorById.get(childId);
        if (!child) {
          structuralIssues.push(`${summary.id}: authored child ${childId} is absent`);
          continue;
        }
        if (parentOf(child) !== summary.id) {
          structuralIssues.push(
            `${summary.id}: authored child ${childId} points to ${parentOf(child) ?? 'no parent'}`,
          );
        }
        leaves.push(...expandLiveLeaves(child, visiting));
      }
    }
    visiting.delete(summary.id);
    liveLeavesMemo.set(summary.id, leaves);
    return leaves;
  };

  for (const summary of survivors) {
    const leaves = expandLiveLeaves(summary);
    const positions = leaves.map((id) => msgIndex.get(id)!).filter((index) => index !== undefined);
    if (new Set(leaves).size !== leaves.length) {
      structuralIssues.push(`${summary.id}: authored live coverage overlaps itself`);
    }
    if (positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) {
      structuralIssues.push(`${summary.id}: authored live coverage is out of order`);
    }
    if (positions.some((position, index) => index > 0 && position !== positions[index - 1]! + 1)) {
      structuralIssues.push(`${summary.id}: authored live coverage is non-contiguous`);
    }
  }

  const ownedBySummary = new Map<string, Set<string>>();
  const recordOwner = new Map<string, string>();
  for (const record of chunkRecords) {
    if (!record.summaryId || !survivorById.has(record.summaryId)) continue;
    for (const messageId of record.sourceIds) {
      if (!msgIndex.has(messageId)) continue;
      const previous = recordOwner.get(messageId);
      if (previous && previous !== record.id) {
        structuralIssues.push(
          `chunk records ${previous} and ${record.id} both own live message ${messageId}`,
        );
      }
      recordOwner.set(messageId, record.id);
      let summaryId: string | undefined = record.summaryId;
      const seen = new Set<string>();
      while (summaryId && survivorById.has(summaryId) && !seen.has(summaryId)) {
        seen.add(summaryId);
        const owned = ownedBySummary.get(summaryId) ?? new Set<string>();
        owned.add(messageId);
        ownedBySummary.set(summaryId, owned);
        summaryId = parentOf(survivorById.get(summaryId)!);
      }
    }
  }
  for (const [summaryId, owned] of ownedBySummary) {
    const semantic = new Set(expandLiveLeaves(survivorById.get(summaryId)!));
    if (
      owned.size !== semantic.size ||
      [...owned].some((messageId) => !semantic.has(messageId))
    ) {
      structuralIssues.push(
        `${summaryId}: record ownership (${owned.size}) differs from authored live coverage (${semantic.size})`,
      );
    }
  }
}

// ---- coverage invariant (2026-07-12 guard) ----
// A repair must never SHRINK live summary coverage: every live message that
// some L1 covered before must still be covered by a surviving L1 after.
// (Wipes/unmerges don't reduce L1 coverage — pruning is the only way to lose
// it.) The 2026-07-12 backfire would have tripped this in dry-run.
const coverageOf = (ids: Iterable<string>): Set<string> => {
  const set = new Set<string>();
  for (const sid of ids) {
    const s = byId.get(sid);
    for (const id of s?.sourceIds ?? []) if (msgIndex.has(id)) set.add(id);
  }
  return set;
};
const coverageBefore = coverageOf(l1s.map(s => s.id));
const coverageAfter = coverageOf(l1s.filter(s => !prunedL1.has(s.id)).map(s => s.id));
let coverageLost = 0;
let coverageDeferred = 0;
const uncompressedRecordMessages = new Set(
  chunkRecords
    .filter((record) => !record.compressed || !record.summaryId)
    .flatMap((record) => record.sourceIds)
    .filter((id) => msgIndex.has(id)),
);
for (const id of coverageBefore) {
  if (coverageAfter.has(id)) continue;
  if (uncompressedRecordMessages.has(id)) coverageDeferred++;
  else coverageLost++;
}

// ---- fold-floor estimate (2026-07-12 guard #2) ----
// The mythos 01:28Z backfire was NOT coverage loss (the pruned L1s were all
// redundant) but DEPTH loss: wiping contaminated L2/L3s drops their spans'
// deepest rung to L1, and until the offline merge drain rebuilds the upper
// levels the fully-folded floor can exceed the agent's hard budget — the
// picker then fails every wake ("cannot fit even fully folded"). Estimate
// the deepest-fold render before/after so the operator sees the drain debt
// BEFORE applying, and require an explicit flag when the floor grows.
const estimateFloor = (all: SummaryEntry[]): number => {
  // Deepest LIVE summary covering each live message; messages covered by no
  // live summary count raw (chars/4 of their JSON as a rough estimate).
  //
  // "Live" mirrors what the strategy actually renders: loadPersistedState
  // CLEARS a dangling mergedInto (parent id absent from the loaded set) and
  // REVIVES that summary to the unmerged frontier; all render paths then
  // filter on `!s.mergedInto`. So the effective live set is the frontier
  // PLUS revived-dangling summaries — NOT "merged into an existing parent"
  // (that is the strategy's dangling-EDGE test, the opposite selection). In
  // corrupted stores a dangling-merged L1 can be the sole deepest coverage
  // for its span; excluding it costs the span raw, inflates the floor, and
  // (for the before-side) under-trips the floor-growth guard below in
  // exactly the stores the guard exists for.
  const allById = new Map(all.map(x => [x.id, x]));
  const live = all.filter(s => !s.mergedInto || !allById.has(s.mergedInto));
  const deepestByMsg = new Map<string, SummaryEntry>();
  for (const s of live) {
    if (!Array.isArray(s.sourceIds)) continue;
    // Walk to leaf message ids: L1 sourceIds are messages; deeper levels
    // reference child summaries — resolve recursively via the FULL set
    // (children of a live parent are merged, hence not themselves live, but
    // they are how the parent's span resolves to messages).
    const leaves = (x: SummaryEntry, seen = new Set<string>()): string[] => {
      if (seen.has(x.id)) return [];
      seen.add(x.id);
      if (x.sourceLevel === 0) return x.sourceIds;
      const out: string[] = [];
      for (const cid of x.sourceIds) {
        const child = allById.get(cid);
        if (child) out.push(...leaves(child, seen));
      }
      return out;
    };
    for (const id of leaves(s)) {
      if (!msgIndex.has(id)) continue;
      const cur = deepestByMsg.get(id);
      if (!cur || s.level > cur.level) deepestByMsg.set(id, s);
    }
  }
  const used = new Set<SummaryEntry>();
  let floor = 0;
  for (const s of deepestByMsg.values()) used.add(s);
  for (const s of used) floor += s.tokens || 0;
  // Uncovered live messages render raw.
  const msgArr: Array<{ id?: string } & Record<string, unknown>> = Array.isArray(messages) ? messages : [];
  for (const m of msgArr) {
    if (m && typeof m.id === 'string' && !deepestByMsg.has(m.id)) {
      floor += Math.ceil(JSON.stringify(m.content ?? m).length / 4);
    }
  }
  return floor;
};
// Pass the FULL arrays: estimateFloor derives the effective live set itself
// (frontier + revived-dangling) and needs merged children for leaf
// resolution. `survivors` may still carry pre-existing dangling mergedInto
// pointers (the unmerge step only clears pointers at pruned/wiped ids) —
// the strategy will revive those on load, and the after-estimate models
// that the same way the before-estimate does.
const floorBefore = estimateFloor(summaries);
const floorAfter = estimateFloor(survivors);
const allowFloorGrowth = args.includes('--allow-floor-growth');

// ---- 5. merge queue ----
const rawQueue = store.getStateJson(MERGEQ);
const mergeQueue: Array<{ level: number; sourceIds: string[] }> = Array.isArray(rawQueue) ? rawQueue : [];
const removedIds = new Set([...prunedL1, ...wiped]);
const cleanQueue = mergeQueue.filter(m => !m.sourceIds.some(id => removedIds.has(id)));

// ---- report ----
const count = (lvl: number, set: Set<string>) =>
  summaries.filter(s => s.level === lvl && set.has(s.id)).length;
console.log(`store:        ${storePath}`);
console.log(`namespace:    ${namespace}`);
console.log(`mode:         ${frontierOnly ? 'FRONTIER-ONLY (unmerged stale L1s only, no wipes)' : 'full repair'}`);
console.log(`keepers from: ${keeperSource}`);
console.log(`summaries:    ${summaries.length} loaded (${loaded.length - summaries.length} duplicate-id copies collapsed)`);
console.log(`L1: ${l1s.length} total → keep ${keepers.size}, prune ${prunedL1.size}`);
console.log(`L2: ${summaries.filter(s => s.level === 2).length} total → wipe ${count(2, wiped)}`);
console.log(`L3: ${summaries.filter(s => s.level === 3).length} total → wipe ${count(3, wiped)}`);
console.log(`survivors:    ${survivors.length} (${unmerged} returned to unmerged frontier)`);
if (explicitlyRetired.size > 0) {
  console.log(`retired:      ${[...explicitlyRetired].sort().join(', ')}`);
}
console.log(`merge queue:  ${mergeQueue.length} → ${cleanQueue.length}`);
console.log(
  `coverage:     ${coverageBefore.size} live messages L1-covered before → ${coverageAfter.size} after ` +
    `(${coverageDeferred} deferred to explicit uncompressed records; ${coverageLost} LOST/UNOWNED)`,
);
console.log(
  `structure:    ${structuralIssues.length === 0 ? 'canonical closure verified' : `${structuralIssues.length} issue(s)`}`,
);
for (const issue of structuralIssues.slice(0, 20)) console.log(`  - ${issue}`);
console.log(
  `fold floor:   ≥~${Math.round(floorBefore / 1000)}k tokens fully-folded before → ≥~${Math.round(floorAfter / 1000)}k after ` +
    `(OPTIMISTIC lower bound: group-consistency can force shallower renders — mythos 2026-07-12 measured 490k where this estimated ~134k)`,
);
if (floorAfter > floorBefore * 1.25) {
  console.log(
    `\n⚠️  DEPTH DEBT: wiping contaminated upper levels raises the fully-folded floor ` +
      `~${Math.round(floorBefore / 1000)}k → ~${Math.round(floorAfter / 1000)}k. Until the offline merge drain ` +
      `rebuilds L2/L3, any agent whose hard budget is below ~${Math.round(floorAfter / 1000)}k will FAIL EVERY ` +
      `COMPILE (the mythos 2026-07-12 01:28Z failure). Plan: apply → run the drain offline → only then restart ` +
      `the agent.`,
  );
}

if (coverageLost > 0) {
  console.error(
    `\nFATAL: this repair would remove L1 coverage from ${coverageLost} live messages — ` +
      `their spans would render raw and the folded floor would grow (the 2026-07-12 failure mode). ` +
      `Refusing to apply; reconcile keeper selection first.`,
  );
  store.close();
  process.exit(4);
}

if (!frontierOnly && structuralIssues.length > 0) {
  console.error(
    `\nFATAL: repaired projection is not a canonical authored ownership forest ` +
      `(${structuralIssues.length} issue(s)); refusing to apply. Use a targeted ownership ` +
      `surgery to split/retarget the listed spans first.`,
  );
  store.close();
  process.exit(6);
}

if (!apply) {
  console.log('\nDRY RUN — nothing written. Pass --apply to write (back up first!).');
  store.close();
  process.exit(0);
}

if (floorAfter > floorBefore * 1.25 && !allowFloorGrowth) {
  console.error(
    `\nFATAL: refusing to apply — the fold floor would grow ~${Math.round(floorBefore / 1000)}k → ` +
      `~${Math.round(floorAfter / 1000)}k and the agent may not fit its budget until the merge drain runs. ` +
      `Re-run with --allow-floor-growth if the drain is planned (agent stopped, offline drain ready).`,
  );
  store.close();
  process.exit(5);
}

store.setStateJson(SUMS, survivors);
store.setStateJson(MERGEQ, cleanQueue);
store.close();
console.log('\nAPPLIED. Run the offline merge drain (or let the agent re-merge live).');
