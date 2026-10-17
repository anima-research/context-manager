/**
 * Raw-body attribution (compile-provenance.ts): when a compiled copy carries
 * its stored body completely, and when it does not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { attributeEntries as attributeIn, coversStoredContent, rawBodiesOf } from '../src/compile-provenance.js';
import type { ContextEntry, StoredMessage } from '../src/index.js';

/** Attribution over `stored`, resolving an id to its sequence among those messages, as a store's lookup does. */
function attributeEntries(entries: readonly ContextEntry[], stored: readonly StoredMessage[]) {
  return attributeIn(entries, stored, (id) => stored.find((m) => m.id === id)?.sequence);
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const image = (data: string): ContentBlock => ({ type: 'image', source: { type: 'base64', data, mediaType: 'image/png' } } as ContentBlock);

function msg(id: string, sequence: number, content: ContentBlock[], extra: Partial<StoredMessage> = {}): StoredMessage {
  return { id, sequence, participant: 'user', content, timestamp: new Date(0), ...extra } as StoredMessage;
}

function textOf(m: StoredMessage): string {
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

function copy(m: StoredMessage, content: ContentBlock[] = m.content): ContextEntry {
  return { index: 0, sourceMessageId: m.id, sourceRelation: 'copy', participant: m.participant, content };
}

describe('coversStoredContent', () => {
  it('accepts an identical body and one with a prefixed header', () => {
    const stored = [text('hello'), image('AAAA')];
    assert.ok(coversStoredContent(stored, stored));
    assert.ok(coversStoredContent([text('[discord #general] hello'), image('AAAA')], stored), 'header merged into the first text block');
    assert.ok(coversStoredContent([text('[header]'), text('hello'), image('AAAA')], stored), 'header as its own block');
  });

  it('rejects truncation, a stripped image and a removed block', () => {
    const stored = [text('hello world'), image('AAAA'), text('tail')];
    assert.equal(coversStoredContent([text('hello'), image('AAAA'), text('tail')], stored), false);
    assert.equal(coversStoredContent([text('hello world'), text('[image omitted]'), text('tail')], stored), false);
    assert.equal(coversStoredContent([text('hello world'), image('AAAA')], stored), false);
  });

  it('accepts text blocks a strategy joined into one, in order, and nothing out of order', () => {
    const stored = [text('first part. '), text('second part.'), image('AAAA')];
    assert.ok(coversStoredContent([text('first part. second part.'), image('AAAA')], stored), 'joined into one block');
    assert.ok(coversStoredContent([text('[h] first part. second part. [t]'), image('AAAA')], stored), 'joined, with a header and a tail');
    assert.equal(coversStoredContent([text('second part. first part.'), image('AAAA')], stored), false, 'out of order');
    assert.equal(coversStoredContent([text('first part. '), image('AAAA'), text('second part.')], stored), false, 'past the image');
  });

  it('compares media exactly: same length and same ends are not the same bytes', () => {
    const head = 'A'.repeat(64);
    const stored = [image(`${head}${'B'.repeat(100)}${head}`)];
    const altered = [image(`${head}${'C'.repeat(100)}${head}`)];
    assert.equal(coversStoredContent(altered, stored), false);
    assert.ok(coversStoredContent([image(`${head}${'B'.repeat(100)}${head}`)], stored));
  });

  it('ignores empty stored text, which carries nothing', () => {
    assert.ok(coversStoredContent([text('a')], [text(''), text('a')]));
  });
});

describe('attributeEntries', () => {
  it('marks a body complete only when every shard renders raw and unaltered', () => {
    const g = { bodyGroupId: 'g1' };
    const s0 = msg('s0', 1, [text('part one ')], { ...g, shardIndex: 0 });
    const s1 = msg('s1', 2, [text('part two')], { ...g, shardIndex: 1 });
    const other = msg('o', 3, [text('solo')]);
    const view = [s0, s1, other];

    const whole = attributeEntries([copy(s0), copy(s1), copy(other)], view);
    assert.deepEqual(whole.sources.map((s) => s.kind === 'raw' && s.bodies.map((b) => [b.messageId, b.complete])), [
      [['s0', true]],
      [['s0', true]],
      [['o', true]],
    ]);

    const oneShard = attributeEntries([copy(s1), copy(other)], view);
    const first = oneShard.sources[0]!;
    assert.ok(first.kind === 'raw');
    assert.deepEqual(first.bodies[0], { messageId: 's0', sequence: 1, complete: false, missing: ['shards'] });
    assert.equal(oneShard.rawComplete.get('s1'), false);

    const composite: ContextEntry = {
      index: 0,
      sourceMessageIds: ['s0', 's1'],
      sourceRelation: 'copy',
      participant: 'user',
      content: [text('part one part two')],
    };
    const joined = attributeEntries([composite], view);
    assert.ok(joined.sources[0]!.kind === 'raw' && joined.sources[0]!.bodies[0]!.complete, 'a composite carrying every shard intact is complete');

    const cut: ContextEntry = { ...composite, content: [text('part one part')] };
    const partial = attributeEntries([cut], view);
    assert.deepEqual(partial.sources[0]!.kind === 'raw' && partial.sources[0]!.bodies[0]!.missing, ['content']);
  });

  it('a group that declared its size is whole only with every declared shard stored', () => {
    const declared = { bodyGroupId: 'g2', shardCount: 2 };
    const head = msg('h0', 1, [text('[header]')], { ...declared, shardIndex: 0 });
    // An interrupted write stored only the first of two shards: every member
    // the view has is carried, unaltered, yet the body is not whole.
    const short = attributeEntries([copy(head)], [head]);
    assert.ok(short.sources[0]!.kind === 'raw');
    assert.deepEqual(short.sources[0]!.bodies[0], { messageId: 'h0', sequence: 1, complete: false, missing: ['shards'] });
    assert.equal(short.rawComplete.get('h0'), false);

    const tail = msg('h1', 2, [text('body')], { ...declared, shardIndex: 1 });
    const whole = attributeEntries([copy(head), copy(tail)], [head, tail]);
    assert.ok(whole.sources[0]!.kind === 'raw' && whole.sources[0]!.bodies[0]!.complete);

    // A group written before sizes were declared is judged by the members it has.
    const legacy = msg('l0', 3, [text('old')], { bodyGroupId: 'g3', shardIndex: 0 });
    const legacyOnly = attributeEntries([copy(legacy)], [legacy]);
    assert.ok(legacyOnly.sources[0]!.kind === 'raw' && legacyOnly.sources[0]!.bodies[0]!.complete);
  });

  it('a composite carrying its members\' media unaltered is complete; a dropped or different image, or cut text, is not', async () => {
    const { AutobiographicalStrategy } = await import('../src/index.js');
    class Merger extends AutobiographicalStrategy {
      merge(entries: ContextEntry[], messages: StoredMessage[]): ContextEntry[] {
        return this.mergeAdjacentBodyGroupRaw(entries, {} as never, messages);
      }
    }
    // As autobiographical's ingress chunker shards a body with an image: the
    // text across the shards, the image on shard 0 after its text.
    const g = { bodyGroupId: 'gm', shardCount: 2 };
    const s0 = msg('m0', 1, [text('part one '), image('AAAA')], { ...g, shardIndex: 0 });
    const s1 = msg('m1', 2, [text('part two')], { ...g, shardIndex: 1 });
    const stored = [s0, s1];
    // The strategy's own composite: media first, then the text joined.
    const [merged] = new Merger({}).merge([copy(s0), copy(s1)], stored);
    assert.deepEqual(merged!.content, [image('AAAA'), text('part one part two')]);
    const bodyOf = (entry: ContextEntry) => {
      const source = attributeEntries([entry], stored).sources[0]!;
      assert.ok(source.kind === 'raw');
      return source.bodies[0]!;
    };
    assert.deepEqual(bodyOf(merged!), { messageId: 'm0', sequence: 1, complete: true });
    const variant = (content: ContentBlock[]): ContextEntry => ({ ...merged!, content });
    assert.deepEqual(bodyOf(variant([text('part one part two')])).missing, ['content'], 'the image was dropped');
    assert.deepEqual(bodyOf(variant([image('AAAB'), text('part one part two')])).missing, ['content'], 'a different image');
    assert.deepEqual(bodyOf(variant([image('AAAA'), text('part one part')])).missing, ['content'], 'cut text');
    assert.deepEqual(bodyOf(variant([text('[header] '), image('AAAA'), text('part one part two')])), { messageId: 'm0', sequence: 1, complete: true }, 'additions are allowed');
  });

  it('judges a body as stored, so a member the view filter hid is missing and the head keeps its id', () => {
    // A view filter hid shard 0 from the strategy, which carried shard 1.
    // Attribution reads the stored group: the head is still shard 0.
    const declared = { bodyGroupId: 'gf', shardCount: 2 };
    const h0 = msg('f0', 1, [text('[header]')], { ...declared, shardIndex: 0 });
    const h1 = msg('f1', 2, [text('body')], { ...declared, shardIndex: 1 });
    const result = attributeEntries([copy(h1)], [h0, h1]);
    assert.deepEqual(result.sources[0], { kind: 'raw', bodies: [{ messageId: 'f0', sequence: 1, complete: false, missing: ['shards'] }] });
    assert.equal(result.rawComplete.get('f1'), false);
    assert.deepEqual([...rawBodiesOf(result).entries()].map(([k, v]) => [k, v.map((m) => m.id)]), [['f0', ['f0', 'f1']]]);

    // A group written before sizes were declared: complete means every
    // stored member was carried, and a hidden one was not.
    const l0 = msg('l0', 3, [text('old ')], { bodyGroupId: 'gl', shardIndex: 0 });
    const l1 = msg('l1', 4, [text('body')], { bodyGroupId: 'gl', shardIndex: 1 });
    const legacy = attributeEntries([copy(l1)], [l0, l1]);
    assert.deepEqual(legacy.sources[0], { kind: 'raw', bodies: [{ messageId: 'l0', sequence: 3, complete: false, missing: ['shards'] }] });
  });

  it('reports a truncated or image-stripped copy as missing content', () => {
    const m = msg('m', 1, [text('long body text'), image('AAAA')]);
    const result = attributeEntries([copy(m, [text('long'), text('[image omitted]')])], [m]);
    assert.deepEqual(result.sources[0], { kind: 'raw', bodies: [{ messageId: 'm', sequence: 1, complete: false, missing: ['content'] }] });
  });

  it('names summaries (with a cut one marked partial) and leaves other derived entries as other', () => {
    const entries: ContextEntry[] = [
      { index: 0, participant: 'Claude', sourceRelation: 'derived', content: [text('s')], summaries: [{ id: 'L1-1', level: 1, partial: true }] },
      { index: 1, participant: 'system', sourceRelation: 'derived', content: [text('notice')] },
    ];
    const result = attributeEntries(entries, []);
    assert.deepEqual(result.sources, [
      { kind: 'summary', summaries: [{ id: 'L1-1', level: 1, partial: true }] },
      { kind: 'other' },
    ]);
  });
});

describe('a body is an ingestion, not its content hash', () => {
  it('separates two ingestions of the same text, apart or back to back, each with only its own shards', () => {
    const g = { bodyGroupId: 'bg-same', shardCount: 2 };
    const a0 = msg('a0', 1, [text('same ')], { ...g, shardIndex: 0 });
    const a1 = msg('a1', 2, [text('text')], { ...g, shardIndex: 1 });
    const mid = msg('mid', 3, [text('between')]);
    const b0 = msg('b0', 4, [text('same ')], { ...g, shardIndex: 0 });
    const b1 = msg('b1', 5, [text('text')], { ...g, shardIndex: 1 });
    const c0 = msg('c0', 6, [text('same ')], { ...g, shardIndex: 0 });
    const c1 = msg('c1', 7, [text('text')], { ...g, shardIndex: 1 });
    const stored = [a0, a1, mid, b0, b1, c0, c1];
    const result = attributeEntries([copy(a0), copy(a1), copy(mid), copy(b0), copy(b1), copy(c0), copy(c1)], stored);
    const heads = result.sources.flatMap((s) => (s.kind === 'raw' ? s.bodies.map((b) => [b.messageId, b.complete]) : []));
    assert.deepEqual(heads, [['a0', true], ['a0', true], ['mid', true], ['b0', true], ['b0', true], ['c0', true], ['c0', true]]);
    const bodies = rawBodiesOf(result);
    assert.deepEqual([...bodies.entries()].map(([k, v]) => [k, v.map((m) => m.id)]), [
      ['a0', ['a0', 'a1']], ['mid', ['mid']], ['b0', ['b0', 'b1']], ['c0', ['c0', 'c1']],
    ]);

    // Carrying only the later ingestion's shards says nothing about the
    // earlier one, and does not borrow it.
    const later = attributeEntries([copy(c0), copy(c1)], stored);
    assert.deepEqual(later.sources[0], { kind: 'raw', bodies: [{ messageId: 'c0', sequence: 6, complete: true }] });
  });

  it('reads bodies as body-runs.ts does, whatever the list and whichever of its messages the entries name, in any order', async () => {
    const { bodyBoundsIn } = await import('../src/index.js');
    const g = { bodyGroupId: 'bg-rule', shardCount: 2 };
    const lists: StoredMessage[][] = [
      // back to back, apart, and a shard 0 removed
      [msg('a0', 1, [text('a')], { ...g, shardIndex: 0 }), msg('a1', 2, [text('b')], { ...g, shardIndex: 1 }),
        msg('b0', 3, [text('a')], { ...g, shardIndex: 0 }), msg('b1', 4, [text('b')], { ...g, shardIndex: 1 }),
        msg('x', 5, [text('solo')]), msg('c1', 6, [text('b')], { ...g, shardIndex: 1 })],
      // a list in which something sits between two rising shards of one group
      [msg('p0', 1, [text('a')], { ...g, shardIndex: 0 }), msg('mid', 2, [text('between')]), msg('p1', 3, [text('b')], { ...g, shardIndex: 1 })],
    ];
    for (const stored of lists) {
      const selections = [
        stored,
        [...stored].reverse(),
        stored.filter((_, i) => i % 2 === 1),
        [stored[stored.length - 1]!],
      ];
      for (const named of selections) {
        const { bodies, sources } = attributeEntries(named.map((m) => copy(m)), stored);
        named.forEach((m, k) => {
          const { from, to } = bodyBoundsIn(stored, stored.indexOf(m));
          const body = stored.slice(from, to + 1).map((b) => b.id);
          assert.deepEqual(bodies.get(m.id)!.map((b) => b.id), body, m.id);
          const source = sources[k]!;
          assert.ok(source.kind === 'raw' && source.bodies[0]!.messageId === body[0], `${m.id}: its body's head`);
        });
      }
    }
  });

  it('two back-to-back ingestions merge as two composites, each its own complete body', async () => {
    const { AutobiographicalStrategy } = await import('../src/index.js');
    class Merger extends AutobiographicalStrategy {
      merge(entries: ContextEntry[], messages: StoredMessage[]): ContextEntry[] {
        return this.mergeAdjacentBodyGroupRaw(entries, {} as never, messages);
      }
    }
    // A retried addMessage whose first call landed: the same text twice, nothing between.
    const g = { bodyGroupId: 'bg-twice', shardCount: 2 };
    const a0 = msg('a0', 1, [text('same ')], { ...g, shardIndex: 0 });
    const a1 = msg('a1', 2, [text('text')], { ...g, shardIndex: 1 });
    const b0 = msg('b0', 3, [text('same ')], { ...g, shardIndex: 0 });
    const b1 = msg('b1', 4, [text('text')], { ...g, shardIndex: 1 });
    const stored = [a0, a1, b0, b1];
    const merged = new Merger({}).merge(stored.map((m) => copy(m)), stored);
    assert.deepEqual(merged.map((e) => e.sourceMessageIds ?? [e.sourceMessageId]), [['a0', 'a1'], ['b0', 'b1']]);
    const result = attributeEntries(merged, stored);
    assert.deepEqual(result.sources, [
      { kind: 'raw', bodies: [{ messageId: 'a0', sequence: 1, complete: true }] },
      { kind: 'raw', bodies: [{ messageId: 'b0', sequence: 3, complete: true }] },
    ]);
    assert.deepEqual([...rawBodiesOf(result).entries()].map(([k, v]) => [k, v.map((m) => m.id)]), [['a0', ['a0', 'a1']], ['b0', ['b0', 'b1']]]);
  });

  it('keeps an interrupted ingestion and its re-ingestion apart', () => {
    const g = { bodyGroupId: 'bg-retry', shardCount: 3 };
    const cut0 = msg('cut0', 1, [text('x')], { ...g, shardIndex: 0 });
    const cut1 = msg('cut1', 2, [text('y')], { ...g, shardIndex: 1 });
    const r0 = msg('r0', 3, [text('x')], { ...g, shardIndex: 0 });
    const r1 = msg('r1', 4, [text('y')], { ...g, shardIndex: 1 });
    const r2 = msg('r2', 5, [text('z')], { ...g, shardIndex: 2 });
    const stored = [cut0, cut1, r0, r1, r2];
    const result = attributeEntries(stored.map((m) => copy(m)), stored);
    const heads = result.sources.flatMap((s) => (s.kind === 'raw' ? s.bodies : []));
    assert.deepEqual(heads.map((b) => [b.messageId, b.complete, b.missing]), [
      ['cut0', false, ['shards']], ['cut0', false, ['shards']],
      ['r0', true, undefined], ['r0', true, undefined], ['r0', true, undefined],
    ]);
  });

  it('through addMessage and the real chunker: a reposted document is its own complete body, and its first copy does not change form', async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { chunkMessage } = await import('../src/adaptive/chunker.js');
    const { rmSync } = await import('node:fs');
    class Chunked extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        const body = content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        const sharded = chunkMessage(body, { chunkThreshold: 20, chunkSize: 10, charsPerToken: 4 });
        if (!sharded.wasSharded) return null;
        return { bodyGroupId: sharded.bodyGroupId, shards: sharded.shards.map((s) => ({ content: [text(s.content)], shardIndex: s.index })) };
      }
    }
    const path = './test-reposted-body';
    rmSync(path, { recursive: true, force: true });
    try {
      const cm = await ContextManager.open({ path, strategy: new Chunked() });
      const doc = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} of the shared document, long enough to shard. `).join('');
      const first = cm.addMessage('alice', [text(doc)]);
      const firstShards = cm.getAllMessages().filter((m) => m.bodyGroupId).length;
      assert.ok(firstShards > 2, 'the document was sharded');
      const accepted = await cm.compile();
      cm.acceptRound({ provenance: accepted.provenance! });

      cm.addMessage('bob', [text('a reply in between')]);
      const second = cm.addMessage('alice', [text(doc)]);
      const stored = cm.getAllMessages();
      const groups = new Set(stored.filter((m) => m.bodyGroupId).map((m) => m.bodyGroupId));
      assert.equal(groups.size, 1, 'both ingestions share one content-hash group id');

      const result = await cm.compile();
      const bodies = result.provenance!.messages
        .flatMap((m) => (m.kind === 'raw' ? m.bodies : []))
        .filter((b, i, all) => all.findIndex((x) => x.messageId === b.messageId) === i);
      const byHead = new Map(bodies.map((b) => [b.messageId, b]));
      assert.equal(byHead.get(first)?.complete, true, 'the first copy is still complete');
      assert.equal(byHead.get(second)?.complete, true, 'the repost is its own complete body');
      assert.equal(result.rawBodies!.get(first)!.length, firstShards);
      assert.equal(result.rawBodies!.get(second)!.length, firstShards);
      assert.ok(result.rawBodies!.get(second)!.every((m) => m.sequence > result.rawBodies!.get(first)!.at(-1)!.sequence), 'the repost carries only its own shards');
      assert.equal(cm.acceptRound({ provenance: result.provenance! }), null, 'arrivals only: the first copy did not change form');

      // The same text again, straight after the repost, as a retried write would land.
      const third = cm.addMessage('alice', [text(doc)]);
      const again = await cm.compile();
      const heads = new Map(again.provenance!.messages.flatMap((m) => (m.kind === 'raw' ? m.bodies : [])).map((b) => [b.messageId, b]));
      assert.equal(heads.get(second)?.complete, true, 'the repost keeps its own shards');
      assert.equal(heads.get(third)?.complete, true, 'the back-to-back copy is its own complete body');
      assert.equal(again.rawBodies!.get(second)!.length, firstShards);
      assert.equal(again.rawBodies!.get(third)!.length, firstShards);
      assert.equal(again.rawBodies!.get(third)![0]!.sequence > again.rawBodies!.get(second)!.at(-1)!.sequence, true);
      cm.close();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});

describe('attribution reads what the raw entries name, not the stored history', () => {
  it('reads the history only around the named bodies, with one lookup for each run of consecutive messages', () => {
    // A long history whose newest messages render raw, ending in a sharded
    // body, with one old message recalled raw ahead of them: two runs.
    const n = 50_000;
    const history = Array.from({ length: n }, (_, i) => msg(`m${i}`, 2 * i + 1, [text(`message ${i}`)]));
    const g = { bodyGroupId: 'tail-doc', shardCount: 3 };
    for (let s = 0; s < 3; s++) history[n - 3 + s] = msg(`d${s}`, 2 * (n - 3 + s) + 1, [text(`part ${s} `)], { ...g, shardIndex: s });
    const sequences = new Map(history.map((m) => [m.id, m.sequence]));
    let reads = 0;
    const stored = new Proxy(history, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++;
        return Reflect.get(target, prop, receiver);
      },
    });
    let lookups = 0;
    const sequenceOf = (id: string) => {
      lookups++;
      return sequences.get(id);
    };
    const window = history.slice(n - 20, n - 3);
    const doc: ContextEntry = { index: 0, sourceMessageIds: ['d0', 'd1', 'd2'], sourceRelation: 'copy', participant: 'user', content: [text('part 0 part 1 part 2 ')] };
    const entries = [copy(history[1000]!), ...window.map((m) => copy(m)), doc];

    const result = attributeIn(entries, stored, sequenceOf);
    const heads = result.sources.map((s) => (s.kind === 'raw' ? s.bodies.map((b) => [b.messageId, b.complete]) : null));
    assert.deepEqual(heads, [[['m1000', true]], ...window.map((m) => [[m.id, true]]), [['d0', true]]]);
    assert.deepEqual(rawBodiesOf(result).get('d0')!.map((m) => m.id), ['d0', 'd1', 'd2']);
    assert.ok(rawBodiesOf(result).get('d0')!.every((m, s) => m === history[n - 3 + s]), "the stored array's own objects");
    assert.ok(reads < 500, `read ${reads} of the ${n} stored messages for ${entries.length} raw entries`);
    assert.ok(lookups <= 2, `${lookups} lookups for two runs of consecutive messages`);
  });

  it("finds nothing where the lookup answers with another message's sequence, or with one no stored message has", () => {
    const stored = [msg('a', 1, [text('a')]), msg('b', 3, [text('b')]), msg('c', 5, [text('c')]), msg('d', 7, [text('d')])];
    // c's lookup answers with b's sequence, d's with a sequence nothing has,
    // and an unknown id's with nothing; b is found through its own.
    const answers = new Map([['c', 3], ['d', 4], ['b', 3]]);
    const entries = [copy(stored[2]!), copy(stored[3]!), copy(msg('x', 9, [text('x')])), copy(stored[1]!)];
    const result = attributeIn(entries, stored, (id) => answers.get(id));
    const heads = result.sources.map((s) => (s.kind === 'raw' ? s.bodies.map((b) => b.messageId) : null));
    assert.deepEqual(heads, [[], [], [], ['b']], "no body is credited to c or d, and b's is its own");
    assert.deepEqual([...rawBodiesOf(result).keys()], ['b']);
  });

  it('through compile, a render that starts partway through the history finds each raw body in the store', async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { rmSync } = await import('node:fs');
    class Halves extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        if (content.length < 2) return null;
        return { bodyGroupId: 'late-doc', shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
      }
    }
    const path = './test-attribution-tail';
    rmSync(path, { recursive: true, force: true });
    try {
      const cm = await ContextManager.open({ path, strategy: new Halves() });
      const line = (i: number) => text(`line ${i}: ${'words of an ordinary turn '.repeat(8)}`);
      for (let i = 0; i < 60; i++) cm.addMessage(i % 2 ? 'bob' : 'alice', [line(i)]);
      const doc = cm.addMessage('alice', [line(60), line(61)]);
      for (let i = 62; i < 66; i++) cm.addMessage('bob', [line(i)]);
      const stored = cm.getAllMessages();

      const result = await cm.compile({ maxTokens: 1500, reserveForResponse: 0 });
      const raw = result.provenance!.messages.map((m) => (m.kind === 'raw' ? m.bodies : []));
      assert.ok(result.messages.length < stored.length / 2, `a tail render (${result.messages.length} of ${stored.length})`);
      assert.ok(raw.every((bodies) => bodies.length === 1), 'every compiled message names its body');
      const rendered = stored.slice(stored.length - result.messages.length);
      assert.deepEqual(raw.map((bodies) => bodies[0]!.messageId), rendered.map((m) => (m.bodyGroupId ? doc : m.id)));
      assert.ok(raw.every((bodies) => bodies[0]!.complete), 'each body complete, the document with both shards');
      assert.deepEqual(result.rawBodies!.get(doc)!.map((m) => m.shardIndex), [0, 1]);
      cm.close();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});

describe('a tool result moved by repair is still carried', () => {
  const use = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'fn', input: {} } as ContentBlock);
  const result = (id: string, body: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: body } as ContentBlock);

  async function repaired(entries: ContextEntry[]): Promise<ContextEntry[]> {
    const { AutobiographicalStrategy } = await import('../src/index.js');
    const strategy = new AutobiographicalStrategy({});
    (strategy as unknown as { enforceToolPairing: (e: ContextEntry[]) => void }).enforceToolPairing(entries);
    return entries;
  }

  it('credits the body with its result where repair put it, next to the tool_use', async () => {
    const u = msg('u', 1, [use('tu-1')]);
    const r = msg('r', 3, [result('tu-1', 'the real output'), text('and a note')]);
    const recall: ContextEntry = { index: 0, participant: 'Context Manager', sourceRelation: 'derived', content: [text('What do you remember?')] };
    const entries = await repaired([copy(u), recall, copy(r)]);
    const moved = entries.find((e) => e.sourceMessageId === 'r')!;
    assert.deepEqual(moved.relocatedResults, ['tu-1'], 'repair records what it moved');
    assert.ok(!moved.content.some((b) => b.type === 'tool_result'), 'the result left its entry');
    const result1 = attributeEntries(entries, [u, r]);
    const body = result1.sources.flatMap((s) => (s.kind === 'raw' ? s.bodies : [])).find((b) => b.messageId === 'r');
    assert.deepEqual(body, { messageId: 'r', sequence: 3, complete: true });
  });

  it('still reports missing content when the moved result was altered afterwards, or is not in the request', async () => {
    const u = msg('u', 1, [use('tu-1')]);
    const r = msg('r', 3, [result('tu-1', 'the real output')]);
    const recall: ContextEntry = { index: 0, participant: 'Context Manager', sourceRelation: 'derived', content: [text('What do you remember?')] };
    const entries = await repaired([copy(u), recall, copy(r)]);
    const placed = entries.find((e) => e.content.some((b) => b.type === 'tool_result'))!;
    const i = placed.content.findIndex((b) => b.type === 'tool_result');
    placed.content[i] = result('tu-1', '[older result elided]');
    const altered = attributeEntries(entries, [u, r]);
    assert.deepEqual(altered.sources.flatMap((s) => (s.kind === 'raw' ? s.bodies : [])).find((b) => b.messageId === 'r'),
      { messageId: 'r', sequence: 3, complete: false, missing: ['content'] });

    // An entry that claims a move with no result for it in the request.
    const claimed: ContextEntry = { ...copy(r, [text('[tool result moved during context repair]')]), relocatedResults: ['tu-1'] };
    const lost = attributeEntries([copy(u), claimed], [u, r]);
    assert.deepEqual(lost.sources[1], { kind: 'raw', bodies: [{ messageId: 'r', sequence: 3, complete: false, missing: ['content'] }] });
  });
});

describe('rawBodies', () => {
  it('resolves a body compiled from an auxiliary slot, which getMessage cannot see', async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { rmSync } = await import('node:fs');
    const path = './test-raw-bodies-aux';
    rmSync(path, { recursive: true, force: true });
    try {
      const main = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
      const side = await ContextManager.open({
        store: main.getStore(),
        namespace: 'subconscious/reader',
        isolate: true,
        strategy: new PassthroughStrategy(),
        auxiliaryMessageViews: [{}],
      });
      const auxId = main.addMessage('alice', [text('from the main slot')], { inboundSource: { kind: 'channel' } } as never);
      const result = await side.compile();
      const raw = result.provenance!.messages.find((m) => m.kind === 'raw' && m.bodies[0]!.messageId === auxId);
      assert.ok(raw, 'the reader compiled the auxiliary body raw');
      assert.equal(side.getMessage(auxId), null, 'getMessage cannot resolve it');
      const resolved = result.rawBodies!.get(auxId)?.[0];
      assert.ok(resolved, 'rawBodies does');
      assert.deepEqual((resolved!.metadata as { inboundSource?: unknown }).inboundSource, { kind: 'channel' });
      side.close();
      main.close();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});

describe('sharded writes declare their group size', () => {
  async function withManager(path: string, run: (open: () => Promise<import('../src/index.js').ContextManager>) => Promise<void>) {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { rmSync } = await import('node:fs');
    class Halves extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        if (content.length < 2) return null;
        return { bodyGroupId: `g-${content.length}-${Math.random().toString(36).slice(2)}`, shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
      }
    }
    rmSync(path, { recursive: true, force: true });
    try {
      await run(() => ContextManager.open({ path, strategy: new Halves() }));
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  }

  it('records shardCount on every shard; a whole group compiles complete', async () => {
    await withManager('./test-shard-count-whole', async (open) => {
      const cm = await open();
      const id = cm.addMessage('alice', [text('[header]'), text('the body')]);
      const shards = cm.getAllMessages().filter((m) => m.bodyGroupId);
      assert.deepEqual(shards.map((m) => [m.shardIndex, m.shardCount]), [[0, 2], [1, 2]]);
      const result = await cm.compile();
      const raw = result.provenance!.messages.find((m) => m.kind === 'raw' && m.bodies[0]!.messageId === id);
      assert.ok(raw && raw.kind === 'raw' && raw.bodies[0]!.complete);
      cm.close();
    });
  });

  it('a group write cut short, whose shards could not be removed either, reads as missing shards, and still does after a reopen', async () => {
    await withManager('./test-shard-count-interrupted', async (open) => {
      const cm = await open();
      const store = (cm as unknown as { messageStore: { append: (...args: unknown[]) => unknown; removeBodyGroup: (id: string) => void } }).messageStore;
      const append = store.append.bind(store);
      const removeBodyGroup = store.removeBodyGroup.bind(store);
      let calls = 0;
      store.append = (...args: unknown[]) => {
        calls += 1;
        if (calls === 2) throw new Error('injected failure before the second shard');
        return append(...args);
      };
      // As when the store refuses every write: the rollback fails too (or the
      // process stops mid-write), so the first shard stays.
      store.removeBodyGroup = () => { throw new Error('injected failure of the removal'); };
      const error = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        assert.throws(() => cm.addMessage('alice', [text('[header]'), text('the body')]), /injected failure before the second shard/);
      } finally {
        console.error = error;
      }
      store.append = append;
      store.removeBodyGroup = removeBodyGroup;
      const [head] = cm.getAllMessages();
      assert.ok(
        logged.some((l) => l.includes('removing what it wrote threw') && l.includes(`body group ${head!.bodyGroupId} (first shard ${head!.id})`)),
        `the failed removal is reported, naming the short body: ${logged.join('\n')}`,
      );
      assert.equal(head!.shardCount, 2, 'the stored shard declares the whole group');
      const first = await cm.compile();
      const raw = first.provenance!.messages.find((m) => m.kind === 'raw' && m.bodies[0]!.messageId === head!.id);
      assert.ok(raw && raw.kind === 'raw');
      assert.deepEqual(raw.bodies[0], { messageId: head!.id, sequence: head!.sequence, complete: false, missing: ['shards'] });
      cm.close();

      const reopened = await open();
      const again = await reopened.compile();
      const rawAgain = again.provenance!.messages.find((m) => m.kind === 'raw' && m.bodies[0]!.messageId === head!.id);
      assert.ok(rawAgain && rawAgain.kind === 'raw');
      assert.equal(rawAgain.bodies[0]!.complete, false);
      assert.deepEqual(rawAgain.bodies[0]!.missing, ['shards']);
      reopened.close();
    });
  });

  it('a rollback whose own reads fail still raises the write\'s error, and reports it', async () => {
    await withManager('./test-shard-count-recovery-read', async (open) => {
      const cm = await open();
      const store = (cm as unknown as { messageStore: { append: (...args: unknown[]) => unknown; getTail: (n: number) => unknown[] } }).messageStore;
      const append = store.append.bind(store);
      const getTail = store.getTail.bind(store);
      // The first shard lands, then its append throws, so the rollback has
      // to read the store's tail to find it, and that read fails too.
      store.append = (...args: unknown[]) => {
        append(...args);
        throw new Error('injected failure after the first shard landed');
      };
      store.getTail = () => { throw new Error('injected failure of the tail read'); };
      const error = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        assert.throws(() => cm.addMessage('alice', [text('[header]'), text('the body')]), /injected failure after the first shard landed/);
      } finally {
        console.error = error;
        store.append = append;
        store.getTail = getTail;
      }
      assert.ok(
        logged.some((l) => l.includes('removing what it wrote threw') && l.includes('injected failure of the tail read')),
        `the failed recovery is reported: ${logged.join('\n')}`,
      );
      cm.close();
    });
  });

  it('a rollback whose removal throws a value String() cannot print still raises the write\'s error, and reports it', async () => {
    await withManager('./test-shard-count-recovery-unprintable', async (open) => {
      const cm = await open();
      const store = (cm as unknown as { messageStore: { append: (...args: unknown[]) => unknown; removeBodyGroup: (id: string) => void } }).messageStore;
      const append = store.append.bind(store);
      const removeBodyGroup = store.removeBodyGroup.bind(store);
      let calls = 0;
      store.append = (...args: unknown[]) => {
        calls += 1;
        if (calls === 2) throw new Error('injected failure before the second shard');
        return append(...args);
      };
      // An object with no prototype has no toString, so String() throws on it.
      store.removeBodyGroup = () => { throw Object.create(null); };
      const error = console.error;
      const logged: string[] = [];
      const printable = (arg: unknown): string => { try { return String(arg); } catch { return '(unprintable)'; } };
      console.error = (...args: unknown[]) => { logged.push(args.map(printable).join(' ')); };
      try {
        assert.throws(() => cm.addMessage('alice', [text('[header]'), text('the body')]), /injected failure before the second shard/);
      } finally {
        console.error = error;
        store.append = append;
        store.removeBodyGroup = removeBodyGroup;
      }
      assert.ok(
        logged.some((l) => l.includes('removing what it wrote threw') && l.includes('[object Object]')),
        `the failed removal is reported: ${logged.join('\n')}`,
      );
      cm.close();
    });
  });

  it('a view filter that hides shard 0 leaves the body its identity, all its shards in rawBodies, and no whole-delivery claim', async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { rmSync } = await import('node:fs');
    class Halves extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        if (content.length < 2) return null;
        return { bodyGroupId: 'hidden-head', shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
      }
    }
    const path = './test-shard-filtered-head';
    rmSync(path, { recursive: true, force: true });
    try {
      const cm = await ContextManager.open({
        path,
        strategy: new Halves(),
        viewFilter: (m) => !(m.bodyGroupId && m.shardIndex === 0),
      });
      const id = cm.addMessage('alice', [text('[header]'), text('the body')]);
      const [head, tail] = cm.getAllMessages();
      assert.equal(head!.id, id);
      const result = await cm.compile();
      const raw = result.provenance!.messages.filter((m) => m.kind === 'raw');
      assert.deepEqual(raw, [{ kind: 'raw', bodies: [{ messageId: id, sequence: head!.sequence, complete: false, missing: ['shards'] }] }]);
      assert.deepEqual([...result.rawBodies!.entries()].map(([k, v]) => [k, v.map((m) => m.id)]), [[head!.id, [head!.id, tail!.id]]], 'the head and every shard, hidden or not');
      // The layout is the strategy's view: only the visible shard, as partial.
      const layout = result.provenance!.layout!;
      assert.deepEqual(layout.memberIds, [tail!.id]);
      assert.deepEqual(layout.units.map((u) => u.k === 'r' && u.p), [1]);
      cm.close();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('writes shards in index order, so addMessage returns shard 0\'s id whatever order the decision lists them in', async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { rmSync } = await import('node:fs');
    class Reversed extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        return { bodyGroupId: 'reversed', shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })).reverse() };
      }
    }
    const path = './test-shard-order';
    rmSync(path, { recursive: true, force: true });
    try {
      const cm = await ContextManager.open({ path, strategy: new Reversed() });
      const id = cm.addMessage('alice', [text('first '), text('second')]);
      const shards = cm.getAllMessages();
      assert.deepEqual(shards.map((m) => [m.shardIndex, textOf(m)]), [[0, 'first '], [1, 'second']]);
      assert.equal(id, shards[0]!.id);
      const result = await cm.compile();
      const raw = result.provenance!.messages.find((m) => m.kind === 'raw');
      assert.ok(raw && raw.kind === 'raw' && raw.bodies[0]!.messageId === id && raw.bodies[0]!.complete);
      cm.close();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('refuses a chunking decision whose indices are not 0..n-1, before writing anything', async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { rmSync } = await import('node:fs');
    class Gappy extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        return { bodyGroupId: 'gap', shards: content.map((block, i) => ({ content: [block], shardIndex: i * 2 })) };
      }
    }
    class Doubled extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        return { bodyGroupId: 'dup', shards: content.map((block) => ({ content: [block], shardIndex: 0 })) };
      }
    }
    const path = './test-shard-count-gappy';
    rmSync(path, { recursive: true, force: true });
    try {
      for (const strategy of [new Gappy(), new Doubled()]) {
        rmSync(path, { recursive: true, force: true });
        const cm = await ContextManager.open({ path, strategy });
        assert.throws(() => cm.addMessage('alice', [text('a'), text('b')]), /each index 0\.\.1 exactly once/, strategy.constructor.name);
        assert.equal(cm.getAllMessages().length, 0, `${strategy.constructor.name}: nothing written`);
        cm.close();
      }
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a listener that throws fails neither its write nor a sharded body', async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { rmSync } = await import('node:fs');
    class Sharding extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        return { bodyGroupId: 'three', shards: content.map((block, i) => ({ content: [block], shardIndex: i })) };
      }
    }
    const path = './test-listener-throws';
    rmSync(path, { recursive: true, force: true });
    const error = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const cm = await ContextManager.open({ path, strategy: new Sharding() });
      const heard: string[] = [];
      let throwOn = -1;
      cm.onMessage((event) => {
        heard.push(event.type);
        if (heard.length === throwOn) throw new Error('listener failed');
      });
      throwOn = 1;
      const plain = cm.addMessage('bob', [text('plain')]);
      // The last shard's listener throws, and then a middle one's.
      throwOn = 4;
      const last = cm.addMessage('alice', [text('one '), text('two '), text('three')]);
      throwOn = 6;
      const middle = cm.addMessage('carol', [text('four '), text('five '), text('six')]);
      assert.deepEqual(heard, ['add', 'add', 'add', 'add', 'add', 'add', 'add'], 'every shard heard, nothing removed');
      assert.equal(logged.filter((l) => l.includes('onMessage listener threw')).length, 3);
      assert.ok(logged.some((l) => l.includes(`'add' event for message ${plain};`)), 'each names the message it missed');
      assert.ok(logged.some((l) => l.includes('onMessage listener threw') && l.includes('(body group three);')), "and a shard's body group");
      const result = await cm.compile();
      const bodies = result.provenance!.messages.flatMap((m) => (m.kind === 'raw' ? m.bodies : []));
      for (const id of [plain, last, middle]) {
        assert.equal(bodies.find((b) => b.messageId === id)?.complete, true, `${id}: stored whole`);
      }
      cm.close();
    } finally {
      console.error = error;
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a listener throwing a value console.error cannot format leaves the sharded write whole, and is reported', async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { rmSync } = await import('node:fs');
    const { inspect } = await import('node:util');
    class Sharding extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        return { bodyGroupId: 'three', shards: content.map((block, i) => ({ content: [block], shardIndex: i })) };
      }
    }
    const path = './test-listener-unprintable';
    rmSync(path, { recursive: true, force: true });
    // The real console formats an object through its inspect hook, which can throw.
    const unprintable = { [inspect.custom]() { throw new Error('custom inspect failed'); } };
    const write = process.stderr.write;
    const written: string[] = [];
    try {
      const cm = await ContextManager.open({ path, strategy: new Sharding() });
      let adds = 0;
      cm.onMessage(() => { if (++adds === 2) throw unprintable; });
      process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
      cm.addMessage('alice', [text('one '), text('two '), text('three')]);
      process.stderr.write = write;
      assert.equal(cm.getAllMessages().filter((m) => m.bodyGroupId === 'three').length, 3, 'every shard stays');
      assert.ok(written.some((w) => w.includes('onMessage listener threw') && w.includes('[object Object]')), `reported: ${written.join('')}`);
      cm.close();
    } finally {
      process.stderr.write = write;
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("a first shard whose own append threw after it landed is removed too", async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { rmSync } = await import('node:fs');
    class Sharding extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        return { bodyGroupId: 'three', shards: content.map((block, i) => ({ content: [block], shardIndex: i })) };
      }
    }
    const path = './test-shard-zero-rollback';
    rmSync(path, { recursive: true, force: true });
    try {
      const cm = await ContextManager.open({ path, strategy: new Sharding() });
      cm.addMessage('bob', [text('before')]);
      // The manager's own listener fails on the first shard's add: that append throws after landing.
      const manager = cm as unknown as { handleMessageStoreEvent: (event: { type: string }) => void };
      const handle = manager.handleMessageStoreEvent.bind(cm);
      let adds = 0;
      manager.handleMessageStoreEvent = (event) => {
        if (event.type === 'add' && ++adds === 1) throw new Error('propagation failed');
        handle(event);
      };
      assert.throws(() => cm.addMessage('alice', [text('one '), text('two '), text('three')]), /propagation failed/);
      manager.handleMessageStoreEvent = handle;
      assert.deepEqual(cm.getAllMessages().map((m) => textOf(m)), ['before'], 'shard 0 is gone too');
      cm.close();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("the manager's own listener stays outside that: a failed propagation still fails the write", async () => {
    await withManager('./test-own-listener', async (open) => {
      const cm = await open();
      const id = cm.addMessage('alice', [text('before')]);
      const log = (cm as unknown as { contextLog: { findBySource: (id: string) => unknown } }).contextLog;
      log.findBySource = () => { throw new Error('context log unwritable'); };
      assert.throws(() => cm.editMessage(id, [text('after')]), /context log unwritable/);
      cm.close();
    });
  });

  it('a sharded write that fails partway leaves nothing behind, and a retry writes one complete body', async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { JsStore } = await import('@animalabs/chronicle');
    const { rmSync } = await import('node:fs');
    class Sharding extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        return { bodyGroupId: 'three', shards: content.map((block, i) => ({ content: [block], shardIndex: i })) };
      }
    }
    const path = './test-shard-rollback';
    rmSync(path, { recursive: true, force: true });
    try {
      const real = JsStore.openOrCreate({ path });
      let failOn = -1;
      let writes = 0;
      const flaky = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'appendToStateJsonWithIdentity') {
            return (...args: Parameters<typeof real.appendToStateJsonWithIdentity>) => {
              if (++writes === failOn) throw new Error('disk full');
              return target.appendToStateJsonWithIdentity(...args);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof real;
      const cm = await ContextManager.open({ store: flaky, strategy: new Sharding() });
      cm.addMessage('bob', [text('before')]);
      writes = 0;
      failOn = 2; // the second shard's append
      assert.throws(() => cm.addMessage('alice', [text('one '), text('two '), text('three')]), /disk full/);
      assert.deepEqual(cm.getAllMessages().map((m) => textOf(m)), ['before'], 'no shard left behind');
      failOn = -1;
      const id = cm.addMessage('alice', [text('one '), text('two '), text('three')]);
      const result = await cm.compile();
      const bodies = result.provenance!.messages.flatMap((m) => (m.kind === 'raw' ? m.bodies : []));
      assert.deepEqual([...new Set(bodies.map((b) => b.messageId))], [cm.getAllMessages()[0]!.id, id]);
      assert.equal(bodies.find((b) => b.messageId === id)?.complete, true, 'the retry is one complete body');
      assert.equal(result.rawBodies!.get(id)!.length, 3);
      cm.close();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
