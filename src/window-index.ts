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
 * registration, so a branch made before the window was first written down
 * (a host's first presentRows, or a retractRows that names a row) has no
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
 * Until a host presents anything on a branch, or takes a row out of its
 * window by name (retractRows), the manager is in legacy mode: there is no
 * index, and the window is the record itself, live, as it always was, so
 * every compile sends byte for byte the messages it sent before this module
 * existed. (Its provenance differs: the rendered layout says what its
 * members count, RenderedLayout.keyedBy.) A host's first presentation, or
 * its first naming retraction, writes the index down as the window stands
 * then (every row of the record, in record order, then the header) and the
 * manager is in presented mode on that branch from then on. A retraction's
 * tombstones are a record of their own, after the write-down's: one the
 * store refuses after the write-down landed leaves the branch as
 * presentRows([]) leaves it, in presented mode with the rows it named
 * still in the window, so a row stored after it is out of the window
 * until presented, and a retry takes the named rows out of that window.
 *
 * Each write to the index is one record, at one sequence: the write-down,
 * the rows one presentRows call presents, and the tombstones of one call,
 * appended in one by chronicle's appendManyToStateJsonWithIdentity (the
 * identity-stamped batched append, chronicle 0.6.0 on, which this package's
 * range requires: a store handle without it is refused when the index is
 * made, at the manager's open, derive or reopenDerived, before any record
 * changes, in either mode). The store keeps or loses such a record whole:
 * a write the store refuses writes nothing, and after any throw the index
 * is read again from the store, so its reading is what the store holds,
 * whatever the failure left. Where that read throws too, whether the write
 * landed is unknown: the call throws WindowWriteOutcomeUnknownError, and
 * the next write through the index settles what the write did, once the
 * index reads.
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
 * window still the whole record, and the next presentRows, or a retractRows
 * that names a row, finishes the write-down in one record, the rows it
 * hasn't written then the header, before it does its own work (or, where a
 * slot merged since puts older rows before the ones written, takes those
 * out and writes the whole record again, in record order). A body such an
 * index holds in part is completed, or put back whole, by present. Such an
 * index is read as one written in batches is; this version writes none.
 *
 * A header naming a format other than this version's is another version's
 * index, and so is a log with items this version can't read and no header
 * to say whose they are, and a state that holds no list of items at all: a
 * value of another kind (JSON null among them), one that isn't JSON, or
 * records the store can't read back as one value. The manager reads the
 * window as the record there, with a warning that says what the state
 * holds, and refuses to present or retract, so it never writes its items
 * into a state another format keeps.
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
import { describeThrown, logThrown } from './describe-thrown.js';
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

/**
 * A row that left the window: its id, the ordinal it held there, and the
 * identity of the record whose write presented it at that ordinal (its
 * `by` stamp, where the item carries one), which a branch shares with the
 * one it was made from only for the presentations before the branch point.
 */
export interface LeftRow {
  id: MessageId;
  ordinal: number;
  by?: string;
}

/**
 * A write to the window index that the store threw on, where the index
 * then couldn't be read again to tell whether the write landed: thrown by
 * presentRows, retractRows, retractRemoved and retractAbsentRows in place
 * of the write's own error, which is its `cause`.
 *
 * The write is one record, which the store holds whole or not at all, so
 * either every row `entering` names entered the window and every row
 * `leaving` names left it, or none did. `operation` names the call,
 * `entering` the rows the write would have put in the window, in the order
 * it would have, `leaving` the rows it would have taken out, and
 * `readError` the error of the read that would have told. This error's
 * message ends with the cause's message, so a check that the message
 * contains or ends with the write's own error's message still matches;
 * one that compares the whole message, or is anchored at its start,
 * doesn't.
 *
 * windowStatusOf tells which, once the index reads; a row that entered is
 * refused by presentRows as in the window already, and a row that left by
 * retractRows as not in it. For retractRemoved and retractAbsentRows,
 * whose rows the store no longer holds, windowStatusOf reads 'absent'
 * either way: ordinalOf tells (undefined for a row taken out), and calling
 * either again takes out only what is still there. A write-down (the
 * first presentRows or retractRows on a branch in legacy mode, which
 * writes the window down before any work of its own) puts no row in the
 * window and takes none out: `entering` and `leaving` are both empty,
 * windowMode tells whether it landed, and the strategy has nothing to
 * hear of it. The strategy hears what the write did (onPresented,
 * onRetracted) at the next write to the window on the branch it was made
 * on, once the index reads there, before that call's own work:
 * presentRows (presentRows([]) among them), retractRows, retractRemoved,
 * retractAbsentRows or a removal. Of a write the store didn't keep it
 * hears nothing. A hook of that hearing that moves the store's branch
 * stops the call, which throws, writing nothing (WindowIndex.settled).
 * Where the store can't say its branch before the write or after it,
 * nothing waits to tell the strategy, a warning says so, and so does this
 * error's message: the strategy reads the window at its next select.
 */
export class WindowWriteOutcomeUnknownError extends Error {
  readonly operation: string;
  readonly entering: readonly MessageId[];
  readonly leaving: readonly MessageId[];
  readonly readError: unknown;
  override readonly cause: unknown;

  /**
   * `waiting` is false where nothing waits to tell the strategy what the
   * write did (the store can't say which branch it was made on), which the
   * message then says.
   */
  constructor(
    operation: string,
    rows: { entering: readonly MessageId[]; leaving: readonly MessageId[] },
    cause: unknown,
    readError: unknown,
    waiting = true,
  ) {
    const writeDown = rows.entering.length === 0 && rows.leaving.length === 0;
    const whether = writeDown
      ? 'the window was written down'
      : [
          ...(rows.entering.length > 0 ? [`${rowsNamed(rows.entering)} entered`] : []),
          ...(rows.leaving.length > 0 ? [`${rowsNamed(rows.leaving)} left`] : []),
        ].join(' and ') + ' the window';
    // The rows of the repairs are ones the store no longer holds, which
    // windowStatusOf reads as absent whether or not the write landed.
    const repair = operation === 'retractRemoved' || operation === 'retractAbsentRows';
    const which = repair
      ? `ordinalOf tells which once the index reads (undefined for a row taken out), and calling ${operation} again takes out only what is still there`
      : 'windowStatusOf tells which once the index reads';
    const hears = waiting
      ? 'the strategy hears what it did at the next write to the window'
      : 'nothing waits to tell the strategy what it did, so it reads the window at its next select';
    const tells = writeDown
      ? 'windowMode tells which once the index reads, and a write-down puts no row in the window or takes one out, ' +
        'so the strategy has nothing to hear of it'
      : `${which}${repair ? ';' : ', and'} ${hears}`;
    super(
      `ContextManager.${operation}: the window index's write threw, and the index can't be read again to tell ` +
        `whether the write landed (${describeThrown(readError)}), so whether ${whether} is unknown; ` +
        `the store holds the write whole or not at all, ${tells}: ${describeThrown(cause)}`,
    );
    this.name = 'WindowWriteOutcomeUnknownError';
    this.operation = operation;
    this.entering = Object.freeze([...rows.entering]);
    this.leaving = Object.freeze([...rows.leaving]);
    this.readError = readError;
    this.cause = cause;
  }
}

/** Rows as an error names them: `row <id>`, or `rows <id>, <id>`, the first ten of more. */
function rowsNamed(ids: readonly MessageId[]): string {
  if (ids.length === 1) return `row ${ids[0]}`;
  const shown = ids.slice(0, 10).join(', ');
  return ids.length > 10 ? `${ids.length} rows (${shown}, …)` : `rows ${shown}`;
}

/**
 * A write whose outcome a failed read left unknown, waiting to be settled
 * (WindowIndex.settled): the branch it was made on, and what hears what it
 * did, given the ordinals as the store holds them.
 */
interface Unsettled {
  branch: string;
  settle: (ordinals: ReadonlyMap<MessageId, number>) => void;
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
  /**
   * Per ordinal, the row a presentation put there, kept after a tombstone
   * takes it out; null for an item that presented no row. What this
   * branch's own index issued (issuedTo).
   */
  issued: Array<MessageId | null>;
  /** Per ordinal, the sequence of the record that wrote the item, where it says. */
  at: Array<number | undefined>;
  /**
   * Per ordinal, the identity of the record that wrote the item (its `by`
   * stamp), where it says. Sequences repeat across branches; a record's
   * identity doesn't, so two branches share it only for an item before
   * the branch point (issuedBy).
   */
  by: Array<string | undefined>;
  /** The ordinal of every row in the window. */
  ordinals: Map<MessageId, number>;
  /** Rows of an undone turn, out of the window until presented again. */
  undone: Set<MessageId>;
  /** Rows a tombstone took out of the window, undone or not, and no presentation has put back since. */
  left: Set<MessageId>;
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
  /**
   * What the state holds where it holds no list of items this version can
   * read, as an error names it: a value of another kind (JSON null among
   * them), one that isn't JSON, or records the store can't read back as
   * one value. Null for a list, and for a state with no record.
   */
  found: string | null;
}

/** Bumped for every new reading or change of any index, so versions never repeat. */
let versions = 0;

function emptyState(branchId: unknown, revision: number | null): IndexState {
  return {
    branchId,
    revision,
    rows: [],
    issued: [],
    at: [],
    by: [],
    ordinals: new Map(),
    undone: new Set(),
    left: new Set(),
    version: ++versions,
    presented: null,
    header: null,
    otherFormat: null,
    unreadable: 0,
    found: null,
  };
}

/**
 * Why this version must not write to the index, or null: a state that
 * holds no list of items (found), a header naming another format, or, with
 * no header, items it can't read, which some other format's write-down
 * left. The window reads as the record there.
 */
function foreignness(state: IndexState): string | null {
  if (state.found !== null) return `holds ${state.found}`;
  if (state.otherFormat !== null) return `is in format ${state.otherFormat}, which this version (format ${INDEX_FORMAT}) doesn't read`;
  if (state.header === null && state.unreadable > 0) {
    return `holds ${state.unreadable} item(s) this version can't read and no header naming their format`;
  }
  return null;
}

/**
 * What a state whose value `getStateJson` threw on holds, as foreignness
 * names it, or the error thrown on: a value that isn't JSON, where the
 * store reads the value's bytes and they don't parse, or records the store
 * can't read back as one value, where reading the bytes fails with
 * chronicle's deserialization error (`Deserialization error: …`, matched
 * by its prefix, as state-registration.ts matches a duplicate
 * registration: chronicle gives no code), as an item appended to a
 * snapshot's value leaves. Both are what the state holds, read after read.
 * Any other failure, a store that can't be read now, throws `error`, and
 * so do bytes that parse: the read failed some other way.
 */
function unreadableValue(store: JsStore, stateId: string, error: unknown): string {
  let raw: Buffer | null;
  try {
    raw = store.getState(stateId);
  } catch (rawError) {
    const message = describeThrown(rawError);
    if (message.startsWith('Deserialization error: ')) return `records the store can't read back as one value (${message})`;
    throw error;
  }
  if (raw === null) throw error;
  try {
    JSON.parse(raw.toString('utf8'));
  } catch {
    return `a value that isn't JSON (${describeThrown(error)})`;
  }
  throw error;
}

/** A JSON value's kind as foreignness names it, with the start of the value: `an object ({"a":1})`, or `null`. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value === 'object' ? 'an object' : `a ${typeof value}`;
  let shown: string;
  try {
    shown = JSON.stringify(value) ?? String(value);
  } catch {
    return kind;
  }
  return `${kind} (${shown.length > 80 ? `${shown.slice(0, 80)}…` : shown})`;
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
function apply(state: IndexState, item: unknown, ordinal: number, at: number | undefined, by: string | undefined): boolean {
  state.at[ordinal] = at;
  state.by[ordinal] = by;
  state.rows[ordinal] = null;
  state.issued[ordinal] = null;
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
      state.issued[ordinal] = fields.id;
      state.ordinals.set(fields.id, ordinal);
    }
    state.undone.delete(fields.id);
    state.left.delete(fields.id);
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
    // Only a tombstone after the header takes a row out of the window: one
    // before it is a write-down's, finished over one cut short, for a row it
    // wrote that a removal in legacy mode, where the window is the record,
    // had taken already.
    if (state.header !== null) state.left.add(fields.retract);
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

/**
 * Whether apply reads `item` as one of this format's: a presentation, a
 * tombstone or this format's header. Another format's header, and an item
 * apply can't read, aren't (readOn reads the state whole for them).
 */
function isOwnItem(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const fields = item as { id?: unknown; retract?: unknown; v?: unknown };
  return typeof fields.id === 'string' || typeof fields.retract === 'string' || fields.v === INDEX_FORMAT;
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
 * What present's `cutShort` hears of a write that threw, from the ordinals
 * the store holds once the index reads again: the rows that entered, and
 * the rows of `moving` that left. Made apart from present, as
 * leavingSettlement is apart from writeLeaving, so one that waits for a
 * later write (settled) holds what the write named and nothing else of the
 * call: not its reading of the index, nor the write's error, whose stack
 * holds the caller's frames.
 */
function presentSettlement(
  rows: readonly MessageId[],
  moving: readonly LeftRow[],
  cutShort: (entered: MessageId[], left: LeftRow[]) => void,
): (now: ReadonlyMap<MessageId, number>) => void {
  const before = new Map(moving.map((row) => [row.id, row.ordinal] as const));
  return (now) => {
    const left = moving.filter((row) => now.get(row.id) !== row.ordinal);
    const entered = rows.filter((id) => now.has(id) && now.get(id) !== before.get(id));
    if (entered.length > 0 || left.length > 0) cutShort(entered, inWindowOrder(left));
  };
}

/** What writeLeaving's `cutShort` hears of a write that threw: the rows of `left` out of the window (see presentSettlement). */
function leavingSettlement(left: readonly LeftRow[], cutShort: (left: LeftRow[]) => void): (now: ReadonlyMap<MessageId, number>) => void {
  return (now) => {
    const out = left.filter((row) => now.get(row.id) !== row.ordinal);
    if (out.length > 0) cutShort(inWindowOrder(out));
  };
}

/**
 * The window index of one manager namespace, read through one store handle
 * on whatever branch that handle is on. It reads the state again whenever
 * the state's revision there has moved since it last read it, so another
 * handle's write, a branch switch and a restart all reach it: only the
 * items appended since, where its last reading is a prefix of the state
 * (readOn), so two handles that take turns writing don't each read the
 * whole index at every turn, and the state whole otherwise.
 */
export class WindowIndex {
  readonly stateId: string;
  private readonly namespace: string;
  private state: IndexState | null = null;
  private registered = false;
  /** The last presented listing, with what it was built from. */
  private built: { source: readonly StoredMessage[]; version: number; listing: StoredMessage[] } | null = null;
  /** Writes whose outcome a failed read left unknown, in the order they were made (see settled). */
  private unsettled: Unsettled[] = [];

  constructor(private readonly store: JsStore, namespace: string, private readonly diag: Diagnostics) {
    // Asked at open as well as at each write of several items, so an
    // app-owned handle from a chronicle older than the range admits is
    // refused before any record changes — not after a removal has already
    // left its rows' ordinals issued with only a log line to say so.
    requireBatchedIdentityAppend(store);
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

  /**
   * The index as it stands on the handle's branch. Where the revision has
   * moved since the last reading, the items appended since are applied to
   * that reading (readOn), so another handle's write costs what it wrote;
   * otherwise, and wherever that can't be told, the state is read whole.
   */
  private current(): IndexState {
    const revision = this.revision();
    const branchId = this.branchKey();
    const state = this.state;
    if (state && state.revision === revision && state.branchId === branchId) return state;
    if (state && revision !== null && state.branchId === branchId && this.readOn(state, revision)) return state;
    return (this.state = this.read(branchId, revision));
  }

  /**
   * Bring `state`, a reading of this branch's index or of another's, up to
   * `revision` by applying only the items after it, in place: true where
   * that was done, false where the state has to be read whole (read).
   *
   * The index is append-only: this package only appends to it, so where
   * the state's chain still holds the record that wrote the reading's last
   * item, at that item's ordinal, the reading is a prefix of the state, and
   * the items after it are what was appended since. That record's identity
   * (the item's `by` stamp) is unique in the store, and a branch shares a
   * record with the one it was made from only up to the branch point, so
   * the check holds across a branch switch too: a branch made after that
   * item continues the reading, and any other holds another item there.
   * The store's own snapshots move the revision and append nothing. It is
   * one slice read (getStateSlice) from the reading's last item on, which
   * the store answers from its per-item cache. Read whole instead: a
   * reading with no item or no stamp on its last, or of a state another
   * format keeps or with items this version can't read (so the warnings
   * read gives are given), a slice that holds any item this version would
   * read as another format's or can't read, a store without the slice
   * read, and a slice read that throws. A state another writer edited in
   * place, before that last item, would read as its appends: nothing here
   * writes one so.
   */
  private readOn(state: IndexState, revision: number): boolean {
    const last = state.rows.length - 1;
    const stamp = last >= 0 ? state.by[last] : undefined;
    if (stamp === undefined || state.found !== null || state.otherFormat !== null || state.unreadable > 0) return false;
    const store = this.store as { getStateSlice?: (id: string, offset: number, limit: number) => Buffer | null };
    if (typeof store.getStateSlice !== 'function') return false;
    let items: unknown;
    try {
      const slice = store.getStateSlice(this.stateId, last, 2 ** 31 - 1);
      items = slice === null ? null : JSON.parse(slice.toString('utf8'));
    } catch {
      return false;
    }
    if (!Array.isArray(items) || items.length === 0) return false;
    const boundary = items[0] as { by?: unknown } | null;
    if (typeof boundary !== 'object' || boundary === null || boundary.by !== stamp) return false;
    const added = items.slice(1) as Array<{ at?: unknown; by?: unknown } | null>;
    if (!added.every(isOwnItem)) return false;
    added.forEach((item, i) => {
      apply(state, item, last + 1 + i, typeof item?.at === 'number' ? item.at : undefined, typeof item?.by === 'string' ? item.by : undefined);
    });
    state.revision = revision;
    state.version = ++versions;
    state.presented = null;
    return true;
  }

  /**
   * The index as it stands, once the writes whose outcome a failed read
   * left unknown (WindowWriteOutcomeUnknownError) are settled: each made on
   * the handle's branch hears what the store holds of it, as it would have
   * at the write, in the order they were made, and one the store didn't
   * keep hears nothing. A write made on another branch waits for a reading
   * of that one. Every write through the index reads it so, before its own
   * work, in the manager's call, where the strategy's hooks run; a read
   * doesn't, since it can come from inside a strategy's own select or
   * drain, where they must not. Throws, settling nothing, while the index
   * can't be read.
   *
   * A hook that moves the store's branch as it hears stops the manager's
   * `operation`, which throws, writing nothing: the call was given the
   * record of the branch it was made on, and would write it into the
   * window of the one the store is on now, or take out of that window
   * every row the record lacks. The writes heard of up to that hook stay
   * settled, and those after it aren't heard on the branch the store
   * moved to: they wait for the next write on the branch they were made
   * on, as do they where the store can't say its branch after a hook (its
   * error is thrown). A call made again works on the branch the store is
   * on.
   *
   * Returns the reading with the id of the branch it is of, which the
   * call's own write waits on if its outcome is unknown (afterThrow): read
   * here, before the write, so a store that can't say its branch once the
   * write has thrown doesn't drop it. Null where the store can't say it
   * here either, and nothing waits to be settled. Where something waits,
   * a store that can't say its branch can't say whether it waits on this
   * one, so this throws, settling nothing and writing nothing, as while
   * the index can't be read: the write after it, once the store says its
   * branch, settles it first.
   */
  private settled(operation: string): { state: IndexState; branch: string | null } {
    const state = this.current();
    let branch: { id: string; name: string };
    try {
      branch = this.store.currentBranch();
    } catch (error) {
      if (this.unsettled.length === 0) return { state, branch: null };
      throw new Error(
        `ContextManager.${operation}: the store can't say its branch, so whether a window write whose outcome was ` +
          'unknown waits to be settled on it, before this call, is unknown, and this call writes nothing; call it ' +
          `again once the store says its branch: ${describeThrown(error)}`,
        { cause: error },
      );
    }
    const due = this.unsettled.filter((write) => write.branch === branch.id);
    if (due.length === 0) return { state, branch: branch.id };
    this.unsettled = this.unsettled.filter((write) => write.branch !== branch.id);
    // One at a time, with the branch read after each: a hook that moved the
    // store stops the rest, which wait for the next write on this branch,
    // ahead of any write a hook made meanwhile, and so do they where the
    // branch can't be read after one.
    let next = 0;
    try {
      while (next < due.length) {
        const write = due[next++]!;
        try {
          write.settle(state.ordinals);
        } catch (error) {
          logThrown('[context-manager] telling the strategy what a window write whose outcome was unknown did failed:', error, this.diag);
        }
        const now = this.store.currentBranch();
        if (now.id !== branch.id) {
          throw new Error(
            `ContextManager.${operation}: a strategy hook that heard what an earlier write to the window did moved the ` +
              `store's branch from ${branch.name} to ${now.name}, and this call was given the record of ${branch.name}, ` +
              `so it writes nothing; call it again on the branch the store is on`,
          );
        }
      }
    } finally {
      if (next < due.length) this.unsettled = [...due.slice(next), ...this.unsettled];
    }
    // A hook may have written to the index since.
    return { state: this.current(), branch: branch.id };
  }

  /**
   * After a write that threw: read the index again and give `tell` the
   * ordinals as the store holds them, then return the write's own error to
   * throw on. Where the index can't be read, the outcome is unknown: `tell`
   * waits for the next write on `branch`, the one the write was made on,
   * as settled read it before the write (settled), and the error to throw
   * is a WindowWriteOutcomeUnknownError naming the rows. Where settled
   * couldn't read the branch, it is read now; where that fails too, nothing
   * waits, and a warning says so.
   */
  private afterThrow(
    operation: string,
    error: unknown,
    rows: { entering: readonly MessageId[]; leaving: readonly MessageId[] },
    tell: (ordinals: ReadonlyMap<MessageId, number>) => void,
    branch: string | null,
  ): unknown {
    let ordinals: ReadonlyMap<MessageId, number>;
    try {
      ordinals = this.current().ordinals;
    } catch (readError) {
      let on = branch;
      if (on === null) {
        try {
          on = this.store.currentBranch().id;
        } catch (branchError) {
          this.diag.warn(
            `[context-manager] ContextManager.${operation}: the store can't say which branch the window write whose ` +
              `outcome is unknown was made on (${describeThrown(branchError)}), so nothing waits to tell the strategy ` +
              `what it did; the strategy reads the window at its next select`,
          );
        }
      }
      if (on !== null) this.unsettled.push({ branch: on, settle: tell });
      return new WindowWriteOutcomeUnknownError(operation, rows, error, readError, on !== null);
    }
    tell(ordinals);
    return error;
  }

  private read(branchId: unknown, revision: number | null): IndexState {
    const state = emptyState(branchId, revision);
    if (revision === null) return state;
    let items: unknown;
    try {
      items = this.store.getStateJson(this.stateId);
    } catch (error) {
      // A value the store can't give as JSON is no index this version
      // reads, as one of another kind isn't; a read that fails another way
      // is thrown, so the next read tries again.
      state.found = unreadableValue(this.store, this.stateId, error);
    }
    if (state.found === null && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i] as { at?: unknown; by?: unknown } | null;
        const at = typeof item?.at === 'number' ? item.at : undefined;
        const by = typeof item?.by === 'string' ? item.by : undefined;
        apply(state, item, i, at, by);
      }
    } else if (state.found === null && items !== undefined) {
      // A state with a record holds a value, JSON null among them: a state
      // with none has no revision, and was returned for above.
      state.found = `${kindOf(items)}, not a list of index items`;
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
   * The rows a tombstone took out of the window and no presentation has
   * put back since, undone or not, from one reading of the index: rows a
   * host took out, and rows removed from the record once taken out by
   * their ids. Null in legacy mode. A row removed in legacy mode, before
   * the write-down, was never in the window, and isn't one, even where a
   * write-down cut short wrote it and the one that finished it took it out
   * (its tombstones come before the header); neither is a
   * row removed through another manager that no retract has taken out
   * yet, which keeps its ordinal (see ordinalOf). Read it at once: a later
   * write changes it.
   */
  left(): ReadonlySet<MessageId> | null {
    const state = this.current();
    return inEffect(state) ? state.left : null;
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

  /**
   * The row this branch's index presented at `ordinal`, whether or not it
   * is in the window still: a row taken out keeps its ordinal here, as a
   * hole in the window. Undefined for an ordinal the index never issued to
   * a row (a header, a tombstone, an item past its end), and in legacy
   * mode. A branch made from another holds the parent's ordinals up to the
   * branch point, and its own after.
   */
  issuedTo(ordinal: number): MessageId | undefined {
    const state = this.current();
    return inEffect(state) ? (state.issued[ordinal] ?? undefined) : undefined;
  }

  /**
   * The identity of the record whose write presented a row at `ordinal` on
   * this branch (its `by` stamp; see LeftRow), kept after a tombstone takes
   * the row out. A branch made from another shares it only for an ordinal
   * issued before the branch point: one the branch issued on its own, at
   * the same ordinal, to the same row, comes from a record of its own.
   * Undefined where issuedTo is, and where the item carries no stamp.
   */
  issuedBy(ordinal: number): string | undefined {
    const state = this.current();
    return inEffect(state) && state.issued[ordinal] != null ? state.by[ordinal] : undefined;
  }

  /** Ordinals issued on this branch: the one the next item takes. 0 in legacy mode. */
  length(): number {
    const state = this.current();
    return inEffect(state) ? state.rows.length : 0;
  }

  /**
   * The sequence of the record that presented the row, while it is in the
   * window and its item says: the point a branch cut has to reach for the
   * branch's window to hold the row, for a row a presentRows call
   * presented. A row the write-down presented (presentedByWriteDown) is the
   * exception: it was in the window from its own write, and a cut before
   * the write-down makes a branch in legacy mode, whose window is the
   * record up to the cut, so a cut at the row's own sequence holds it, and
   * such a row stays cut there (a body's at its last shard's: see
   * ContextManager.branchSequenceOf).
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
   * none, so it hears nothing. Where the index can't be read again to tell,
   * the call throws WindowWriteOutcomeUnknownError in place of the write's
   * error, and `cutShort` hears at the next write through the index on the
   * branch, once the index reads there (settled). A write that lands and
   * whose read of the index after it throws is one that threw, its error
   * the read's.
   */
  present(
    ids: readonly MessageId[],
    record: readonly StoredMessage[],
    positionOf: (id: MessageId) => number | undefined,
    cutShort?: (entered: MessageId[], left: LeftRow[]) => void,
  ): { ordinals: number[]; entered: MessageId[]; left: LeftRow[] } {
    const { state, branch } = this.settled('presentRows');
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
      this.writeDownWindow('presentRows', state, record);
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
        if (ordinal !== undefined) moving.push({ id, ordinal, by: state.by[ordinal] });
      }
    }
    const moves = new Set(moving.map((row) => row.id));
    const rows = named.flatMap((name) => name.rows.filter((id) => moves.has(id) || !state.ordinals.has(id)));
    const items: IndexItem[] = [...moving.map((row): IndexItem => ({ retract: row.id })), ...rows.map((id): IndexItem => ({ id }))];
    // The read of the ordinals the write gave is the write's too: one that
    // throws after the write landed goes as a write that threw does, told
    // where the index reads again and waiting where it doesn't.
    let ordinals: ReadonlyMap<MessageId, number>;
    try {
      this.write(items);
      ordinals = this.current().ordinals;
    } catch (error) {
      if (!cutShort) throw error;
      throw this.afterThrow('presentRows', error, { entering: rows, leaving: inWindowOrder(moving).map((row) => row.id) }, presentSettlement(rows, moving, cutShort), branch);
    }
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
   * the error is thrown on: none, when the store refused the write whole.
   * Where the index can't be read again to tell, it hears at the next write
   * instead, as present's does, and the call throws
   * WindowWriteOutcomeUnknownError. A write-down that throws has taken
   * nothing out.
   */
  retract(
    ids: readonly MessageId[],
    record: readonly StoredMessage[],
    positionOf: (id: MessageId) => number | undefined,
    undone: boolean,
    cutShort?: (left: LeftRow[]) => void,
  ): LeftRow[] {
    const { state, branch } = this.settled('retractRows');
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
    if (legacy) this.writeDownWindow('retractRows', state, record);
    const now = this.current();
    const left = leaving.map((id): LeftRow => {
      const ordinal = now.ordinals.get(id)!;
      return { id, ordinal, by: now.by[ordinal] };
    });
    const tombstones = leaving.map((id): IndexItem => (undone ? { retract: id, undone: true } : { retract: id }));
    this.writeLeaving('retractRows', tombstones, left, branch, cutShort);
    return inWindowOrder(left);
  }

  /**
   * Take rows the record no longer holds out of the window: a tombstone for
   * each of `ids` the window holds, as retract writes one, so no other
   * row's ordinal moves. An id the window doesn't hold is passed over. In
   * legacy mode it writes nothing: the window is the record, and a row
   * removed from the record has left it already. Returns the rows taken
   * out, with the ordinals they held, in window order; `cutShort` is as
   * retract's. `leaving`, when given, hears the rows the write is about to
   * take out, in window order, once the writes waiting to be settled have
   * been (settled), whose hooks can take a row out first, and before the
   * write, which can throw.
   */
  retractRemoved(ids: readonly MessageId[], cutShort?: (left: LeftRow[]) => void, leaving?: (left: LeftRow[]) => void): LeftRow[] {
    const { state, branch } = this.settled('retractRemoved');
    if (!inEffect(state)) {
      leaving?.([]);
      return [];
    }
    const left: LeftRow[] = [];
    for (const id of new Set(ids)) {
      const ordinal = state.ordinals.get(id);
      if (ordinal !== undefined) left.push({ id, ordinal, by: state.by[ordinal] });
    }
    leaving?.(inWindowOrder(left));
    this.writeLeaving('retractRemoved', left.map((row): IndexItem => ({ retract: row.id })), left, branch, cutShort);
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
    const { state, branch } = this.settled('retractAbsentRows');
    if (!inEffect(state)) return [];
    const held = positionsIn(record);
    const left: LeftRow[] = [];
    for (const [id, ordinal] of state.ordinals) if (!held.has(id)) left.push({ id, ordinal, by: state.by[ordinal] });
    this.writeLeaving('retractAbsentRows', left.map((row): IndexItem => ({ retract: row.id })), left, branch, cutShort);
    return inWindowOrder(left);
  }

  /**
   * Write `tombstones`, which take `left` out of the window, for the
   * manager's `operation`, on `branch` (as settled read it). A write that
   * throws tells `cutShort` the rows of `left` the store holds as out of
   * the window, in window order, and the error is thrown on; where the
   * index can't be read again to tell, the error is a
   * WindowWriteOutcomeUnknownError, and `cutShort` hears at the next write
   * on that branch (afterThrow).
   */
  private writeLeaving(
    operation: string,
    tombstones: IndexItem[],
    left: readonly LeftRow[],
    branch: string | null,
    cutShort?: (left: LeftRow[]) => void,
  ): void {
    try {
      this.write(tombstones);
    } catch (error) {
      if (!cutShort) throw error;
      throw this.afterThrow(operation, error, { entering: [], leaving: inWindowOrder(left).map((row) => row.id) }, leavingSettlement(left, cutShort), branch);
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
      issued: [...state.issued],
      at: [...state.at],
      by: [...state.by],
      ordinals: new Map(state.ordinals),
      undone: new Set(state.undone),
      left: new Set(state.left),
      version: ++versions,
      // Never changed in place (a write sets it to null), so both can read it.
      presented: state.presented,
      header: state.header,
      otherFormat: state.otherFormat,
      unreadable: state.unreadable,
      found: state.found,
    };
  }

  /**
   * Write the window down (writeDown) for the manager's `operation`. A
   * write-down puts no row in the window and takes none out, so a write
   * that throws has nothing to tell the strategy, and its error is thrown
   * on once the index is read again, which says whether it landed (the
   * mode). Where that read throws too, the error is a
   * WindowWriteOutcomeUnknownError naming no row, and nothing waits:
   * windowMode tells, once the index reads.
   */
  private writeDownWindow(operation: string, state: IndexState, record: readonly StoredMessage[]): void {
    const items = this.writeDown(operation, state, record);
    try {
      this.write(items);
    } catch (error) {
      try {
        this.current();
      } catch (readError) {
        throw new WindowWriteOutcomeUnknownError(operation, { entering: [], leaving: [] }, error, readError);
      }
      throw error;
    }
  }

  /**
   * The items that write the window down, in legacy mode, where the window
   * is the whole record: every row of `record` in record order, then the
   * header, which puts the index in effect. The header goes last so that a
   * write-down cut short, in an index written one record per item (see the
   * module comment), leaves the manager in legacy mode. The next one
   * finishes it from where it stopped. A row it wrote that has since
   * left the record (a removal writes nothing in legacy mode) is taken out,
   * and the rows it didn't write follow the ones it did, while those are
   * still a prefix of the record, as they are while every row stored since
   * is stored after them. A slot merged since (auxiliaryMessageViews) can
   * hold older rows, which sort before them: then the rows it wrote are
   * taken out and every row of the record written again, in record order,
   * so the window is the record as legacy mode read it. Throws for an index
   * this version must not write to (foreignness).
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
    const written = [...state.ordinals].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    const prefix = written.filter((id) => held.has(id)).every((id, i) => record[i]!.id === id);
    const items: IndexItem[] = [];
    for (const id of written) if (!prefix || !held.has(id)) items.push({ retract: id });
    for (const message of record) if (!prefix || !state.ordinals.has(message.id)) items.push({ id: message.id });
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
   * A store handle without the batched append (a chronicle before 0.6.0,
   * which this package's range doesn't admit) is refused when the index is
   * made (the constructor); a write of several items asks again, and would
   * throw before it writes anything, the state's registration included
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
        items.forEach((item, i) => apply(state, item, firstOrdinal + i, record.sequence, record.id));
      } else {
        const record = this.store.appendToStateJsonWithIdentity(this.stateId, items[0]!, 'by', 'at');
        apply(state, items[0]!, state.rows.length, record.sequence, record.id);
      }
      // Read inside the try: the reading was changed in place, and kept
      // under the revision it had before the write, a branch whose index
      // ends at that record would take it for its own.
      state.revision = this.revision();
    } catch (error) {
      this.state = null;
      throw error;
    }
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
 * read, and once at open (the WindowIndex constructor).
 */
export function requireBatchedIdentityAppend(store: JsStore): void {
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
