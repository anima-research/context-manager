/**
 * blockAsStored: a content block as the store hands it back, without a store.
 *
 * Its contract is equality with the store's own read-back: each fixture is
 * appended through a real store and read back with blobs resolved, live and
 * after reopening, and the export must deep-equal what came back. A host
 * relies on that to hash a body as the store will keep it before anything is
 * written (agent-framework's sourceBodyDigest). Further tests pin what the
 * round trip does, so a change to it shows here as well as in the equality.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, PassthroughStrategy, blockAsStored } from '../src/index.js';

const STORE = './test-block-as-stored';
function cleanup(): void {
  if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });
}

const b64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');
const PNG = '89504e470d0a1a0a0000000d49484452';
const JPEG = 'ffd8ffe000104a4649460001';
const GIF87A = '474946383761010001000000';
const GIF89A = '47494638396101000100';
const WEBP = '524946460c00000057454250';
const AVIF = '000000206674797061766966';
const PDF = '255044462d312e340a';

function image(hex: string, mediaType: string, extra: Record<string, unknown> = {}): ContentBlock {
  return { type: 'image', source: { type: 'base64', mediaType, data: b64(hex) }, ...extra } as ContentBlock;
}

/** Every shape the round trip treats differently, each named for the failure message. */
const FIXTURES: Array<[string, ContentBlock]> = [
  ['png labeled jpeg', image(PNG, 'image/jpeg')],
  ['jpeg labeled png', image(JPEG, 'image/png')],
  ['gif87a labeled png', image(GIF87A, 'image/png')],
  ['gif89a labeled jpeg', image(GIF89A, 'image/jpeg')],
  ['webp labeled png', image(WEBP, 'image/png')],
  ['an unsniffed type, kept as declared', image(AVIF, 'image/avif')],
  ['an image carrying more than its source', image(PNG, 'image/png', { tokenEstimate: 85, sourceUrl: 'https://example.com/a.png' })],
  ['base64 with whitespace and no padding', { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: `${b64(PNG).slice(0, 8)}\n${b64(PNG).slice(8).replace(/=+$/, '')}` } } as ContentBlock],
  // Neither base64 nor a URL: kept as a blob all the same, and read back as base64.
  ['an image whose source is a file', { type: 'image', source: { type: 'file', mediaType: 'image/jpeg', data: b64(PNG) } } as unknown as ContentBlock],
  ['a URL image', { type: 'image', source: { type: 'url', url: 'https://example.com/b.png' }, tokenEstimate: 85 } as ContentBlock],
  ['a document', { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: b64(PDF) }, filename: 'a.pdf', rawItem: { type: 'input_file' } } as ContentBlock],
  ['audio', { type: 'audio', source: { type: 'base64', mediaType: 'audio/wav', data: b64('52494646') }, duration: 2 } as ContentBlock],
  ['video', { type: 'video', source: { type: 'base64', mediaType: 'video/mp4', data: b64('0000001866747970') }, duration: 3 } as ContentBlock],
  ['text', { type: 'text', text: 'plain' }],
  ['a tool call', { type: 'tool_use', id: 'call_1', name: 'fs:read', input: { path: '/a' } } as ContentBlock],
  ['a tool result', { type: 'tool_result', toolUseId: 'call_1', content: 'contents' } as ContentBlock],
];

describe('blockAsStored', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('equals what the store hands back, live and after reopening', async () => {
    const blocks = FIXTURES.map(([, block]) => block);
    const expected = blocks.map((block) => blockAsStored(block));

    let manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    const id = manager.addMessage('user', blocks);
    const check = (content: ContentBlock[] | undefined, when: string): void => {
      assert.ok(content, `the message reads back ${when}`);
      assert.equal(content.length, FIXTURES.length);
      FIXTURES.forEach(([name], i) => assert.deepStrictEqual(expected[i], content[i], `${name}, ${when}`));
    };
    check(manager.getMessage(id)?.content, 'live');
    check(manager.getAllMessages().at(-1)?.content, 'live, from the full listing');
    check(manager.getMessageWindow(0, 1).messages[0]?.content, 'live, from a window');
    manager.close();

    manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    check(manager.getMessage(id)?.content, 'after reopening');
    manager.close();
  });

  it('relabels an image by its bytes, and keeps a type it can\'t sniff', () => {
    const typeOf = (block: ContentBlock): unknown => (block as { source: { mediaType: string } }).source.mediaType;
    assert.equal(typeOf(blockAsStored(image(PNG, 'image/jpeg'))), 'image/png');
    assert.equal(typeOf(blockAsStored(image(JPEG, 'image/png'))), 'image/jpeg');
    assert.equal(typeOf(blockAsStored(image(GIF87A, 'image/png'))), 'image/gif');
    assert.equal(typeOf(blockAsStored(image(GIF89A, 'image/jpeg'))), 'image/gif');
    assert.equal(typeOf(blockAsStored(image(WEBP, 'image/png'))), 'image/webp');
    assert.equal(typeOf(blockAsStored(image(AVIF, 'image/avif'))), 'image/avif');
    // Only images are relabeled: a document keeps its declared type whatever its bytes.
    const pngAsDocument = { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: b64(PNG) } } as ContentBlock;
    assert.equal(typeOf(blockAsStored(pngAsDocument)), 'application/pdf');
  });

  it('keeps inline media as its source alone, with base64 rewritten from the bytes', () => {
    assert.deepStrictEqual(blockAsStored(image(PNG, 'image/png', { tokenEstimate: 85, sourceUrl: 'https://example.com/a.png' })), {
      type: 'image', source: { type: 'base64', data: b64(PNG), mediaType: 'image/png' },
    });
    const document = FIXTURES.find(([name]) => name === 'a document')![1];
    assert.deepStrictEqual(blockAsStored(document), {
      type: 'document', source: { type: 'base64', data: b64(PDF), mediaType: 'application/pdf' },
    });
    const ragged = FIXTURES.find(([name]) => name === 'base64 with whitespace and no padding')![1];
    assert.equal((blockAsStored(ragged) as { source: { data: string } }).source.data, b64(PNG));
    const file = FIXTURES.find(([name]) => name === 'an image whose source is a file')![1];
    assert.deepStrictEqual(blockAsStored(file), {
      type: 'image', source: { type: 'base64', data: b64(PNG), mediaType: 'image/png' },
    });
  });

  it('gives back every other block as it was, and changes nothing it is given', () => {
    for (const [name, block] of FIXTURES.filter(([n]) => ['a URL image', 'text', 'a tool call', 'a tool result'].includes(n))) {
      assert.equal(blockAsStored(block), block, name);
    }
    for (const [name, block] of FIXTURES) {
      const before = structuredClone(block);
      blockAsStored(block);
      assert.deepStrictEqual(block, before, `${name} is left as it was`);
    }
  });

  it('leaves the store\'s serialization out: a block differs from its read-back only there', async () => {
    // Undefined fields, key order and UTF-8 (a lone surrogate comes back as
    // U+FFFD) belong to the store's serialization, which blockAsStored doesn't
    // model. Normalizing them on both sides makes the two equal.
    const block = { type: 'text', text: 'lone \ud800 surrogate', note: undefined } as unknown as ContentBlock;
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    const id = manager.addMessage('user', [block]);
    const back = manager.getMessage(id)!.content[0];
    manager.close();
    assert.notDeepStrictEqual(blockAsStored(block), back);
    // String.prototype.toWellFormed is ES2024, past this package's lib; node has it.
    const wellFormed = (s: string): string => (s as unknown as { toWellFormed(): string }).toWellFormed();
    const serialized = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === 'string' ? wellFormed(v) : v)));
    assert.deepStrictEqual(serialized(blockAsStored(block)), serialized(back));
    assert.equal((back as { text: string }).text, 'lone \ufffd surrogate');
  });
});
