import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AutobiographicalStrategy } from '../src/index.js';
import { inlineImageBytes } from '../src/inline-images.js';

class Prepared extends AutobiographicalStrategy {
  prepare(request: NormalizedRequest) { return this.prepareCompressionRequest(request); }
  static bytes(block: unknown) { return inlineImageBytes(block); }
  private get preparation() {
    return this as unknown as {
      prepareCompressionAhead(r: NormalizedRequest): NormalizedRequest;
      prepareCompressionCandidate(r: NormalizedRequest, label: string): NormalizedRequest;
    };
  }
  ahead(request: NormalizedRequest) { return this.preparation.prepareCompressionAhead(request); }
  send(request: NormalizedRequest, label: string) { return this.preparation.prepareCompressionCandidate(request, label); }
}
const MiB = 1024 * 1024;
const image = (data: string) => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }) as ContentBlock;
function captureErrors<T>(run: () => T): { result: T; logs: string[] } {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  try { return { result: run(), logs }; } finally { console.error = original; }
}
const request = (content: ContentBlock[]): NormalizedRequest => ({
  messages: [{ participant: 'User', content }], config: { model: 'mock', maxTokens: 1000 },
});
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
describe('compression request preparation', () => {
  it('owns wrappers, releases edited/shared raw forms, and retains untouched blocks and arrays', () => {
    const payload = 'A'.repeat(5000);
    const rawXml = '<function_results>data:image/png;base64,' + payload + '</function_results>';
    const rawItem = { type: 'function_call_output', id: 'old', output: rawXml };
    const changed = { type: 'tool_result', toolUseId: 'a', content: 'data:image/png;base64,' + payload, rawXml, rawItem } as ContentBlock;
    const sibling = { type: 'tool_result', toolUseId: 'b', content: 'other result', rawXml, rawItem } as ContentBlock;
    const untouched = { type: 'tool_result', toolUseId: 'c', content: [{ type: 'text', text: 'unchanged' }],
      rawItem: { type: 'function_call_output', id: 'untouched', output: 'unchanged' } } as ContentBlock;
    const input = request([changed, sibling, untouched]);
    const before = JSON.stringify(input);
    freeze(input);
    const result = new Prepared().prepare(input);
    assert.notStrictEqual(result.request, input);
    assert.notStrictEqual(result.request.messages[0], input.messages[0]);
    assert.equal(result.serializedMediaReplacements, 1);
    assert.equal(JSON.stringify(input), before);
    assert.ok(!JSON.stringify(result.request).includes(payload));
    for (const b of result.request.messages[0].content.slice(0, 2)) {
      assert.equal((b as { rawXml?: unknown }).rawXml, undefined);
      assert.equal((b as { rawItem?: unknown }).rawItem, undefined);
    }
    assert.strictEqual(result.request.messages[0].content[2], untouched);
    assert.strictEqual((result.request.messages[0].content[2] as { content?: unknown }).content,
      (untouched as { content?: unknown }).content);
  });
  it('retains a wholly untouched nested array and raw form by identity', () => {
    const nested = [{ type: 'text', text: 'plain' }] as ContentBlock[];
    const block = { type: 'tool_result', toolUseId: 'a', content: nested, rawXml: '<function_results>plain</function_results>' } as ContentBlock;
    const input = request([block]);
    const prepared = new Prepared().prepare(input);
    assert.strictEqual(prepared.request.messages[0].content, input.messages[0].content);
    assert.strictEqual(prepared.request.messages[0].content[0], block);
    assert.strictEqual((prepared.request.messages[0].content[0] as { content?: unknown }).content, nested);
  });
  it('preparing an expanded candidate cannot change the canonical head image', () => {
    const head = { participant: 'User', content: [image('AAAA')] };
    const canonical = { ...request([]), messages: [head] };
    const strategy = new Prepared({ maxCompressionImageBytes: 6 });
    const preparedCanonical = strategy.prepare(canonical).request;
    const before = JSON.stringify(preparedCanonical);
    const variant = { ...canonical, messages: [head, { participant: 'User', content: [image('BBBBBB')] }] };
    assert.equal(strategy.prepare(variant).imageReplacements, 1);
    assert.equal(JSON.stringify(preparedCanonical), before);
    assert.equal(head.content[0].type, 'image');
  });
  it('preparing a prepared request replaces nothing more, and sending it logs nothing', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const strategy = new Prepared({ maxCompressionImageBytes: 4 });
    const first = strategy.prepare(request([
      { type: 'text', text: url + '\\n' + url + '\\"' },
      { type: 'tool_use', id: 't', name: 'post', input: { image: url } } as ContentBlock,
      image('AAAAAAAA'), image('AAA'),
    ]));
    assert.equal(first.serializedMediaReplacements, 3);
    assert.equal(first.imageReplacements, 1);
    const second = strategy.prepare(first.request);
    assert.equal(second.serializedMediaReplacements, 0);
    assert.equal(second.imageReplacements, 0);
    assert.equal(JSON.stringify(second.request), JSON.stringify(first.request));
    const { logs } = captureErrors(() => strategy.send(first.request, 'resent'));
    assert.deepEqual(logs, []);
  });
  it('the compression cap counts every inline image shape, generated images included, inside tool results too', () => {
    const shapes = [
      { type: 'image', source: { type: 'url', url: 'data:image/png;base64,AAAAAAAA' } },
      { type: 'image', source: { type: 'url', url: 'DATA:image/png;base64,AAAAAAAA' } },
      { type: 'image', data: 'AAAAAAAA', mimeType: 'image/png' },
      { type: 'generated_image', data: 'AAAAAAAA', mimeType: 'image/png' },
    ];
    for (const shape of shapes) {
      assert.equal(Prepared.bytes(shape), 8, JSON.stringify(shape));
      const top = new Prepared({ maxCompressionImageBytes: 4 }).prepare(request([shape as ContentBlock]));
      assert.equal(top.imageReplacements, 1);
      assert.equal(top.request.messages[0].content[0].type, 'text');
      const nested = { type: 'tool_result', toolUseId: 'a', content: [shape] } as ContentBlock;
      const inner = new Prepared({ maxCompressionImageBytes: 4 }).prepare(request([nested]));
      assert.equal(inner.imageReplacements, 1);
      assert.equal((inner.request.messages[0].content[0] as { content: ContentBlock[] }).content[0].type, 'text');
      assert.equal((nested as { content: ContentBlock[] }).content[0].type, shape.type, 'the stored block is unchanged');
    }
    assert.equal(Prepared.bytes({ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }), 0);
  });
  it('replaces a data URL in a tool call input, changes nothing else in it, and releases the call replay form', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    const rawXml = '<function_calls><invoke name="post">' + url + '</invoke></function_calls>';
    const fields = { caption: 'a cat', count: 3, ok: true, none: null, files: [{ url, size: 10 }, 'plain', [1, 'two']] };
    const call = { type: 'tool_use', id: 't', name: 'post', input: fields, rawXml } as ContentBlock;
    const input = request([call]);
    const before = JSON.stringify(input);
    freeze(input);
    const result = new Prepared().prepare(input);
    assert.equal(result.serializedMediaReplacements, 1);
    const prepared = result.request.messages[0].content[0] as unknown as { input: unknown; rawXml?: string };
    assert.deepEqual(prepared.input, { ...fields, files: [{ url: marker, size: 10 }, 'plain', [1, 'two']] });
    assert.strictEqual((prepared.input as typeof fields).files[2], fields.files[2], 'an unchanged array keeps its identity');
    assert.equal(prepared.rawXml, undefined);
    assert.equal(JSON.stringify(input), before);
  });
  it('leaves a tool call whose input holds no long data URL as it is, its replay form included', () => {
    const call = { type: 'tool_use', id: 't', name: 'post', input: { caption: 'short', list: [1, 'two', null, true] },
      rawXml: '<function_calls><invoke name="post">short</invoke></function_calls>' } as ContentBlock;
    const input = request([call]);
    const prepared = new Prepared().prepare(input);
    assert.strictEqual(prepared.request.messages[0].content, input.messages[0].content);
    assert.strictEqual(prepared.request.messages[0].content[0], call);
  });
  it('replaces a data URL held by a __proto__ member, which stays the input\'s own', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const parsed = JSON.parse('{"__proto__":' + JSON.stringify(url) + '}') as Record<string, unknown>;
    const call = { type: 'tool_use', id: 't', name: 'post', input: parsed } as ContentBlock;
    const input = (new Prepared().prepare(request([call])).request.messages[0].content[0] as unknown as { input: Record<string, unknown> }).input;
    assert.deepEqual(Object.keys(input), ['__proto__']);
    assert.match(JSON.stringify(input), /^\{"__proto__":"\[embedded image\/png data URL omitted/);
  });
  it('replaces a data URL in arguments that did not parse, beside one in the input, and leaves the stored call as it was', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    const unparseableInput = '{"image":"' + url + '","caption":';
    const call = { type: 'tool_use', id: 't', name: 'post', input: { image: url }, unparseableInput } as ContentBlock;
    const input = request([call]);
    const before = JSON.stringify(input);
    freeze(input);
    const result = new Prepared().prepare(input);
    assert.equal(result.serializedMediaReplacements, 2);
    const prepared = result.request.messages[0].content[0] as unknown as { input: { image: string }; unparseableInput: string };
    assert.equal(prepared.input.image, marker);
    assert.equal(prepared.unparseableInput, '{"image":"' + marker + '","caption":');
    assert.equal(JSON.stringify(input), before);
  });
  it('keeps every member of a tool call input it rebuilds, a __proto__ member included', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const parsed = JSON.parse(JSON.stringify({ image: url }).replace('{', '{"__proto__":{"note":"keep"},')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['__proto__', 'image']);
    const call = { type: 'tool_use', id: 't', name: 'post', input: parsed } as ContentBlock;
    const result = new Prepared().prepare(request([call]));
    const input = (result.request.messages[0].content[0] as unknown as { input: Record<string, unknown> }).input;
    assert.deepEqual(Object.keys(input), ['__proto__', 'image']);
    assert.equal(JSON.stringify(input).startsWith('{"__proto__":{"note":"keep"},"image":"[embedded image/png'), true);
  });
  it('reports serialized payload characters including JSON slash escapes, at the existing floor', () => {
    const payload = 'A\\/'.repeat(1500);
    const result = new Prepared().prepare(request([{ type: 'text', text: 'data:image\\/png;base64,' + payload }]));
    assert.equal(result.serializedMediaReplacements, 1);
    assert.ok(JSON.stringify(result.request).includes('4500 serialized payload characters'));
    for (const size of [4095, 4096]) {
      const r = new Prepared().prepare(request([{ type: 'text', text: 'data:image/png;base64,' + 'A'.repeat(size) }]));
      assert.equal(r.serializedMediaReplacements, size < 4096 ? 0 : 1);
    }
  });
});

describe('preparation counts and logging', () => {
  it('returns its counts without logging; a candidate logs each kind of replacement once, naming the request', () => {
    const strategy = new Prepared({ maxCompressionImageBytes: 3 * MiB });
    const input = request([
      { type: 'text', text: 'data:image/png;base64,' + 'A'.repeat(5000) },
      image('A'.repeat(2.5 * MiB)),
      image('A'.repeat(MiB)),
    ]);
    const { result: prepared, logs } = captureErrors(() => strategy.prepare(input));
    assert.equal(prepared.serializedMediaReplacements, 1);
    assert.equal(prepared.imageReplacements, 1, 'the 2.5 MiB image fits the 3 MiB budget, then the 1 MiB one does not');
    assert.equal(prepared.imageBudgetBytes, 3 * MiB);
    assert.equal(prepared.imageBytesKept, 2.5 * MiB);
    assert.deepEqual(logs, [], 'prepareCompressionRequest logs nothing');
    const sent = captureErrors(() => strategy.send(input, 'count-test'));
    assert.deepEqual(sent.logs, [
      '[autobiographical] compression prompt: replaced 1 serialized data URL(s) with markers [count-test]',
      '[autobiographical] compression prompt: replaced 1 image(s) with placeholders to stay under the ' +
        '3.0MiB inline image budget (kept 2.5MiB, newest messages first) [count-test]',
    ]);
    assert.deepEqual(captureErrors(() => strategy.send(request([{ type: 'text', text: 'plain' }]), 'unchanged')).logs, []);
  });
  it('a request prepared ahead logs what was replaced when it is sent, once', () => {
    const strategy = new Prepared();
    const input = request([{ type: 'text', text: 'data:image/png;base64,' + 'A'.repeat(5000) }]);
    const { result: ahead, logs } = captureErrors(() => strategy.ahead(input));
    assert.deepEqual(logs, [], 'nothing is logged when it is prepared');
    const first = captureErrors(() => strategy.send(ahead, 'first-send'));
    assert.strictEqual(first.result, ahead, 'it is sent as prepared');
    assert.deepEqual(first.logs, ['[autobiographical] compression prompt: replaced 1 serialized data URL(s) with markers [first-send]']);
    assert.deepEqual(captureErrors(() => strategy.send(ahead, 'second-send')).logs, []);
  });
});
