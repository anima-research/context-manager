import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { ContextManager, type AutobiographicalOptions, type SummaryEntry, type StrategyContext } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import { ZeroRecallSurgeryStrategy } from '../src/surgery/zero-recall-strategy.js';
import { assertZeroRecallConstruction, assertZeroRecallSourceSafe, transformConstructedZeroRecallCompression, captureZeroRecallConstruction } from '../src/surgery/zero-recall-compression.js';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const thinking: ContentBlock = { type: 'thinking', thinking: 'reasoning', signature: 'signed' };
class Probe extends ZeroRecallSurgeryStrategy {
  observed = 0;
  protected override observeL1CompressionRequest(request: NormalizedRequest, ids: readonly string[]) {
    this.observed++;
    super.observeL1CompressionRequest(request, ids);
  }
  seed(summary: SummaryEntry) { this.pushSummary(summary); }
  compress(chunk: Chunk, ctx: StrategyContext) { return this.compressChunkHierarchical(chunk, ctx); }
}

async function exercise(content: ContentBlock[], options: AutobiographicalOptions = {}, rejectCarriers = false,
  inspect?: (request: NormalizedRequest, expected: ContentBlock[]) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'zc-'));
  const strategy = new Probe({ compressionModel: 'mock', headWindowTokens: 0, recentWindowTokens: 0,
    targetChunkTokens: 100, minChunkCharsForLLM: 0, mergeThreshold: 99, autoTickOnNewMessage: false,
    quarantineAlarmIntervalMs: 0, compressionRefusalCurveFallbacks: 0, ...options });
  const requests: NormalizedRequest[] = [];
  const membrane = { complete: async (request: NormalizedRequest) => {
    const constructed = strategy.construction!;
    assert.ok(constructed, 'construction observer ran before transport');
    assertZeroRecallConstruction(request, constructed.request);
    const expected = constructed.expectedAnswers.find(a => a.id === 'L1-100')!;
    assert.ok(expected, 'retained prior memory is actually recalled');
    const edited = transformConstructedZeroRecallCompression(request, strategy.opening(), constructed);
    assert.deepEqual(edited.removedRecallIds, ['L1-100']);
    assert.ok(edited.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('source turn'))));
    assert.ok(edited.messages.some(m => m.content.some(b => b.type === 'text' && b.text === 'raw middle')),
      'same-speaker raw history is not blessed as part of a recall answer');
    // An interceptor cannot alter either the answer or any other request field.
    for (const changed of [
      { ...request, config: { ...request.config, model: 'different' } },
      { ...request, messages: request.messages.map((m, i) => i === 1 ? { ...m, content: [text('wrong')] } : m) },
    ]) assert.throws(() => assertZeroRecallConstruction(changed, constructed.request), /differs from trusted/);
    inspect?.(request, expected.answer.content);
    requests.push(structuredClone(request));
    if (rejectCarriers && requests.length === 1) throw Object.assign(new Error('invalid_request: thinking cannot be modified'), { httpStatus: 400, type: 'invalid_request', retryable: false });
    return { content: [text('new summary')], stopReason: 'end_turn' };
  } };
  const manager = await ContextManager.open({ path: dir, strategy, membrane: membrane as never });
  try {
    manager.setToolDefinitions([{ name: 'mock', description: 'mock', inputSchema: { type: 'object' } }] as never);
    const first = manager.addMessage('user', [text('prior covered turn')]);
    manager.addMessage('Claude', [text('raw middle')]);
    const source = manager.addMessage('user', [text('source turn '.repeat(50))]);
    strategy.seed({ id: 'L1-100', level: 1, content: 'stored summary', responseContent: content,
      tokens: 20, sourceLevel: 0, sourceIds: [first], sourceRange: { first, last: first }, created: 0 });
    const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
    const messages = ctx.messageStore.getAll().filter(m => m.id === source);
    const compression = strategy.compress({ index: 1, startIndex: 2, endIndex: 3, messages, tokens: 100, compressed: false }, ctx);
    if (content.some(b => b.type === 'tool_result')) {
      await assert.rejects(compression, /Split recall answer/);
      assert.equal(strategy.observed, 1, 'refusal happened in the construction observer, not a missing-tools deferral');
    } else await compression;
    return requests;
  } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('constructed expectations share empty-text sanitization and cache-control stripping', async () => {
  const input = [thinking, text(''), { ...text('summary'), cache_control: { type: 'ephemeral' } } as ContentBlock];
  const original = structuredClone(input);
  const calls = await exercise(input, {}, false, (_r, expected) => {
    assert.deepEqual(expected, [thinking, text('summary')]);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(input, original, 'stored summary blocks are not edited');
});

test('constructed expectations share serialized-media preparation in answers and opening', async () => {
  const url = 'data:image/png;base64,' + 'A'.repeat(10000);
  const calls = await exercise([thinking, text('summary ' + url)], {
    compressionInstructions: { templates: { opening: 'OPEN ' + url } },
  }, false, (request, expected) => {
    assert.ok(!JSON.stringify(expected).includes(url));
    assert.ok(!JSON.stringify(request).includes(url));
    assert.match(JSON.stringify(expected), /summary/);
  });
  assert.equal(calls.length, 1);
});

test('constructed expectations share whole-request image replacement', async () => {
  const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA'.repeat(100) } } as unknown as ContentBlock;
  const calls = await exercise([thinking, text('summary'), image], { maxCompressionImageBytes: 1 }, false,
    (_request, expected) => assert.ok(expected.every(b => b.type !== 'image')));
  assert.equal(calls.length, 1);
});

test('constructed expectations follow the explicit carrier-transport retry', async () => {
  const calls = await exercise([thinking, text('summary')], {}, true, (_request, expected) => {
    assert.ok(expected.some(b => b.type === 'text'));
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].messages.some(m => m.content.some(b => b.type === 'thinking')));
  assert.ok(calls[1].messages.every(m => m.content.every(b => b.type !== 'thinking')));
});

test('constructed expectations share unpaired-tool stripping', async () => {
  const calls = await exercise([thinking, text('summary'), { type: 'tool_use', id: 'orphan', name: 'mock', input: {} }], {}, false,
    (_r, expected) => assert.ok(expected.every(b => b.type !== 'tool_use')));
  assert.equal(calls.length, 1);
});

test('mixed-tool answers fail closed instead of treating a normalized fragment as a whole memory', async () => {
  const calls = await exercise([thinking, text('summary'),
    { type: 'tool_use', id: 'call', name: 'mock', input: {} },
    { type: 'tool_result', toolUseId: 'call', content: [text('result')] }, text('continuation')]);
  assert.equal(calls.length, 0);
});

test('source-safety binding rejects an ordinary raw turn equal to the opening', () => {
  assert.throws(() => assertZeroRecallSourceSafe([
    { participant: 'Context Manager', content: [text('OPEN')] },
  ], 'OPEN'), /collides with compression opening/);
});

test('cache stripping kill switch preserves imported answer cache metadata', async () => {
  const cached = { ...text('summary'), cache_control: { type: 'ephemeral' } } as ContentBlock;
  const calls = await exercise([thinking, cached], { compressionCacheMarkers: false }, false,
    (_r, expected) => assert.deepEqual(expected, [thinking, cached]));
  assert.equal(calls.length, 1);
});


test('construction-bound surgery refuses a raw false opening that truncates recall removal', () => {
  const request = { config: {}, messages: [
    { participant: 'Context Manager', content: [text('[CM] Recall memory L1-1.')] },
    { participant: 'Claude', content: [text('first')] },
    { participant: 'Context Manager', content: [text('OPEN')] },
    { participant: 'user', content: [text('raw')] },
    { participant: 'Context Manager', content: [text('[CM] Recall memory L1-2.')] },
    { participant: 'Claude', content: [text('second')] },
  ] } as NormalizedRequest;
  const construction = captureZeroRecallConstruction(request, ['L1-1', 'L1-2']);
  assert.throws(() => transformConstructedZeroRecallCompression(request, 'OPEN', construction), /Incomplete constructed recall removal/);
});
