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
 *   1. Selects L1 KEEPERS — from the `autobio:chunks` records when present
 *      (post-migration store), else by the same coverage algorithm the
 *      migration uses (start asc, span desc; fully-covered L1s are stale).
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

interface SummaryEntry {
  id: string;
  level: number;
  content: string;
  tokens: number;
  sourceLevel: number;
  sourceIds: string[];
  sourceRange?: { first: string; last: string };
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
const byId = new Map<string, SummaryEntry>();
for (const s of loaded) {
  const prev = byId.get(s.id);
  if (!prev) byId.set(s.id, s);
  else if (!prev.mergedInto && s.mergedInto) byId.set(s.id, s);
}
const summaries = [...byId.values()];
const l1s = summaries.filter(s => s.level === 1 && Array.isArray(s.sourceIds) && s.sourceIds.length > 0);

const messages = store.getStateJson('messages');
const msgIndex = new Map<string, number>();
(Array.isArray(messages) ? messages : []).forEach((m: { id?: string }, i: number) => {
  if (m && typeof m.id === 'string') msgIndex.set(m.id, i);
});

// ---- 1. keepers ----
const records = store.getStateJson(CHUNKS);
const chunkRecords: ChunkRecord[] = Array.isArray(records) ? records : [];
let keepers: Set<string>;
let keeperSource: string;
if (chunkRecords.length > 0) {
  keepers = new Set(chunkRecords.map(r => r.summaryId).filter((x): x is string => typeof x === 'string'));
  keeperSource = `chunk records (${chunkRecords.length})`;
  for (const id of keepers) {
    if (!byId.has(id)) {
      console.error(`FATAL: chunk record points at missing summary ${id} — reconcile before repairing`);
      process.exit(3);
    }
  }
} else {
  // Same algorithm as AutobiographicalStrategy.migrateChunkRecords.
  keepers = new Set();
  const covered = new Set<string>();
  const sorted = [...l1s].sort((a, b) => {
    const sa = msgIndex.get(a.sourceIds[0]) ?? Number.MAX_SAFE_INTEGER;
    const sb = msgIndex.get(b.sourceIds[0]) ?? Number.MAX_SAFE_INTEGER;
    return sa - sb || b.sourceIds.length - a.sourceIds.length;
  });
  for (const s of sorted) {
    if (!s.sourceIds.some(id => msgIndex.has(id))) continue; // fully orphaned
    if (s.sourceIds.every(id => covered.has(id))) continue;  // stale generation
    for (const id of s.sourceIds) covered.add(id);
    keepers.add(s.id);
  }
  keeperSource = 'coverage algorithm (no chunk records)';
}

// ---- 2..4. prune / wipe / unmerge ----
const prunedL1 = new Set(l1s.filter(s => !keepers.has(s.id)).map(s => s.id));
// Ghost L1s (no live sourceIds, not keepers) are pruned too.
for (const s of summaries.filter(x => x.level === 1 && !keepers.has(x.id))) prunedL1.add(s.id);

// Frontier-only mode: restrict the prune set to UNMERGED stale L1s and skip
// all wiping — merged stale L1s and their L2/L3 prose stay as they are.
if (frontierOnly) {
  for (const id of [...prunedL1]) {
    const s = byId.get(id);
    if (s?.mergedInto) prunedL1.delete(id);
  }
}

const children = new Map<string, SummaryEntry[]>();
for (const s of summaries) {
  if (s.mergedInto) {
    const list = children.get(s.mergedInto) ?? [];
    list.push(s);
    children.set(s.mergedInto, list);
  }
}

const wiped = new Set<string>();
if (!frontierOnly) {
  for (const l2 of summaries.filter(s => s.level === 2)) {
    const kids = children.get(l2.id) ?? [];
    if (kids.some(k => prunedL1.has(k.id))) wiped.add(l2.id);
  }
  for (const l3 of summaries.filter(s => s.level === 3)) {
    const kids = children.get(l3.id) ?? [];
    if (kids.some(k => wiped.has(k.id) || prunedL1.has(k.id))) wiped.add(l3.id);
  }
}
// Cascade upward defensively for any deeper levels.
let grew = true;
while (grew) {
  grew = false;
  for (const s of summaries.filter(x => x.level > 3)) {
    if (wiped.has(s.id)) continue;
    const kids = children.get(s.id) ?? [];
    if (kids.some(k => wiped.has(k.id) || prunedL1.has(k.id))) { wiped.add(s.id); grew = true; }
  }
}

const survivors: SummaryEntry[] = [];
let unmerged = 0;
for (const s of summaries) {
  if (prunedL1.has(s.id) || wiped.has(s.id)) continue;
  if (s.mergedInto && (wiped.has(s.mergedInto) || prunedL1.has(s.mergedInto))) {
    const { mergedInto: _drop, ...rest } = s;
    survivors.push(rest as SummaryEntry);
    unmerged++;
  } else {
    survivors.push(s);
  }
}

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
console.log(`merge queue:  ${mergeQueue.length} → ${cleanQueue.length}`);

if (!apply) {
  console.log('\nDRY RUN — nothing written. Pass --apply to write (back up first!).');
  store.close();
  process.exit(0);
}

store.setStateJson(SUMS, survivors);
store.setStateJson(MERGEQ, cleanQueue);
store.close();
console.log('\nAPPLIED. Run the offline merge drain (or let the agent re-merge live).');
