import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedMessage } from '@animalabs/membrane';
import { AutobiographicalStrategy } from '../src/index.js';
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
  const result = transformZeroRecallCompression(input, 'OPEN', [{ id: 'L1-1', answer: signedAnswer }, { id: 'L2-2', answer: input[4] }]);
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
    const result = transformZeroRecallCompression(input, opening, [{ id: 'L1-1', answer: input[1] }]);
    assert.deepEqual(result.removedRecallIds, ['L1-1']);
    assert.deepEqual(result.messages, input.slice(2));
    assert.equal(result.messages[1], source);
  });
}

test('one-shot source safety refuses recall-shaped raw prefix history', () => {
  assert.throws(() => assertZeroRecallSourceSafe([text('Context Manager', '[CM] Recall memory raw.')]), /Raw recall-shaped/);
  assert.doesNotThrow(() => assertZeroRecallSourceSafe([text('user', '[CM] Recall memory quoted.')]));
});

class CollapseProbe extends AutobiographicalStrategy {
  collapse(messages: NormalizedMessage[]) { return this.collapseConsecutiveMessages(messages); }
}
for (const placement of ['head', 'middle', 'opening'] as const) {
  test(`zero-recall surgery refuses collapsed ${placement} headers before returning success`, () => {
    const pair = [text('Context Manager', '[CM] Recall memory L1-1.'), text('mythos', 'memory that must not leak')];
    const isolated = [text('Context Manager', '[CM] Recall memory L1-2.'), text('mythos', 'isolated memory')];
    const raw = text('Context Manager', 'raw CM history');
    const input = placement === 'opening'
      ? [...isolated, ...pair.slice(0, 1), text('Context Manager', 'OPEN'), text('user', 'source')]
      : [...(placement === 'middle' ? isolated : []), raw, ...pair,
        ...(placement === 'head' ? isolated : []), text('Context Manager', 'OPEN'), text('user', 'source')];
    const collapsed = new CollapseProbe().collapse(input);
    assert.ok(collapsed.some(m => m.content.length > 1));
    assert.throws(() => transformZeroRecallCompression(collapsed, 'OPEN', [{ id: 'L1-2', answer: isolated[1] }]), /Collapsed or unrecognized/);
  });
}


test('zero-recall surgery shares the strategy grammar: dotted IDs accepted, multiline IDs refused', () => {
  for (const id of ['archive.1', 'multi\nline', 'multi\rline', 'multi\u2028line', 'multi\u2029line']) {
    const pair = [text('Context Manager', `[CM] Recall memory ${id}.`), text('mythos', 'memory')];
    const input = new CollapseProbe().collapse([...pair, text('Context Manager', 'OPEN'), text('user', 'source')]);
    const run = () => transformZeroRecallCompression(input, 'OPEN', [{ id, answer: pair[1] }]);
    if (id === 'archive.1') assert.deepEqual(run().removedRecallIds, [id]);
    else assert.throws(run, /Collapsed or unrecognized/);
  }
});

test('zero-recall surgery refuses an answer collapsed with same-speaker raw middle history', () => {
  for (const id of ['L1-1', 'multi\nline']) {
    const pair = [text('Context Manager', `[CM] Recall memory ${id}.`), text('mythos', 'memory')];
    const input = [...pair, text('mythos', 'RAW MIDDLE'), text('Context Manager', 'OPEN'), text('user', 'source')];
    const collapsed = new CollapseProbe().collapse(input);
    assert.ok(collapsed[1].content.some(b => b.type === 'text' && b.text === 'RAW MIDDLE'));
    assert.throws(() => transformZeroRecallCompression(collapsed, 'OPEN', [{ id, answer: pair[1] }]), /Unmatched|unrecognized/);
  }
});

test('surgery removes only exact independently supplied recall pairs', () => {
  const header = text('Context Manager', '[CM] Recall memory L1-1.');
  const answer = text('mythos', 'memory');
  const expected = [{ id: 'L1-1', answer }];
  const tail = [text('user', 'raw middle'), text('Context Manager', 'OPEN'), text('mythos', 'source')];
  for (const h of [header, { ...header, content: [...header.content, ...text('Context Manager', 'raw').content] }, text('Context Manager', '[CM] Recall memory L1-1. raw.'), text('Context Manager', 'raw [CM] Recall memory L1-1.'), text('Context Manager', '[CM] Recall memory L1-1.\n')]) {
    for (const a of [answer, text('mythos', 'memory plus raw'), { ...answer, content: [...answer.content, ...text('mythos', 'raw').content] }, { ...answer, participant: 'other' }]) {
      const input = [h, a, ...tail];
      const snapshot = structuredClone(input);
      if (h === header && a === answer) {
        assert.deepEqual(transformZeroRecallCompression(input, 'OPEN', expected).messages, tail);
      } else {
        assert.throws(() => transformZeroRecallCompression(input, 'OPEN', expected));
      }
      assert.deepEqual(input, snapshot, 'failure and success leave the input untouched');
    }
  }
  assert.throws(() => transformZeroRecallCompression([header, answer, ...tail], 'OPEN'), /Unmatched/);
  assert.throws(() => transformZeroRecallCompression([header, answer, ...tail], 'OPEN', [...expected, ...expected]), /ambiguous/);
  assert.throws(() => transformZeroRecallCompression([header, answer, header, answer, ...tail], 'OPEN', expected), /ambiguous/);
});


test('nonblank opening guard is independent of pair geometry', () => {
  const answer = text('mythos', 'memory');
  assert.throws(() => transformZeroRecallCompression([
    text('Context Manager', '[CM] Recall memory L1-1.'), answer,
    text('Context Manager', '   '), text('user', 'source'),
  ], '   ', [{ id: 'L1-1', answer }]), /Missing or ambiguous/);
});

test('Context Manager cannot be the recall answer even before a later opening', () => {
  const answer = text('Context Manager', 'not an assistant answer');
  assert.throws(() => transformZeroRecallCompression([
    text('Context Manager', '[CM] Recall memory L1-1.'), answer,
    text('user', 'middle'), text('Context Manager', 'OPEN'),
  ], 'OPEN', [{ id: 'L1-1', answer }]), /missing assistant answer/);
});

test('source safety accepts ordinary CM history and inspects every block', () => {
  assert.doesNotThrow(() => assertZeroRecallSourceSafe([text('Context Manager', 'ordinary history')]));
  assert.throws(() => assertZeroRecallSourceSafe([{
    participant: 'Context Manager', content: [
      ...text('Context Manager', 'ordinary history').content,
      ...text('Context Manager', '[CM] Recall memory hidden.').content,
    ],
  }]), /Raw recall-shaped/);
});
