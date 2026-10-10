/**
 * Thinking binding: send a signed thinking block only while the prefix it was
 * minted under is the prefix it is sent under.
 *
 * Anthropic binds each thinking / redacted_thinking block to the conversation
 * before it (system, tools, every earlier message). When anything before the
 * block changes, the block fails the binding check: a 400 by default, or a
 * removal under `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`.
 * A compile that folds, merges, caps, strips an image or releases a raw form
 * rewrites the prefix of every raw message after the change, so the thinking
 * those messages carry stops being valid at that compile.
 *
 * The pass keeps a digest chain over the compiled messages, in order, seeded
 * with the host's identity for what it sends before them (system and tools)
 * and with the system injections the compile returns. A stored message that
 * carries thinking is stamped once, when it is stored (or, if a compile not
 * yet accepted fenced the walk before it, when that compile is accepted),
 * with what it was minted under: the seed, the chain before it (before each part, for a
 * bundled tool cycle a compile splits), and a digest of each of its blocks.
 * That chain is the end of the branch's owner, its latest accepted compile,
 * extended by the messages this manager stored after that compile up to this
 * one, as they stand when it is stored: what the live request carried after
 * the compile. At every compile a message's thinking renders only when the
 * chain before it equals its stamp's, and only up to the first block that
 * differs from the block minted there. So an edit made after a reply was
 * stored strips the reply, and one made before (a host writing a result
 * over its placeholder before the reply is stored) is what its round
 * carried. Thinking without a stamp does not render: recall carriers (minted
 * in the summarizer's request), messages stored before the first accepted
 * compile, and replies stored after a sharded body in the same live request,
 * whose form as sent the shards can't restore.
 *
 * Stamping vouches for a reply only through compiles that sent what it
 * walked. A compile bound after the accepted one (sent, its acceptance not
 * yet in) whose chain at its head differs from the walk's, because it ran
 * under another seed or sent the messages before its head differently, fences
 * the walk: replies stored after it wait unstamped for its acceptance, which
 * stamps them from its own chain, and lose their thinking for good if a
 * compile bound later is accepted first. What the process learned since the
 * last record is not known after a reopen: compiles bound, and stamps made.
 * So a reply stored before the reopen and not yet recorded is stamped again
 * from the store as it stands, and if it was minted under a compile that
 * sent something else, from the walk. A reply stamped late, at the
 * acceptance of a compile that fenced it, likewise reads what was stored
 * after that compile's head as it stands then: an edit to it in between is
 * taken as what the round carried.
 *
 * The host's part. Stamping takes what this manager stored in its own slot
 * after an accepted compile, up to a reply, as what the live request carried
 * after the compile's messages, in that order and as it stands when the
 * reply is stored. A host stores each round as it went out, and defers its
 * other writes to the slot (a message heard mid-tool-loop) until the turn
 * ends. Another writer's messages, in an auxiliary slot, aren't walked: the
 * live request didn't carry what was stored there after the compile.
 *
 * Every manager on one store object shares a namespace's state, as the fold
 * journal's index is shared: an acceptance through one engages, stamps and
 * fences for all of them. They walk one message slot, the namespace's, as
 * long as none opens it isolated while another doesn't.
 *
 * Engagement. The pass engages at the namespace's first accepted compile.
 * Only a host that calls `acceptRound` says which compile a reply was minted
 * under, so a store whose host never has renders as it always did.
 *
 * Release. When the pass strips a message's thinking on a branch, the
 * thinking is released on the branch: a compile's rewrites move forward, so
 * its prefix almost never comes back, and from then on the strategy's view
 * reads the message without it, so budgets and estimates count what is sent.
 * A release runs from the first block the strip took, so thinking before an
 * edited block stays. The exception is a compile under a seed other than the
 * branch's latest accepted one (a host's one-turn system change): it keeps
 * what was minted under that seed, which renders again when the seed comes
 * back. A reply still waiting for its own compile's acceptance isn't
 * released, and a branch with no accepted compile of its own releases
 * nothing.
 *
 * Storage is Chronicle typed records, one per accepted compile: its seed,
 * chain end and head sequence, whether its acceptance made it its branch's
 * owner, and the stamps and releases no record holds yet. They are written
 * at acceptance, before the fold journal's record, and read when first
 * needed and at each acceptance after that, so a record whose write
 * reported a failure after landing is found rather than written again. A
 * compile is accepted once.
 */

import { createHash } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import { branchKey } from './fold-journal.js';
import { splitMixedToolMessages } from './normalize-tool-messages.js';
import type { BranchRef, CompiledMessageSources, MessageId, MessageStoreView, StoredMessage } from './types/index.js';

export const THINKING_BINDING_RECORD = 'context-manager/thinking-binding';

/** The thinking-binding record format. */
const RECORD_VERSION = 1;
/** Compiles a manager remembers until they are accepted (older ones are
 *  forgotten, and their acceptance records nothing), and per branch, the
 *  compiles its walk hasn't passed (past that, the branch goes blind). */
const PENDING_LIMIT = 32;

export interface ChainMessage {
  participant: string;
  content: ContentBlock[];
}

/** JSON with object keys sorted and undefined members dropped, so the same
 *  content hashes the same whichever path built its objects. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** The chain value after `message`, given the value before it. */
export function chainStep(before: string, message: ChainMessage): string {
  return createHash('sha256')
    .update(before)
    .update('\n')
    .update(canonicalJson({ p: message.participant, c: message.content }))
    .digest('hex');
}

/**
 * The chain's first value: the host's identity for the prefix it sends
 * before the compiled messages, and the system injections the compile
 * returns for that prefix.
 */
export function chainSeed(prefixIdentity: string | undefined, systemInjections: readonly ContentBlock[] = []): string {
  return createHash('sha256')
    .update('thinking-binding/v1\n')
    .update(prefixIdentity ?? '')
    .update('\n')
    .update(canonicalJson(systemInjections))
    .digest('hex');
}

/** A digest of one block as stored or compiled. */
export function blockDigest(block: ContentBlock): string {
  return createHash('sha256').update(canonicalJson(block)).digest('hex');
}

export function isThinkingBlock(block: ContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking';
}

/** What a stored message's thinking was minted under. */
export interface Stamp {
  /** The seed of the chain it was minted on. */
  seed: string;
  /**
   * For each part a compile splits the message into (one, unless it is a
   * bundled tool cycle): the chain value before the part, and the index of
   * the part's first block in the stored message.
   */
  parts: Array<[string, number]>;
  /** A digest of each of the message's blocks as stored. */
  blocks: string[];
}

/**
 * Walk `message` onto `chain` in the parts a compile splits it into
 * (splitMixedToolMessages): the chain before each part with the part's first
 * block, and the chain after the message.
 */
export function walkMessage(chain: string, message: ChainMessage): { parts: Array<[string, number]>; after: string } {
  const parts: Array<[string, number]> = [];
  let start = 0;
  for (const part of splitMixedToolMessages([message])) {
    parts.push([chain, start]);
    chain = chainStep(chain, part);
    start += part.content.length;
  }
  return { parts, after: chain };
}

/** The stamp of `message`, stored after `chain` on a chain seeded with `seed`. */
export function mintStamp(seed: string, chain: string, message: ChainMessage): Stamp {
  return { seed, parts: walkMessage(chain, message).parts, blocks: message.content.map(blockDigest) };
}

export interface BindingResult {
  /** The compiled messages as they go out, thinking stripped where unbound. */
  messages: ChainMessage[];
  /** Parallel to `messages`. */
  sources: CompiledMessageSources[];
  /** Index (into the input) of each message kept, parallel to `messages`. */
  kept: number[];
  /** Thinking blocks removed. */
  stripped: number;
  /** The blocks removed, for pricing what the compile no longer sends. */
  strippedBlocks: ContentBlock[];
  /** Stored messages whose thinking was removed, each with the first block
   *  of its own the strip took (0 when that can't be placed: a compiled
   *  message carrying several bodies, or a later part of an unstamped one). */
  strippedFrom: Map<MessageId, number>;
  /** The chain value after the last message. */
  chainEnd: string;
}

/**
 * Walk the compiled messages in order, deciding each message's thinking
 * against the chain before it, and extending the chain with the message as it
 * goes out. A message left with no content is dropped, as a host would drop it.
 */
export function bindThinking(args: {
  messages: readonly ChainMessage[];
  sources: readonly CompiledMessageSources[];
  seed: string;
  /** Whether stamps are in force (the namespace has accepted a compile). */
  engaged: boolean;
  stampOf: (id: MessageId) => Stamp | undefined;
}): BindingResult {
  const out: ChainMessage[] = [];
  const sources: CompiledMessageSources[] = [];
  const kept: number[] = [];
  const strippedFrom = new Map<MessageId, number>();
  const strippedBlocks: ContentBlock[] = [];
  let stripped = 0;
  let chain = args.seed;
  // Consecutive compiled messages of one stored body are the parts a compile
  // split it into (a bundled tool cycle); `part` counts them.
  let previous: MessageId | undefined;
  let part = 0;
  for (let i = 0; i < args.messages.length; i++) {
    const message = args.messages[i]!;
    const source = args.sources[i] ?? { kind: 'other' as const };
    const body = source.kind === 'raw' && source.bodies.length === 1 ? source.bodies[0]!.messageId : undefined;
    part = body !== undefined && body === previous ? part + 1 : 0;
    previous = body;
    let content = message.content;
    if (args.engaged && content.some(isThinkingBlock)) {
      const stamp = body !== undefined ? args.stampOf(body) : undefined;
      const keepUpTo = boundPrefix(message, stamp?.parts[part], stamp, chain);
      // Where this part starts in the stored message, when that's known.
      const start = stamp?.parts[part]?.[1] ?? (part === 0 ? 0 : undefined);
      const next: ContentBlock[] = [];
      for (let b = 0; b < content.length; b++) {
        const block = content[b]!;
        if (isThinkingBlock(block) && b >= keepUpTo) {
          stripped++;
          strippedBlocks.push(block);
          if (source.kind === 'raw') {
            const from = body !== undefined && start !== undefined ? start + b : 0;
            for (const each of source.bodies) {
              strippedFrom.set(each.messageId, Math.min(from, strippedFrom.get(each.messageId) ?? from));
            }
          }
          continue;
        }
        next.push(block);
      }
      if (next.length !== content.length) content = next;
    }
    if (content.length === 0) continue;
    const sent = content === message.content ? message : { ...message, content };
    out.push(sent);
    sources.push(source);
    kept.push(i);
    chain = chainStep(chain, sent);
  }
  return { messages: out, sources, kept, stripped, strippedBlocks, strippedFrom, chainEnd: chain };
}

/**
 * How many leading blocks of a compiled message keep their thinking: up to
 * the first block that differs from the one minted there, when the message is
 * (a part of) one stored body whose stamp has the chain before it for that
 * part; none otherwise.
 */
function boundPrefix(
  message: ChainMessage,
  part: [string, number] | undefined,
  stamp: Stamp | undefined,
  chainBefore: string,
): number {
  if (!stamp || !part || part[0] !== chainBefore) return 0;
  const start = part[1];
  const n = Math.min(stamp.blocks.length - start, message.content.length);
  for (let b = 0; b < n; b++) {
    if (blockDigest(message.content[b]!) !== stamp.blocks[start + b]) return b;
  }
  return Math.max(n, 0);
}

/** A released copy of a stored message, and the block its release runs from. */
export interface ReleasedCopy {
  from: number;
  copy: StoredMessage;
}

/**
 * A view in which each released message (one whose thinking the pass has
 * stripped on this branch, from the block mapped to it; its prefix never
 * comes back) reads without that thinking, so selection, budgets and
 * estimates count what is sent. Copies are memoized per stored message, in
 * `copies`, so a strategy's caches keyed on a message stay warm from one
 * compile to the next.
 */
export function releaseThinkingView(
  view: MessageStoreView,
  released: ReadonlyMap<MessageId, number>,
  copies: WeakMap<StoredMessage, ReleasedCopy> = new WeakMap(),
): MessageStoreView {
  if (released.size === 0) return view;
  const strip = (m: StoredMessage): StoredMessage => {
    const from = released.get(m.id);
    if (from === undefined) return m;
    const memo = copies.get(m);
    if (memo && memo.from === from) return memo.copy;
    const content = m.content.filter((b, i) => i < from || !isThinkingBlock(b));
    const copy = content.length === m.content.length ? m : { ...m, content };
    copies.set(m, { from, copy });
    return copy;
  };
  return {
    ...view,
    getAll: () => view.getAll().map(strip),
    get: (id: MessageId) => {
      const m = view.get(id);
      return m ? strip(m) : null;
    },
    getFrom: (index: number) => view.getFrom(index).map(strip),
    getTail: (count: number) => view.getTail(count).map(strip),
  };
}

/** An accepted compile, as stamping needs it. */
interface AcceptedChain {
  compileId: string;
  /** The seed the compile was sent under. */
  seed: string;
  /** The chain value after the compile's last message, as sent. */
  end: string;
  /** The highest message sequence when the compile ran. */
  head: number;
  /** Its place in bind order, when it was bound in this process. */
  n?: number;
}

interface PendingCompile extends AcceptedChain {
  branch: BranchRef;
  n: number;
}

/** A compile bound with an id, as the walk's fence reads it. */
interface SentCompile {
  /** Its place in bind order. */
  n: number;
  head: number;
  end: string;
}

/** One accepted compile's record (format 1). */
interface BindingRecord {
  v: typeof RECORD_VERSION;
  ns: string;
  branch: BranchRef;
  compileId: string;
  seed: string;
  end: string;
  head: number;
  /** Whether its acceptance made it the owner of its branch: the compile
   *  the replies that follow it are stamped from. */
  owns: boolean;
  /** Stamps no earlier record holds: [message id, seed, parts, block digests]. */
  stamps?: Array<[MessageId, string, Array<[string, number]>, string[]]>;
  /** Releases on `branch` no earlier record holds: [message id, first
   *  block released]. */
  released?: Array<[MessageId, number]>;
}

function isBindingRecord(record: unknown): record is BindingRecord {
  const r = record as Partial<BindingRecord> | null;
  return !!r && r.v === RECORD_VERSION && typeof r.ns === 'string' && typeof r.compileId === 'string'
    && !!r.branch && typeof r.seed === 'string' && typeof r.end === 'string' && typeof r.head === 'number'
    && typeof r.owns === 'boolean';
}

/** Where stamping a branch has reached: the chain after the last message it
 *  walked (null once a sharded body made it unknowable), from the compile it
 *  started at. */
interface Cursor {
  owner: string;
  chain: string | null;
  through: number;
}

const NOTHING_RELEASED: ReadonlyMap<MessageId, number> = new Map();

/** Add a release to `map`, keeping the earlier first block. Returns whether
 *  it released more than `map` held. */
function addRelease(map: Map<MessageId, number>, id: MessageId, from: number): boolean {
  const held = map.get(id);
  if (held !== undefined && held <= from) return false;
  map.set(id, from);
  return true;
}

/** The index of the first of `messages` (in sequence order) after `sequence`. */
function firstAfter(messages: readonly StoredMessage[], sequence: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (messages[mid]!.sequence <= sequence) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Each store object's binding state, by namespace. */
const bindings = new WeakMap<JsStore, Map<string, ThinkingBinding>>();

/**
 * The thinking-binding state of `namespace` on `store`, one for every
 * manager on that store object, as the fold journal's index is: an
 * acceptance through any of them engages, stamps and fences for all.
 */
export function thinkingBindingFor(store: JsStore, namespace: string): ThinkingBinding {
  let byNamespace = bindings.get(store);
  if (!byNamespace) bindings.set(store, (byNamespace = new Map()));
  let binding = byNamespace.get(namespace);
  if (!binding) byNamespace.set(namespace, (binding = new ThinkingBinding(store, namespace)));
  return binding;
}

/**
 * A namespace's thinking-binding state on one store object: stamps, each
 * branch's owner and released messages, as the records hold them, plus what
 * this process has learned since its last record. Shared by the managers on
 * that store object (thinkingBindingFor).
 */
export class ThinkingBinding {
  private loaded = false;
  /** Records of this type read so far, of the store's, in order. */
  private read = 0;
  /** Whether the namespace has accepted a compile. */
  private accepted = false;
  private readonly stamps = new Map<MessageId, Stamp>();
  /** Each branch's owner: the accepted compile its next reply follows, as
   *  each acceptance decided it. */
  private readonly latest = new Map<string, AcceptedChain>();
  private readonly released = new Map<string, Map<MessageId, number>>();
  /** Stamps and releases learned since the last record. */
  private readonly unrecordedStamps = new Set<MessageId>();
  private readonly unrecordedReleases = new Map<string, Map<MessageId, number>>();
  /** Compiles awaiting acceptance, oldest first. */
  private readonly pending = new Map<string, PendingCompile>();
  /** Compiles bound so far in this process. */
  private binds = 0;
  /** Each branch's compiles bound after its owner that its walk hasn't
   *  passed, in bind order (at most PENDING_LIMIT). */
  private readonly sent = new Map<string, SentCompile[]>();
  /** Each branch's compiles forgotten from `sent` unpassed: the head of the
   *  first and the bind order of the last. The walk passes nothing after
   *  that head until a compile bound after the last becomes the owner. */
  private readonly forgotten = new Map<string, { head: number; n: number }>();
  private readonly cursors = new Map<string, Cursor>();
  /** Released copies of stored messages, kept while the stored one lives. */
  private readonly releasedCopies = new WeakMap<StoredMessage, ReleasedCopy>();

  constructor(
    private readonly store: JsStore,
    private readonly namespace: string,
  ) {}

  /** Whether stamps are in force: the namespace has accepted a compile. */
  engaged(): boolean {
    this.load();
    return this.accepted;
  }

  /** Messages whose thinking `branch` no longer sends, each with the first
   *  block released. */
  releasedOn(branch: BranchRef): ReadonlyMap<MessageId, number> {
    this.load();
    return this.released.get(branchKey(branch)) ?? NOTHING_RELEASED;
  }

  /** `view` as `branch` sends it: released messages read without their
   *  thinking (see releaseThinkingView). */
  releasedView(view: MessageStoreView, branch: BranchRef): MessageStoreView {
    return releaseThinkingView(view, this.releasedOn(branch), this.releasedCopies);
  }

  /**
   * A message carrying thinking was just stored on `branch`: stamp it now,
   * from the store as it stands, which is what its round carried. A later
   * edit to what came before it is then a change, which strips it.
   */
  stampStored(branch: BranchRef, own: readonly StoredMessage[]): void {
    this.load();
    this.stampNew(branchKey(branch), own, true);
  }

  /**
   * Bind one compile's messages. First stamps what this manager stored on the
   * branch since its owner and hasn't stamped yet. A compile with an id is
   * remembered until accepted, and commits its stamps and releases; one
   * without (a dry run) commits nothing.
   */
  bind(args: {
    branch: BranchRef;
    compileId?: string;
    messages: readonly ChainMessage[];
    sources: readonly CompiledMessageSources[];
    seed: string;
    /** This manager's own stored messages on the branch, unfiltered, in
     *  sequence order. */
    own: readonly StoredMessage[];
    /** The highest message sequence the compile read. */
    head: number;
  }): BindingResult {
    this.load();
    const key = branchKey(args.branch);
    const commit = args.compileId !== undefined;
    const { made, awaiting } = this.stampNew(key, args.own, commit);
    const result = bindThinking({
      messages: args.messages,
      sources: args.sources,
      seed: args.seed,
      engaged: this.accepted,
      stampOf: (id) => this.stamps.get(id) ?? made.get(id),
    });
    if (!commit) return result;
    const owner = this.latest.get(key);
    if (owner && result.strippedFrom.size > 0) {
      const released = this.released.get(key) ?? new Map<MessageId, number>();
      const unrecorded = this.unrecordedReleases.get(key) ?? new Map<MessageId, number>();
      for (const [id, from] of result.strippedFrom) {
        // Its own compile may still be accepted and stamp it.
        if (awaiting.has(id)) continue;
        // Under a one-turn seed, what the branch's seed minted comes back with it.
        if (args.seed !== owner.seed && this.stamps.get(id)?.seed === owner.seed) continue;
        if (addRelease(released, id, from)) unrecorded.set(id, from);
      }
      this.released.set(key, released);
      this.unrecordedReleases.set(key, unrecorded);
    }
    const n = this.binds++;
    // The fence checks a compile when the walk reaches past its head; one
    // that would check as the last one does adds nothing.
    const sent = this.sent.get(key) ?? [];
    const last = sent[sent.length - 1];
    if (!last || last.head !== args.head || last.end !== result.chainEnd) {
      sent.push({ n, head: args.head, end: result.chainEnd });
      while (sent.length > PENDING_LIMIT) {
        const dropped = sent.shift()!;
        const held = this.forgotten.get(key);
        this.forgotten.set(key, { head: Math.min(held?.head ?? dropped.head, dropped.head), n: dropped.n });
      }
      this.sent.set(key, sent);
    }
    this.pending.set(args.compileId!, {
      compileId: args.compileId!,
      seed: args.seed,
      end: result.chainEnd,
      head: args.head,
      branch: args.branch,
      n,
    });
    while (this.pending.size > PENDING_LIMIT) this.pending.delete(this.pending.keys().next().value!);
    return result;
  }

  /**
   * Record that a compile's provider round succeeded: its chain, whether it
   * becomes its branch's owner (it does when it was bound after the current
   * one), and the stamps and releases no record holds yet, as one record.
   * Once per compile: one already recorded (whose write may have reported a
   * failure after landing) records nothing again, and neither does a compile
   * not remembered here (a dry run, one from before a reopen, or one long
   * forgotten).
   */
  accept(compileId: string): void {
    this.load();
    this.refresh();
    // A compile is remembered until its record is read, so one whose record
    // landed (a write that reported failure after landing) is gone by now.
    const compile = this.pending.get(compileId);
    if (!compile) return;
    const key = branchKey(compile.branch);
    const owner = this.latest.get(key);
    const stamps = [...this.unrecordedStamps].map((id): [MessageId, string, Array<[string, number]>, string[]] => {
      const stamp = this.stamps.get(id)!;
      return [id, stamp.seed, stamp.parts, stamp.blocks];
    });
    const released = [...(this.unrecordedReleases.get(key) ?? [])];
    const record: BindingRecord = {
      v: RECORD_VERSION,
      ns: this.namespace,
      branch: compile.branch,
      compileId,
      seed: compile.seed,
      end: compile.end,
      head: compile.head,
      owns: !owner || owner.n === undefined || compile.n > owner.n,
      ...(stamps.length > 0 ? { stamps } : {}),
      ...(released.length > 0 ? { released } : {}),
    };
    // Durable at the caller's sync. A record that outlives messages it names
    // (stored since the last sync) is inert: their ids are their Chronicle
    // records', which no later message takes, and a head past them costs the
    // replies after it a stamp.
    this.store.appendJson(THINKING_BINDING_RECORD, record);
    this.read += 1;
    this.ingest(record);
  }

  /** Read the namespace's records, once. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.refresh();
  }

  /** Read the records written since the last read: all of them at first,
   *  and later one whose write reported a failure after it landed. */
  private refresh(): void {
    const ids = this.store.getRecordIdsByType(THINKING_BINDING_RECORD);
    for (let i = this.read; i < ids.length; i++) {
      const stored = this.store.getRecord(ids[i]!);
      if (!stored) continue;
      let record: unknown;
      try {
        record = JSON.parse(stored.payload.toString('utf8'));
      } catch {
        continue;
      }
      if (isBindingRecord(record) && record.ns === this.namespace) this.ingest(record);
    }
    this.read = Math.max(this.read, ids.length);
  }

  /** Take in one record, written here or read from the store. */
  private ingest(record: BindingRecord): void {
    this.accepted = true;
    const key = branchKey(record.branch);
    // Bound in this process: its place in bind order orders it against
    // compiles bound later.
    const n = this.pending.get(record.compileId)?.n;
    this.pending.delete(record.compileId);
    if (record.owns) {
      this.latest.set(key, { compileId: record.compileId, seed: record.seed, end: record.end, head: record.head, n });
      if (n !== undefined) {
        // Compiles bound before the owner minted nothing after it.
        const sent = this.sent.get(key);
        if (sent) this.sent.set(key, sent.filter((c) => c.n > n));
        const forgotten = this.forgotten.get(key);
        if (forgotten && forgotten.n < n) this.forgotten.delete(key);
      }
    }
    for (const [id, seed, parts, blocks] of record.stamps ?? []) {
      if (!this.stamps.has(id)) this.stamps.set(id, { seed, parts, blocks });
      this.unrecordedStamps.delete(id);
    }
    if (record.released && record.released.length > 0) {
      const released = this.released.get(key) ?? new Map<MessageId, number>();
      const unrecorded = this.unrecordedReleases.get(key);
      for (const [id, from] of record.released) {
        addRelease(released, id, from);
        if (unrecorded !== undefined && (unrecorded.get(id) ?? Infinity) >= from) unrecorded.delete(id);
      }
      this.released.set(key, released);
    }
  }

  /**
   * Stamp each unstamped message carrying thinking that this manager stored
   * on the branch after its owner, walking from where the last walk stopped:
   * the chain from the owner's end, extended by each message as stored, in
   * the parts a compile splits it into. A sharded body ends what the walk can
   * vouch for until the next accepted compile. The walk passes the head of a
   * compile bound since the owner only when that compile's chain there is
   * the walk's; at one that isn't, it stops, and the replies after it await
   * their own compile. Returns the stamps it made and the replies awaiting;
   * with `commit` the stamps are also kept, and the walk's position with
   * them.
   */
  private stampNew(key: string, own: readonly StoredMessage[], commit: boolean): {
    made: Map<MessageId, Stamp>;
    awaiting: Set<MessageId>;
  } {
    const made = new Map<MessageId, Stamp>();
    const awaiting = new Set<MessageId>();
    const owner = this.latest.get(key);
    if (!owner) return { made, awaiting };
    const held = this.cursors.get(key);
    const cursor: Cursor = held && held.owner === owner.compileId
      ? { ...held }
      : { owner: owner.compileId, chain: owner.end, through: owner.head };
    const sent = this.sent.get(key) ?? [];
    const passed = new Set<SentCompile>();
    const blindAfter = this.forgotten.get(key)?.head ?? Infinity;
    let fenced = false;
    for (let i = firstAfter(own, cursor.through); i < own.length; i++) {
      const message = own[i]!;
      if (!fenced && message.sequence > blindAfter) fenced = true;
      for (const compile of sent) {
        if (fenced) break;
        if (compile.head >= message.sequence || passed.has(compile)) continue;
        if (cursor.chain !== null && cursor.chain === compile.end) passed.add(compile);
        else fenced = true;
      }
      if (fenced) {
        if (!this.stamps.has(message.id) && message.content.some(isThinkingBlock)) awaiting.add(message.id);
        continue;
      }
      cursor.through = message.sequence;
      if (cursor.chain === null) continue;
      if (message.bodyGroupId !== undefined) {
        cursor.chain = null;
        continue;
      }
      const walked = walkMessage(cursor.chain, { participant: message.participant, content: message.content });
      if (!this.stamps.has(message.id) && message.content.some(isThinkingBlock)) {
        made.set(message.id, { seed: owner.seed, parts: walked.parts, blocks: message.content.map(blockDigest) });
      }
      cursor.chain = walked.after;
    }
    if (commit) {
      this.cursors.set(key, cursor);
      if (passed.size > 0) this.sent.set(key, sent.filter((c) => !passed.has(c)));
      for (const [id, stamp] of made) {
        this.stamps.set(id, stamp);
        this.unrecordedStamps.add(id);
      }
    }
    return { made, awaiting };
  }
}
