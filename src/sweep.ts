import type { JsStore } from '@animalabs/chronicle';
import type { MessageId, MessageMetadata, StoredContentBlock } from './types/message.js';
import { registerStateIfAbsent } from './state-registration.js';
import { isEmptyTextBlock, releaseEditedRawForms } from './raw-forms.js';

/**
 * One stored message, as the store holds it, read without blobs: media is
 * its `blob_ref`. A body stored as shards is given whole: its shards' other
 * blocks, then one text block that joins their text, in the order in which
 * AutobiographicalStrategy renders a sharded body in its head and recent
 * windows.
 */
export interface SweepBody {
  /** The body's first row: the id a rewrite keeps. */
  id: MessageId;
  /** Its writer. */
  participant: string;
  timestamp: Date;
  metadata?: MessageMetadata;
  content: StoredContentBlock[];
}

/**
 * A sweep's code. `mend` is pure. It gives a body's new content, or null for
 * a body that it leaves, a mended body included. It matches only what the
 * faulty writer wrote, and gives null where a body can't show that. After a
 * release its result for a body doesn't change: another transformation is
 * another entry, under another name. A `blob_ref` in its result must be one
 * that the store holds. A block it gives back unchanged, as the same object,
 * keeps its raw replay forms; every block that shares a raw form with a
 * block it changed or left out gives that form up (raw-forms.ts), so a
 * spread block never replays its old text. An opaque carrier keeps its raw
 * item, which is its whole content: an entry mends one by its `rawItem`.
 * An entry can't remove or empty a body: a result with no block, or with
 * only text blocks that hold nothing, is reported, and the body stays as it
 * is. What an entry throws is reported by its class alone, since its message
 * and its name can quote the body.
 */
export interface SweepEntry {
  name: string;
  /** One line that says what it mends. */
  line: string;
  mend: (body: SweepBody) => StoredContentBlock[] | null;
}

/** A take: the store's record that it took a sweep, and when. */
export interface SweepTake {
  /** The record's id. */
  take: string;
  name: string;
  /** ISO time. */
  at: string;
}

/** A body that a pass listed before it rewrote it. */
export interface ListedBody {
  id: MessageId;
  participant: string;
  /** The body's time, in ms. */
  timestamp: number;
  /** The rows after its first, which the pass removes. */
  laterShards: MessageId[];
}

/**
 * An item of a branch's applied list. `listed`: what a pass will rewrite in
 * `slot`, or the later shards that an earlier pass left standing and that
 * this pass will remove, with the branch's `sequence` before that write,
 * where the old text can be read (getMessageAt). `finished`: the branch
 * finished `take` for `slot`.
 */
export type SweepApplied =
  | { v: 1; kind: 'listed'; name: string; take: string; slot: string; at: string; sequence: number; bodies: ListedBody[] }
  | { v: 1; kind: 'finished'; name: string; take: string; slot: string; at: string };

export const SWEEP_TAKE_RECORD = 'context-manager/sweep-take';
export const SWEEPS_APPLIED_STATE_ID = 'context-manager/sweeps-applied';

/** A change that a show gives: never the old text. Lengths count the characters of text blocks. */
export interface SweepChange {
  id: MessageId;
  timestamp: Date;
  content: StoredContentBlock[];
  oldLength: number;
  newLength: number;
}

/** A body that a show or a pass could not mend, and why. */
export interface SweepFailure {
  id: MessageId;
  error: string;
}

export interface SweepShow {
  changes: SweepChange[];
  /**
   * Bodies that a pass would not rewrite, and why: a body stored short,
   * whatever the entry would give, and a body the entry would mend where the
   * entry throws, gives no content, or gives content that the store or the
   * strategy refuses. A refusal is given as it reads, and can quote the
   * content that the entry gave.
   */
  failures: SweepFailure[];
}

/**
 * What a pass did for one sweep. `finished`: the branch has finished its
 * newest take for the slot. `owed`: not yet, or later shards that a pass of
 * any take of it listed still stand, and a later pass is asked again; its
 * receipt can then say the take is finished. `unknown`: the store took it,
 * and no entry of that name was given, so nothing was asked of any body.
 */
export interface SweepPassOutcome {
  name: string;
  take: string;
  outcome: 'finished' | 'owed' | 'unknown';
  rewritten: MessageId[];
  /** Later shards removed: this pass's, and those an earlier pass left. */
  removed: MessageId[];
  failed: SweepFailure[];
}

export interface SweepPassReport {
  slot: string;
  branch: string;
  sweeps: SweepPassOutcome[];
  /**
   * Why the pass stopped before it was done, or null: a listener of one of
   * its writes moved the store to another branch or closed the manager, or
   * a write to the branch's applied list threw. It wrote nothing after that
   * write, and what it hadn't done is owed.
   */
  stopped: string | null;
  /**
   * What the pass could not read: the indexes of the branch's applied-list
   * items and the ids of take records that don't parse. A damaged item's
   * bodies are not let go of, and a damaged take is not applied.
   */
  unreadable: { items: number[]; takes: string[] };
}

/** A pass on the open branch, as its list item names it. */
export interface SweepPass {
  take: string;
  at: string;
  sequence: number;
  bodies: ListedBody[];
}

/**
 * Where a sweep stands for one slot on the open branch. `take` is the
 * store's newest take of it, or null: never taken. `finished`: this branch
 * finished that take for the slot.
 */
export interface SweepReceipt {
  name: string;
  take: SweepTake | null;
  finished: boolean;
  passes: SweepPass[];
}

/**
 * The applied list's items from `from` on, on the store's open branch,
 * with its length: a reader keeps the length it has read as its cursor.
 * An item that doesn't parse is left out, counts in the length, and is
 * named by its index in `unreadable`.
 */
export function sweepsApplied(store: JsStore, from = 0): { items: SweepApplied[]; length: number; unreadable: number[] } {
  const length = store.getStateLen(SWEEPS_APPLIED_STATE_ID) ?? 0;
  const items: SweepApplied[] = [];
  const unreadable: number[] = [];
  for (let i = Math.max(0, from); i < length; i++) {
    const item: unknown = store.getStateItemJson(SWEEPS_APPLIED_STATE_ID, i);
    if (isSweepApplied(item)) items.push(item);
    else unreadable.push(i);
  }
  return { items, length, unreadable };
}

/** The ids of the rows that `items` list, bodies and later shards. */
export function listedRows(items: readonly SweepApplied[]): Set<MessageId> {
  const ids = new Set<MessageId>();
  for (const item of items) {
    if (item.kind !== 'listed') continue;
    for (const body of item.bodies) {
      ids.add(body.id);
      for (const shard of body.laterShards) ids.add(shard);
    }
  }
  return ids;
}

export function listedLaterShards(items: readonly SweepApplied[]): Set<MessageId> {
  const ids = new Set<MessageId>();
  for (const item of items) {
    if (item.kind !== 'listed') continue;
    for (const body of item.bodies) for (const shard of body.laterShards) ids.add(shard);
  }
  return ids;
}

export function newestTakes(store: JsStore): { takes: SweepTake[]; unreadable: string[] } {
  const newest = new Map<string, SweepTake>();
  const unreadable: string[] = [];
  for (const id of store.getRecordIdsByType(SWEEP_TAKE_RECORD)) {
    const record = store.getRecord(id);
    let payload: unknown;
    try {
      payload = record ? JSON.parse(record.payload.toString('utf8')) : undefined;
    } catch {
      payload = undefined;
    }
    if (!isTakePayload(payload)) {
      unreadable.push(id);
      continue;
    }
    newest.delete(payload.name);
    newest.set(payload.name, { take: id, name: payload.name, at: payload.at });
  }
  return { takes: [...newest.values()], unreadable };
}

let passRunning = false;

export function sweepPassRunning(): boolean {
  return passRunning;
}

export function runSweepPass<T>(pass: () => T): T {
  if (passRunning) {
    throw new Error(
      'ContextManager.applySweeps refused: a pass is running, and one of its writes asked for another. ' +
        'Ask for the pass once that one has returned.',
    );
  }
  passRunning = true;
  try {
    return pass();
  } finally {
    passRunning = false;
  }
}

export function appendTake(store: JsStore, name: string, at: string): SweepTake {
  const record = store.appendJson(SWEEP_TAKE_RECORD, { v: 1, name, at });
  store.sync();
  return { take: record.id, name, at };
}

export function appendApplied(store: JsStore, item: SweepApplied): void {
  registerStateIfAbsent(store, { id: SWEEPS_APPLIED_STATE_ID, strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 10 });
  store.appendToStateJson(SWEEPS_APPLIED_STATE_ID, item);
}

export function askEntry(
  entry: SweepEntry,
  body: SweepBody,
): { kind: 'mended'; content: StoredContentBlock[] } | { kind: 'left' } | { kind: 'threw'; error: string } {
  let content: StoredContentBlock[] | null;
  try {
    content = entry.mend(body);
  } catch (error) {
    const type = error instanceof Error ? error.constructor.name : typeof error;
    return { kind: 'threw', error: `${entry.name} threw ${type} on ${body.id}; its message and name are left out, since they can quote the body` };
  }
  if (content === null) return { kind: 'left' };
  if (!Array.isArray(content) || content.every((block) => block.type === 'text' && isEmptyTextBlock(block))) {
    return {
      kind: 'threw',
      error: `${entry.name} gave no content for ${body.id}, and the body stays as it is: an entry gives null to leave a body, or content that holds something`,
    };
  }
  return { kind: 'mended', content: releaseEditedRawForms(body.content, content) };
}

export function textLength(content: readonly StoredContentBlock[]): number {
  let length = 0;
  for (const block of content) if (block.type === 'text') length += block.text.length;
  return length;
}

export function sweepBodyOf(
  rows: readonly { id: MessageId; participant: string; timestamp: number; metadata?: MessageMetadata; content: StoredContentBlock[] }[],
): SweepBody {
  const first = rows[0]!;
  const content: StoredContentBlock[] =
    rows.length === 1
      ? first.content
      : [
          ...rows.flatMap((row) => row.content.filter((block) => block.type !== 'text')),
          { type: 'text', text: rows.map((row) => row.content.map((block) => (block.type === 'text' ? block.text : '')).join('')).join('') },
        ];
  return {
    id: first.id,
    participant: first.participant,
    timestamp: new Date(first.timestamp),
    ...(first.metadata !== undefined ? { metadata: first.metadata } : {}),
    content,
  };
}

function isTakePayload(value: unknown): value is { v: 1; name: string; at: string } {
  if (typeof value !== 'object' || value === null) return false;
  return 'v' in value && value.v === 1 && 'name' in value && typeof value.name === 'string' && 'at' in value && typeof value.at === 'string';
}

function isListedBody(value: unknown): value is ListedBody {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'id' in value && typeof value.id === 'string' &&
    'participant' in value && typeof value.participant === 'string' &&
    'timestamp' in value && typeof value.timestamp === 'number' &&
    'laterShards' in value && Array.isArray(value.laterShards) && value.laterShards.every((id: unknown) => typeof id === 'string')
  );
}

function isSweepApplied(value: unknown): value is SweepApplied {
  if (typeof value !== 'object' || value === null) return false;
  if (!('v' in value) || value.v !== 1) return false;
  if (!('name' in value) || typeof value.name !== 'string') return false;
  if (!('take' in value) || typeof value.take !== 'string') return false;
  if (!('slot' in value) || typeof value.slot !== 'string') return false;
  if (!('at' in value) || typeof value.at !== 'string') return false;
  if (!('kind' in value)) return false;
  if (value.kind === 'finished') return true;
  return (
    value.kind === 'listed' &&
    'sequence' in value && typeof value.sequence === 'number' &&
    'bodies' in value && Array.isArray(value.bodies) && value.bodies.every(isListedBody)
  );
}
