import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import {
  AutobiographicalStrategy,
  BlobManager,
  ContextLog,
  ContextManager,
  MalformedContentError,
  MessageStore,
  PassthroughStrategy,
  blockAsStored,
  malformedContentPlaces,
} from '../src/index.js';

const STORE = './test-tool-result-images';
function cleanup(): void {
  if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });
}

const b64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');
const PNG = `89504e470d0a1a0a0000000d49484452${'00'.repeat(64)}`;
const PNG_2 = `89504e470d0a1a0a0000000d49484452${'11'.repeat(64)}`;
const AVIF = '000000206674797061766966';
const PDF = '255044462d312e340a';

function image(hex: string, mediaType: string, extra: Record<string, unknown> = {}): ContentBlock {
  return { type: 'image', source: { type: 'base64', mediaType, data: b64(hex) }, ...extra } as ContentBlock;
}

function toolResult(id: string, content: string | unknown[]): ContentBlock {
  return { type: 'tool_result', toolUseId: id, toolName: 'world--snap', content } as unknown as ContentBlock;
}

function blobFiles(): string[] {
  const root = join(STORE, 'blobs');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

function recorded(manager: ContextManager, id: string): unknown[] {
  const message = manager.getMessageWindow(0, manager.getAllMessages().length, { resolveBlobs: false })
    .messages.find((m) => m.id === id);
  assert.ok(message, `message ${id} is in the store`);
  return message.content as unknown[];
}

function nested(content: unknown[], index = 0): Array<Record<string, unknown>> {
  return (content[index] as { content: Array<Record<string, unknown>> }).content;
}

const CAPTION = 'world--snap result';
const STORED_IMAGE = { type: 'image', source: { type: 'base64', data: b64(PNG), mediaType: 'image/png' } };
const RESULT = toolResult('call_1', [{ type: 'text', text: CAPTION }, image(PNG, 'image/jpeg', { tokenEstimate: 85 })]);

describe('an image inside a tool result', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('is kept as a blob, and every read gives it back inline as blockAsStored says, live and after reopening', async () => {
    const expected = blockAsStored(RESULT);
    let manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    const id = manager.addMessage('user', [RESULT]);
    const check = (content: ContentBlock[] | undefined, when: string): void => {
      assert.ok(content, `the message reads back ${when}`);
      assert.deepStrictEqual(content, [expected], when);
    };
    check(manager.getMessage(id)?.content, 'live');
    check(manager.getAllMessages().at(-1)?.content, 'live, from the full listing');
    check(manager.getMessageWindow(0, 1).messages[0]?.content, 'live, from a window');
    const inRecord = nested(recorded(manager, id));
    assert.deepStrictEqual(inRecord[0], { type: 'text', text: CAPTION }, 'the text block is kept as given');
    assert.equal(inRecord[1]!.type, 'blob_ref', 'the record holds a reference in the image\'s place');
    assert.equal(blobFiles().length, 1, 'the blob store holds one file');
    manager.close();

    manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    check(manager.getMessage(id)?.content, 'after reopening');
    check(manager.getAllMessages().at(-1)?.content, 'after reopening, from the full listing');
    check(manager.getMessageWindow(0, 1).messages[0]?.content, 'after reopening, from a window');
    manager.close();
  });

  it('reads back the same on a fork, and after the store moves to another branch and back', async () => {
    const expected = blockAsStored(RESULT);
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('user', [RESULT]);
      const main = manager.getStore().currentBranch().name;
      const fork = await manager.fork('tool-image-fork');
      assert.notEqual(fork, main);
      assert.deepStrictEqual(manager.getMessage(id)?.content, [expected], 'on the fork');
      await manager.switchBranch(main);
      assert.deepStrictEqual(manager.getMessage(id)?.content, [expected], 'back on the branch it was written on');
      assert.equal(blobFiles().length, 1, 'the fork made no second blob');
    } finally {
      manager.close();
    }
  });

  it('is one blob where two results hold the same image', async () => {
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      const first = manager.addMessage('user', [toolResult('call_1', [image(PNG, 'image/png')])]);
      const second = manager.addMessage('user', [toolResult('call_2', [{ type: 'text', text: 'again' }, image(PNG, 'image/png')])]);
      const refOf = (block: Record<string, unknown>): string => (block as { ref: { hash: string } }).ref.hash;
      assert.equal(refOf(nested(recorded(manager, first))[0]!), refOf(nested(recorded(manager, second))[1]!));
      assert.equal(blobFiles().length, 1);
    } finally {
      manager.close();
    }
  });

  it('is kept as a blob when an edit writes it', async () => {
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('user', [toolResult('call_1', '[results withheld for now]')]);
      manager.editMessage(id, [RESULT]);
      assert.deepStrictEqual(manager.getMessage(id)?.content, [blockAsStored(RESULT)]);
      assert.equal(nested(recorded(manager, id))[1]!.type, 'blob_ref');
      assert.equal(blobFiles().length, 1);
    } finally {
      manager.close();
    }
  });

  it('is kept as a blob in a context log entry, which reads back inline, also after reopening', async () => {
    let store = JsStore.openOrCreate({ path: STORE });
    try {
      ContextLog.register(store);
      new ContextLog(store).append('user', [RESULT]);
      const entry = store.getStateItemJson(ContextLog.stateIdFor(), 0) as { content: unknown[] };
      assert.equal(nested(entry.content)[1]!.type, 'blob_ref', 'the entry holds a reference');
      assert.deepStrictEqual(new ContextLog(store).get(0)?.content, [blockAsStored(RESULT)]);
      assert.equal(blobFiles().length, 1);
    } finally {
      store.close();
    }
    store = JsStore.openOrCreate({ path: STORE });
    try {
      assert.deepStrictEqual(new ContextLog(store).get(0)?.content, [blockAsStored(RESULT)], 'after reopening');
    } finally {
      store.close();
    }
  });

  it('comes back as its source alone, as an image at the top does: blockAsStored pinned to literal output', () => {
    assert.deepStrictEqual(blockAsStored(RESULT), {
      type: 'tool_result',
      toolUseId: 'call_1',
      toolName: 'world--snap',
      content: [{ type: 'text', text: CAPTION }, STORED_IMAGE],
    });
    const textOnly = toolResult('call_2', [{ type: 'text', text: 'no image here' }]);
    assert.equal(blockAsStored(textOnly), textOnly);
    const before = structuredClone(RESULT);
    blockAsStored(RESULT);
    assert.deepStrictEqual(RESULT, before, 'the block it is given is left as it was');
  });

  it('leaves a URL image beside it as given, with no blob of its own', async () => {
    const url = { type: 'image', source: { type: 'url', url: 'https://example.com/b.png' } };
    const result = toolResult('call_1', [url, image(PNG, 'image/png')]);
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('user', [result]);
      const inRecord = nested(recorded(manager, id));
      assert.deepStrictEqual(inRecord[0], url);
      assert.equal(inRecord[1]!.type, 'blob_ref');
      assert.equal(blobFiles().length, 1);
      assert.deepStrictEqual(manager.getMessage(id)?.content, [toolResult('call_1', [url, STORED_IMAGE])]);
      assert.deepStrictEqual(blockAsStored(result), toolResult('call_1', [url, STORED_IMAGE]));
    } finally {
      manager.close();
    }
  });

  it('counts in BlobManager\'s media helpers', () => {
    assert.equal(BlobManager.hasStorableMedia(RESULT), true);
    assert.equal(BlobManager.estimateMediaSize(RESULT), Math.ceil(b64(PNG).length * 0.75));
    const textOnly = toolResult('call_2', [{ type: 'text', text: 'no image here' }]);
    assert.equal(BlobManager.hasStorableMedia(textOnly), false);
    assert.equal(BlobManager.estimateMediaSize(textOnly), 0);
  });

  it('is refused by name at the write, where the store can\'t keep it', async () => {
    const untyped = toolResult('call_1', [
      { type: 'text', text: 'a picture' },
      { type: 'image', source: { type: 'base64', data: b64(AVIF) } },
    ]);
    const place = "content[1].source.mediaType is undefined, not a string, and the image's data has no png, jpeg, gif or webp signature";
    assert.throws(() => blockAsStored(untyped), { name: 'MalformedContentError', message: `blockAsStored: block.${place}.` });
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      assert.throws(() => manager.addMessage('user', [untyped]), {
        name: 'MalformedContentError', message: `Message refused: content[0].${place}.`,
      });
      assert.equal(manager.getAllMessages().length, 0, 'nothing stored');
    } finally {
      manager.close();
    }
  });

  it('names the places of a refused tool result in content order', () => {
    const result = toolResult('call_1', [
      { type: 'image', source: { type: 'base64', data: b64(AVIF) } },
      { type: 'text', text: 42 },
    ]);
    assert.deepStrictEqual(malformedContentPlaces([result]), [
      "content[0].content[0].source.mediaType is undefined, not a string, and the image's data has no png, jpeg, gif or webp signature",
      'content[0].content[1].text is a number, not a string',
    ]);
  });

  it('leaves other media inside a tool result as given', async () => {
    const document = { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: b64(PDF) }, filename: 'a.pdf' };
    const result = toolResult('call_1', [document]);
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('user', [result]);
      assert.deepStrictEqual(nested(recorded(manager, id))[0], document);
      assert.equal(blobFiles().length, 0);
    } finally {
      manager.close();
    }
  });

  it('reads back as before from a store that holds it inline, in a message and in a context log entry', async () => {
    const store = JsStore.openOrCreate({ path: STORE });
    MessageStore.register(store);
    ContextLog.register(store);
    store.appendToStateJsonWithIdentity('messages', { participant: 'user', content: [RESULT], timestamp: Date.now() }, 'id', 'sequence');
    store.appendToStateJson(ContextLog.stateIdFor(), { index: 0, participant: 'user', content: [RESULT] });
    store.close();
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      assert.deepStrictEqual(manager.getAllMessages()[0]!.content, [RESULT]);
      assert.deepStrictEqual(new ContextLog(manager.getStore()).get(0)?.content, [RESULT]);
    } finally {
      manager.close();
    }
  });

  it('leaves a reference to other media inside a tool result as it is when it reads', async () => {
    const reference = { type: 'blob_ref', ref: { hash: 'no-such-blob', mediaType: 'application/pdf', originalType: 'document' } };
    const store = JsStore.openOrCreate({ path: STORE });
    MessageStore.register(store);
    store.appendToStateJsonWithIdentity('messages', { participant: 'user', content: [toolResult('call_1', [reference])], timestamp: Date.now() }, 'id', 'sequence');
    store.close();
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      assert.deepStrictEqual(manager.getAllMessages()[0]!.content, [toolResult('call_1', [reference])]);
    } finally {
      manager.close();
    }
  });

  it('has the type the store holds in a window read without resolution, which a write refuses, and its image in a default read', async () => {
    const manager = await ContextManager.open({ path: STORE, strategy: new PassthroughStrategy() });
    try {
      manager.addMessage('user', [RESULT]);
      const raw = manager.getMessageWindow(0, 1, { resolveBlobs: false }).messages[0]!;
      // @ts-expect-error A row read without resolution holds a blob_ref, which a write refuses.
      assert.throws(() => manager.editMessage(raw.id, raw.content), MalformedContentError);
      const resolveBlobs = [false, true][0]!;
      const either = manager.getMessageWindow(0, 1, { resolveBlobs }).messages[0]!;
      // @ts-expect-error A read that may be without resolution has either type.
      assert.throws(() => manager.editMessage(either.id, either.content), MalformedContentError);
      const read = manager.getMessageWindow(0, 1).messages[0]!;
      manager.editMessage(read.id, read.content);
      assert.deepStrictEqual(manager.getMessage(read.id)?.content, read.content);
    } finally {
      manager.close();
    }
  });
});

describe('a stored tool image, as strategies read it', () => {
  beforeEach(cleanup);
  after(cleanup);

  const BUDGET = { maxTokens: 200_000, reserveForResponse: 4_000 };
  const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'world--snap', input: {} } as ContentBlock);
  const resultIn = (messages: Array<{ content: ContentBlock[] }>, id: string): ContentBlock[] | undefined =>
    (messages.find((m) => m.content.some((b) => b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === id))
      ?.content.find((b) => b.type === 'tool_result') as { content: ContentBlock[] } | undefined)?.content;
  const storedAsBlob = (manager: ContextManager, id: string): void => {
    assert.equal(nested(recorded(manager, id)).find((b) => b.type !== 'text')?.type, 'blob_ref', 'the image is stored as a blob');
  };

  it('under maxLiveImages: 1, the older shows the store\'s labelled placeholder and the newer its image', async () => {
    const manager = await ContextManager.open({ path: STORE, strategy: new AutobiographicalStrategy({ maxLiveImages: 1 }) });
    try {
      manager.addMessage('user', [{ type: 'text', text: 'Take a picture, please.' }]);
      manager.addMessage('prime', [call('call_1')]);
      const older = manager.addMessage('user', [toolResult('call_1', [{ type: 'text', text: 'first' }, image(PNG, 'image/png')])]);
      manager.addMessage('prime', [{ type: 'text', text: 'I see it.' }]);
      manager.addMessage('prime', [call('call_2')]);
      const newer = manager.addMessage('user', [toolResult('call_2', [{ type: 'text', text: 'second' }, image(PNG_2, 'image/png')])]);
      storedAsBlob(manager, older);
      storedAsBlob(manager, newer);
      const { messages } = await manager.compile(BUDGET);
      assert.deepStrictEqual(resultIn(messages, 'call_1'), [
        { type: 'text', text: 'first' },
        { type: 'text', text: '[image not shown: this context keeps only some images]' },
      ]);
      assert.deepStrictEqual(resultIn(messages, 'call_2'), [
        { type: 'text', text: 'second' },
        { type: 'image', source: { type: 'base64', data: b64(PNG_2), mediaType: 'image/png' } },
      ]);
    } finally {
      manager.close();
    }
  });

  it('reaches the summarizer\'s request as an image when its stretch is compressed', async () => {
    const requests: Array<{ messages: Array<{ content: ContentBlock[] }> }> = [];
    const membrane = {
      complete: async (request: { messages: Array<{ content: ContentBlock[] }> }) => {
        requests.push(request);
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `A summary of the stretch: ${'word '.repeat(40)}` }],
          usage: { input_tokens: 1000, output_tokens: 50 } };
      },
    };
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'test-compression-model', targetChunkTokens: 80, headWindowTokens: 0, recentWindowTokens: 0,
    });
    const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
    try {
      manager.setToolDefinitions([{ name: 'world--snap', description: 'Take a picture.', inputSchema: { type: 'object', properties: {} } }]);
      const drain = async (): Promise<void> => {
        for (let i = 0; i < 500 && !manager.isReady(); i++) await manager.tick();
      };
      let resultId: string | undefined;
      for (let i = 0; i < 30; i++) {
        if (i === 3) {
          manager.addMessage('prime', [call('call_1')]);
          await drain();
          resultId = manager.addMessage('user', [RESULT]);
        } else {
          manager.addMessage(i % 2 === 0 ? 'user' : 'prime', [{ type: 'text', text: `turn ${i} of steady traffic about the watch rota `.repeat(3) }]);
        }
        await drain();
      }
      storedAsBlob(manager, resultId!);
      const isTheImage = (block: ContentBlock): boolean =>
        block.type === 'image' && (block as { source: { data?: string } }).source.data === b64(PNG);
      const holdsImage = (request: { messages: Array<{ content: ContentBlock[] }> }): boolean => request.messages.some((m) => m.content.some((b) =>
        isTheImage(b) || (b.type === 'tool_result' && Array.isArray(b.content) && (b.content as ContentBlock[]).some(isTheImage))));
      assert.ok(requests.length > 0, 'the stretch was compressed');
      assert.ok(requests.some(holdsImage), `a summarizer's request holds the image as an image block (${requests.length} requests)`);
    } finally {
      manager.close();
    }
  });
});
