/** Split one reviewed, classifier-hostile merge quarantine into smaller work.
 * Dry-run by default. This changes production grouping, not authored content;
 * every source must still exist, be unparented, and be absent from the queue. */

import { JsStore } from '@animalabs/chronicle';

interface SummaryEntry {
  id: string;
  parentId?: string;
  mergedInto?: string;
}

interface MergeRecord {
  key: string;
  level: number;
  sourceIds: string[];
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter((arg) => !arg.startsWith('--'));
const [storePath, namespace, key, sizeRaw] = positional;
const size = Number(sizeRaw);
if (!storePath || !namespace || !key || !Number.isSafeInteger(size) || size < 2) {
  console.error(
    'usage: split-merge-quarantine <copied-store> <namespace> <full-key> <group-size>=2 [--apply]',
  );
  process.exit(2);
}

const store = JsStore.open({ path: storePath });
const quarantineState = `${namespace}/autobio:merge-quarantine`;
const queueState = `${namespace}/autobio:mergeQueue`;
const summariesState = `${namespace}/autobio:summaries`;
const rawQuarantine = store.getStateJson(quarantineState);
const rawQueue = store.getStateJson(queueState);
const rawSummaries = store.getStateJson(summariesState);
if (!Array.isArray(rawQuarantine) || !Array.isArray(rawQueue) || !Array.isArray(rawSummaries)) {
  console.error('FATAL: expected quarantine, queue, and summaries arrays');
  store.close();
  process.exit(3);
}
const records = rawQuarantine as MergeRecord[];
const matches = records.filter((record) => record?.key === key);
if (matches.length !== 1) {
  console.error(`FATAL: expected one quarantine ${key}, found ${matches.length}`);
  store.close();
  process.exit(3);
}
const record = matches[0]!;
if (size >= record.sourceIds.length) {
  console.error(`FATAL: group size ${size} does not split ${record.sourceIds.length} sources`);
  store.close();
  process.exit(3);
}
const summaries = new Map(
  (rawSummaries as SummaryEntry[]).map((summary) => [summary.id, summary] as const),
);
const queued = new Set(
  (rawQueue as Array<{ sourceIds?: string[] }>).flatMap((merge) => merge.sourceIds ?? []),
);
for (const sourceId of record.sourceIds) {
  const source = summaries.get(sourceId);
  if (!source) throw new Error(`source ${sourceId} is absent`);
  if (source.parentId ?? source.mergedInto) {
    throw new Error(`source ${sourceId} is already parented`);
  }
  if (queued.has(sourceId)) throw new Error(`source ${sourceId} is already queued`);
}

const groups: string[][] = [];
for (let index = 0; index < record.sourceIds.length; index += size) {
  groups.push(record.sourceIds.slice(index, index + size));
}
if (groups.at(-1)!.length === 1) {
  const previous = groups.at(-2)!;
  groups.at(-1)!.unshift(previous.pop()!);
}
if (groups.some((group) => group.length < 2)) throw new Error('split produced a singleton');
const nextQueue = [
  ...(rawQueue as Array<{ level: number; sourceIds: string[] }>),
  ...groups.map((sourceIds) => ({ level: record.level, sourceIds })),
];
const nextQuarantine = records.filter((candidate) => candidate.key !== key);

console.log(`store:      ${storePath}`);
console.log(`mode:       ${apply ? 'APPLY' : 'DRY RUN'}`);
console.log(`quarantine: ${key.slice(0, 12)} L${record.level} ${record.sourceIds.length} sources`);
console.log(`groups:     ${groups.map((group) => group.join(',')).join(' | ')}`);
if (!apply) {
  console.log('\nDRY RUN — nothing written.');
  store.close();
  process.exit(0);
}
store.setStateJson(quarantineState, nextQuarantine);
store.setStateJson(queueState, nextQueue);
store.close();
console.log('\nAPPLIED to copied store. Resume the offline drain.');

