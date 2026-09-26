/**
 * One-time, fail-closed topology surgery for Linn's store (agents/Linn).
 * Dry-run by default; run only on a stopped, copied store.
 *
 * Damage (issue #122, head-window ratchet, 2026-09-05/06): the seed's opening
 * messages 1–11 were peeled out of the head one by one into late chunks —
 * c-59/61/67/69/77 (one message each, L1-69/72/78/81/91) and c-413 (1–5,
 * never compressed). The five L1s merged with the open frontier by
 * chunk-record order into cross-era L2s (L2-71/79/88/93) → L3-89/L3-129 →
 * L4-259, which the canonical forest rejects and the load-time audit
 * (topologyPolicy 'reject') refuses.
 *
 * Repair: remove the six records and five L1s so 1–11 are unowned again;
 * detach the L1s from their parents (sourceIds) and recompute every touched
 * ancestor's sourceRange from its remaining children; clear kv-stable
 * resolutions for 1–11. With CM ≥ #123 the head window anchors to coverage,
 * so 1–11 render verbatim in the head, as the seed intended. No summary is
 * regenerated: the four L2s keep their prose (which still narrates the
 * detached messages — a fidelity wart, not a structural one).
 */

import { JsStore } from '@animalabs/chronicle';

interface SummaryEntry {
  id: string; level: number; sourceIds: string[]; sourceRange: { first: string; last: string };
  mergedInto?: string; parentId?: string; [key: string]: unknown;
}
interface ChunkRecord { id: string; sourceIds: string[]; compressed: boolean; summaryId?: string; [key: string]: unknown }

const [storePath, namespace, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
if (!storePath || namespace !== 'agents/Linn') {
  console.error('usage: repair-linn-topology <copied-store> agents/Linn [--apply]');
  process.exit(2);
}

// Reviewed shapes on the 2026-09-26 copy. Any deviation aborts.
const STRAY_L1: Record<string, { sources: string[]; parent: string }> = {
  'L1-69': { sources: ['11'], parent: 'L2-71' },
  'L1-72': { sources: ['10'], parent: 'L2-79' },
  'L1-78': { sources: ['9'], parent: 'L2-88' },
  'L1-81': { sources: ['8'], parent: 'L2-88' },
  'L1-91': { sources: ['6', '7'], parent: 'L2-93' },
};
const PARENTS: Record<string, string[]> = {
  'L2-71': ['L1-59', 'L1-66', 'L1-67', 'L1-68', 'L1-69', 'L1-70'],
  'L2-79': ['L1-72', 'L1-73', 'L1-74', 'L1-75', 'L1-76', 'L1-77'],
  'L2-88': ['L1-78', 'L1-80', 'L1-81', 'L1-82', 'L1-83', 'L1-84'],
  'L2-93': ['L1-85', 'L1-86', 'L1-87', 'L1-90', 'L1-91', 'L1-92'],
};
const STRAY_RECORDS: Record<string, { sources: string[]; summaryId?: string }> = {
  'c-59': { sources: ['11'], summaryId: 'L1-69' },
  'c-61': { sources: ['10'], summaryId: 'L1-72' },
  'c-67': { sources: ['9'], summaryId: 'L1-78' },
  'c-69': { sources: ['8'], summaryId: 'L1-81' },
  'c-77': { sources: ['6', '7'], summaryId: 'L1-91' },
  'c-413': { sources: ['1', '2', '3', '4', '5'] },
};
const RETURNED_TO_HEAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const store = JsStore.open({ path: storePath });
const sumsState = `${namespace}/autobio:summaries`;
const chunksState = `${namespace}/autobio:chunks`;
const resolutionsState = `${namespace}/autobio:resolutions`;
const summaries = (store.getStateJson(sumsState) as SummaryEntry[] | null) ?? [];
const records = (store.getStateJson(chunksState) as ChunkRecord[] | null) ?? [];
const byId = new Map(summaries.map((s) => [s.id, s] as const));
const messages = (store.getStateJson('messages') as Array<{ id: string }> | null) ?? [];
const position = new Map(messages.map((m, i) => [String(m.id), i] as const));
if (position.size === 0) throw new Error('no messages state');

// ---- guards --------------------------------------------------------------
for (const [id, shape] of Object.entries(STRAY_L1)) {
  const s = byId.get(id);
  if (!s) throw new Error(`${id} missing`);
  if (s.level !== 1 || !same(s.sourceIds, shape.sources)) throw new Error(`${id} shape changed: ${JSON.stringify(s.sourceIds)}`);
  if ((s.mergedInto ?? s.parentId) !== shape.parent) throw new Error(`${id} parent changed: ${s.mergedInto ?? s.parentId}`);
}
for (const [id, sources] of Object.entries(PARENTS)) {
  const s = byId.get(id);
  if (!s) throw new Error(`${id} missing`);
  if (!same(s.sourceIds, sources)) throw new Error(`${id} sources changed: ${JSON.stringify(s.sourceIds)}`);
}
const recById = new Map(records.map((r) => [r.id, r] as const));
console.error(`loaded ${summaries.length} summaries, ${records.length} records (${records.filter((r) => !r.compressed).map((r) => r.id).join(',')} uncompressed), ${position.size} messages`);
// c-413 (1..5, never compressed) exists in the kv-unified-era snapshot but the
// kv-stable host dropped it at load (its 17:34 snapshot has 413 records):
// present → must match and is removed; absent → 1..5 are already unowned.
const OPTIONAL_RECORDS = new Set(['c-413']);
for (const [id, shape] of Object.entries(STRAY_RECORDS)) {
  const r = recById.get(id);
  if (!r) { if (OPTIONAL_RECORDS.has(id)) { console.error(`record ${id} absent (already dropped by the host)`); continue; } throw new Error(`record ${id} missing`); }
  if (!same(r.sourceIds, shape.sources) || r.summaryId !== shape.summaryId) throw new Error(`record ${id} shape changed: ${JSON.stringify(r)}`);
}
for (const id of RETURNED_TO_HEAD) {
  const owners = records.filter((r) => r.sourceIds.includes(id)).map((r) => r.id);
  const expected = Object.entries(STRAY_RECORDS).filter(([rid, s]) => s.sources.includes(id) && recById.has(rid)).map(([rid]) => rid);
  if (!same(owners, expected)) throw new Error(`message ${id} owned by ${owners.join(',')}, expected ${expected.join(',')}`);
}
if (!byId.get('L1-14') || !same(byId.get('L1-14')!.sourceIds, ['12', '13', '14', '15', '16', '17', '18', '19', '20'])) throw new Error('L1-14 (12..20) shape changed');
// The store's head must be able to take 1–11 back: nothing else may own them.
for (const s of summaries) if (s.level === 1 && !(s.id in STRAY_L1)) for (const id of s.sourceIds) if (RETURNED_TO_HEAD.includes(id)) throw new Error(`${s.id} also owns ${id}`);

// ---- surgery -------------------------------------------------------------
const strayIds = new Set(Object.keys(STRAY_L1));
const kept = summaries.filter((s) => !strayIds.has(s.id));
const keptById = new Map(kept.map((s) => [s.id, s] as const));
const touched = new Set<string>();
for (const parentId of new Set(Object.values(STRAY_L1).map((x) => x.parent))) {
  const p = keptById.get(parentId)!;
  p.sourceIds = p.sourceIds.filter((id) => !strayIds.has(id));
  if (p.sourceIds.length < 2) throw new Error(`${parentId} would be left with ${p.sourceIds.length} source(s)`);
  touched.add(parentId);
}
// Recompute sourceRange bottom-up for every ancestor of a touched node.
const leafSpan = (s: SummaryEntry): { first: string; last: string } => {
  if (s.level === 1) {
    const sorted = [...s.sourceIds].sort((a, b) => position.get(a)! - position.get(b)!);
    return { first: sorted[0], last: sorted[sorted.length - 1] };
  }
  const spans = s.sourceIds.map((id) => { const c = keptById.get(id); if (!c) throw new Error(`${s.id} child ${id} missing`); return leafSpan(c); });
  spans.sort((a, b) => position.get(a.first)! - position.get(b.first)!);
  const last = spans.reduce((best, x) => (position.get(x.last)! > position.get(best)! ? x.last : best), spans[0].last);
  return { first: spans[0].first, last };
};
const rangeChanges: string[] = [];
let frontier = [...touched];
const visited = new Set<string>();
while (frontier.length) {
  const id = frontier.shift()!;
  if (visited.has(id)) continue;
  visited.add(id);
  const s = keptById.get(id)!;
  const span = leafSpan(s);
  if (s.sourceRange.first !== span.first || s.sourceRange.last !== span.last) {
    rangeChanges.push(`${id}: ${s.sourceRange.first}..${s.sourceRange.last} → ${span.first}..${span.last}`);
    s.sourceRange = span;
  }
  const parent = s.mergedInto ?? s.parentId;
  if (parent) frontier.push(parent);
}
const keptRecords = records.filter((r) => !(r.id in STRAY_RECORDS));

// ---- invariants ----------------------------------------------------------
const ownership = new Map<string, string>();
for (const r of keptRecords) for (const id of r.sourceIds) {
  if (ownership.has(id)) throw new Error(`records ${ownership.get(id)} and ${r.id} both own ${id}`);
  ownership.set(id, r.id);
}
for (const id of RETURNED_TO_HEAD) if (ownership.has(id)) throw new Error(`${id} still owned by ${ownership.get(id)}`);
for (const s of kept) for (const c of s.sourceIds) if (s.level > 1 && !keptById.has(c)) throw new Error(`${s.id} references removed ${c}`);
for (const s of kept) if (s.level === 1 && !keptRecords.some((r) => r.summaryId === s.id)) { /* legacy generations exist without records; not our concern */ }
// Strict contiguity of every kept summary among owned messages in store order.
const owned = [...ownership.keys()].sort((a, b) => position.get(a)! - position.get(b)!);
const ownedPos = new Map(owned.map((id, i) => [id, i] as const));
const leaves = new Map<string, string[]>();
const collect = (s: SummaryEntry): string[] => {
  const c = leaves.get(s.id); if (c) return c;
  const out = s.level === 1 ? [...s.sourceIds] : s.sourceIds.flatMap((id) => collect(keptById.get(id)!));
  leaves.set(s.id, out); return out;
};
const linked = new Set(keptRecords.map((r) => r.summaryId).filter(Boolean) as string[]);
let crossed = 0;
for (const s of kept) {
  if (s.level === 1 && !linked.has(s.id)) continue;
  const ps = collect(s).map((id) => ownedPos.get(id)).filter((p): p is number => p !== undefined);
  if (ps.length < 2) continue;
  const min = Math.min(...ps), max = Math.max(...ps);
  if (max - min + 1 !== new Set(ps).size) { crossed++; console.error(`still crossed: ${s.id} (${new Set(ps).size} leaves, ${max - min + 1 - new Set(ps).size} holes)`); }
}
if (crossed) throw new Error(`${crossed} summar${crossed === 1 ? 'y' : 'ies'} still crossed after surgery`);

const resolutions = { ...((store.getStateJson(resolutionsState) as Record<string, unknown> | null) ?? {}) };
let cleared = 0;
for (const id of RETURNED_TO_HEAD) if (id in resolutions) { delete resolutions[id]; cleared++; }

console.log(`store:            ${storePath}`);
console.log(`mode:             ${apply ? 'APPLY' : 'DRY RUN'}`);
console.log(`removed L1s:      ${[...strayIds].join(', ')}`);
console.log(`removed records:  ${Object.keys(STRAY_RECORDS).filter((id) => recById.has(id)).join(', ')}`);
console.log(`detached from:    ${[...touched].map((id) => `${id}[${keptById.get(id)!.sourceIds.length}]`).join(', ')}`);
console.log(`range changes:    ${rangeChanges.length ? '\n  ' + rangeChanges.join('\n  ') : 'none'}`);
console.log(`returned to head: ${RETURNED_TO_HEAD.join(',')} (${cleared} kv-stable resolutions cleared)`);
console.log(`summaries:        ${summaries.length} → ${kept.length}; records ${records.length} → ${keptRecords.length}; crossed after: 0`);
if (!apply) { console.log('\nDRY RUN — nothing written.'); store.close(); process.exit(0); }
store.setStateJson(sumsState, kept);
store.setStateJson(chunksState, keptRecords);
store.setStateJson(resolutionsState, resolutions);
store.close();
console.log('\nAPPLIED. Validate: audit-topology (expect 0) and a host compile on the new runtime.');
