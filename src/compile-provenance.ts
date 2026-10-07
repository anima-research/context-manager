/**
 * Compile provenance: what each compiled message is a copy of, and the
 * rendered layout one compile produced.
 *
 * Both are derived from the entries the strategy actually emitted, never
 * from a plan: a raw copy is an entry with `sourceRelation: 'copy'` naming
 * its source ids, a summary is an entry naming its summaries, and a message
 * of the strategy's view represented by neither was not rendered (omitted).
 *
 * Completeness of a raw copy is judged against the stored body: a copy is
 * complete only when every shard of the body is present and every block
 * arrived unaltered (no truncation, no stripped image, no block removed by a
 * structural repair).
 */

import type { ContentBlock } from '@animalabs/membrane';
import type {
  CompiledMessageSources,
  ContextEntry,
  LayoutUnit,
  MessageId,
  RawBodySource,
  RenderedLayout,
  RenderedSummaryInfo,
  StoredMessage,
} from './types/index.js';

/** Per-body completeness, aggregated over every raw entry of one compile. */
interface BodyState {
  /** First shard (or the message itself). */
  head: StoredMessage;
  /** Every stored member of the body, in shard order. */
  members: StoredMessage[];
  /** Member ids present raw in this compile. */
  present: Set<MessageId>;
  /** False once any entry carrying part of the body altered it. */
  contentOk: boolean;
}

export interface EntryProvenance {
  /** Sources per entry, parallel to the strategy's entries. */
  sources: CompiledMessageSources[];
  /** Raw message id -> whether its body was complete in this compile. */
  rawComplete: Map<MessageId, boolean>;
}

function isRawEntry(entry: ContextEntry): boolean {
  if (entry.sourceRelation === 'derived' || entry.sourceRelation === 'referenced') return false;
  return entry.sourceMessageId !== undefined || (entry.sourceMessageIds?.length ?? 0) > 0;
}

function entrySourceIds(entry: ContextEntry): MessageId[] {
  if (entry.sourceMessageIds && entry.sourceMessageIds.length > 0) return [...entry.sourceMessageIds];
  return entry.sourceMessageId !== undefined ? [entry.sourceMessageId] : [];
}

/**
 * Attribute every entry of one compile. `stored` is every message the
 * compile read, before any view filter (ordered by sequence): a body is
 * judged as stored, so a shard the filter hid from the strategy still
 * belongs to its body, whose head is shard 0 whether or not it was visible.
 */
export function attributeEntries(entries: readonly ContextEntry[], stored: readonly StoredMessage[]): EntryProvenance {
  const byId = new Map<MessageId, StoredMessage>();
  const groups = new Map<string, StoredMessage[]>();
  for (const msg of stored) {
    byId.set(msg.id, msg);
    if (msg.bodyGroupId) {
      const list = groups.get(msg.bodyGroupId);
      if (list) list.push(msg);
      else groups.set(msg.bodyGroupId, [msg]);
    }
  }
  for (const list of groups.values()) list.sort((a, b) => (a.shardIndex ?? 0) - (b.shardIndex ?? 0));

  const bodies = new Map<string, BodyState>();
  const bodyKeyOf = (msg: StoredMessage): string => msg.bodyGroupId ? `g:${msg.bodyGroupId}` : `m:${msg.id}`;
  const bodyOf = (msg: StoredMessage): BodyState => {
    const key = bodyKeyOf(msg);
    let state = bodies.get(key);
    if (!state) {
      const members = msg.bodyGroupId ? groups.get(msg.bodyGroupId) ?? [msg] : [msg];
      state = { head: members[0]!, members, present: new Set(), contentOk: true };
      bodies.set(key, state);
    }
    return state;
  };

  // Pass 1: which members each raw entry carries, and whether it carried
  // them unaltered.
  const entryBodies: Array<BodyState[] | null> = [];
  for (const entry of entries) {
    if (!isRawEntry(entry)) {
      entryBodies.push(null);
      continue;
    }
    const sourceMessages = entrySourceIds(entry)
      .map((id) => byId.get(id))
      .filter((m): m is StoredMessage => m !== undefined);
    const states: BodyState[] = [];
    for (const msg of sourceMessages) {
      const state = bodyOf(msg);
      state.present.add(msg.id);
      if (!states.includes(state)) states.push(state);
    }
    const unaltered = sourceMessages.length === 1
      ? coversStoredContent(entry.content, sourceMessages[0]!.content)
      : sourceMessages.length > 1 && compositeCovers(entry.content, sourceMessages);
    if (!unaltered) for (const state of states) state.contentOk = false;
    entryBodies.push(states);
  }

  // Pass 2: per-entry sources with request-level completeness. A group that
  // declared its size must hold exactly that many shards, indices 0..n-1: an
  // interrupted write leaves immutable members that are not the whole body.
  // A group without a declaration (written before it was recorded) can only
  // be judged by the members stored for it: complete then means every one of
  // them was carried, not that the group was written whole.
  const wholeGroup = (state: BodyState): boolean => {
    const declared = state.head.shardCount;
    if (declared === undefined) return true;
    const indices = new Set(state.members.map((m) => m.shardIndex));
    return state.members.length === declared && indices.size === declared
      && [...indices].every((i) => i !== undefined && i >= 0 && i < declared);
  };
  const allShards = (state: BodyState): boolean =>
    wholeGroup(state) && state.members.every((m) => state.present.has(m.id));
  const complete = (state: BodyState): boolean => state.contentOk && allShards(state);
  const rawComplete = new Map<MessageId, boolean>();
  for (const state of bodies.values()) {
    const ok = complete(state);
    for (const id of state.present) rawComplete.set(id, ok);
  }

  const sources: CompiledMessageSources[] = entries.map((entry, i) => {
    const states = entryBodies[i];
    if (states) {
      const out: RawBodySource[] = states.map((state) => {
        const ok = complete(state);
        const missing: Array<'shards' | 'content'> = [];
        if (!allShards(state)) missing.push('shards');
        if (!state.contentOk) missing.push('content');
        return {
          messageId: state.head.id,
          sequence: state.head.sequence,
          complete: ok,
          ...(ok ? {} : { missing }),
        };
      });
      return { kind: 'raw', bodies: out };
    }
    if (entry.summaries && entry.summaries.length > 0) {
      return {
        kind: 'summary',
        summaries: entry.summaries.map((s) => (s.partial ? { id: s.id, level: s.level, partial: true as const } : { id: s.id, level: s.level })),
      };
    }
    return { kind: 'other' };
  });

  return { sources, rawComplete };
}

/**
 * Build the rendered layout of one compile: one unit per raw message, and
 * ranges for summarized and omitted messages, in view order.
 *
 * `estimateBase` returns a base (calibration-free) token estimate for some
 * rendered content. Raw message tokens are their entry's estimate, split
 * evenly across the messages a composite entry carries; a summary's tokens
 * are the estimates of the entries that render it, named in every unit the
 * summary renders (comparisons count each summary once per side).
 */
export function buildRenderedLayout(opts: {
  view: readonly StoredMessage[];
  entries: readonly ContextEntry[];
  rawComplete: ReadonlyMap<MessageId, boolean>;
  summaryInfo: ReadonlyMap<string, RenderedSummaryInfo>;
  estimateBase: (content: ContentBlock[]) => number;
  /** Base tokens of rendered content that is not an entry (injections). */
  extraTokens: number;
  calibration: number;
  cause?: string;
}): RenderedLayout {
  const rawTokens = new Map<MessageId, number>();
  const summaryTokens = new Map<string, number>();
  const partialSummaries = new Set<string>();
  let totalTokens = opts.extraTokens;

  for (const entry of opts.entries) {
    const tokens = opts.estimateBase(entry.content);
    totalTokens += tokens;
    if (isRawEntry(entry)) {
      const ids = entrySourceIds(entry);
      const share = ids.length > 0 ? tokens / ids.length : 0;
      for (const id of ids) rawTokens.set(id, (rawTokens.get(id) ?? 0) + share);
    } else if (entry.summaries && entry.summaries.length > 0) {
      const share = tokens / entry.summaries.length;
      for (const s of entry.summaries) {
        summaryTokens.set(s.id, (summaryTokens.get(s.id) ?? 0) + share);
        if (s.partial) partialSummaries.add(s.id);
      }
    }
  }

  // Which rendered summaries cover each message.
  const coveredBy = new Map<MessageId, string[]>();
  for (const [id, info] of opts.summaryInfo) {
    for (const leaf of info.leaves) {
      const list = coveredBy.get(leaf);
      if (list) {
        if (!list.includes(id)) list.push(id);
      } else {
        coveredBy.set(leaf, [id]);
      }
    }
  }

  const units: LayoutUnit[] = [];
  for (const msg of opts.view) {
    if (rawTokens.has(msg.id)) {
      const unit: LayoutUnit = { k: 'r', s: msg.sequence, id: msg.id, t: Math.round(rawTokens.get(msg.id)!) };
      if (opts.rawComplete.get(msg.id) === false) unit.p = 1;
      units.push(unit);
      continue;
    }
    const covering = coveredBy.get(msg.id);
    if (covering && covering.length > 0) {
      const ids = [...covering].sort();
      const last = units[units.length - 1];
      if (last && last.k === 's' && sameIds(last.sm.map((s) => s[0]), ids)) {
        extend(last, msg);
        continue;
      }
      const sm: Array<[string, number, string, 0 | 1, number]> = [];
      for (const id of ids) {
        const info = opts.summaryInfo.get(id)!;
        sm.push([id, info.level, info.method, partialSummaries.has(id) ? 1 : 0, Math.round(summaryTokens.get(id) ?? 0)]);
      }
      units.push({
        k: 's', a: msg.sequence, ai: msg.id, b: msg.sequence, bi: msg.id,
        m: [[msg.sequence, msg.id, msg.sequence, msg.id]], sm,
      });
      continue;
    }
    const last = units[units.length - 1];
    if (last && last.k === 'o') {
      extend(last, msg);
      continue;
    }
    units.push({ k: 'o', a: msg.sequence, ai: msg.id, b: msg.sequence, bi: msg.id, m: [[msg.sequence, msg.id, msg.sequence, msg.id]] });
  }

  return {
    v: 1,
    units,
    totalTokens: Math.round(totalTokens),
    calibration: opts.calibration,
    ...(opts.cause ? { cause: opts.cause } : {}),
  };
}

/** Add the next view message to a range unit, keeping its exact membership. */
function extend(unit: Extract<LayoutUnit, { k: 's' | 'o' }>, msg: StoredMessage): void {
  unit.b = msg.sequence;
  unit.bi = msg.id;
  const run = unit.m[unit.m.length - 1]!;
  if (run[2] + 1 === msg.sequence) {
    run[2] = msg.sequence;
    run[3] = msg.id;
  } else {
    unit.m.push([msg.sequence, msg.id, msg.sequence, msg.id]);
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The stored messages behind every raw body the sources name, from the
 * messages the compile read (the same `stored` list attribution judged
 * bodies by): each body's head and every shard of a sharded body.
 */
export function rawSourcesOf(
  sources: readonly CompiledMessageSources[],
  stored: readonly StoredMessage[],
): ReadonlyMap<MessageId, StoredMessage> {
  const heads = new Set<MessageId>();
  for (const source of sources) {
    if (source.kind === 'raw') for (const body of source.bodies) heads.add(body.messageId);
  }
  const out = new Map<MessageId, StoredMessage>();
  if (heads.size === 0) return out;
  const groups = new Set<string>();
  for (const msg of stored) {
    if (heads.has(msg.id)) {
      out.set(msg.id, msg);
      if (msg.bodyGroupId) groups.add(msg.bodyGroupId);
    }
  }
  if (groups.size > 0) {
    for (const msg of stored) {
      if (msg.bodyGroupId && groups.has(msg.bodyGroupId)) out.set(msg.id, msg);
    }
  }
  return out;
}

/**
 * A composite entry (the strategy merged several shards into one message)
 * carries its members unaltered only when it carries their text,
 * concatenated in shard order, intact, and every non-text block of theirs,
 * unaltered and in their order, among its own non-text blocks. A composite
 * gathers the text into one block, so where a non-text block sits relative
 * to the text is not compared.
 */
function compositeCovers(content: ContentBlock[], members: StoredMessage[]): boolean {
  const ordered = [...members].sort((a, b) => (a.shardIndex ?? 0) - (b.shardIndex ?? 0));
  const storedBlocks = ordered.flatMap((msg) => msg.content);
  const textOf = (blocks: readonly ContentBlock[]): string =>
    blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
  if (!textOf(content).includes(textOf(storedBlocks))) return false;
  return coversStoredContent(
    content.filter((b) => b.type !== 'text'),
    storedBlocks.filter((b) => b.type !== 'text'),
  );
}

/**
 * Whether a rendered copy carries every block of the stored body intact, in
 * order. Additions are allowed (a strategy may prefix a provenance header or
 * merge it into the first text block); losses are not: a truncated text, a
 * stripped image, or a block a structural repair removed makes the copy
 * partial. Each stored block must be covered by a later rendered block of
 * the same kind — a text block by one that contains its whole text.
 */
export function coversStoredContent(rendered: readonly ContentBlock[], stored: readonly ContentBlock[]): boolean {
  if (rendered === stored) return true;
  let j = 0;
  for (const block of stored) {
    if (block.type === 'text' && block.text === '') continue; // carries nothing
    while (j < rendered.length && !covers(rendered[j]!, block)) j++;
    if (j >= rendered.length) return false;
    j++;
  }
  return true;
}

function covers(rendered: ContentBlock, stored: ContentBlock): boolean {
  if (rendered === stored) return true;
  if (rendered.type === 'text' && stored.type === 'text') return rendered.text.includes(stored.text);
  return sameBlock(rendered, stored);
}

function sameBlocks(a: readonly ContentBlock[], b: readonly ContentBlock[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameBlock(a[i]!, b[i]!)) return false;
  }
  return true;
}

function sameBlock(x: ContentBlock, y: ContentBlock): boolean {
  if (x === y) return true;
  if (x.type !== y.type) return false;
  const a = x as unknown as Record<string, unknown>;
  const b = y as unknown as Record<string, unknown>;
  switch (x.type) {
    case 'text':
      return a.text === b.text;
    case 'thinking':
      return a.thinking === b.thinking && a.signature === b.signature;
    case 'redacted_thinking':
      return a.data === b.data;
    case 'tool_use':
      return a.id === b.id && a.name === b.name && JSON.stringify(a.input) === JSON.stringify(b.input);
    case 'tool_result':
      return a.toolUseId === b.toolUseId &&
        (a.isError ?? false) === (b.isError ?? false) &&
        (typeof a.content === 'string' && typeof b.content === 'string'
          ? a.content === b.content
          : sameNested(a.content, b.content));
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
      return sameMediaSource(a.source, b.source);
    default:
      return JSON.stringify(a) === JSON.stringify(b);
  }
}

function sameNested(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return sameBlocks(a as ContentBlock[], b as ContentBlock[]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Media sources are equal only when every field that carries the payload is
 * exactly equal: the kind, the media type, and the URL or the whole data.
 * A sampled comparison could call different bytes the same, and the
 * complete-body claim rests on this.
 */
function sameMediaSource(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const sa = a as Record<string, unknown>;
  const sb = b as Record<string, unknown>;
  if (sa.type !== sb.type) return false;
  if ((sa.media_type ?? sa.mediaType) !== (sb.media_type ?? sb.mediaType)) return false;
  if (typeof sa.url === 'string' || typeof sb.url === 'string') return sa.url === sb.url;
  return sa.data === sb.data;
}
