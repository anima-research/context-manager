/**
 * Raw-body attribution (compile-provenance.ts): when a compiled copy carries
 * its stored body completely, and when it does not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { attributeEntries, coversStoredContent } from '../src/compile-provenance.js';
import type { ContextEntry, StoredMessage } from '../src/index.js';

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const image = (data: string): ContentBlock => ({ type: 'image', source: { type: 'base64', data, mediaType: 'image/png' } } as ContentBlock);

function msg(id: string, sequence: number, content: ContentBlock[], extra: Partial<StoredMessage> = {}): StoredMessage {
  return { id, sequence, participant: 'user', content, timestamp: new Date(0), ...extra } as StoredMessage;
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
