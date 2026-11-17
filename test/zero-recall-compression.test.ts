import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedMessage } from '@animalabs/membrane';
import { transformZeroRecallCompression, assertZeroRecallSourceSafe } from '../src/surgery/zero-recall-compression.js';

const text = (participant: string, value: string): NormalizedMessage => ({ participant, content: [{ type: 'text', text: value }] });

test('zero-recall surgery removes whole pairs and preserves all other messages', () => {
  const signedAnswer: NormalizedMessage = {
    participant: 'mythos',
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'summary' }],
  };
  const source = text('user', 'source');
  const opening = text('Context Manager', 'OPEN');
  const instruction = text('Context Manager', 'Compress now.');
  const input = [
    text('user', 'head'),
    text('Context Manager', '[CM] Recall memory L1-1.'),
    signedAnswer,
    text('Context Manager', '[CM] Recall memory L2-2.'),
    text('mythos', 'another summary'),
    opening,
    source,
    instruction,
  ];
  const result = transformZeroRecallCompression(input, 'OPEN');
  assert.deepEqual(result.removedRecallIds, ['L1-1', 'L2-2']);
  assert.equal(result.originalMessageCount, 8);
  assert.equal(result.sentMessageCount, 4);
  assert.deepEqual(result.messages[0], input[0]);
  assert.deepEqual(result.messages[2], source);
  assert.deepEqual(result.messages[3], instruction);
  assert.notEqual(result.originalSha256, result.transformedSha256);
});

test('zero-recall surgery refuses malformed, absent or ambiguous geometry', () => {
  const open = text('Context Manager', 'OPEN');
  assert.throws(() => transformZeroRecallCompression([text('user', 'source'), open], 'OPEN'), /No recall pairs/);
  assert.throws(() => transformZeroRecallCompression([text('Context Manager', '[CM] Recall memory L1-1.'), open], 'OPEN'), /missing assistant answer/);
  for (const input of [[], [open, open]]) {
    assert.throws(() => transformZeroRecallCompression(input, 'OPEN'), /Missing or ambiguous/);
  }
});

for (const opening of ['[CM] Recall memory example.', '[CM] Recall memory example. Instructions...']) {
  test(`zero-recall surgery preserves opening and source: ${opening}`, () => {
    const source = text('mythos', 'first source turn must survive');
    const input = [text('Context Manager', '[CM] Recall memory L1-1.'), text('mythos', 'summary'),
      text('Context Manager', opening), source,
      text('Context Manager', '[CM] Recall memory raw.'), text('mythos', 'raw answer-shaped source')];
    const result = transformZeroRecallCompression(input, opening);
    assert.deepEqual(result.removedRecallIds, ['L1-1']);
    assert.deepEqual(result.messages, input.slice(2));
    assert.equal(result.messages[1], source);
  });
}

test('one-shot source safety refuses recall-shaped raw prefix history', () => {
  assert.throws(() => assertZeroRecallSourceSafe([text('Context Manager', '[CM] Recall memory raw.')]), /Raw recall-shaped/);
  assert.doesNotThrow(() => assertZeroRecallSourceSafe([text('user', '[CM] Recall memory quoted.')]));
});
