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
 * append-log state, `<namespace>/window`, so it is per branch, survives
 * a restart, and a branch made from another starts from the parent's index
 * as of the branch point: `fork`, `branchAt` and `derive` carry it, the last
 * by listing it among the states the manager owns. Rows are stored before
 * they are presented, so the index as of any sequence names only rows the
 * record held by then. Chronicle carries a state's chain, not its
 * registration, so a branch made before the first presentation has no
 * index, and is in legacy mode, as its parent was then. Its items are:
 *
 * - a header, `{ v: 1 }`, naming the format: the last item of the write-down
 *   (below), so an index holds one only once the window was written down
 *   whole;
 * - a presentation, `{ id }`: the stored row with that id (a record id, as a
 *   string) entered the window;
 * - a tombstone, `{ retract, undone? }`: the row left the window, taken out
 *   by a host or removed from the record. With `undone`, it was a row of an
 *   undone turn, which stays out until it is presented again (a redo).
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
 * always was, so every compile sends byte for byte the messages it sent
 * before this module existed. (Its provenance differs: the rendered layout
 * says what its members count, RenderedLayout.keyedBy.) A host's first
 * presentation writes the index down as the window stands then (every row
 * of the record, in record order, then the header) and the manager is in
 * presented mode on that branch from then on.
 *
 * Each write to the index is one record, at one sequence: the write-down,
 * the rows one presentRows call presents, and the tombstones of one call,
 * appended in one by chronicle's appendManyToStateJsonWithIdentity (the
 * identity-stamped batched append, chronicle 0.6.0 on, which this package's
 * range requires: on a store handle without it, a write of several items
 * throws, writing nothing). The store keeps or loses such a record whole:
 * a write the store refuses writes nothing, and after any throw the index
 * is read again from the store, so its reading is what the store holds,
 * whatever the failure left.
 * A batch is one presentation point: every item of it carries the same `at`,
 * and chronicle cuts a branch only between records, so a cut at a row a
 * batch presented keeps every row of the batch, and a cut before it drops
 * them all. A write of one item is one record as it always was, so a host
 * that presents an agent's own rows one call at a time has a cut for each.
 * The first batch a store records moves its MANIFEST to format version 2,
 * which chronicle releases from before batched appends refuse to open.
 *
 * Pre-release builds of this index, before batched writes, appended each
 * item as one record; no release did. In an index they wrote, a write-down
 * can be cut short, by a failed append or by a crash that lost the records
 * the store hadn't synced, and the rows it wrote are a prefix of the window
 * without the header; a presentation or a retract can stop partway through
 * a body, and a branch or a derive can cut between a body's shards. The
 * header is what switches the mode, and the write-down writes it last, so
 * such a prefix is not in effect: the manager stays in legacy mode, its
 * window still the whole record, and the next presentRows or retractRows
 * finishes the write-down in one record, the rows it hasn't written then
 * the header, before it does its own work. A body such an index holds in
 * part is completed, or put back whole, by present. Such an index is read
 * as one written in batches is; this version writes none.
 *
 * A header naming a format other than this version's is another version's
 * index, and so is a log with items this version can't read and no header
 * to say whose they are. The manager reads the window as the record there,
 * with a warning, and refuses to present or retract, so it never writes its
 * items into a log another format keeps.
 *
 * Not to be confused with two other senses of the word in this package:
 * kv-unified's presentation receipts (a provider submission's leaf layout)
 * and the fold journal's `Presentation` (how a round carried a compile,
 * which acceptRound takes as `presentation`). So the index's mode, its
 * newest row and its state are named by the window (`windowMode`,
 * `newestWindowSequence`, `<namespace>/window`), and the verb names only
 * rows entering it (presentRows, getPresentedMessages, onPresented).
 */

import type { JsStore } from '@animalabs/chronicle';
import { bodyBoundsIn, continuesBody } from './body-runs.js';
import type { Diagnostics } from './diagnostics.js';
import { registerStateIfAbsent } from './state-registration.js';
import type { MessageId, MessageStoreView, StoredMessage } from './types/index.js';

/** Whether a manager's window is the record (`legacy`) or its index (`presented`), on the branch its store is on. */
export type WindowMode = 'legacy' | 'presented';

/**
 * Where a row stands with a manager's window (ContextManager.windowStatusOf):
 * in it (`in`), stored and not in it (`out`), an undone turn's row, out of
 * it until it is presented again (`undone`), or held by no slot the manager
 * merges (`absent`).
 */
export type WindowStatus = 'in' | 'out' | 'undone' | 'absent';

/** A row that left the window: its id, and the ordinal it held there. */
export interface LeftRow {
  id: MessageId;
  ordinal: number;
}

/**
 * The format the header names. An index whose header names another is
 * another version's, which this one reads as the record and never writes to.
 */
const INDEX_FORMAT = 1;

/** The state that holds a namespace's window index. */
export function windowIndexStateId(namespace: string): string {
  return `${namespace}/window`;
}

/**
 * One item per row presented, so the index grows as the message slot does,
 * and the slot's cadence fits it for the same reason (MessageStore.register):
 * a full snapshot of an append log copies its whole history, so it is kept
 * rare. The cadence counts records, and a batch is one (write), so where the
 * store batches, snapshots come rarer still.
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
  /**
   * The ordinal of this format's header, the write-down's last item, once
   * read; null while the index holds none, and is not in effect (legacy
   * mode, see inEffect). The rows at ordinals below it are the ones the
   * write-down presented.
   */
  header: number | null;
  /** A header's format that isn't this version's, the first one read; null when there is none. */
  otherFormat: number | null;
  /** How many items this version can't read. */
  unreadable: number;
}

/** Bumped for every new reading or change of any index, so versions never repeat. */
let versions = 0;

function emptyState(branchId: unknown, revision: number | null): IndexState {
  return {
    branchId,
    revision,
    rows: [],
    at: [],
    ordinals: new Map(),
    undone: new Set(),
    version: ++versions,
    presented: null,
    header: null,
    otherFormat: null,
    unreadable: 0,
  };
}

/**
 * Why this version must not write to the index, or null: a header naming
 * another format, or, with no header, items it can't read, which some other
 * format's write-down left. The window reads as the record there.
 */
function foreignness(state: IndexState): string | null {
  if (state.otherFormat !== null) return `is in format ${state.otherFormat}, which this version (format ${INDEX_FORMAT}) doesn't read`;
  if (state.header === null && state.unreadable > 0) {
    return `holds ${state.unreadable} item(s) this version can't read and no header naming their format`;
  }
  return null;
}

/**
 * Whether the index is the window: it holds this format's header, which
 * the write-down writes last, and nothing of another format's. Otherwise the
 * manager is in legacy mode, whatever rows a write-down cut short left (in
 * an index written one record per item: see the module comment).
 */
function inEffect(state: IndexState): boolean {
  return state.header !== null && foreignness(state) === null;
}

/**
 * Applies one item at `ordinal`, the next one; false for an item this
 * version can't read, which leaves a hole. A header leaves a hole too.
 */
function apply(state: IndexState, item: unknown, ordinal: number, at: number | undefined): boolean {
  state.at[ordinal] = at;
  state.rows[ordinal] = null;
  if (typeof item !== 'object' || item === null) {
    state.unreadable++;
    return false;
  }
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
  if (typeof fields.v === 'number') {
    if (fields.v !== INDEX_FORMAT) state.otherFormat ??= fields.v;
    else state.header ??= ordinal;
    return true;
  }
  state.unreadable++;
  return false;
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
 * The position of the first message in a listing in record order stored
 * after `sequence`, or the listing's length when none is.
 */
function firstStoredAfter(listing: readonly StoredMessage[], sequence: number): number {
  let lo = 0;
  let hi = listing.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (listing[mid]!.sequence > sequence) hi = mid;
    else lo = mid + 1;
  }
  return lo;
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
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as { at?: unknown } | null;
      const at = typeof item?.at === 'number' ? item.at : undefined;
      apply(state, item, i, at);
    }
    const foreign = foreignness(state);
    if (foreign !== null) {
      this.diag.warn(
        `[context-manager] the window index of branch ${this.store.currentBranch().name} ${foreign}; ` +
          `the window there is the record (legacy mode), and presentRows and retractRows refuse to write to it`,
      );
    } else if (state.unreadable > 0) {
      this.diag.warn(
        `[context-manager] the window index of branch ${this.store.currentBranch().name} holds ${state.unreadable} ` +
          `item(s) this version can't read; each is left out of the window as a hole`,
      );
    }
    return state;
  }

  /** `presented` once the index holds this format's header, which the write-down writes last; `legacy` before. */
  mode(): WindowMode {
    return inEffect(this.current()) ? 'presented' : 'legacy';
  }

  /**
   * The row's index ordinal, while the index holds it; undefined otherwise,
   * and in legacy mode. A row removed from the record through another
   * manager keeps its ordinal here until a retract takes it out (see
   * ContextManager.ordinalOf).
   */
  ordinalOf(id: MessageId): number | undefined {
    const state = this.current();
    return inEffect(state) ? state.ordinals.get(id) : undefined;
  }

  /**
   * Whether the row is an undone turn's: a tombstone with `undone` took it
   * out of the window, and no presentation has put it back since. False in
   * legacy mode. The id needn't be a row the record still holds.
   */
  isUndone(id: MessageId): boolean {
    const state = this.current();
    return inEffect(state) && state.undone.has(id);
  }

  /**
   * The ordinal of every row in the window, from one reading of the index;
   * null in legacy mode, where there is none. For a caller asking of many
   * rows at once, such as a compile's rendered layout, where ordinalOf
   * would read the state's revision once a row. Read it at once: a later
   * write changes it. Like ordinalOf, it can hold the id of a row the
   * record no longer has, which listing leaves out.
   */
  ordinals(): ReadonlyMap<MessageId, number> | null {
    const state = this.current();
    return inEffect(state) ? state.ordinals : null;
  }

  /** Ordinals issued on this branch: the one the next item takes. 0 in legacy mode. */
  length(): number {
    const state = this.current();
    return inEffect(state) ? state.rows.length : 0;
  }

  /**
   * The sequence of the record that presented the row, while it is in the
   * window and its item says: the point a branch cut has to reach for the
   * branch's window to hold the row.
   */
  presentedAt(id: MessageId): number | undefined {
    const state = this.current();
    if (!inEffect(state)) return undefined;
    const ordinal = state.ordinals.get(id);
    return ordinal === undefined ? undefined : state.at[ordinal];
  }

  /**
   * Whether the row is in the window at the ordinal the write-down gave it,
   * one below the header's, which the write-down writes last. Such a row
   * was in the window from its own write, as every row is in legacy mode,
   * and the rows before it there were the rows stored before it, since the
   * write-down follows record order. A row taken out since and presented
   * again holds a later ordinal and is not one. False in legacy mode.
   */
  presentedByWriteDown(id: MessageId): boolean {
    const state = this.current();
    if (!inEffect(state)) return false;
    const ordinal = state.ordinals.get(id);
    return ordinal !== undefined && ordinal < state.header!;
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
    if (!inEffect(state)) return source;
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
    if (!inEffect(state)) return undefined;
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
    if (!inEffect(state)) return undefined;
    const messages = messagesIn(source);
    for (let i = Math.max(0, ordinal); i < state.rows.length; i++) {
      const id = state.rows[i];
      const message = id == null ? undefined : messages.get(id);
      if (message) return message.sequence;
    }
    return undefined;
  }

  /**
   * The record's rows not in the window, in record order, leaving out an
   * undone turn's rows. Empty in legacy mode.
   *
   * A body partly in the window (in an index written one record per item,
   * a presentation cut short, or a branch cut between its shards'
   * presentations, left its first shards in: see the module comment) lists
   * the shards it lacks, undone or not: the window holds part of it, so the
   * rest is due, and present takes the first of them as naming the rest.
   * A host that presents these rows by id completes the body.
   *
   * With `afterSequence`, only the rows stored after it: the same rows the
   * whole listing gives with a sequence greater than it, found from the
   * first such row of `source` (which is in record order) by a binary
   * search, so the walk is over those rows alone. A cut inside a body reads
   * the body's shards before it to say whether the body is partly in the
   * window.
   */
  unpresented(source: readonly StoredMessage[], afterSequence?: number): StoredMessage[] {
    const state = this.current();
    if (!inEffect(state)) return [];
    const from = afterSequence === undefined ? 0 : firstStoredAfter(source, afterSequence);
    const rows: StoredMessage[] = [];
    // Whether the body the row before belongs to has a shard in the window.
    let bodyInWindow = false;
    if (from > 0 && from < source.length && continuesBody(source[from - 1], source[from])) {
      const { from: start } = bodyBoundsIn(source, from);
      for (let k = start; k < from && !bodyInWindow; k++) bodyInWindow = state.ordinals.has(source[k]!.id);
    }
    for (let i = from; i < source.length; i++) {
      const message = source[i]!;
      if (i > from && !continuesBody(source[i - 1], message)) bodyInWindow = false;
      if (state.ordinals.has(message.id)) bodyInWindow = true;
      else if (bodyInWindow || !state.undone.has(message.id)) rows.push(message);
    }
    return rows;
  }

  /**
   * Present `ids`, rows of `record` (the merged listing, in record order),
   * in the order given, after checking every one before writing any. In
   * legacy mode the window is the whole record already: the call writes it
   * down as the index (writeDown: every row of `record` in record order,
   * then the header), or finishes a write-down an earlier call left cut
   * short, and the rows it names are among them. Returns each named row's
   * ordinal, and `entered`, the rows that entered the window, in window
   * order, every shard of a body: none when the call wrote the window down
   * in legacy mode, since each of its rows was in the window already.
   *
   * A body enters whole, in the call's one record (write). In an index
   * written one record per item (see the module comment), a presentation
   * cut short can have left a body's first shards in the window and the
   * rest out, and so can a branch cut between its shards' presentations
   * there. Naming such a body, by its first shard's id or by the first
   * shard the window lacks (the one unpresented lists first), presents
   * only the shards it lacks, in body order, at the end of the window: the
   * shards in it keep their ordinals, and `entered` holds only the new
   * ones. A row presented
   * between the two calls stays between them in the window, so the body is
   * then sent as two runs. A name whose rows are all in the window already
   * is refused.
   *
   * A body the window holds the other way round, its first shard out and a
   * later one in (a retract cut short after the first shard's tombstone, in
   * such an index, or a branch cut between its shards' tombstones there),
   * can't be completed where it stands: its head would follow its own later
   * shards. Naming it by its first shard's id takes the shards in the window
   * out and presents the body whole at the end, in body order, in the same
   * write: those shards take new ordinals, `left` gives them with the
   * ordinals they held, and `entered` holds every shard of the body.
   *
   * `cutShort`, when given, hears the rows that entered before a write that
   * threw, and the rows that left, in window order, as the store holds them
   * when it is read again, before the error is thrown on: each that entered
   * is in the window, each that left is out of it, and no later call
   * presents or takes it out again. A write the store refuses whole leaves
   * none, so it hears nothing.
   */
  present(
    ids: readonly MessageId[],
    record: readonly StoredMessage[],
    positionOf: (id: MessageId) => number | undefined,
    cutShort?: (entered: MessageId[], left: LeftRow[]) => void,
  ): { ordinals: number[]; entered: MessageId[]; left: LeftRow[] } {
    const state = this.current();
    const legacy = !inEffect(state);
    // A cut-short write-down's rows aren't a window: in legacy mode the
    // window is the whole record, which holds no body in part.
    const named = namedBodies(
      'presentRows',
      ids,
      record,
      positionOf,
      (id) => {
        throw new Error(`ContextManager.presentRows: no stored message has id ${id}; give each row by the id addMessage returned for it`);
      },
      legacy ? undefined : (id) => state.ordinals.has(id),
    );
    if (legacy) {
      this.write(this.writeDown('presentRows', state, record));
      const ordinals = this.current().ordinals;
      return { ordinals: ids.map((id) => ordinals.get(id)!), entered: [], left: [] };
    }
    const already = named.filter((name) => name.rows.every((id) => state.ordinals.has(id))).map((name) => name.id);
    if (already.length > 0) {
      throw new Error(`ContextManager.presentRows: ${already.join(', ')} ${already.length === 1 ? 'is' : 'are'} in the window already; a row is presented once`);
    }
    // A body whose first named shard the window lacks while a later one is
    // in it: the shards in the window leave, and the body enters whole.
    const moving: LeftRow[] = [];
    for (const name of named) {
      if (state.ordinals.has(name.rows[0]!)) continue;
      for (const id of name.rows.slice(1)) {
        const ordinal = state.ordinals.get(id);
        if (ordinal !== undefined) moving.push({ id, ordinal });
      }
    }
    const moves = new Set(moving.map((row) => row.id));
    const rows = named.flatMap((name) => name.rows.filter((id) => moves.has(id) || !state.ordinals.has(id)));
    const items: IndexItem[] = [...moving.map((row): IndexItem => ({ retract: row.id })), ...rows.map((id): IndexItem => ({ id }))];
    try {
      this.write(items);
    } catch (error) {
      if (cutShort) {
        let entered: MessageId[] = [];
        let left: LeftRow[] = [];
        try {
          const now = this.current().ordinals;
          left = moving.filter((row) => now.get(row.id) !== row.ordinal);
          const before = new Map(moving.map((row) => [row.id, row.ordinal] as const));
          entered = rows.filter((id) => now.has(id) && now.get(id) !== before.get(id));
        } catch {
          // The index can't be read: the error thrown on says why, and the
          // next read finds what entered and what left.
        }
        if (entered.length > 0 || left.length > 0) cutShort(entered, inWindowOrder(left));
      }
      throw error;
    }
    const ordinals = this.current().ordinals;
    return { ordinals: ids.map((id) => ordinals.get(id)!), entered: rows, left: inWindowOrder(moving) };
  }

  /**
   * Take `ids` out of the window, leaving their ordinals as holes, after
   * checking every one before writing any. A row the record no longer has
   * can still be taken out by its id. An empty `ids` takes nothing out and
   * writes nothing, in either mode. In legacy mode, where the window is the
   * record, the window is first written down as `present` writes it, and
   * the manager is in presented mode from then on: the rows taken out are
   * holes in the index that write-down began.
   *
   * Returns the rows taken out, with the ordinals they held, in window
   * order. The tombstones are one record (write), and the write-down
   * another before them. `cutShort`, when given, hears the rows the store
   * holds as taken out after a write that threw, in window order, before
   * the error is thrown on: none, when the store refused the write whole. A
   * write-down that throws has taken nothing out.
   */
  retract(
    ids: readonly MessageId[],
    record: readonly StoredMessage[],
    positionOf: (id: MessageId) => number | undefined,
    undone: boolean,
    cutShort?: (left: LeftRow[]) => void,
  ): LeftRow[] {
    const state = this.current();
    const legacy = !inEffect(state);
    const rows = namedBodies('retractRows', ids, record, positionOf, (id) => {
      // In legacy mode the window is the record, so a row it doesn't hold
      // isn't in the window either, whatever a write-down cut short wrote.
      if (legacy || !state.ordinals.has(id)) {
        throw new Error(`ContextManager.retractRows: no stored message has id ${id}, and the window holds none`);
      }
    }).flatMap((name) => name.rows);
    if (rows.length === 0) return [];
    // In legacy mode every row of the record is in the window. Otherwise a
    // row named must be; a shard that came with its first shard's id and
    // isn't (a body a presentation cut short, or a branch cut between its
    // shards, left partly in the window) has nothing to take.
    const inWindow = (id: MessageId) => legacy || state.ordinals.has(id);
    const named = new Set(ids);
    const absent = rows.filter((id) => named.has(id) && !inWindow(id));
    if (absent.length > 0) {
      throw new Error(`ContextManager.retractRows: ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not in the window`);
    }
    const leaving = rows.filter(inWindow);
    // Written down first in legacy mode, so each row has the ordinal the
    // write-down gave it before its tombstone takes it out.
    if (legacy) this.write(this.writeDown('retractRows', state, record));
    const held = this.current().ordinals;
    const left = leaving.map((id): LeftRow => ({ id, ordinal: held.get(id)! }));
    const tombstones = leaving.map((id): IndexItem => (undone ? { retract: id, undone: true } : { retract: id }));
    this.writeLeaving(tombstones, left, cutShort);
    return inWindowOrder(left);
  }

  /**
   * Take rows the record no longer holds out of the window: a tombstone for
   * each of `ids` the window holds, as retract writes one, so no other
   * row's ordinal moves. An id the window doesn't hold is passed over. In
   * legacy mode it writes nothing: the window is the record, and a row
   * removed from the record has left it already. Returns the rows taken
   * out, with the ordinals they held, in window order; `cutShort` is as
   * retract's.
   */
  retractRemoved(ids: readonly MessageId[], cutShort?: (left: LeftRow[]) => void): LeftRow[] {
    const state = this.current();
    if (!inEffect(state)) return [];
    const left: LeftRow[] = [];
    for (const id of new Set(ids)) {
      const ordinal = state.ordinals.get(id);
      if (ordinal !== undefined) left.push({ id, ordinal });
    }
    this.writeLeaving(left.map((row): IndexItem => ({ retract: row.id })), left, cutShort);
    return inWindowOrder(left);
  }

  /**
   * Take out of the window every row `record` (the merged listing) doesn't
   * hold: a tombstone for each, as retractRemoved writes one, so no other
   * row's ordinal moves. Such a row was removed through a manager that
   * doesn't keep this index, and this one never heard it go, or its own
   * removal's tombstone failed (see ContextManager.ordinalOf). A row of a
   * slot `record` no longer merges reads the same. In legacy mode, which
   * includes a write-down cut short, it writes nothing, as retractRemoved.
   * Returns the rows taken out, with the ordinals they held, in window
   * order; `cutShort` is as retract's.
   */
  retractAbsent(record: readonly StoredMessage[], cutShort?: (left: LeftRow[]) => void): LeftRow[] {
    const state = this.current();
    if (!inEffect(state)) return [];
    const held = positionsIn(record);
    const left: LeftRow[] = [];
    for (const [id, ordinal] of state.ordinals) if (!held.has(id)) left.push({ id, ordinal });
    this.writeLeaving(left.map((row): IndexItem => ({ retract: row.id })), left, cutShort);
    return inWindowOrder(left);
  }

  /**
   * Write `tombstones`, which take `left` out of the window. A write that
   * throws partway tells `cutShort` the rows of `left` out of the window by
   * then, in window order, and the error is thrown on.
   */
  private writeLeaving(tombstones: IndexItem[], left: readonly LeftRow[], cutShort?: (left: LeftRow[]) => void): void {
    try {
      this.write(tombstones);
    } catch (error) {
      if (cutShort) {
        let out: LeftRow[] = [];
        try {
          const now = this.current().ordinals;
          out = left.filter((row) => now.get(row.id) !== row.ordinal);
        } catch {
          // The index can't be read: the error thrown on says why, and the
          // next read finds what left.
        }
        if (out.length > 0) cutShort(inWindowOrder(out));
      }
      throw error;
    }
  }

  /**
   * Start from `parent`'s reading of the index instead of reading the state
   * again, where both handles' chains end at the record that reading was
   * of: a manager derived at the head, on a branch that took its parent's
   * chain head as it was. The reading is copied, so neither side's later
   * presentations reach the other's. Otherwise this does nothing, and the
   * index is read from the store when it is first asked for.
   */
  seedFrom(parent: WindowIndex): void {
    const state = parent.state;
    // Only a reading keyed on the state's offset can be shared: one keyed
    // on the branch (a chronicle without offsets) names the parent's branch.
    if (!state || state.branchId !== null || this.branchKey() !== null) return;
    if (state.revision !== parent.revision() || state.revision !== this.revision()) return;
    this.state = {
      branchId: null,
      revision: state.revision,
      rows: [...state.rows],
      at: [...state.at],
      ordinals: new Map(state.ordinals),
      undone: new Set(state.undone),
      version: ++versions,
      // Never changed in place (a write sets it to null), so both can read it.
      presented: state.presented,
      header: state.header,
      otherFormat: state.otherFormat,
      unreadable: state.unreadable,
    };
  }

  /**
   * The items that write the window down, in legacy mode, where the window
   * is the whole record: every row of `record` in record order, then the
   * header, which puts the index in effect. The header goes last so that a
   * write-down cut short, in an index written one record per item (see the
   * module comment), leaves the manager in legacy mode. The next one
   * finishes it from where it stopped. A row it wrote that has since
   * left the record (a removal writes nothing in legacy mode) is taken out,
   * and the rows it didn't write follow the ones it did: those were a
   * prefix of the record and still are, since later rows are stored after
   * them. Throws for an index this version must not write to (foreignness).
   */
  private writeDown(operation: string, state: IndexState, record: readonly StoredMessage[]): IndexItem[] {
    const foreign = foreignness(state);
    if (foreign !== null) {
      throw new Error(
        `ContextManager.${operation}: the window index of branch ${this.store.currentBranch().name} ${foreign}, ` +
          `so this version writes nothing to it; the window there is the record`,
      );
    }
    const held = messagesIn(record);
    const items: IndexItem[] = [];
    for (const id of state.ordinals.keys()) if (!held.has(id)) items.push({ retract: id });
    for (const message of record) if (!state.ordinals.has(message.id)) items.push({ id: message.id });
    items.push({ v: INDEX_FORMAT });
    return items;
  }

  /**
   * Append items, each stamped with the sequence and id of the record that
   * holds it (`at`, `by`). Several items go in as one record, at one
   * sequence (appendManyToStateJsonWithIdentity): the store keeps or loses
   * the write whole, and one it refuses has written nothing. That is a
   * presentation point (see the module comment). One item is one record,
   * through the single form, as it always was: a store all of whose writes
   * are single keeps its MANIFEST at version 1, as one presenting a row at a
   * time to an empty record does.
   *
   * A write of several items on a store handle without the batched append
   * (a chronicle before 0.6.0, which this package's range doesn't admit)
   * throws before it writes anything, the state's registration included
   * (requireBatchedIdentityAppend). After any throw from the store, the
   * index is read again from it, which says what was written.
   */
  private write(items: IndexItem[]): void {
    if (items.length === 0) return;
    if (items.length > 1) requireBatchedIdentityAppend(this.store);
    if (!this.registered) {
      registerStateIfAbsent(this.store, registrationFor(this.namespace));
      this.registered = true;
    }
    const state = this.current();
    try {
      if (items.length > 1) {
        const { record, firstOrdinal } = this.store.appendManyToStateJsonWithIdentity(this.stateId, items, 'by', 'at');
        // The batch went on at the end of the state as this reading had it,
        // unless another handle wrote to it since: then the reading is
        // stale, and the next read takes the store's.
        if (firstOrdinal !== state.rows.length) {
          this.state = null;
          return;
        }
        items.forEach((item, i) => apply(state, item, firstOrdinal + i, record.sequence));
      } else {
        const record = this.store.appendToStateJsonWithIdentity(this.stateId, items[0]!, 'by', 'at');
        apply(state, items[0]!, state.rows.length, record.sequence);
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
 * Refuses a store handle without chronicle's appendManyToStateJsonWithIdentity,
 * the identity-stamped batched append (chronicle 0.6.0 on), with which the
 * index writes several items as one record. Such a handle comes from a
 * chronicle older than this package's range admits, or a copy of one a host
 * installed beside it. The index has no one-record-per-item path, which
 * would let a write stop partway: a write of several items there throws,
 * writing nothing. Asked at each such write, as stateHeadOffset is at each
 * read.
 */
function requireBatchedIdentityAppend(store: JsStore): void {
  if (typeof (store as { appendManyToStateJsonWithIdentity?: unknown }).appendManyToStateJsonWithIdentity === 'function') return;
  throw new Error(
    'ContextManager: the store handle has no appendManyToStateJsonWithIdentity, the identity-stamped batched append of ' +
      '@animalabs/chronicle 0.6.0, with which the window index writes several rows as one record; ' +
      'install @animalabs/chronicle ^0.6.0, which context-manager declares, and open the store with it',
  );
}

/** Rows that left the window, in the order the window held them. */
function inWindowOrder(left: readonly LeftRow[]): LeftRow[] {
  return [...left].sort((a, b) => a.ordinal - b.ordinal);
}

/** One name in a presentRows or retractRows call: the id given, and the rows it stands for, in record order. */
interface Named {
  id: MessageId;
  rows: MessageId[];
}

/** Refuses `ids` unless it is an array of message ids, naming the manager's operation. */
export function requireMessageIds(operation: string, ids: unknown): asserts ids is readonly MessageId[] {
  if (!Array.isArray(ids)) throw new TypeError(`ContextManager.${operation}: \`ids\` must be an array of message ids, got ${typeof ids}`);
  ids.forEach((id: unknown, i) => {
    if (typeof id !== 'string') throw new TypeError(`ContextManager.${operation}: id ${i} must be a message id, got ${JSON.stringify(id) ?? typeof id}`);
  });
}

/**
 * The rows `ids` name, name by name, each body whole. A body stored as
 * shards is named by its first shard's id, the one addMessage returned,
 * which stands for every shard in order; its other shards may follow it in
 * the call, in order, and then name the same body. With `inWindow` (present,
 * in presented mode, where a body can be partly in the window), a later
 * shard whose earlier shards are all in the window names the rest of the
 * body, itself and every shard after it, and those may follow it in the
 * same way. A later shard named any other way is refused as part of a
 * body, and a row named twice, by two names, as named twice. `unknown`
 * decides an id `record` doesn't hold: it throws, or lets the id through as
 * it is.
 */
function namedBodies(
  operation: string,
  ids: readonly MessageId[],
  record: readonly StoredMessage[],
  positionOf: (id: MessageId) => number | undefined,
  unknown: (id: MessageId) => void,
  inWindow?: (id: MessageId) => boolean,
): Named[] {
  requireMessageIds(operation, ids);
  const named: Named[] = [];
  for (let i = 0; i < ids.length; ) {
    const id = ids[i]!;
    const at = positionOf(id);
    if (at === undefined) {
      unknown(id);
      named.push({ id, rows: [id] });
      i++;
      continue;
    }
    const { from, to } = bodyBoundsIn(record, at);
    if (at !== from && !(inWindow && record.slice(from, at).every((m) => inWindow(m.id)))) {
      throw new Error(
        `ContextManager.${operation}: ${id} is shard ${record[at]!.shardIndex ?? '?'} of a body stored as shards; ` +
          `a body goes whole, named by its first shard's id (${record[from]!.id})` +
          (inWindow ? `, or the rest of one partly in the window by the first shard the window lacks` : ''),
      );
    }
    const rows: MessageId[] = [];
    for (let k = at; k <= to; k++) rows.push(record[k]!.id);
    named.push({ id, rows });
    i++;
    for (let k = at + 1; k <= to && i < ids.length && ids[i] === record[k]!.id; k++) i++;
  }
  const seen = new Set<MessageId>();
  for (const { rows } of named) {
    for (const id of rows) {
      if (seen.has(id)) throw new Error(`ContextManager.${operation}: ${id} is named twice (a body's shards come with its first shard)`);
      seen.add(id);
    }
  }
  return named;
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
