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
import { JsStore } from '@animalabs/chronicle';
import { BlobManager, ContextManager, MessageStore, PassthroughStrategy, blockAsStored } from '../src/index.js';

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
    check(manager.getAllMessages().at(-1)?.content, 'after reopening, from the full listing');
    check(manager.getMessageWindow(0, 1).messages[0]?.content, 'after reopening, from a window');
    manager.close();
  });

  it('pins the stored form of each kind of media to literal output, not only to the store', () => {
    // The equality above runs the store and the export through the same helpers, so a change to a
    // helper moves both together. These pin the round trip itself.
    const named = (name: string): ContentBlock => FIXTURES.find(([n]) => n === name)![1];
    assert.deepStrictEqual(blockAsStored(named('png labeled jpeg')), {
      type: 'image', source: { type: 'base64', data: b64(PNG), mediaType: 'image/png' },
    });
    assert.deepStrictEqual(blockAsStored(named('a document')), {
      type: 'document', source: { type: 'base64', data: b64(PDF), mediaType: 'application/pdf' },
    });
    assert.deepStrictEqual(blockAsStored(named('audio')), {
      type: 'audio', source: { type: 'base64', data: b64('52494646'), mediaType: 'audio/wav' },
    });
    assert.deepStrictEqual(blockAsStored(named('video')), {
      type: 'video', source: { type: 'base64', data: b64('0000001866747970'), mediaType: 'video/mp4' },
    });
  });

  it('writes the sniffed type into the stored reference, not the declared one', async () => {
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    manager.addMessage('user', [image(PNG, 'image/jpeg')]);
    const raw = manager.getMessageWindow(0, 1, { resolveBlobs: false }).messages[0]!.content[0] as unknown as {
      type: string; ref: { mediaType: string; originalType: string };
    };
    manager.close();
    assert.equal(raw.type, 'blob_ref');
    assert.equal(raw.ref.mediaType, 'image/png', 'the reference holds the type its bytes carry');
    assert.equal(raw.ref.originalType, 'image');
  });

  /** Store a message holding `ref`, a block or several, as an older release stored one, past the write, which refuses a blob_ref now. */
  function storeLegacyReference(ref: (hash: string) => unknown, mediaType: string): void {
    const store = JsStore.openOrCreate({ path: STORE });
    const hash = store.storeBlob(Buffer.from(PNG, 'hex'), mediaType);
    MessageStore.register(store);
    store.appendToStateJsonWithIdentity('messages', { participant: 'user', content: [ref(hash)].flat(), timestamp: Date.now() }, 'id', 'sequence');
    store.close();
  }

  it('relabels on read a reference an older release wrote under the wrong type', async () => {
    // Older releases wrote the declared label into the reference, and the read side relabels it from the bytes.
    storeLegacyReference((hash) => ({ type: 'blob_ref', ref: { hash, mediaType: 'image/jpeg', originalType: 'image' } }), 'image/jpeg');
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    const back = manager.getAllMessages()[0]!.content[0];
    manager.close();
    assert.deepStrictEqual(back, { type: 'image', source: { type: 'base64', data: b64(PNG), mediaType: 'image/png' } });
  });

  it('leaves out of its read a reference of an unknown original type, and one of other media with no string media type, naming each, and reads an image\'s with none as before', async () => {
    storeLegacyReference((hash) => [
      { type: 'blob_ref', ref: { hash, mediaType: 'image/png', originalType: 'hologram' } },
      { type: 'blob_ref', ref: { hash, originalType: 'image' } },
      { type: 'blob_ref', ref: { hash, originalType: 'audio' } },
      { type: 'blob_ref', ref: { hash, mediaType: null, originalType: 'document' } },
      { type: 'blob_ref', ref: { hash, mediaType: 42, originalType: 'video' } },
    ], 'image/png');
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    let manager: ContextManager | undefined;
    try {
      manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
      // The first reference is left out, where every read of it threw. The second, of an image whose
      // reference has no media type, reads relabelled from its bytes, as before. The audio, document
      // and video references, whose media type nothing else names, are left out, where they read back
      // with none, or with the reference's null or number.
      const read = manager.getAllMessages()[0]!.content;
      const image = { type: 'image', source: { type: 'base64', data: b64(PNG), mediaType: 'image/png' } };
      assert.deepEqual(read, [image]);
      // What the read gives, a write takes: a host copying the message as read stores it.
      manager.addMessage('user', read);
      assert.deepEqual(manager.getAllMessages()[1]!.content, [image]);
      await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 });
    } finally {
      console.error = original;
      manager?.close();
    }
    assert.ok(
      lines.some((line) => line.includes(
        '(content[0].ref.originalType is "hologram", not image, document, audio or video; content[2].ref.mediaType is undefined, not a string; ' +
          'content[3].ref.mediaType is null, not a string; content[4].ref.mediaType is a number, not a string)',
      )),
      lines.join('\n'),
    );
  });

  it('throws for a block the store refuses, and for a blob_ref, rather than return a form the store would not give back', async () => {
    const untypedDocument = { type: 'document', source: { type: 'base64', data: b64(PDF) } } as unknown as ContentBlock;
    const untypedUnsniffable = { type: 'image', source: { type: 'base64', data: b64(AVIF) } } as unknown as ContentBlock;
    const noData = { type: 'audio', source: { type: 'base64', mediaType: 'audio/wav' } } as unknown as ContentBlock;
    const ref = { type: 'blob_ref', ref: { hash: 'h', mediaType: 'image/png', originalType: 'image' } } as unknown as ContentBlock;
    const urlDocument = { type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } } as unknown as ContentBlock;
    // Data that isn't a string, whose bytes carry no signature the store reads.
    const untypedUnsniffableBytes = { type: 'image', source: { type: 'base64', data: Buffer.from(AVIF, 'hex') } } as unknown as ContentBlock;
    const refusals: Array<[ContentBlock, string]> = [
      [untypedDocument, 'source.mediaType is undefined, not a string'],
      [untypedUnsniffable, "source.mediaType is undefined, not a string, and the image's data has no png, jpeg, gif or webp signature"],
      [untypedUnsniffableBytes, "source.mediaType is undefined, not a string, and the image's data has no png, jpeg, gif or webp signature"],
      [noData, 'source.data is undefined, not base64 data'],
      [urlDocument, 'source.data is undefined, not base64 data; content[0].source.mediaType is undefined, not a string'],
    ];
    // blockAsStored names the block's places from `block`.
    for (const [block, place] of refusals) {
      assert.throws(() => blockAsStored(block), {
        name: 'MalformedContentError',
        message: `blockAsStored: block.${place.replaceAll('content[0].', 'block.')}.`,
      });
    }
    assert.throws(() => blockAsStored(ref), {
      name: 'MalformedContentError',
      message: 'blockAsStored: block is a blob_ref, which only the store writes (a read with blobs resolved, the default, gives the block to write).',
    });
    // A write refuses the same blocks by name, before anything is stored.
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      for (const [block, place] of refusals) {
        assert.throws(() => manager.addMessage('user', [block]), { name: 'MalformedContentError', message: `Message refused: content[0].${place}.` });
      }
      assert.throws(() => manager.addMessage('user', [ref]), {
        name: 'MalformedContentError',
        message: 'Message refused: content[0] is a blob_ref, which only the store writes (a read with blobs resolved, the default, gives the block to write).',
      });
      assert.equal(manager.getAllMessages().length, 0, 'nothing stored');
    } finally {
      manager.close();
    }
  });

  it('a write takes inline media the store can keep, as the store reads its source', async () => {
    // An image without a declared type whose data names one, with whitespace the decode skips before it, past
    // the first 32 characters a short read of the data would see.
    const spaced = { type: 'image', source: { type: 'base64', data: `${'\n'.repeat(40)}${b64(PNG)}` } } as unknown as ContentBlock;
    // Data that isn't a string, which the store reads as bytes.
    const bytes = { type: 'audio', source: { type: 'base64', mediaType: 'audio/wav', data: [0x52, 0x49, 0x46, 0x46] } } as unknown as ContentBlock;
    // An image without a declared type whose data, bytes rather than a string, names one.
    const pngBytes = { type: 'image', source: { type: 'base64', data: Buffer.from(PNG, 'hex') } } as unknown as ContentBlock;
    assert.deepStrictEqual(blockAsStored(spaced), { type: 'image', source: { type: 'base64', data: b64(PNG), mediaType: 'image/png' } });
    assert.deepStrictEqual(blockAsStored(bytes), { type: 'audio', source: { type: 'base64', data: b64('52494646'), mediaType: 'audio/wav' } });
    assert.deepStrictEqual(blockAsStored(pngBytes), { type: 'image', source: { type: 'base64', data: b64(PNG), mediaType: 'image/png' } });
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      manager.addMessage('user', [spaced, bytes, pngBytes]);
      assert.deepStrictEqual(manager.getAllMessages()[0]!.content, [blockAsStored(spaced), blockAsStored(bytes), blockAsStored(pngBytes)]);
    } finally {
      manager.close();
    }
  });

  it('BlobManager\'s media helpers follow the store\'s rule for what becomes a blob', () => {
    const named = (name: string): ContentBlock => FIXTURES.find(([n]) => n === name)![1];
    const file = named('an image whose source is a file');
    assert.equal(BlobManager.hasStorableMedia(file), true, 'a non-URL image is stored as a blob, base64 or not');
    assert.equal(BlobManager.estimateMediaSize(file), Math.ceil(b64(PNG).length * 0.75));
    assert.equal(BlobManager.hasStorableMedia(named('a URL image')), false);
    assert.equal(BlobManager.estimateMediaSize(named('a URL image')), 0);
    assert.equal(BlobManager.hasStorableMedia(named('audio')), true);
    assert.equal(BlobManager.hasStorableMedia(named('text')), false);
  });

  it('reads data as the store does: a Buffer is bytes, stored and given back as base64', async () => {
    const bytes = { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.4') } } as unknown as ContentBlock;
    const expected = blockAsStored(bytes);
    assert.deepStrictEqual(expected, { type: 'document', source: { type: 'base64', data: 'JVBERi0xLjQ=', mediaType: 'application/pdf' } });
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    const id = manager.addMessage('user', [bytes]);
    assert.deepStrictEqual(manager.getMessage(id)!.content[0], expected, 'the store accepts it, and gives back the same');
    manager.close();
  });

  it('stores an untyped image whose bytes carry a signature under the sniffed type', async () => {
    const untyped = { type: 'image', source: { type: 'base64', data: b64(PNG) } } as unknown as ContentBlock;
    const expected = blockAsStored(untyped);
    assert.equal((expected as { source: { mediaType: string } }).source.mediaType, 'image/png');
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    const id = manager.addMessage('user', [untyped]);
    assert.deepStrictEqual(manager.getMessage(id)!.content[0], expected);
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
    for (const name of ['a URL image', 'text', 'a tool call', 'a tool result']) {
      const block = FIXTURES.find(([n]) => n === name)![1];
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
