import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkMessage } from '../../src/adaptive/chunker.js';
import { concatBodyGroups, placeholderRecallText } from '../../src/adaptive/render.js';
import type { StoredMessage } from '../../src/types/message.js';
import type { ContentBlock } from '@animalabs/membrane';

function makeShard(
  body: string,
  groupId: string,
  shardIndex: number,
  options: Partial<StoredMessage> = {}
): StoredMessage {
  return {
    id: `${groupId}-shard-${shardIndex}`,
    sequence: shardIndex,
    participant: 'User',
    content: [{ type: 'text', text: body } as ContentBlock],
    timestamp: new Date(0),
    bodyGroupId: groupId,
    shardIndex,
    ...options,
  };
}

function makePlainMessage(id: string, body: string, sequence = 0): StoredMessage {
  return {
    id,
    sequence,
    participant: 'User',
    content: [{ type: 'text', text: body } as ContentBlock],
    timestamp: new Date(0),
  };
}

test('render: messages without bodyGroupId pass through unchanged', () => {
  const messages = [
    makePlainMessage('m-1', 'hello', 0),
    makePlainMessage('m-2', 'world', 1),
  ];
  const out = concatBodyGroups(messages, placeholderRecallText);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'm-1');
  assert.equal(out[1].id, 'm-2');
});

test('render: byte-faithful concat for all-L0 shards', () => {
  const originalBody = 'a'.repeat(200) + '\n\n' + 'b'.repeat(200) + '\n\n' + 'c'.repeat(200);
  const sharded = chunkMessage(originalBody, { chunkThreshold: 50, chunkSize: 50, charsPerToken: 1.0 });
  assert.equal(sharded.wasSharded, true);

  // Build StoredMessages from the shards
  const messages = sharded.shards.map((s) =>
    makeShard(s.content, sharded.bodyGroupId, s.index)
  );

  const concatenated = concatBodyGroups(messages, placeholderRecallText);
  assert.equal(concatenated.length, 1, 'all shards should merge into one composite');
  const block = concatenated[0].content[0];
  assert.equal(block.type, 'text');
  const text = (block as { type: 'text'; text: string }).text;
  assert.equal(text, originalBody, 'concatenated body must equal original byte-for-byte');
});

test('render: shard at L1 emits recall text instead of raw', () => {
  const shard0 = makeShard('first shard ', 'g-1', 0);
  const shard1 = makeShard('second shard ', 'g-1', 1, { currentResolution: 1 });
  const shard2 = makeShard('third shard', 'g-1', 2);

  const concatenated = concatBodyGroups([shard0, shard1, shard2], (s) => `<<recall:${s.id}>>`);
  assert.equal(concatenated.length, 1);
  const text = (concatenated[0].content[0] as { type: 'text'; text: string }).text;
  assert.equal(text, 'first shard <<recall:g-1-shard-1>>third shard');
});

test('render: multiple bodyGroups remain separate', () => {
  const g1s0 = makeShard('hello ', 'g-1', 0);
  const g1s1 = makeShard('world', 'g-1', 1);
  const g2s0 = makeShard('foo ', 'g-2', 0);
  const g2s1 = makeShard('bar', 'g-2', 1);

  const concatenated = concatBodyGroups([g1s0, g1s1, g2s0, g2s1], placeholderRecallText);
  assert.equal(concatenated.length, 2);
  assert.equal((concatenated[0].content[0] as { type: 'text'; text: string }).text, 'hello world');
  assert.equal((concatenated[1].content[0] as { type: 'text'; text: string }).text, 'foo bar');
});

test('render: shard order honored even if input is out of order', () => {
  const s0 = makeShard('A', 'g', 0);
  const s1 = makeShard('B', 'g', 1);
  const s2 = makeShard('C', 'g', 2);
  // Note: the input order here would actually break grouping because we
  // group by *consecutive* same-bodyGroupId — out-of-order input means
  // the group is broken if a different one interrupts. But within a
  // contiguous run, shardIndex determines concat order.
  const concatenated = concatBodyGroups([s2, s0, s1], placeholderRecallText);
  assert.equal(concatenated.length, 1);
  const text = (concatenated[0].content[0] as { type: 'text'; text: string }).text;
  assert.equal(text, 'ABC');
});

test('render: interleaved plain + grouped messages preserve order', () => {
  const plain1 = makePlainMessage('p-1', 'plain text 1', 0);
  const g1s0 = makeShard('group ', 'g-1', 0);
  const g1s1 = makeShard('one', 'g-1', 1);
  const plain2 = makePlainMessage('p-2', 'plain text 2', 3);
  const g2s0 = makeShard('group ', 'g-2', 0);
  const g2s1 = makeShard('two', 'g-2', 1);

  const concatenated = concatBodyGroups(
    [plain1, g1s0, g1s1, plain2, g2s0, g2s1],
    placeholderRecallText
  );
  assert.equal(concatenated.length, 4);
  assert.equal(concatenated[0].id, 'p-1');
  assert.equal((concatenated[1].content[0] as { type: 'text'; text: string }).text, 'group one');
  assert.equal(concatenated[2].id, 'p-2');
  assert.equal((concatenated[3].content[0] as { type: 'text'; text: string }).text, 'group two');
});

test('render: chunker + render round-trips with realistic large doc', () => {
  // Build a synthetic doc, chunk it, render it back, verify byte-identical.
  const paragraphs: string[] = [];
  for (let i = 0; i < 50; i++) {
    paragraphs.push(`# Section ${i}\n\nThis is the content of section ${i}. ` + 'Lorem ipsum dolor sit amet. '.repeat(20));
  }
  const body = paragraphs.join('\n\n');

  const sharded = chunkMessage(body); // default options
  const messages = sharded.shards.map((s) =>
    makeShard(s.content, sharded.bodyGroupId, s.index)
  );

  const concatenated = concatBodyGroups(messages, placeholderRecallText);
  assert.equal(concatenated.length, 1);
  const text = (concatenated[0].content[0] as { type: 'text'; text: string }).text;
  assert.equal(text, body);
});
