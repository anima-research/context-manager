/**
 * Raw-body attribution (compile-provenance.ts): when a compiled copy carries
 * its stored body completely, and when it does not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { attributeEntries, coversStoredContent, rawSourcesOf } from '../src/compile-provenance.js';
import type { ContextEntry, StoredMessage } from '../src/index.js';

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
    assert.deepEqual([...rawSourcesOf(result.sources, [h0, h1]).keys()], ['f0', 'f1']);

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

describe('rawSources', () => {
  it('resolves a body compiled from an auxiliary slot, which getMessage cannot see', async () => {
    const { ContextManager, PassthroughStrategy } = await import('../src/index.js');
    const { rmSync } = await import('node:fs');
    const path = './test-raw-sources-aux';
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
      const resolved = result.rawSources!.get(auxId);
      assert.ok(resolved, 'rawSources does');
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

  it('an interrupted group write reads as missing shards, and still does after a reopen', async () => {
    await withManager('./test-shard-count-interrupted', async (open) => {
      const cm = await open();
      const store = (cm as unknown as { messageStore: { append: (...args: unknown[]) => unknown } }).messageStore;
      const append = store.append.bind(store);
      let calls = 0;
      store.append = (...args: unknown[]) => {
        calls += 1;
        if (calls === 2) throw new Error('injected failure before the second shard');
        return append(...args);
      };
      assert.throws(() => cm.addMessage('alice', [text('[header]'), text('the body')]), /injected failure/);
      store.append = append;
      const [head] = cm.getAllMessages();
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

  it('a view filter that hides shard 0 leaves the body its identity, all its shards in rawSources, and no whole-delivery claim', async () => {
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
      assert.deepEqual([...result.rawSources!.keys()].sort(), [head!.id, tail!.id].sort(), 'the head and every shard, hidden or not');
      // The layout is the strategy's view: only the visible shard, as partial.
      assert.deepEqual(result.provenance!.layout!.units.map((u) => u.k === 'r' && [u.id, u.p]), [[tail!.id, 1]]);
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
    const path = './test-shard-count-gappy';
    rmSync(path, { recursive: true, force: true });
    try {
      const cm = await ContextManager.open({ path, strategy: new Gappy() });
      assert.throws(() => cm.addMessage('alice', [text('a'), text('b')]), /each index 0\.\.1 exactly once/);
      assert.equal(cm.getAllMessages().length, 0);
      cm.close();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
