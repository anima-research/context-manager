import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedMessage } from '@animalabs/membrane';
import { transformZeroRecallCompression } from '../src/surgery/zero-recall-compression.js';

const text = (participant: string, value: string): NormalizedMessage => ({ participant, content: [{ type: 'text', text: value }] });

test('zero-recall surgery removes whole pairs and preserves all other messages', () => {
  const signedAnswer: NormalizedMessage = {
    participant: 'mythos',
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'summary' }],
  };
  const source = text('user', 'source');
  const instruction = text('Context Manager', 'Compress now.');
  const input = [
    text('user', 'head'),
    text('Context Manager', '[CM] Recall memory L1-1.'),
    signedAnswer,
    text('Context Manager', '[CM] Recall memory L2-2.'),
    text('mythos', 'another summary'),
    source,
    instruction,
  ];
  const result = transformZeroRecallCompression(input);
  assert.deepEqual(result.removedRecallIds, ['L1-1', 'L2-2']);
  assert.equal(result.originalMessageCount, 7);
  assert.equal(result.sentMessageCount, 3);
  assert.deepEqual(result.messages[0], input[0]);
  assert.deepEqual(result.messages[1], source);
  assert.deepEqual(result.messages[2], instruction);
  assert.notEqual(result.originalSha256, result.transformedSha256);
});

test('zero-recall surgery refuses malformed or absent recall geometry', () => {
  assert.throws(() => transformZeroRecallCompression([text('user', 'source'), text('Context Manager', 'Compress now.')]), /No recall pairs/);
  assert.throws(() => transformZeroRecallCompression([text('Context Manager', '[CM] Recall memory L1-1.')]), /missing assistant answer/);
});
