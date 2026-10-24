/**
 * Thinking binding (#155): which signed thinking blocks a compile can send to
 * a model that binds each block to the request it was minted in.
 *
 * Such a provider refuses a request that carries a thinking block, or with
 * its drop control sets the block aside, once anything sent before the block
 * differs from the request that minted it: a fold, an edit, a moved
 * injection, a changed tool or system text. A compile can't know what minted
 * a block, but it can know what its branch last sent. So the manager keeps,
 * per branch, a record of what the branch last sent: the last committing
 * compile's messages as sent, and the rows a host noted after them
 * (`ContextManager.noteRequestSent`): what its stream's requests went on to
 * carry and, once the stream ended, its last reply. A compile keeps a
 * message's thinking only while nothing up to it differs from the record,
 * and past the record's end nothing keeps its thinking: only the host knows
 * which stored reply answered which request. On a branch with no record, a
 * reply keeps its thinking only with the drop control, for the provider to
 * judge.
 *
 * The record is a Chronicle snapshot state in the manager's namespace, so it
 * is per branch, survives a restart, and a branch made from another starts
 * from the parent's record as of the branch point.
 */

import { createHash } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';
import { canonicalJson } from './canonical-json.js';
import { releaseEditedRawForms } from './raw-forms.js';
import { registerStateIfAbsent } from './state-registration.js';
import type { CompiledMessageSources, RawBodySource, ThinkingStrip } from './types/context.js';
import type { MessageId, Sequence } from './types/message.js';
import type { RequestIdentity, SelectOptions } from './types/strategy.js';

export function isThinkingBlock(block: ContentBlock): boolean {
  return block.type === 'thinking' || (block.type as string) === 'redacted_thinking';
}

/**
 * The content without its thinking blocks, each left out whole, with every
 * raw form a left-out block carried released from the blocks that kept it,
 * as `releaseEditedRawForms` releases them (see raw-forms.ts).
 */
export function withoutThinking(content: ContentBlock[]): ContentBlock[] {
  return releaseEditedRawForms(content, content.filter((block) => !isThinkingBlock(block)));
}

/**
 * The content less the thinking blocks `sent` doesn't hold (the canonical
 * forms `thinkingSent` takes from the compiled messages), raw forms released
 * as `withoutThinking` releases them; the content itself when `sent` holds
 * all of its thinking. A block is matched by its canonical form, cache
 * marker aside: a signature makes each one distinct.
 */
export function thinkingAsSent(content: ContentBlock[], sent: ReadonlySet<string>): ContentBlock[] {
  const left = (block: ContentBlock) => isThinkingBlock(block) && !sent.has(thinkingKey(block));
  if (!content.some(left)) return content;
  return releaseEditedRawForms(content, content.filter((block) => !left(block)));
}

/** Each thinking block `messages` carry, by its canonical form, for `thinkingAsSent`. */
export function thinkingSent(messages: ReadonlyArray<{ content: ContentBlock[] }>): Set<string> {
  const sent = new Set<string>();
  for (const message of messages) for (const block of message.content) if (isThinkingBlock(block)) sent.add(thinkingKey(block));
  return sent;
}

function thinkingKey(block: ContentBlock): string {
  return canonicalJson(withoutCacheMarker(block));
}

/** What a branch last sent, as its record keeps it. */
export interface BindingRecord {
  /** Each message the compile that wrote the record sent, in order: a
   *  digest of its participant and content (`messageDigest`). `[UNVOUCHED]`
   *  once a note came with another head than `identity`: then the record
   *  vouches for nothing until a compile writes it again. */
  sent: string[];
  /** What a host noted after those messages, in order: for each stored
   *  row, a digest of each message the compile makes of it as the strategy
   *  renders it among the newest (a bundled tool cycle makes several), or
   *  `UNVOUCHED` for a row the next compile can't reproduce. Empty until a
   *  note. */
  continued: string[];
  /** The stored bodies that compile sent without their thinking. */
  without: MessageId[];
  /** The head digests that compile sent. */
  identity: RequestIdentity;
  /** The branch's sequence (`JsStore.currentSequence`) when the record
   *  began: a message at or below it was stored before. */
  recordedAfter: Sequence;
  /** The `provenance.compileId` of the committing compile that wrote it: a
   *  note is for that compile's stream only. */
  compileId: string;
}

/** A row of a noted request that matches nothing a compile sends. */
export const UNVOUCHED = '';

export const IDENTITY_KEYS = ['system', 'tools', 'model', 'request'] as const;

/**
 * Refuse a binding compile that can't vouch for the thinking it would keep:
 * one without `thinkingBinding.participant`, which says whose replies are the
 * model's own, or without `identity`, or with a digest that isn't a string.
 */
export function refuseUnboundBinding(opts: SelectOptions): void {
  const participant: unknown = opts.thinkingBinding?.participant;
  if (typeof participant !== 'string' || participant.length === 0) {
    throw new TypeError(
      '`thinkingBinding.binds` needs `thinkingBinding.participant`: the participant whose messages are ' +
        "the model's own replies, such as the agent's name",
    );
  }
  if (typeof opts.identity !== 'object' || opts.identity === null) {
    throw new TypeError("`thinkingBinding.binds` needs `identity`: the digests of what the request carries before its messages");
  }
  refuseUnreadableIdentity(opts.identity);
}

/** Refuse head digests that aren't all strings: written to a record, they
 *  would leave it unreadable. */
export function refuseUnreadableIdentity(identity: unknown): void {
  if (typeof identity !== 'object' || identity === null) {
    throw new TypeError(`\`identity\` must be an object of four digests, got ${identity === null ? 'null' : typeof identity}`);
  }
  for (const key of IDENTITY_KEYS) {
    const value: unknown = (identity as Record<string, unknown>)[key];
    if (typeof value !== 'string') {
      throw new TypeError(`\`identity.${key}\` must be a string, got ${value === null ? 'null' : typeof value}`);
    }
  }
}

export function bindingStateId(namespace: string): string {
  return `${namespace}/thinking-binding`;
}

export function registerBindingState(store: JsStore, namespace: string): void {
  registerStateIfAbsent(store, { id: bindingStateId(namespace), strategy: 'snapshot' });
}

/**
 * The branch's record, or null when it has none. A value that isn't a
 * record's shape is reported as malformed and read as no record.
 */
export function readBindingRecord(store: JsStore, namespace: string): { record: BindingRecord | null; malformed: boolean } {
  const value = store.getStateJson(bindingStateId(namespace)) as unknown;
  if (value === null || value === undefined) return { record: null, malformed: false };
  return isBindingRecord(value) ? { record: value, malformed: false } : { record: null, malformed: true };
}

export function writeBindingRecord(store: JsStore, namespace: string, record: BindingRecord): void {
  store.setStateJson(bindingStateId(namespace), record);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBindingRecord(value: unknown): value is BindingRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!isStringArray(v.sent) || !isStringArray(v.continued) || !isStringArray(v.without)) return false;
  if (!isSequence(v.recordedAfter) || typeof v.compileId !== 'string') return false;
  if (typeof v.identity !== 'object' || v.identity === null || Array.isArray(v.identity)) return false;
  const identity = v.identity as Record<string, unknown>;
  return IDENTITY_KEYS.every((key) => typeof identity[key] === 'string');
}

/**
 * A compiled message's digest: its participant and content, keys in canonical
 * order, so a block read back from the store (keys sorted) and the same block
 * as built compare equal, as the provider reads them. A cache breakpoint isn't
 * part of it, nor a block's own cache marker (`cache_control`,
 * `cacheControl`): the binding doesn't count them, as observed in a run on
 * Anthropic's API on 2026-10-23 (Haiku 5.5 with the drop control, on an
 * account that enforces the binding and on one that doesn't): moving only a
 * cache marker, onto or off a block before two replies, dropped neither
 * reply's thinking, where changing one word dropped both. Other binding
 * models weren't run for markers. 66 bits of
 * SHA-256 are kept: a digest is only ever compared with the one recorded at
 * the same place.
 */
export function messageDigest(message: Pick<NormalizedMessage, 'participant' | 'content'>): string {
  return createHash('sha256')
    .update(canonicalJson({ p: message.participant, c: message.content.map(withoutCacheMarker) }))
    .digest('base64url')
    .slice(0, 11);
}

function withoutCacheMarker(block: ContentBlock): unknown {
  const marked = block as unknown as Record<string, unknown>;
  if (!('cache_control' in marked) && !('cacheControl' in marked)) return block;
  const { cache_control: _snake, cacheControl: _camel, ...rest } = marked;
  return rest;
}

export interface BindInput {
  /** The compiled messages, injections placed. */
  messages: readonly NormalizedMessage[];
  /** Parallel to `messages`. */
  sources: readonly CompiledMessageSources[];
  record: BindingRecord | null;
  dropBlock: boolean;
  identity: RequestIdentity;
  /** The participant whose messages are the model's own replies. */
  participant: string;
  /** The branch's sequence now (`JsStore.currentSequence`). */
  sequence: Sequence;
  /** This compile's `provenance.compileId`. */
  compileId: string;
}

export interface BindOutcome {
  /** The messages to send. */
  messages: NormalizedMessage[];
  /** Set when a reply's thinking is newly left out. */
  strip?: ThinkingStrip;
  /** What a committing compile records. Its `without` is every stored body
   *  whose thinking this compile leaves out. */
  record: BindingRecord;
  /** The thinking blocks left out of messages with a stored body, which a
   *  strategy's select priced; an injection's never were. */
  leftOut: ContentBlock[];
}

/**
 * Mark each raw body in `without` as not carried whole: a compile left its
 * thinking out, a block removed (`RawBodySource.missing` gains 'content').
 */
export function markThinkingLeftOut(sources: readonly CompiledMessageSources[], without: ReadonlySet<MessageId>): void {
  for (const source of sources) {
    if (source.kind !== 'raw') continue;
    for (const body of source.bodies) {
      if (!without.has(body.messageId)) continue;
      body.complete = false;
      body.missing = [...new Set<'shards' | 'content'>([...(body.missing ?? []), 'content'])];
    }
  }
}

function rawBodies(source: CompiledMessageSources | undefined): RawBodySource[] {
  return source?.kind === 'raw' ? source.bodies : [];
}

/**
 * Decide which compiled messages keep their thinking (see
 * `SelectOptions.thinkingBinding`), and the record that compile leaves.
 *
 * A message keeps its thinking only when it is the participant's own, from a
 * stored body; none of its bodies was sent without thinking by the record's
 * compile; it was stored after the record began, unless the request carries
 * the drop control; and, where there is a record, nothing up to it differs
 * from the record, which it is within. With no record, only the drop control
 * keeps a reply's thinking. Any other message's thinking (another
 * participant's, a summary's recall, an injection) was never minted in this
 * agent's requests, and is always left out.
 */
export function bindThinking(input: BindInput): BindOutcome {
  const { record, identity, participant } = input;
  const recordedAfter = record?.recordedAfter ?? input.sequence;
  const recorded = record ? [...record.sent, ...record.continued] : [];
  const changed = record ? IDENTITY_KEYS.filter((key) => identity[key] !== record.identity[key]) : [];
  let diverged = changed.length > 0;
  const wasWithout = new Set(record?.without ?? []);
  const messages: NormalizedMessage[] = [];
  const sent: string[] = [];
  const without = new Set<MessageId>();
  const newly = new Set<MessageId>();
  let newlyBeforeRecord = false;
  const leftOut: ContentBlock[] = [];
  const stripped = (message: NormalizedMessage): NormalizedMessage => ({ ...message, content: withoutThinking(message.content) });

  for (let i = 0; i < input.messages.length; i++) {
    const message = input.messages[i]!;
    const bodies = rawBodies(input.sources[i]);
    const thinking = message.content.some(isThinkingBlock);
    // The participant's own reply, from stored bodies, not left out before.
    const owned = thinking && bodies.length > 0 && message.participant === participant &&
      !bodies.some((body) => wasWithout.has(body.messageId));
    // Stored before the record began, and the provider won't set it aside.
    const beforeRecord = !input.dropBlock && bodies.some((body) => body.sequence <= recordedAfter);
    let keep = owned && !beforeRecord;
    if (owned && beforeRecord) {
      for (const body of bodies) newly.add(body.messageId);
      newlyBeforeRecord = true;
    }
    let out = thinking && !keep ? stripped(message) : message;
    let digest = messageDigest(out);
    // Past the record's end, nothing was vouched for.
    if (!diverged && record !== null) diverged = i >= recorded.length || digest !== recorded[i];
    if (diverged && keep) {
      keep = false;
      out = stripped(message);
      digest = messageDigest(out);
      for (const body of bodies) newly.add(body.messageId);
    }
    if (thinking && !keep && bodies.length > 0) {
      for (const block of message.content) if (isThinkingBlock(block)) leftOut.push(block);
      for (const body of bodies) without.add(body.messageId);
    }
    messages.push(out);
    sent.push(digest);
  }

  const cause: ThinkingStrip['cause'] = changed.length > 0 ? 'head' : newlyBeforeRecord ? 'first' : 'messages';
  return {
    messages,
    ...(newly.size > 0 ? { strip: { newly: [...newly], cause, ...(cause === 'head' ? { changed } : {}) } } : {}),
    record: {
      sent,
      continued: [],
      without: [...without],
      identity: copyIdentity(identity),
      recordedAfter,
      compileId: input.compileId,
    },
    leftOut,
  };
}

function copyIdentity(identity: RequestIdentity): RequestIdentity {
  return { system: identity.system, tools: identity.tools, model: identity.model, request: identity.request };
}

/**
 * The record once a host has noted the rows it sent after the messages of
 * the compile that wrote it (`continued`, each a digest or `UNVOUCHED`),
 * with the head `identity`. A note with another head than the record's
 * carried thinking minted under the old one: the record keeps its head and
 * vouches for nothing until a compile writes it again, so the next compile
 * under the new head reports the head change.
 */
export function continueRecord(record: BindingRecord, continued: string[], identity: RequestIdentity): BindingRecord {
  const sameHead = IDENTITY_KEYS.every((key) => identity[key] === record.identity[key]);
  return sameHead ? { ...record, continued } : { ...record, sent: [UNVOUCHED], continued: [] };
}
