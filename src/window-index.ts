/**
 * The window index (agent-framework #291): which stored rows one agent has
 * been shown, and in what order.
 *
 * The store's record holds every write in the order it arrived, whoever
 * wrote it and whoever it was for. An agent's window is another order over
 * the same rows: the rows it was shown, in the order it was shown them,
 * which is what its requests carried. Each compile has to send that order
 * again for the provider's prompt cache to hold and for a reply's signed
 * thinking to be sent with the prefix it was minted under. While one agent
 * writes one slot the two orders are the same. Once agents share a slot, or
 * one reads another's, they differ: a row another agent stored during my
 * turn sits inside my turn in the record, but enters my window only at my
 * next tool boundary or turn start.
 *
 * The index is that order, kept per manager namespace as a Chronicle
 * append-log state, `<namespace>/presentation`, so it is per branch, survives
 * a restart, and a branch made from another starts from the parent's index
 * as of the branch point. Its items are:
 *
 * - a header, `{ v: 1 }`, the first item a manager writes;
 * - a presentation, `{ id }`: the stored row with that id (a record id, as a
 *   string) entered the window;
 * - a tombstone, `{ retract, undone? }`: the row left the window. With
 *   `undone`, it was a row of an undone turn, which stays out until it is
 *   presented again (a redo).
 *
 * Each item also carries `at` and `by`, the sequence and id of the record
 * that wrote it, which come after the row's own: a presentation is a later
 * write than the row it presents.
 *
 * Two notions of position follow from this, named apart:
 *
 * - An index ordinal is an item's place in the log. It never changes: a
 *   row that leaves the window leaves a hole at its ordinal, and a row
 *   presented again takes a new one at the end. Ordinals are what a host's
 *   watermarks compare, what a compile's rendered layout counts its members
 *   by (RenderedLayout.keyedBy), where windowed passthrough's anchor sits
 *   (StrategyContext.window), and what stays stable across a removal
 *   (`ContextManager.ordinalOf`).
 * - A listing position is a row's place in the presented listing a
 *   strategy reads (`MessageStoreView.positionOf`). It shifts when a row
 *   before it leaves the window, as a position in the store's own listing
 *   shifts when a row is removed.
 *
 * Until a host presents anything on a branch, the manager is in legacy
 * mode: there is no index, and the window is the record itself, live, as it
 * always was, so every compile is byte for byte what it was before this
 * module existed. A host's first presentation writes the index down as the
 * window stands then (every row of the record, in record order) and the
 * manager is in presented mode on that branch from then on.
 *
 * Not to be confused with two other senses of the word in this package:
 * kv-unified's presentation receipts (a provider submission's leaf layout)
 * and the fold journal's `Presentation` (how a round carried a compile).
 */

import type { JsStore } from '@animalabs/chronicle';
import { bodyBoundsIn } from './body-runs.js';
import type { Diagnostics } from './diagnostics.js';
import { registerStateIfAbsent } from './state-registration.js';
import type { MessageId, MessageStoreView, StoredMessage } from './types/index.js';

/** Whether a manager's window is the record (`legacy`) or its index (`presented`), on the branch its store is on. */
export type PresentationMode = 'legacy' | 'presented';

/** The format the header names. */
const INDEX_FORMAT = 1;

/** The state that holds a namespace's window index. */
export function windowIndexStateId(namespace: string): string {
  return `${namespace}/presentation`;
}

/**
 * One presentation per row, so the index grows as the message slot does,
 * and the slot's cadence fits it for the same reason (MessageStore.register):
 * a full snapshot of an append log copies its whole history, so it is kept
 * rare.
 */
function registrationFor(namespace: string) {
  return {
    id: windowIndexStateId(namespace),
    strategy: 'append_log' as const,
    deltaSnapshotEvery: 50,
    fullSnapshotEvery: 100,
  };
}

type IndexItem =
  | { v: number }
  | { id: MessageId }
  | { retract: MessageId; undone?: true };

/** The index as read on one branch at one revision. */
interface IndexState {
  /** The branch read, on a chronicle without state offsets; null otherwise (see revision). */
  branchId: unknown;
  revision: number | null;
  /** Per ordinal, the row presented there while it is still in the window; null for a hole. */
  rows: Array<MessageId | null>;
  /** Per ordinal, the sequence of the record that wrote the item, where it says. */
  at: Array<number | undefined>;
  /** The ordinal of every row in the window. */
  ordinals: Map<MessageId, number>;
  /** Rows of an undone turn, out of the window until presented again. */
  undone: Set<MessageId>;
  /** Changes whenever the window does, so a listing built from an earlier one is rebuilt. */
  version: number;
  /** `rows` without its holes, once asked for. */
  presented: MessageId[] | null;
}

/** Bumped for every new reading or change of any index, so versions never repeat. */
let versions = 0;

function emptyState(branchId: unknown, revision: number | null): IndexState {
  return { branchId, revision, rows: [], at: [], ordinals: new Map(), undone: new Set(), version: ++versions, presented: null };
}

/** Applies one item at `ordinal`, the next one; false for an item this version can't read, which leaves a hole. */
function apply(state: IndexState, item: unknown, ordinal: number, at: number | undefined): boolean {
  state.at[ordinal] = at;
  state.rows[ordinal] = null;
  if (typeof item !== 'object' || item === null) return false;
  const fields = item as { id?: unknown; retract?: unknown; undone?: unknown; v?: unknown };
  if (typeof fields.id === 'string') {
    // A row presented twice keeps its first ordinal: the window only grows
    // at the end, and a reload must never move a row a compile has sent.
    if (!state.ordinals.has(fields.id)) {
      state.rows[ordinal] = fields.id;
      state.ordinals.set(fields.id, ordinal);
    }
    state.undone.delete(fields.id);
    return true;
  }
  if (typeof fields.retract === 'string') {
    const was = state.ordinals.get(fields.retract);
    if (was !== undefined) {
      state.rows[was] = null;
      state.ordinals.delete(fields.retract);
    }
    if (fields.undone === true) state.undone.add(fields.retract);
    else state.undone.delete(fields.retract);
    return true;
  }
  return typeof fields.v === 'number';
}

/** Positions of each id in a listing, built once per listing (a listing is never changed in place). */
const positionsByListing = new WeakMap<readonly StoredMessage[], Map<MessageId, number>>();

function positionsIn(listing: readonly StoredMessage[]): Map<MessageId, number> {
  let positions = positionsByListing.get(listing);
  if (!positions) {
    positions = new Map();
    for (let i = 0; i < listing.length; i++) positions.set(listing[i]!.id, i);
    positionsByListing.set(listing, positions);
  }
  return positions;
}

/** Messages of a listing by id, built once per listing. */
const messagesByListing = new WeakMap<readonly StoredMessage[], Map<MessageId, StoredMessage>>();

function messagesIn(listing: readonly StoredMessage[]): Map<MessageId, StoredMessage> {
  let messages = messagesByListing.get(listing);
  if (!messages) {
    messages = new Map();
    for (const message of listing) messages.set(message.id, message);
    messagesByListing.set(listing, messages);
  }
  return messages;
}

/**
 * The position of the message stored at `sequence` in a listing in record
 * order, or -1: the store's listing and a merge of several slots list their
 * messages by sequence.
 */
function positionOfSequence(listing: readonly StoredMessage[], sequence: number): number {
  let lo = 0;
  let hi = listing.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const at = listing[mid]!.sequence;
    if (at === sequence) return mid;
    if (at < sequence) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * A row's position in a listing in record order, found by its sequence
 * (`sequenceOf`, which a store answers from its listing while that is
 * cached), so it reads no message.
 */
export function recordPositionOf(view: MessageStoreView, listing: readonly StoredMessage[], id: MessageId): number | undefined {
  const sequence = view.sequenceOf ? view.sequenceOf(id) : view.get(id)?.sequence;
  if (sequence === undefined) return undefined;
  const at = positionOfSequence(listing, sequence);
  return at !== -1 && listing[at]!.id === id ? at : undefined;
}

function sameElements(a: readonly StoredMessage[], b: readonly StoredMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The window index of one manager namespace, read through one store handle
 * on whatever branch that handle is on. It reads the state again whenever
 * the state's revision there has moved since it last read it, so another
 * handle's write, a branch switch and a restart all reach it.
 */
export class WindowIndex {
  readonly stateId: string;
  private readonly namespace: string;
  private state: IndexState | null = null;
  private registered = false;
  /** The last presented listing, with what it was built from. */
  private built: { source: readonly StoredMessage[]; version: number; listing: StoredMessage[] } | null = null;

  constructor(private readonly store: JsStore, namespace: string, private readonly diag: Diagnostics) {
    this.namespace = namespace;
    this.stateId = windowIndexStateId(namespace);
  }

  /**
   * The state's revision on the handle's branch: the log offset of its
   * newest chain record, null when it has none there. One record is one
   * value, so two branches whose chains end at the same record hold the same
   * index, and the offset alone says whether a reading is current, across a
   * branch switch too; reading the branch costs several times as much, and
   * every read of a view asks. On a chronicle without offsets, the state's
   * length on the branch, which then has to be read with it.
   */
  private revision(): number | null {
    const store = this.store as { stateHeadOffset?: (id: string) => number | null };
    if (typeof store.stateHeadOffset === 'function') return store.stateHeadOffset(this.stateId);
    return this.store.getStateLen(this.stateId);
  }

  private branchKey(): unknown {
    return typeof (this.store as { stateHeadOffset?: unknown }).stateHeadOffset === 'function'
      ? null
      : this.store.currentBranch().id;
  }

  /** The index as it stands on the handle's branch. */
  private current(): IndexState {
    const revision = this.revision();
    const branchId = this.branchKey();
    const state = this.state;
    if (state && state.revision === revision && state.branchId === branchId) return state;
    return (this.state = this.read(branchId, revision));
  }

  private read(branchId: unknown, revision: number | null): IndexState {
    const state = emptyState(branchId, revision);
    if (revision === null) return state;
    const items = this.store.getStateJson(this.stateId) as unknown;
    if (!Array.isArray(items)) return state;
    let unreadable = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as { at?: unknown } | null;
      const at = typeof item?.at === 'number' ? item.at : undefined;
      if (!apply(state, item, i, at)) unreadable++;
    }
    if (unreadable > 0) {
      this.diag.warn(
        `[context-manager] the window index of branch ${this.store.currentBranch().name} holds ${unreadable} ` +
          `item(s) this version can't read; each is left out of the window as a hole`,
      );
    }
    return state;
  }

  mode(): PresentationMode {
    return this.current().rows.length > 0 ? 'presented' : 'legacy';
  }

  /** The row's index ordinal, while it is in the window; undefined otherwise, and in legacy mode. */
  ordinalOf(id: MessageId): number | undefined {
    return this.current().ordinals.get(id);
  }

  /**
   * The ordinal of every row in the window, from one reading of the index;
   * null in legacy mode, where there is none. For a caller asking of many
   * rows at once, such as a compile's rendered layout, where ordinalOf
   * would read the state's revision once a row. Read it at once: a later
   * write changes it.
   */
  ordinals(): ReadonlyMap<MessageId, number> | null {
    const state = this.current();
    return state.rows.length === 0 ? null : state.ordinals;
  }

  /** Ordinals issued on this branch: the one the next item takes. 0 in legacy mode. */
  length(): number {
    return this.current().rows.length;
  }

  /**
   * The sequence of the record that presented the row, while it is in the
   * window and its item says: the point a branch cut has to reach for the
   * branch's window to hold the row.
   */
  presentedAt(id: MessageId): number | undefined {
    const state = this.current();
    const ordinal = state.ordinals.get(id);
    return ordinal === undefined ? undefined : state.at[ordinal];
  }

  /** The rows in the window, in order. */
  private presentedIds(state: IndexState): MessageId[] {
    if (!state.presented) {
      state.presented = [];
      for (const id of state.rows) if (id !== null) state.presented.push(id);
    }
    return state.presented;
  }

  /**
   * The window over `source`, the record as the manager's merged view lists
   * it: in legacy mode `source` itself; in presented mode the rows the index
   * holds, in its order, as the store's own message objects, leaving out a
   * row the record no longer has. The same array comes back while neither
   * the index nor the window's rows changed, `source` itself when the window
   * is the whole record in record order, and otherwise a new array, never
   * one changed in place: the strategies' per-listing memos rely on all
   * three (message-view.ts).
   */
  listing(source: StoredMessage[]): StoredMessage[] {
    const state = this.current();
    if (state.rows.length === 0) return source;
    const built = this.built;
    if (built && built.source === source && built.version === state.version) return built.listing;
    const messages = messagesIn(source);
    const window: StoredMessage[] = [];
    for (const id of this.presentedIds(state)) {
      const message = messages.get(id);
      if (message) window.push(message);
    }
    // A write the window doesn't take, or another index's, leaves the
    // window as it was: its array stays the same one.
    const listing = sameElements(window, source)
      ? source
      : built && sameElements(window, built.listing) ? built.listing : window;
    this.built = { source, version: state.version, listing };
    return listing;
  }

  /**
   * The ordinal of the first row in the window, in window order, stored at
   * `sequence` or after, as `source` (the record) holds it: where a window
   * that starts at that sequence starts once rows are presented. The next
   * ordinal (`length()`) when no row in the window is. Undefined in legacy
   * mode, where there is no ordinal.
   *
   * While the window is in record order, as it is when the index is first
   * written down, the rows at that ordinal and after are the rows stored at
   * `sequence` and after. Once rows are presented out of record order they
   * aren't: a row stored before `sequence` but presented after that first
   * row is after it in the window too.
   */
  ordinalFrom(sequence: number, source: StoredMessage[]): number | undefined {
    const state = this.current();
    if (state.rows.length === 0) return undefined;
    for (const message of this.listing(source)) {
      if (message.sequence >= sequence) return state.ordinals.get(message.id);
    }
    return state.rows.length;
  }

  /**
   * The sequence of the first row in the window at `ordinal` or after, as
   * `source` (the record) holds it; undefined when no row is, and in legacy
   * mode.
   */
  sequenceFrom(ordinal: number, source: StoredMessage[]): number | undefined {
    const state = this.current();
    const messages = messagesIn(source);
    for (let i = Math.max(0, ordinal); i < state.rows.length; i++) {
      const id = state.rows[i];
      const message = id == null ? undefined : messages.get(id);
      if (message) return message.sequence;
    }
    return undefined;
  }

  /** The record's rows not in the window, in record order, leaving out an undone turn's rows. Empty in legacy mode. */
  unpresented(source: readonly StoredMessage[]): StoredMessage[] {
    const state = this.current();
    if (state.rows.length === 0) return [];
    return source.filter((m) => !state.ordinals.has(m.id) && !state.undone.has(m.id));
  }

  /**
   * Present `ids`, rows of `record` (the merged listing, in record order),
   * in the order given, after checking every one before writing any. In
   * legacy mode the window is the whole record already: the call writes it
   * down as the index (the header, then every row of `record` in record
   * order), and the rows it names are among them. Returns each named row's
   * ordinal, and `entered`, the rows that entered the window, in window
   * order, every shard of a body: none when the call wrote the window down
   * in legacy mode, since each of its rows was in the window already.
   */
  present(
    ids: readonly MessageId[],
    record: readonly StoredMessage[],
    positionOf: (id: MessageId) => number | undefined,
  ): { ordinals: number[]; entered: MessageId[] } {
    const state = this.current();
    const rows = wholeBodies('presentRows', ids, record, positionOf, (id) => {
      throw new Error(`ContextManager.presentRows: no stored message has id ${id}; give each row by the id addMessage returned for it`);
    });
    if (state.rows.length === 0) {
      this.write(this.bootstrap(record));
      const ordinals = this.current().ordinals;
      return { ordinals: ids.map((id) => ordinals.get(id)!), entered: [] };
    }
    const already = rows.filter((id) => state.ordinals.has(id));
    if (already.length > 0) {
      throw new Error(`ContextManager.presentRows: ${already.join(', ')} ${already.length === 1 ? 'is' : 'are'} in the window already; a row is presented once`);
    }
    this.write(rows.map((id) => ({ id })));
    const ordinals = this.current().ordinals;
    return { ordinals: ids.map((id) => ordinals.get(id)!), entered: rows };
  }

  /**
   * Take `ids` out of the window, leaving their ordinals as holes, after
   * checking every one before writing any. A row the record no longer has
   * can still be taken out by its id. In legacy mode the window is first
   * written down as `present` writes it.
   */
  retract(
    ids: readonly MessageId[],
    record: readonly StoredMessage[],
    positionOf: (id: MessageId) => number | undefined,
    undone: boolean,
  ): void {
    const state = this.current();
    const legacy = state.rows.length === 0;
    const rows = wholeBodies('retractRows', ids, record, positionOf, (id) => {
      if (!state.ordinals.has(id)) {
        throw new Error(`ContextManager.retractRows: no stored message has id ${id}, and the window holds none`);
      }
    });
    // In legacy mode every row of the record is in the window. Otherwise a
    // row named must be; a shard that came with its first shard's id and
    // isn't (a body a failed write left part-presented) has nothing to take.
    const inWindow = (id: MessageId) => legacy || state.ordinals.has(id);
    const named = new Set(ids);
    const absent = rows.filter((id) => named.has(id) && !inWindow(id));
    if (absent.length > 0) {
      throw new Error(`ContextManager.retractRows: ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not in the window`);
    }
    const tombstones = rows
      .filter(inWindow)
      .map((id): IndexItem => (undone ? { retract: id, undone: true } : { retract: id }));
    this.write(legacy ? [...this.bootstrap(record), ...tombstones] : tombstones);
  }

  private bootstrap(record: readonly StoredMessage[]): IndexItem[] {
    return [{ v: INDEX_FORMAT }, ...record.map((m) => ({ id: m.id }))];
  }

  /**
   * Append items, one record each. A store that can append several items in
   * one record would make a presentation one write; until then a failure
   * partway leaves the items before it written, and the index is read again
   * from the store.
   */
  private write(items: IndexItem[]): void {
    if (items.length === 0) return;
    if (!this.registered) {
      registerStateIfAbsent(this.store, registrationFor(this.namespace));
      this.registered = true;
    }
    const state = this.current();
    try {
      for (const item of items) {
        const record = this.store.appendToStateJsonWithIdentity(this.stateId, item, 'by', 'at');
        apply(state, item, state.rows.length, record.sequence);
      }
    } catch (error) {
      this.state = null;
      throw error;
    }
    state.revision = this.revision();
    state.version = ++versions;
    state.presented = null;
  }
}

/**
 * The rows `ids` name, each body whole. A body stored as shards is named by
 * its first shard's id, the one addMessage returned, which stands for every
 * shard in order; its other shards may follow it in the call, in order, and
 * then name the same body. A later shard named any other way is refused as
 * part of a body, and a row named twice as named twice. `unknown` decides
 * an id `record` doesn't hold: it throws, or lets the id through as it is.
 */
function wholeBodies(
  operation: string,
  ids: readonly MessageId[],
  record: readonly StoredMessage[],
  positionOf: (id: MessageId) => number | undefined,
  unknown: (id: MessageId) => void,
): MessageId[] {
  if (!Array.isArray(ids)) throw new TypeError(`ContextManager.${operation}: \`ids\` must be an array of message ids, got ${typeof ids}`);
  ids.forEach((id: unknown, i) => {
    if (typeof id !== 'string') throw new TypeError(`ContextManager.${operation}: id ${i} must be a message id, got ${JSON.stringify(id) ?? typeof id}`);
  });
  const rows: MessageId[] = [];
  for (let i = 0; i < ids.length; ) {
    const id = ids[i]!;
    const at = positionOf(id);
    if (at === undefined) {
      unknown(id);
      rows.push(id);
      i++;
      continue;
    }
    const { from, to } = bodyBoundsIn(record, at);
    if (at !== from) {
      throw new Error(
        `ContextManager.${operation}: ${id} is shard ${record[at]!.shardIndex ?? '?'} of a body stored as shards; ` +
          `a body goes whole, named by its first shard's id (${record[from]!.id})`,
      );
    }
    for (let k = from; k <= to; k++) rows.push(record[k]!.id);
    i++;
    for (let k = from + 1; k <= to && i < ids.length && ids[i] === record[k]!.id; k++) i++;
  }
  const seen = new Set<MessageId>();
  for (const id of rows) {
    if (seen.has(id)) throw new Error(`ContextManager.${operation}: ${id} is named twice (a body's shards come with its first shard)`);
    seen.add(id);
  }
  return rows;
}

/**
 * The manager's window as a view, before its view filter: in legacy mode
 * the merged record itself, read live; in presented mode the rows the index
 * holds, in its order. Every read asks the index which mode it is in, so a
 * view a strategy holds across a long drain follows the window as the
 * store's own views follow the record.
 *
 * In both modes `positionOf` answers a row's position in `getAll()` without
 * reading the message: by its sequence in legacy mode, where the listing is
 * in record order, and from the listing's own positions otherwise.
 * `length()` is the window's row count, and `getFrom`/`getTail` index the
 * window. Token estimates and calibration are the merged view's.
 */
export function presentedMessageView(merged: MessageStoreView, index: WindowIndex): MessageStoreView {
  const all = () => index.listing(merged.getAll());
  const presented = () => index.mode() === 'presented';
  const find = (id: MessageId): StoredMessage | null => {
    const listing = all();
    const at = positionsIn(listing).get(id);
    return at === undefined ? null : listing[at]!;
  };
  return {
    getAll: all,
    get: (id) => (presented() ? find(id) : merged.get(id)),
    sequenceOf: (id) => {
      if (presented()) return find(id)?.sequence;
      return merged.sequenceOf ? merged.sequenceOf(id) : merged.get(id)?.sequence;
    },
    positionOf: (id) => {
      if (presented()) return positionsIn(all()).get(id);
      return recordPositionOf(merged, merged.getAll(), id);
    },
    getFrom: (index_) => (presented() ? all().slice(index_) : merged.getFrom(index_)),
    getTail: (count) => {
      if (!presented()) return merged.getTail(count);
      const messages = all();
      return count >= messages.length ? messages : messages.slice(messages.length - count);
    },
    length: () => (presented() ? all().length : merged.length()),
    estimateTokens: (msg) => merged.estimateTokens(msg),
    setTokenCalibration: merged.setTokenCalibration
      ? (f: number) => merged.setTokenCalibration!(f)
      : undefined,
    getTokenCalibration: merged.getTokenCalibration
      ? () => merged.getTokenCalibration!()
      : undefined,
  };
}
