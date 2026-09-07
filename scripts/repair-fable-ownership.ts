/**
 * One-time, fail-closed ownership surgery for Fable's two disjoint persisted
 * chunks. Dry-run by default; ALWAYS run on a copied store first.
 *
 * - L1-403 is semantically the later run: retarget its authored metadata and
 *   c-166 to 8097..8111; put 1..3 in a fresh uncompressed record.
 * - L1-267 genuinely fuses both runs: replace c-52 with two uncompressed
 *   records. The old L1 remains archived until repair-pyramid prunes it and
 *   closes its contaminated authored ancestry.
 * - Clear carried resolutions for messages that no longer have an L1.
 *
 * Follow with:
 *   repair-pyramid <copy> agents/fable --retire=L3-569
 * and only use --apply after that dry run reports canonical closure.
 */

import { createHash } from 'node:crypto';
import { JsStore } from '@animalabs/chronicle';

interface SummaryEntry {
  id: string;
  content: string;
  sourceIds: string[];
  sourceRange: { first: string; last: string };
  [key: string]: unknown;
}

interface ChunkRecord {
  id: string;
  sourceIds: string[];
  compressed: boolean;
  summaryId?: string;
  [key: string]: unknown;
}

const L1_267_SOURCE = ['4', '5', '2132', '2133', '2134', '2148', '2151', '2152'];
const L1_267_EARLY = ['4', '5'];
const L1_267_LATE = ['2132', '2133', '2134', '2148', '2151', '2152'];
const L1_403_SOURCE = [
  '1', '2', '3', '8097', '8099', '8100', '8101', '8102', '8103', '8105', '8107', '8111',
];
const L1_403_EARLY = ['1', '2', '3'];
const L1_403_LATE = ['8097', '8099', '8100', '8101', '8102', '8103', '8105', '8107', '8111'];
const EXPECTED_HASHES = {
  'L1-267': 'fefe78c27ee908918f673cf83e42e4232724831f8cab2417f87d04bb8838e181',
  'L1-403': '33329f725143b52cceb40ce30d88d6d03cc6b81c8d06db5d295648c841181d9b',
} as const;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const [storePath, namespace] = args.filter((arg) => !arg.startsWith('--'));
if (!storePath || !namespace) {
  console.error('usage: repair-fable-ownership <copied-store> agents/fable [--apply]');
  process.exit(2);
}
if (namespace !== 'agents/fable') {
  console.error(`FATAL: this surgery is scoped to agents/fable, got ${namespace}`);
  process.exit(2);
}

const store = JsStore.open({ path: storePath });
const sumsState = `${namespace}/autobio:summaries`;
const chunksState = `${namespace}/autobio:chunks`;
const resolutionsState = `${namespace}/autobio:resolutions`;
const rawSummaries = store.getStateJson(sumsState);
const rawRecords = store.getStateJson(chunksState);
const rawMessages = store.getStateJson('messages');
if (!Array.isArray(rawSummaries) || !Array.isArray(rawRecords) || !Array.isArray(rawMessages)) {
  console.error('FATAL: expected summaries, chunks, and messages state arrays');
  store.close();
  process.exit(3);
}
const summaries = rawSummaries.map((summary) => ({ ...(summary as SummaryEntry) }));
const records = rawRecords.map((record) => ({ ...(record as ChunkRecord), sourceIds: [...(record as ChunkRecord).sourceIds] }));
const liveMessageIds = new Set(
  rawMessages
    .map((message) => (message as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string'),
);
const liveMessageOrder = new Map(
  rawMessages
    .map((message, index) => [(message as { id?: unknown })?.id, index] as const)
    .filter((entry): entry is readonly [string, number] => typeof entry[0] === 'string'),
);

const exactSummary = (id: 'L1-267' | 'L1-403'): SummaryEntry => {
  const matches = summaries.filter((summary) => summary.id === id);
  if (matches.length !== 1) throw new Error(`${id}: expected exactly one canonical entry, found ${matches.length}`);
  const summary = matches[0]!;
  const hash = createHash('sha256')
    .update(JSON.stringify({
      id: summary.id,
      content: summary.content,
      sourceIds: summary.sourceIds,
      sourceRange: summary.sourceRange,
    }))
    .digest('hex');
  if (hash !== EXPECTED_HASHES[id]) throw new Error(`${id}: authored shape hash mismatch (${hash})`);
  return summary;
};
const exactRecord = (id: string, summaryId: string, sourceIds: readonly string[]): ChunkRecord => {
  const matches = records.filter((record) => record.id === id && record.summaryId === summaryId);
  if (matches.length !== 1) throw new Error(`${id}/${summaryId}: expected one record, found ${matches.length}`);
  const record = matches[0]!;
  if (JSON.stringify(record.sourceIds) !== JSON.stringify(sourceIds)) {
    throw new Error(`${id}/${summaryId}: sourceIds differ from the reviewed snapshot`);
  }
  return record;
};
for (const id of [...L1_267_SOURCE, ...L1_403_SOURCE]) {
  if (!liveMessageIds.has(id)) throw new Error(`reviewed live message ${id} is absent`);
}

exactSummary('L1-267');
const l1_403 = exactSummary('L1-403');
const c52 = exactRecord('c-52', 'L1-267', L1_267_SOURCE);
const c166 = exactRecord('c-166', 'L1-403', L1_403_SOURCE);

const nextRecordNumber = records.reduce((max, record) => {
  const number = Number(record.id.replace(/^c-/, ''));
  return Number.isFinite(number) ? Math.max(max, number + 1) : max;
}, 0);
let allocated = nextRecordNumber;
const makeUncompressed = (sourceIds: readonly string[]): ChunkRecord => ({
  id: `c-${allocated++}`,
  sourceIds: [...sourceIds],
  compressed: false,
});

// Retarget the later-focused authored node; its response content and token
// accounting remain byte-identical.
l1_403.sourceIds = [...L1_403_LATE];
l1_403.sourceRange = { first: L1_403_LATE[0]!, last: L1_403_LATE.at(-1)! };
c166.sourceIds = [...L1_403_LATE];

const l2_410 = summaries.find((summary) => summary.id === 'L2-410');
if (!l2_410 || JSON.stringify(l2_410.sourceRange) !== JSON.stringify({ first: '1', last: '8281' })) {
  throw new Error('L2-410: reviewed sourceRange 1..8281 is absent');
}
l2_410.sourceRange = { first: '8097', last: '8281' };

// L1-267 cannot be retargeted honestly. Remove its ledger pointer and create
// two contiguous production debts; repair-pyramid will archive the stale node.
const c52Index = records.indexOf(c52);
records.splice(c52Index, 1);
const newRecords = [
  makeUncompressed(L1_403_EARLY),
  makeUncompressed(L1_267_EARLY),
  makeUncompressed(L1_267_LATE),
];
records.push(...newRecords);
records.sort((left, right) => {
  const leftFirst = Math.min(...left.sourceIds.map((id) => liveMessageOrder.get(id) ?? Number.MAX_SAFE_INTEGER));
  const rightFirst = Math.min(...right.sourceIds.map((id) => liveMessageOrder.get(id) ?? Number.MAX_SAFE_INTEGER));
  return leftFirst - rightFirst || left.id.localeCompare(right.id);
});

const ownership = new Map<string, string>();
for (const record of records) {
  for (const messageId of record.sourceIds) {
    const previous = ownership.get(messageId);
    if (previous) throw new Error(`records ${previous} and ${record.id} both own ${messageId}`);
    ownership.set(messageId, record.id);
  }
}
for (const id of [...L1_267_SOURCE, ...L1_403_SOURCE]) {
  if (!ownership.has(id)) throw new Error(`surgery left ${id} without a chunk owner`);
}

const resolutions = {
  ...((store.getStateJson(resolutionsState) as Record<string, unknown> | null) ?? {}),
};
for (const id of [...L1_403_EARLY, ...L1_267_SOURCE]) delete resolutions[id];

console.log(`store:       ${storePath}`);
console.log(`mode:        ${apply ? 'APPLY' : 'DRY RUN'}`);
console.log(`L1-403:      ${L1_403_SOURCE.length} sources → ${L1_403_LATE.length} later sources`);
console.log(`L2-410:      range 1..8281 → 8097..8281 (content unchanged)`);
console.log(`c-52:        removed; L1-267 remains archived pending pyramid cleanup`);
console.log(`new records: ${newRecords.map((record) => `${record.id}[${record.sourceIds[0]}..${record.sourceIds.at(-1)}]`).join(', ')}`);
console.log(`resolutions: cleared ${L1_403_EARLY.length + L1_267_SOURCE.length} potentially unrealizable entries`);

if (!apply) {
  console.log('\nDRY RUN — nothing written.');
  store.close();
  process.exit(0);
}
store.setStateJson(sumsState, summaries);
store.setStateJson(chunksState, records);
store.setStateJson(resolutionsState, resolutions);
store.close();
console.log('\nAPPLIED to copied store. Run hardened repair-pyramid dry mode next.');
