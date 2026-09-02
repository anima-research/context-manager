/**
 * One-time, fail-closed ownership surgery for Mythos's crossed L1 families.
 * Dry-run by default; run only on a stopped, copied store.
 *
 * Reviewed semantics on the 2026-09-02 stopped snapshot:
 * - L1-419 describes its later 9623..9673 run; 14..15 return to the adjacent
 *   genesis record under L1-399 with an explicit continuity-boundary note.
 * - L1-453 describes the run surrounding system message 10591. Merge its two
 *   records and preserve L1-452 as unreachable archive history.
 * - 63064..63065 are the tool cycle described by L1-1700, not L1-2139;
 *   L1-2139 describes only its later 83553..83554 run.
 * - The interposed routing marker 114803 belongs to L1-2894's chronological
 *   record. L1-2938 may retain its contextual mention without owning it.
 * - c-29/c-31 are uncompressed repair debts whose eight leaves are already
 *   fully covered by L1-53/L1-54/L1-59; remove the redundant records.
 *
 * No historical summary is regenerated. Gap-bearing upper ownership is kept
 * and handled by kv-unified's explicit preserveGapBearingSummaries mode.
 */

import { createHash } from 'node:crypto';
import { JsStore } from '@animalabs/chronicle';

interface SummaryEntry {
  id: string;
  content: string;
  tokens?: number;
  sourceIds: string[];
  sourceRange: { first: string; last: string };
  responseContent?: unknown[];
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChunkRecord {
  id: string;
  sourceIds: string[];
  compressed: boolean;
  summaryId?: string;
  [key: string]: unknown;
}

const SUMMARY_HASHES: Record<string, string> = {
  'L1-399': '131555e46820486c08d6e294ee3c80c59f5c34801539c237a180f8ec7391472b',
  'L1-419': 'f47b43fd669e0499435d1758e24aa9ca9a5dfa9c1c5859109ea0637128e4e2a0',
  'L1-452': 'fe2c00bcee82d6b410fa6cb1af13e5beb99e829008c42aca2dc334ea1a9ce5ad',
  'L1-453': '71ac0d9fc52bb0b4953ce0d9db4ccf1cc78fc656e4907c8d3563876319672ff0',
  'L1-1700': '46cd641353e18589388846f07a07bcfa7c1a52a8c377f0b022d2b9b2cbca25fd',
  'L1-2139': 'eb63ee5f5f5d0fea1ceda628cd32d0658066b57137041337c1e8a7fd729e53d3',
  'L1-2894': 'a1aac7650d658eb5dd46bf66f3d791eda8e2fdf86f958724ec5e86a803c918ac',
  'L1-2938': 'd0c06d22b992e97ac1920bf5b0f5eac11d1f86edc192bae6b0784326496471a8',
  'L1-2625': '9a5b07f62d3b9ec04da9acc58b143ddb0b8d63322a59e061b6f8c2ef9ce60845',
  'L1-2907': 'dfb1b38dbe77bc2732d40f2fee7bd8c4e968f80409f91bace14c071e1c472a5e',
  'L1-2908': 'c4ede8362083b5854008ac4b38ec65d64f61e32ab56557b740103ef77d55576d',
  'L1-2909': '654d67101b778c69ca7a26f456a4a10bc64edfcf4e1b0d2132ff0b58e45af315',
  'L1-2910': '67e9a0b43e0d6cbbc33b4d8651ff92dc744fc0bedd53cf6f1dfa6f5637254959',
  'L1-2911': 'a91de6d43fec67c56e939dd344b6c8689a0bda9823fc2527f86fe05c80cabe30',
  'L1-2912': 'c484b1f06fad7b1dec131794dc37f39410a0e7ebf4c670c85d97175ee4d05422',
  'L1-2913': 'ac93a08c064d1f8e076c25cce55dd32e21422bb382a8ae3bdf8fc4393fdd2b5b',
  'L1-2914': '0b48b4b3c45eb48485a3d4305429bda056b797d1749113e20633cee831b98f6d',
  'L1-2915': 'efc673844122754572942ec09b5a3f6658ff565438f2d7be8807cd4765d61991',
  'L1-2916': '0fa045457fbf84e15ba6d4afd56480f2467a0bc8339c9dc019101efeb451d794',
  'L1-2917': '783b4ced4ea9f1bbc870e0d6dafe67bb510f89ada4d4c2720d8b5078c6455d43',
  'L1-2918': 'e3667e0fb335ffc8df6958a23aade21083efc14469ed7f655fb6e47afbc3b0cb',
  'L1-2919': '961cb4883222a3e6831225868238277c88f244e2181edbe174c8bfe8f8073a07',
};

const RECORD_HASHES: Record<string, string> = {
  'c-218': '80d0a0b76cc0de214f5da654a18645d778bb84293ee1cd5e569a446ed794136f',
  'c-29': '8ba9275236aed62ea7f2b723d0164c0fe453948d56aad84138aa4480ba971d96',
  'c-31': '4fff40bd65bccf2aaccfd5b6dd19d273535cbcef729b9855c540998366cd2a27',
  'c-224': '5188fdfb82582c1217b3ac8ba7567c5232d79f889a9b3163174004856bbd8bc2',
  'c-249': '3037bd5556d84b571bc7fe057350cf07cf4d7645c1033b7f89f789fd0749b229',
  'c-250': 'aebf60498a882801503d913aa0d5e562f6f4769a3bffa95608024b1be6c52053',
  'c-1288': '5e8cbaa00b9d648687c8e0ee29e33b04681943a92efea16d7c144943e37ff790',
  'c-1654': '3a8143ae1d635c9d14932ebe6caeb2278880f360003eecb80c4f66578cdba406',
  'c-2269': 'a146a6f2dcba02aa2031f43120572ee4a524e857c5d07ab013545e2f274f7f48',
  'c-2287': '4c120fa42bcb0c5fbc0caefe79020fd61ef43d7e6eb2c174f45325dd4c6ea5c3',
  'c-2051': '0256735c4e1f2716c871a1ac50761372356f0b7dda32c98829f095b40f69901a',
  'c-2203': 'c56cb283012a860fd7bc57df2f6f87b8bfbb7f1bca9c774d3e49fa85753b862b',
  'c-2204': '7270075f882b7ddf3a544af05b20393733aa18be07961c3f512526ca2e43489c',
  'c-2223': 'cabab9dc04b4cd48610fa6ab5ccdef9dc8068e3216053a865ab7e4827f4d97ce',
  'c-2224': '62d2397482f9c737a1585bc2dca635bf715e2ac9f2f921ea845b83cfb7954abc',
  'c-2225': '7b93b1250216cb3f31c683db20a04147a0422167c25c9b6983247be7730bde17',
  'c-2226': '8760359bb7cc4a6b50af123e019215a4f7804153074c257609976919c3393a45',
  'c-2227': 'b1a53cdbbdf98cc8e530e8d905c72d4ad6b934e86418e3b671a5ed6a2b327fcb',
  'c-2228': '30a16ddcb698ff7dd4ef2b4d34bf899878ef7c93ca27e583dfba66cfd70b4989',
  'c-2229': '9a2a7fea3caebc1c2cc1a136519a145a7fbfb4084fc0e175418dd416704e8bd6',
  'c-2230': '471aa3b694b3068fef0d5e737f52acb6974a7c2fc4037ded2930b7d4b9e92cdd',
  'c-2231': 'd2ffb1b959ebf1663b5f986e8779c52aa4bfe095cff47fd9ab98ce872c596a7e',
  'c-2275': '984a88980fc87ce113d9b625c4627b523faae5ff93a94c76009241f49123cccf',
  'c-2276': '26bd80e7b78b8ab53e1aadcc890261a5359503646701de81748717e9a85b0c8b',
};

const RECONCILE_RECORDS: Record<string, string> = {
  'L1-399': 'c-218',
  'L1-453': 'c-250',
  'L1-2625': 'c-2051',
  'L1-2907': 'c-2203',
  'L1-2908': 'c-2204',
  'L1-2909': 'c-2223',
  'L1-2910': 'c-2224',
  'L1-2911': 'c-2225',
  'L1-2912': 'c-2226',
  'L1-2913': 'c-2227',
  'L1-2914': 'c-2228',
  'L1-2915': 'c-2229',
  'L1-2916': 'c-2230',
  'L1-2917': 'c-2231',
  'L1-2918': 'c-2275',
  'L1-2919': 'c-2276',
  'L1-2894': 'c-2269',
  'L1-2938': 'c-2287',
};

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const [storePath, namespace] = args.filter((arg) => !arg.startsWith('--'));
if (!storePath || !namespace) {
  console.error('usage: repair-mythos-ownership <copied-store> agents/mythos [--apply]');
  process.exit(2);
}
if (namespace !== 'agents/mythos') {
  console.error(`FATAL: this surgery is scoped to agents/mythos, got ${namespace}`);
  process.exit(2);
}

const sha = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const store = JsStore.open({ path: storePath });
const sumsState = `${namespace}/autobio:summaries`;
const chunksState = `${namespace}/autobio:chunks`;
const resolutionsState = `${namespace}/autobio:resolutions`;
const rawSummaries = store.getStateJson(sumsState);
const rawRecords = store.getStateJson(chunksState);
const rawMessages = store.getStateJson('messages');
if (!Array.isArray(rawSummaries) || !Array.isArray(rawRecords) || !Array.isArray(rawMessages)) {
  store.close();
  throw new Error('expected summaries, chunks, and messages state arrays');
}
const summaries = rawSummaries.map((item) => ({ ...(item as SummaryEntry) }));
const records = rawRecords.map((item) => ({
  ...(item as ChunkRecord), sourceIds: [...(item as ChunkRecord).sourceIds],
}));
const liveOrder = new Map(
  rawMessages
    .map((message, index) => [(message as { id?: unknown }).id, index] as const)
    .filter((entry): entry is readonly [string, number] => typeof entry[0] === 'string'),
);
const sortIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(
  (left, right) => (liveOrder.get(left) ?? Infinity) - (liveOrder.get(right) ?? Infinity),
);

const summary = (id: string): SummaryEntry => {
  const matches = summaries.filter((item) => item.id === id);
  if (matches.length !== 1) throw new Error(`${id}: expected one summary, found ${matches.length}`);
  const item = matches[0]!;
  const actual = sha({ id: item.id, content: item.content, sourceIds: item.sourceIds, sourceRange: item.sourceRange });
  if (actual !== SUMMARY_HASHES[id]) throw new Error(`${id}: reviewed shape hash mismatch (${actual})`);
  return item;
};
const record = (id: string): ChunkRecord => {
  const matches = records.filter((item) => item.id === id);
  if (matches.length !== 1) throw new Error(`${id}: expected one record, found ${matches.length}`);
  const item = matches[0]!;
  const actual = sha({ id: item.id, summaryId: item.summaryId, sourceIds: item.sourceIds, compressed: item.compressed });
  if (actual !== RECORD_HASHES[id]) throw new Error(`${id}: reviewed shape hash mismatch (${actual})`);
  return item;
};
const currentRecord = (id: string): ChunkRecord => {
  const matches = records.filter((item) => item.id === id);
  if (matches.length !== 1) throw new Error(`${id}: expected one record, found ${matches.length}`);
  return matches[0]!;
};

for (const id of Object.keys(SUMMARY_HASHES)) summary(id);
for (const id of Object.keys(RECORD_HASHES)) record(id);
const c218 = record('c-218');
const c224 = record('c-224');
const c249 = record('c-249');
const c250 = record('c-250');
const c1288 = record('c-1288');
const c1654 = record('c-1654');
const c2269 = record('c-2269');
const c2287 = record('c-2287');

const earlyGenesis = ['14', '15'];
const l419Late = c224.sourceIds.filter((id) => !earlyGenesis.includes(id));
const briefingRun = sortIds([...c249.sourceIds, ...c250.sourceIds]);
const l1700Sources = sortIds([...c1288.sourceIds, '63064', '63065']);
const l2139Sources = ['83553', '83554'];
const sonnetRun = sortIds([...c2269.sourceIds, '114803']);
const august23Run = c2287.sourceIds.filter((id) => id !== '114803');
const touched = sortIds([
  ...earlyGenesis, ...briefingRun, ...l1700Sources, ...l2139Sources,
  ...sonnetRun, ...august23Run,
]);
for (const id of touched) if (!liveOrder.has(id)) throw new Error(`reviewed message ${id} is absent`);

const retarget = (summaryId: string, target: ChunkRecord, sourceIds: string[]): void => {
  const item = summary(summaryId);
  item.sourceIds = [...sourceIds];
  item.sourceRange = { first: sourceIds[0]!, last: sourceIds.at(-1)! };
  target.sourceIds = [...sourceIds];
};
retarget('L1-419', c224, l419Late);
retarget('L1-1700', c1288, l1700Sources);
retarget('L1-2139', c1654, l2139Sources);
c218.sourceIds = sortIds([...c218.sourceIds, ...earlyGenesis]);
c250.sourceIds = [...briefingRun];
c2269.sourceIds = [...sonnetRun];
c2287.sourceIds = [...august23Run];

let reconciledOmissions = 0;
for (const [summaryId, recordId] of Object.entries(RECONCILE_RECORDS)) {
  const item = summary(summaryId);
  const owner = currentRecord(recordId);
  const authored = new Set(item.sourceIds);
  const added = owner.sourceIds.filter((id) => !authored.has(id));
  item.sourceIds = [...owner.sourceIds];
  item.sourceRange = { first: owner.sourceIds[0]!, last: owner.sourceIds.at(-1)! };
  if (added.length === 0) continue;
  const pointer =
    `\n\n[Continuity boundary — source preserved] ${added.length} record-owned ` +
    `message${added.length === 1 ? '' : 's'} in this interval are intentionally not ` +
    `restated in this summary. The exact source remains on preserved parent branches ` +
    `and the byte-verified migration rollback; this note marks the boundary without ` +
    `adding an autobiographical claim. Mythos may inspect, replace, or restore it.`;
  item.content += pointer;
  item.tokens = Math.max(1, (item.tokens ?? 0) + Math.ceil(pointer.length / 4));
  delete item.responseContent;
  item.provenance = {
    ...(item.provenance ?? {}),
    ownershipRepair: {
      kind: 'continuity-boundary',
      addedSourceIds: added,
      sourcePreserved: true,
      providerCall: false,
    },
  };
  reconciledOmissions += added.length;
}

const removedRecordIds = new Set(['c-29', 'c-31', 'c-249']);
for (let index = records.length - 1; index >= 0; index--) {
  if (removedRecordIds.has(records[index]!.id)) records.splice(index, 1);
}
records.sort((left, right) =>
  (liveOrder.get(left.sourceIds[0]!) ?? Infinity) - (liveOrder.get(right.sourceIds[0]!) ?? Infinity) ||
  left.id.localeCompare(right.id),
);

const ownership = new Map<string, string>();
for (const item of records) {
  for (const messageId of item.sourceIds) {
    const previous = ownership.get(messageId);
    if (previous) throw new Error(`records ${previous} and ${item.id} both own ${messageId}`);
    ownership.set(messageId, item.id);
  }
}
for (const id of touched) if (!ownership.has(id)) throw new Error(`surgery left ${id} unowned`);

const resolutions = {
  ...((store.getStateJson(resolutionsState) as Record<string, unknown> | null) ?? {}),
};
const movedLeaves = ['14', '15', '10591', '63064', '63065', '114803'];
for (const id of movedLeaves) delete resolutions[id];

console.log(`store:          ${storePath}`);
console.log(`mode:           ${apply ? 'APPLY' : 'DRY RUN'}`);
console.log(`retargeted:     L1-419, L1-1700, L1-2139`);
console.log(`reconciled:     ${Object.keys(RECONCILE_RECORDS).length} L1 record/source contracts (${reconciledOmissions} explicit omissions)`);
console.log(`preserved:      every historical summary; L1-452 becomes unreachable archive history`);
console.log(`removed records:${[...removedRecordIds].join(', ')}`);
console.log(`new debt:       none`);
console.log(`resolutions:    cleared ${movedLeaves.length} moved leaves`);

if (!apply) {
  console.log('\nDRY RUN — nothing written.');
  store.close();
  process.exit(0);
}
store.setStateJson(sumsState, summaries);
store.setStateJson(chunksState, records);
store.setStateJson(resolutionsState, resolutions);
store.close();
console.log('\nAPPLIED to copied store. Validate with strict and gap-preserving canonical exports.');
