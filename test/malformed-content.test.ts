/**
 * Content that doesn't match ContentBlock where its readers read it (#184):
 * content that isn't an array; a block that isn't an object, is an array,
 * or has no string type; a text
 * block whose text, or a thinking block whose thinking, isn't a string; a
 * tool_use whose input isn't an object; a tool_result whose content is
 * neither a string nor an array of such blocks, at any depth; media without
 * an object source, such as MCP's form, which carries its data and mimeType
 * on the block; a generated image without string data and media type; and a
 * blob_ref, which only the store writes, whose ref has no string hash or an
 * originalType other than image, document, audio or video. A store written
 * before writes refused it can hold it. Reads leave it out or make it match,
 * so every compile, compression pass and reopen works, and the store keeps
 * it as written. A write mends a tool_use's input, as a read does, and
 * refuses the rest, naming where it is.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AutobiographicalStrategy,
  blockAsStored,
  ContextLog,
  ContextManager,
  MalformedContentError,
  malformedContentPlaces,
  MessageStore,
  PassthroughStrategy,
  WindowedPassthroughStrategy,
} from '../src/index.js';

const t = (text: string) => ({ type: 'text', text }) as ContentBlock;
/** A 1x1 PNG, and a WAV header with no samples, as base64. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
/** Media in MCP's form: its data and media type on the block, with no source. */
const mcpMedia = (type: string, data: string, mimeType: string) => ({ type, data, mimeType });
/** The same media as a read mends it, and as agent-framework converts MCP's media. */
const asSource = (type: string, data: string, mediaType: string) => ({ type, source: { type: 'base64', data, mediaType } });
const toolResult = (toolUseId: string, content: unknown) => ({ type: 'tool_result', toolUseId, content });
const toolUse = (id: string, input?: unknown) => ({ type: 'tool_use', id, name: 'probe', ...(input === undefined ? {} : { input }) });
/** An array that holds itself: a value with no JSON form. */
const cyclic = (): unknown[] => {
  const a: unknown[] = [];
  a.push(a);
  return a;
};

/** Each user message that doesn't match ContentBlock at its top level. */
const MALFORMED_BLOCKS: unknown[][] = [
  [t('kept'), 'a bare string'],
  ['only a string'],
  [t('kept'), 42],
  [t('kept'), true],
  [t('kept'), null],
  [t('kept'), { type: 'text' }],
  [t('kept'), { type: 'text', text: null }],
  [t('kept'), { type: 'text', text: 42 }],
  [t('kept'), [t('in an array')]],
  [t('kept'), { text: 'without a type' }],
  [t('kept'), { type: 'image' }],
  [t('kept'), { type: 'document', source: null }],
  [t('kept'), { type: 'video', source: 'x' }],
  [t('kept'), { type: 'generated_image', mimeType: 'image/png' }],
  [t('kept'), { type: 'blob_ref' }],
  [t('kept'), { type: 'blob_ref', ref: {} }],
];
/** Each assistant message whose thinking doesn't match: unsigned, and signed with no text. */
const MALFORMED_ASSISTANT: unknown[][] = [
  [{ type: 'thinking' }, t('kept')],
  [{ type: 'thinking', thinking: null }, t('kept')],
  [{ type: 'thinking', signature: 'sig' }, t('kept')],
];
/** Each tool_use input that doesn't match: missing, null, a string, an array. */
const MALFORMED_INPUTS: unknown[] = [undefined, null, 'x', [1]];
/** Each tool_result content that doesn't match: elements, a nested tool_result, and content that is neither a string nor an array. */
const MALFORMED_TOOL_CONTENT: unknown[] = [
  ['nested string'],
  [42],
  [true],
  [null],
  [t('ok'), null],
  [t('ok'), { type: 'text' }],
  [t('outer'), toolResult('inner', [t('deep'), null])],
  null,
  undefined,
  42,
  {},
  t('a lone block'),
];

/** Write content to the message slot as a store can hold it, past MessageStore. */
function writeRaw(store: JsStore, participant: string, content: unknown[]): void {
  store.appendToStateJsonWithIdentity('messages', { participant, content, timestamp: Date.now() }, 'id', 'sequence');
}

/** Each place in compiled or read messages that doesn't match ContentBlock, at any depth. */
function malformedIn(messages: ReadonlyArray<{ content: readonly unknown[] }>): string[] {
  const places: string[] = [];
  const isObject = (value: unknown) => typeof value === 'object' && value !== null;
  const walk = (blocks: readonly unknown[], at: string) => {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as {
        type?: unknown; text?: unknown; thinking?: unknown; input?: unknown; content?: unknown; source?: unknown; data?: unknown; mimeType?: unknown;
      } | null;
      const here = `${at}[${i}]`;
      if (!isObject(block) || Array.isArray(block)) places.push(here);
      else if (typeof block!.type !== 'string') places.push(`${here}.type`);
      else if (block!.type === 'text' && typeof block!.text !== 'string') places.push(`${here}.text`);
      else if (block!.type === 'thinking' && typeof block!.thinking !== 'string') places.push(`${here}.thinking`);
      else if (block!.type === 'tool_use' && (!isObject(block!.input) || Array.isArray(block!.input))) places.push(`${here}.input`);
      else if (['image', 'document', 'audio', 'video'].includes(block!.type as string) && (!isObject(block!.source) || Array.isArray(block!.source))) places.push(`${here}.source`);
      else if (block!.type === 'generated_image' && (typeof block!.data !== 'string' || typeof block!.mimeType !== 'string')) places.push(`${here}.data`);
      // A compile resolves every blob it reads, so none is left as a reference.
      else if (block!.type === 'blob_ref') places.push(here);
      else if (block!.type === 'tool_result') {
        if (Array.isArray(block!.content)) walk(block!.content, `${here}.content`);
        else if (typeof block!.content !== 'string') places.push(`${here}.content`);
      }
    }
  };
  messages.forEach((message, m) => walk(message.content, `message ${m}`));
  return places;
}

async function withStore(run: (store: JsStore) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-malformed-'));
  const store = JsStore.create({ path: join(dir, 'store') });
  try {
    await run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Capture console.error while `run` runs. */
async function errorLines(run: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines;
}

const STRATEGIES: Record<string, () => PassthroughStrategy | WindowedPassthroughStrategy | AutobiographicalStrategy> = {
  passthrough: () => new PassthroughStrategy(),
  windowed: () => new WindowedPassthroughStrategy(),
  // Compression runs over the earliest messages, where the malformed ones are.
  autobiographical: () => new AutobiographicalStrategy({
    targetChunkTokens: 20, headWindowTokens: 0, recentWindowTokens: 0, hierarchical: true,
    l1HoldbackChunks: 0, minChunkCharsForLLM: 0, autoTickOnNewMessage: false, compressionModel: 'test-model',
  }),
};

describe("content that doesn't match ContentBlock", () => {
  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    const compresses = name === 'autobiographical';
    it(`a store holding it compiles and reopens under ${name}${compresses ? ', and compresses' : ''}`, async () => {
      await withStore(async (store) => {
        const asked: string[] = [];
        const membrane = {
          complete: async (request: unknown) => {
            asked.push(JSON.stringify(request));
            return { stopReason: 'end_turn', content: [t('Summary of the chunk')] };
          },
        };
        const open = async () => {
          const manager = await ContextManager.open({ store, strategy: strategy(), membrane: membrane as never });
          manager.setToolDefinitions([{ name: 'probe', description: 'A probe tool', inputSchema: { type: 'object', properties: {} } }]);
          return manager;
        };
        MessageStore.register(store);
        writeRaw(store, 'User', [t('hi')]);
        for (const content of MALFORMED_BLOCKS) writeRaw(store, 'User', content);
        // A reference to a blob the store holds, of an original type no release writes.
        const hash = store.storeBlob(Buffer.from(PNG, 'base64'), 'image/png');
        writeRaw(store, 'User', [t('kept'), { type: 'blob_ref', ref: { hash, mediaType: 'image/png', originalType: 'hologram' } }]);
        // Content that isn't an array at all.
        writeRaw(store, 'User', null as unknown as unknown[]);
        writeRaw(store, 'User', 'not blocks' as unknown as unknown[]);
        for (const content of MALFORMED_ASSISTANT) {
          writeRaw(store, 'Claude', content);
          writeRaw(store, 'User', [t('go on')]);
        }
        MALFORMED_INPUTS.forEach((input, i) => {
          writeRaw(store, 'Claude', [toolUse(`u${i}`, input)]);
          writeRaw(store, 'User', [toolResult(`u${i}`, [t('kept')])]);
        });
        MALFORMED_TOOL_CONTENT.forEach((content, i) => {
          writeRaw(store, 'Claude', [toolUse(`t${i}`, {})]);
          writeRaw(store, 'User', [toolResult(`t${i}`, content)]);
        });
        const compiled: Array<{ messages: ReadonlyArray<{ content: readonly unknown[] }> }> = [];
        await errorLines(async () => {
          let manager = await open();
          try {
            for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`filler ${i}: ${'x'.repeat(60)}`)]);
            compiled.push(await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }));
            for (let k = 0; k < 4; k++) await manager.tick();
            compiled.push(await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }));
            // And a tighter budget.
            compiled.push(await manager.compile({ maxTokens: 900, reserveForResponse: 50 }));
          } finally {
            manager.close();
          }
          manager = await open();
          try {
            compiled.push(await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }));
          } finally {
            manager.close();
          }
        });
        for (const result of compiled) assert.deepEqual(malformedIn(result.messages), []);
        assert.ok(JSON.stringify(compiled[0]!.messages).includes('"kept"'), 'what matches in the malformed messages reaches the compile');
        if (compresses) assert.ok(asked.some((request) => request.includes('"kept"')), 'compression read the malformed messages');
      });
    });
  }

  it('reads leave out or mend what doesn\'t match, at any depth, keep a string tool_result content, and the store keeps it as written', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      writeRaw(store, 'User', [
        t('a'), null, { type: 'text' }, [t('in an array')], { text: 'without a type' },
        { type: 'image' }, { type: 'audio', source: [] }, { type: 'generated_image', data: 'x' },
        // A reference whose only fault is its missing hash.
        { type: 'blob_ref', ref: { mediaType: 'image/png', originalType: 'image' } },
      ]);
      writeRaw(store, 'Claude', [
        { type: 'thinking', thinking: 7 }, { type: 'thinking', signature: 'sig' },
        toolUse('t0'), toolUse('t5', null), toolUse('t6', [1]), toolUse('t7', 'x'),
        ...['t1', 't2', 't3', 't4', 't8', 't9'].map((id) => toolUse(id, {})),
      ]);
      writeRaw(store, 'User', [
        toolResult('t0', [t('done')]),
        toolResult('t1', [t('x'), null, 3]),
        toolResult('t2', 'a string'),
        toolResult('t3', [t('outer'), toolResult('inner', [t('deep'), null, { type: 'text', text: null }])]),
        toolResult('t4', null),
        toolResult('t8', t('a lone block')),
        toolResult('t9', 42),
      ]);
      const expected = [
        [t('a')],
        [
          { type: 'thinking', signature: 'sig', thinking: '' },
          { ...toolUse('t0'), input: {} },
          { ...toolUse('t5', {}), unparseableInput: 'null' },
          { ...toolUse('t6', {}), unparseableInput: '[1]' },
          { ...toolUse('t7', {}), unparseableInput: '"x"' },
          ...['t1', 't2', 't3', 't4', 't8', 't9'].map((id) => toolUse(id, {})),
        ],
        [
          toolResult('t0', [t('done')]),
          toolResult('t1', [t('x')]),
          toolResult('t2', 'a string'),
          toolResult('t3', [t('outer'), toolResult('inner', [t('deep')])]),
          toolResult('t4', []),
          toolResult('t8', [t('a lone block')]),
          toolResult('t9', '42'),
        ],
      ];
      const lines = await errorLines(() => {
        const messages = new MessageStore(store);
        assert.deepEqual(messages.getAll().map((message) => message.content), expected);
        const viewed = messages.getWindow(0, 3, { resolveBlobs: false }).messages;
        assert.deepEqual(viewed.map((message) => message.content), expected, 'a read without blob resolution gives the same');
      });
      const stored = store.getStateJson('messages') as Array<{ content: unknown[] }>;
      assert.deepEqual(stored[0]!.content.slice(0, 6), [t('a'), null, { type: 'text' }, [t('in an array')], { text: 'without a type' }, { type: 'image' }], 'the store keeps it as written');
      assert.deepEqual(stored[1]!.content.slice(1, 4), [{ type: 'thinking', signature: 'sig' }, toolUse('t0'), toolUse('t5', null)]);
      assert.deepEqual((stored[2]!.content[1] as { content: unknown[] }).content, [t('x'), null, 3]);
      assert.equal((stored[2]!.content[4] as { content: unknown }).content, null);
      assert.equal((stored[2]!.content[6] as { content: unknown }).content, 42);
      assert.ok(lines.some((line) => line.includes('content[8].ref is an object without a string hash, not a blob reference')), lines.join('\n'));
    });
  });

  /** Media in MCP's form at the top and inside a tool_result, as a store can hold it, and the same messages as a read mends them. */
  const MCP_IMAGE = mcpMedia('image', PNG, 'image/png');
  function writeMcpMedia(store: JsStore): void {
    writeRaw(store, 'User', [t('look'), MCP_IMAGE]);
    writeRaw(store, 'Claude', [toolUse('s1', {})]);
    writeRaw(store, 'User', [toolResult('s1', [
      // MCP's annotations ride along: a mend changes only what doesn't match.
      t('shot'), MCP_IMAGE, { ...mcpMedia('audio', WAV, 'audio/wav'), annotations: { audience: ['user'] } },
      // Without its media type, or its data, there's no source to make, so a read leaves it out.
      { type: 'image', data: PNG }, { type: 'video', mimeType: 'video/mp4' },
    ])]);
  }
  const MCP_MENDED = [
    [t('look'), asSource('image', PNG, 'image/png')],
    [toolUse('s1', {})],
    [toolResult('s1', [
      t('shot'), asSource('image', PNG, 'image/png'), { ...asSource('audio', WAV, 'audio/wav'), annotations: { audience: ['user'] } },
    ])],
  ];

  it("a read mends media in MCP's form, at the top and inside a tool_result, and every strategy compiles it, compresses it and reopens", async () => {
    for (const [name, strategy] of Object.entries(STRATEGIES)) {
      await withStore(async (store) => {
        const asked: string[] = [];
        const membrane = {
          complete: async (request: unknown) => {
            asked.push(JSON.stringify(request));
            return { stopReason: 'end_turn', content: [t('Summary of the chunk')] };
          },
        };
        const open = async () => {
          const manager = await ContextManager.open({ store, strategy: strategy(), membrane: membrane as never });
          manager.setToolDefinitions([{ name: 'probe', description: 'A probe tool', inputSchema: { type: 'object', properties: {} } }]);
          return manager;
        };
        MessageStore.register(store);
        writeMcpMedia(store);
        const compiled: Array<{ messages: ReadonlyArray<{ content: readonly unknown[] }> }> = [];
        await errorLines(async () => {
          let manager = await open();
          try {
            assert.deepEqual(manager.getAllMessages().map((message) => message.content), MCP_MENDED, name);
            for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`filler ${i}: ${'x'.repeat(60)}`)]);
            compiled.push(await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }));
            for (let k = 0; k < 4; k++) await manager.tick();
            compiled.push(await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }));
          } finally {
            manager.close();
          }
          manager = await open();
          try {
            compiled.push(await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }));
          } finally {
            manager.close();
          }
        });
        for (const result of compiled) assert.deepEqual(malformedIn(result.messages), [], name);
        const blocks = compiled[0]!.messages.flatMap((message) => message.content) as Array<{ type: string; content?: unknown }>;
        const mendedResult = MCP_MENDED[2]![0] as { content: unknown };
        assert.deepEqual(blocks.find((block) => block.type === 'tool_result')?.content, mendedResult.content, `${name}: the compile carries the mended media`);
        if (name === 'autobiographical') assert.ok(asked.some((request) => request.includes(WAV)), 'compression read the mended media');
      });
    }
  });

  it("what a read mends a write takes, and a write refuses MCP's form itself, naming where it is", async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      writeMcpMedia(store);
      const lines = await errorLines(async () => {
        const manager = await ContextManager.open({ store });
        try {
          manager.addMessage('User', MCP_MENDED[0] as ContentBlock[]);
          manager.addMessage('User', MCP_MENDED[2] as ContentBlock[]);
          assert.deepEqual(manager.getAllMessages().slice(3).map((message) => message.content), [MCP_MENDED[0], MCP_MENDED[2]]);
          assert.throws(() => manager.addMessage('User', [toolResult('s2', [MCP_IMAGE]) as ContentBlock]), {
            message: 'Message refused: content[0].content[0].source is undefined, not an object.',
          });
        } finally {
          manager.close();
        }
      });
      assert.ok(lines.some((line) => line.includes('(content[1].source is undefined, not an object)')), lines.join('\n'));
      assert.ok(lines.some((line) => line.includes('content[0].content[1].source is undefined, not an object; content[0].content[2].source is undefined')), lines.join('\n'));
      const stored = store.getStateJson('messages') as Array<{ content: unknown[] }>;
      assert.deepEqual(stored[0]!.content, [t('look'), MCP_IMAGE], 'the store keeps it as written');
    });
  });

  it("a stored message whose content isn't an array reads as empty, with a line, and the store keeps it", async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      writeRaw(store, 'User', null as unknown as unknown[]);
      writeRaw(store, 'User', 'not blocks' as unknown as unknown[]);
      const lines = await errorLines(() => {
        assert.deepEqual(new MessageStore(store).getAll().map((message) => message.content), [[], []]);
      });
      assert.ok(lines.some((line) => line.includes('content is null, not an array of content blocks')), lines.join('\n'));
      assert.ok(lines.some((line) => line.includes('content is a string, not an array of content blocks')), lines.join('\n'));
      const kept = store.getStateJson('messages') as Array<{ content: unknown }>;
      assert.deepEqual(kept.map((m) => m.content), [null, 'not blocks']);
    });
  });

  it('a block that shares a raw replay form with one a read changes or leaves out gives the form up too', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      const sharedXml = '<function_results><result>x</result><result>y</result></function_results>';
      const ownXml = '<function_results><result>z</result></function_results>';
      const sharedItem = { type: 'function_call_output', id: 'fco_1', call_id: 't4', output: 'u v' };
      const ownItem = { type: 'function_call_output', id: 'fco_2', call_id: 't6', output: 'w' };
      const message = { type: 'message', id: 'msg_1', role: 'assistant', content: [] };
      writeRaw(store, 'Claude', ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => toolUse(id, {})));
      writeRaw(store, 'User', [
        { ...toolResult('t1', [t('x'), null]), rawXml: sharedXml },
        { ...toolResult('t2', [t('y')]), rawXml: sharedXml },
        { ...toolResult('t3', [t('z')]), rawXml: ownXml },
        { ...toolResult('t4', [t('u'), 7]), rawItem: sharedItem },
        { ...toolResult('t5', [t('v')]), rawItem: sharedItem },
        { ...toolResult('t6', [t('w')]), rawItem: ownItem },
      ]);
      // A message item whose parts are text blocks: one has no text, so it is left out.
      writeRaw(store, 'Claude', [{ type: 'text', rawItem: message }, { ...t('kept part'), rawItem: message }]);
      await errorLines(() => {
        const [, results, parts] = new MessageStore(store).getAll();
        assert.deepEqual(results!.content, [
          toolResult('t1', [t('x')]),
          toolResult('t2', [t('y')]),
          { ...toolResult('t3', [t('z')]), rawXml: ownXml },
          toolResult('t4', [t('u')]),
          toolResult('t5', [t('v')]),
          { ...toolResult('t6', [t('w')]), rawItem: ownItem },
        ]);
        assert.deepEqual(parts!.content, [t('kept part')], 'the part that stays gives up the item it shared with the one left out');
      });
    });
  });

  it("inside a tool_result's content, a block that shares a raw replay form with one a read mends or leaves out there gives the form up too", async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      // The shared rawXml still carries n1's call as written, which the {} a read gives n1 no longer matches.
      const sharedXml = '<function_calls><invoke name="probe"><parameter name="q">old</parameter></invoke><invoke name="probe"></invoke></function_calls>';
      const ownXml = '<function_calls><invoke name="probe"></invoke></function_calls>';
      const item = { type: 'message', id: 'msg_2', role: 'assistant', content: [] };
      writeRaw(store, 'Claude', [toolUse('t1', {})]);
      writeRaw(store, 'User', [
        toolResult('t1', [
          { ...toolUse('n1', 'old'), rawXml: sharedXml },
          { ...toolUse('n2', {}), rawXml: sharedXml },
          { ...toolUse('n3', {}), rawXml: ownXml },
          { type: 'text', rawItem: item },
          { ...t('kept part'), rawItem: item },
        ]),
      ]);
      await errorLines(() => {
        const [, results] = new MessageStore(store).getAll();
        assert.deepEqual(results!.content, [
          toolResult('t1', [
            { ...toolUse('n1', {}), unparseableInput: '"old"' },
            toolUse('n2', {}),
            { ...toolUse('n3', {}), rawXml: ownXml },
            t('kept part'),
          ]),
        ]);
      });
    });
  });

  it('one line per message names what reads leave out or mend', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      writeRaw(store, 'User', [t('a'), null]);
      writeRaw(store, 'User', [t('fine')]);
      writeRaw(store, 'User', [toolResult('t1', ['s', toolResult('t2', [false, { type: 'text' }])])]);
      const messages = new MessageStore(store);
      let ids: string[] = [];
      const lines = (await errorLines(() => {
        ids = messages.getAll().map((message) => String(message.id));
        messages.getAll();
        messages.getWindow(0, 3);
      })).filter((line) => line.startsWith('[context-manager]'));
      assert.deepEqual(lines, [
        `[context-manager] message ${ids[0]}: reads leave out or mend what doesn't match ContentBlock (content[1] is null, not a content block); the store keeps it as written`,
        `[context-manager] message ${ids[2]}: reads leave out or mend what doesn't match ContentBlock (content[0].content[0] is a string, not a content block; content[0].content[1].content[0] is a boolean, not a content block; content[0].content[1].content[1].text is undefined, not a string); the store keeps it as written`,
      ]);
    });
  });

  it('an edit replaces a message that holds it, through ContextManager.editMessage', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      writeRaw(store, 'User', [t('a'), null]);
      const manager = await ContextManager.open({ store });
      try {
        await errorLines(() => {
          const [held] = manager.getAllMessages();
          manager.editMessage(held!.id, [t('fixed')]);
          assert.deepEqual(manager.getAllMessages()[0]!.content, [t('fixed')]);
        });
      } finally {
        manager.close();
      }
      assert.deepEqual((store.getStateJson('messages') as Array<{ content: unknown[] }>)[0]!.content, [t('fixed')]);
    });
  });

  // #239: a read's line names the namespace whose state it read. An isolated message slot is its
  // manager's; the shared message slot is no one namespace's.
  it('a read\'s line names the namespace of an isolated message slot, and none for the shared slot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-malformed-ns-'));
    const path = join(dir, 'store');
    try {
      const raw = JsStore.create({ path });
      MessageStore.register(raw, 'agents/tern');
      MessageStore.register(raw);
      raw.appendToStateJsonWithIdentity('agents/tern/messages', { participant: 'User', content: [t('own'), null], timestamp: Date.now() }, 'id', 'sequence');
      raw.appendToStateJsonWithIdentity('messages', { participant: 'User', content: [t('shared'), null], timestamp: Date.now() }, 'id', 'sequence');
      raw.close();
      const lines = (await errorLines(async () => {
        const own = await ContextManager.open({ path, namespace: 'agents/tern', isolate: true });
        own.getAllMessages();
        own.close();
        const shared = await ContextManager.open({ path, namespace: 'agents/wren' });
        shared.getAllMessages();
        shared.close();
      })).filter((line) => line.startsWith('[context-manager]'));
      assert.equal(lines.length, 2, lines.join('\n'));
      assert.match(lines[0]!, /^\[context-manager\] message .*the store keeps it as written ns=agents\/tern$/);
      assert.match(lines[1]!, /^\[context-manager\] message .*the store keeps it as written$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #239: a context log of one namespace names it on its lines; the log with no namespace names
  // none, as the next test's line shows.
  it('a context log\'s line names its namespace', async () => {
    await withStore(async (store) => {
      ContextLog.register(store, 'agents/tern');
      store.appendToStateJson('agents/tern/context', { index: 0, participant: 'User', content: [t('x'), null] });
      const log = new ContextLog(store, { namespace: 'agents/tern' });
      const lines = (await errorLines(() => {
        log.getAll();
      })).filter((line) => line.startsWith('[context-manager]'));
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.match(lines[0]!, /^\[context-manager\] context entry 0: .* ns=agents\/tern$/);
    });
  });

  it('a context entry holding it is read without it, with one line', async () => {
    await withStore(async (store) => {
      ContextLog.register(store);
      store.appendToStateJson('context', {
        index: 0,
        participant: 'User',
        content: [t('x'), null, toolResult('t1', [7, t('y')])],
      });
      const log = new ContextLog(store);
      const lines = (await errorLines(() => {
        assert.deepEqual(log.getAll()[0]!.content, [t('x'), toolResult('t1', [t('y')])]);
        log.getAll();
      })).filter((line) => line.startsWith('[context-manager]'));
      assert.deepEqual(lines, [
        "[context-manager] context entry 0: reads leave out or mend what doesn't match ContentBlock (content[1] is null, not a content block; content[2].content[0] is a number, not a content block); the store keeps it as written",
      ]);
    });
  });

  it('an entry that comes to have another\'s index logs its own line', async () => {
    await withStore(async (store) => {
      ContextLog.register(store);
      store.appendToStateJson('context', { index: 0, participant: 'User', content: [t('x'), null] });
      const log = new ContextLog(store);
      const read = async () => (await errorLines(() => { log.getAll(); })).filter((line) => line.startsWith('[context-manager]'));
      assert.equal((await read()).length, 1);
      assert.equal((await read()).length, 0, 'the same entry is logged once');
      // Another entry at index 0, as a replacement written before writes refused it leaves one.
      store.redactStateItems('context', 0, 1);
      store.appendToStateJson('context', { index: 0, participant: 'User', content: [t('y'), 7] });
      assert.deepEqual(await read(), [
        "[context-manager] context entry 0: reads leave out or mend what doesn't match ContentBlock (content[1] is a number, not a content block); the store keeps it as written",
      ]);
    });
  });

  it('addMessage refuses it, naming where it is, before anything changes', async () => {
    await withStore(async (store) => {
      const manager = await ContextManager.open({ store });
      try {
        const events: unknown[] = [];
        manager.onMessage((event) => { events.push(event); });
        const sequence = store.currentSequence();
        const refusals: Array<[unknown[], string]> = [
          [[t('kept'), 'a bare string'], 'content\\[1\\] is a string, not a content block'],
          [['only a string'], 'content\\[0\\] is a string, not a content block'],
          [[t('kept'), 42], 'content\\[1\\] is a number, not a content block'],
          [[t('kept'), true], 'content\\[1\\] is a boolean, not a content block'],
          [[t('kept'), [t('in an array')]], 'content\\[1\\] is an array, not a content block'],
          [[{ text: 'without a type' }], 'content\\[0\\]\\.type is undefined, not a string'],
          [[{ type: 7, text: 'a number for a type' }], 'content\\[0\\]\\.type is a number, not a string'],
          [[t('kept'), null], 'content\\[1\\] is null, not a content block'],
          [[t('kept'), undefined], 'content\\[1\\] is undefined, not a content block'],
          [[, t('kept')], 'content\\[0\\] is undefined, not a content block'],
          [[{ type: 'text' }], 'content\\[0\\]\\.text is undefined, not a string'],
          [[{ type: 'text', text: 42 }], 'content\\[0\\]\\.text is a number, not a string'],
          [[{ type: 'thinking', thinking: null }], 'content\\[0\\]\\.thinking is null, not a string'],
          [[{ type: 'thinking', signature: 'sig' }], 'content\\[0\\]\\.thinking is undefined, not a string'],
          [[toolUse('u1', 10n)], 'content\\[0\\]\\.input is a bigint, not an object'],
          [[{ type: 'image' }], 'content\\[0\\]\\.source is undefined, not an object'],
          [[mcpMedia('image', PNG, 'image/png')], 'content\\[0\\]\\.source is undefined, not an object'],
          [[toolResult('t1', [mcpMedia('audio', WAV, 'audio/wav')])], 'content\\[0\\]\\.content\\[0\\]\\.source is undefined, not an object'],
          [[{ type: 'video' }], 'content\\[0\\]\\.source is undefined, not an object'],
          [[toolUse('u1', () => 1)], 'content\\[0\\]\\.input is a function, not an object'],
          [[toolUse('u1', cyclic())], 'content\\[0\\]\\.input is an array, not an object'],
          [[{ type: 'document', source: 'x' }], 'content\\[0\\]\\.source is a string, not an object'],
          // Inline media the store can't keep as a blob.
          [[t('kept'), { type: 'document', source: { type: 'base64', data: 'JVBERi0=' } }], 'content\\[1\\]\\.source\\.mediaType is undefined, not a string'],
          [[{ type: 'audio', source: { type: 'base64', mediaType: 'audio/wav', data: 7 } }], 'content\\[0\\]\\.source\\.data is a number, not base64 data'],
          [[{ type: 'image', source: { type: 'base64', data: 'AAAA' } }],
            "content\\[0\\]\\.source\\.mediaType is undefined, not a string, and the image's data has no png, jpeg, gif or webp signature"],
          [[{ type: 'generated_image', data: 1 }],
            'content\\[0\\]\\.data is a number, not a string; content\\[0\\]\\.mimeType is undefined, not a string'],
          [[{ type: 'blob_ref', ref: { hash: 'h', mediaType: 'image/png', originalType: 'image' } }],
            'content\\[0\\] is a blob_ref, which only the store writes \\(a read with blobs resolved, the default, gives the block to write\\)'],
          [[toolResult('t1', [t('ok'), null, 'x'])],
            'content\\[0\\]\\.content\\[1\\] is null, not a content block; content\\[0\\]\\.content\\[2\\] is a string, not a content block'],
          [[toolResult('t1', [toolResult('t2', [null])])], 'content\\[0\\]\\.content\\[0\\]\\.content\\[0\\] is null, not a content block'],
          [[toolResult('t1', [{ type: 'text' }])], 'content\\[0\\]\\.content\\[0\\]\\.text is undefined, not a string'],
          [[toolResult('t1', 42)], 'content\\[0\\]\\.content is a number, not a string or an array of content blocks'],
          [[toolResult('t1', {})], 'content\\[0\\]\\.content is an object, not a string or an array of content blocks'],
          [[{ type: 'tool_result', toolUseId: 't1' }], 'content\\[0\\]\\.content is undefined, not a string or an array of content blocks'],
        ];
        for (const [content, places] of refusals) {
          const message = new RegExp(`^Message refused: ${places}\\.$`);
          assert.throws(() => manager.addMessage('User', content as ContentBlock[]), { message });
          assert.throws(() => manager.addMessage('User', content as ContentBlock[], undefined, undefined, { holdCompression: true }), { message });
        }
        assert.equal(store.currentSequence(), sequence, 'nothing was stored');
        assert.deepEqual(events, [], 'no event was emitted');
        assert.equal(manager.getCompressionHolds().size, 0, 'no hold was placed');
        assert.equal((manager as unknown as { holdingAdds: unknown }).holdingAdds, null);
        manager.addMessage('User', [toolResult('t1', 'a string') as ContentBlock]);
        manager.addMessage('Claude', [toolUse('u1', {}) as ContentBlock, { type: 'thinking', thinking: '' } as ContentBlock]);
        manager.addMessage('User', [{ type: 'a_later_block', data: 1 } as unknown as ContentBlock]);
        // The store keeps media inside a tool_result as given, so a write doesn't read its source.
        const nested = toolResult('t2', [{ type: 'audio', source: { type: 'base64', mediaType: 'audio/wav' } }]);
        manager.addMessage('User', [nested as ContentBlock]);
        assert.equal(manager.getAllMessages().length, 4, 'a string tool_result content, an object input, an empty thinking, a block of a type the check names nowhere and media inside a tool_result are stored');
        assert.deepEqual(manager.getAllMessages()[2]!.content, [{ type: 'a_later_block', data: 1 }], 'and a read gives that block as it is');
        assert.deepEqual(manager.getAllMessages()[3]!.content, [nested]);
      } finally {
        manager.close();
      }
    });
  });

  it('a refused add expires no compression hold that is due, and the next add does', async () => {
    class CountsReleases extends PassthroughStrategy {
      releases = 0;
      onCompressionHoldsReleased() {
        this.releases++;
      }
    }
    await withStore(async (store) => {
      const clock = { t: 0 };
      const strategy = new CountsReleases();
      const manager = await ContextManager.open({ store, strategy, now: () => clock.t });
      try {
        manager.addMessage('User', [t('held')], undefined, undefined, { holdCompression: { timeoutMs: 100 } });
        clock.t = 200;
        assert.throws(() => manager.addMessage('User', [null] as unknown as ContentBlock[]), { message: /^Message refused: / });
        assert.equal(strategy.releases, 0, 'the refused add released no hold');
        manager.addMessage('User', [t('next')]);
        assert.equal(strategy.releases, 1, 'the hold was due, and the next add released it');
      } finally {
        manager.close();
      }
    });
  });

  it("a message a strategy would shard is refused before the strategy reads it, and a strategy's malformed shard before any shard is stored", async () => {
    class ShardEachBlock extends PassthroughStrategy {
      ingress = 0;
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        this.ingress++;
        // A shard of each block, and one more the chunker makes up that doesn't match.
        const shards = content.map((block, shardIndex) => ({ content: [block], shardIndex }));
        if (content.some((block) => (block as { text?: string }).text === 'bad shard')) {
          shards.push({ content: [null as unknown as ContentBlock], shardIndex: shards.length });
        }
        if (content.some((block) => (block as { text?: string }).text === 'media shard')) {
          // Inline media the store can't keep: a document with no media type.
          shards.push({ content: [{ type: 'document', source: { type: 'base64', data: 'JVBERi0=' } } as unknown as ContentBlock], shardIndex: shards.length });
        }
        return { bodyGroupId: 'each-block', shards };
      }
    }
    await withStore(async (store) => {
      const strategy = new ShardEachBlock();
      const manager = await ContextManager.open({ store, strategy });
      try {
        assert.throws(() => manager.addMessage('User', [t('a'), 'b'] as ContentBlock[]), { message: /^Message refused: content\[1\] is a string, not a content block\.$/ });
        assert.equal(strategy.ingress, 0, 'the strategy never read it');
        assert.throws(
          () => manager.addMessage('User', [t('a'), t('bad shard')], undefined, undefined, { holdCompression: true }),
          { message: /^Shard 2 of the message, as the strategy chunked it, refused: content\[0\] is null, not a content block\.$/ },
        );
        assert.equal(strategy.ingress, 1);
        assert.throws(
          () => manager.addMessage('User', [t('a'), t('media shard')]),
          { message: /^Shard 2 of the message, as the strategy chunked it, refused: content\[0\]\.source\.mediaType is undefined, not a string\.$/ },
        );
        assert.equal(strategy.ingress, 2);
        assert.equal(manager.getAllMessages().length, 0, 'no shard of any of them was stored');
        assert.equal(manager.getCompressionHolds().size, 0, 'and no hold was placed');
      } finally {
        manager.close();
      }
    });
  });

  it('the stores refuse it at append and at edit, ContextLog.replaceAll before it clears, and blockAsStored as the store does', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      ContextLog.register(store);
      assert.throws(() => new MessageStore(store).append('User', [t('a'), null] as ContentBlock[]), { message: /^Message refused: content\[1\] is null, not a content block\.$/ });
      writeRaw(store, 'User', [t('a'), null]);
      const messages = new MessageStore(store);
      await errorLines(() => {
        const [held] = messages.getAll();
        assert.throws(
          () => messages.edit(held!.id, [t('b'), 'x'] as ContentBlock[]),
          { message: new RegExp(`^Edit of ${held!.id} refused: content\\[1\\] is a string, not a content block\\.$`) },
        );
        messages.edit(held!.id, [t('fixed')]);
        assert.deepEqual(messages.get(held!.id)!.content, [t('fixed')]);
      });
      const log = new ContextLog(store);
      assert.throws(() => log.append('User', [toolResult('t1', [null])] as ContentBlock[]), { message: /^Context entry refused: content\[0\]\.content\[0\] is null, not a content block\.$/ });
      log.append('User', [t('entry')]);
      assert.throws(() => log.edit(0, [{ type: 'text' }] as ContentBlock[]), { message: /^Edit of context entry 0 refused: content\[0\]\.text is undefined, not a string\.$/ });
      assert.throws(
        () => log.append('User', [{ type: 'video', source: { type: 'base64', data: 'AAAA' } }] as ContentBlock[]),
        { message: /^Context entry refused: content\[0\]\.source\.mediaType is undefined, not a string\.$/ },
      );
      assert.throws(
        () => messages.append('User', [{ type: 'audio', source: { type: 'base64', mediaType: 'audio/wav' } }] as ContentBlock[]),
        { message: /^Message refused: content\[0\]\.source\.data is undefined, not base64 data\.$/ },
      );
      assert.deepEqual(log.getAll().map((entry) => entry.content), [[t('entry')]], 'the context log stored nothing refused');
      assert.throws(
        () => log.replaceAll([
          { participant: 'User', content: [t('new 1')] },
          { participant: 'User', content: [null] as unknown as ContentBlock[] },
        ]),
        { message: /^Context entry 1 of the replacement refused: content\[0\] is null, not a content block\.$/ },
      );
      assert.deepEqual(log.getAll().map((entry) => entry.content), [[t('entry')]], 'a refused replacement leaves the log as it was');
      assert.throws(
        () => log.replaceAll([
          { participant: 'User', content: [t('new 1')] },
          { participant: 'User', content: [{ type: 'video', source: { type: 'base64', data: 'AAAA' } }] as ContentBlock[] },
        ]),
        { message: /^Context entry 1 of the replacement refused: content\[0\]\.source\.mediaType is undefined, not a string\.$/ },
      );
      // A hole among the entries is an entry with no content.
      const holed = [{ participant: 'User', content: [t('new 1')] }, , { participant: 'User', content: [t('new 3')] }] as Array<{ participant: string; content: ContentBlock[] }>;
      assert.throws(
        () => log.replaceAll(holed),
        { message: /^Context entry 1 of the replacement refused: content is undefined, not an array of content blocks\.$/ },
      );
      assert.deepEqual(log.getAll().map((entry) => entry.content), [[t('entry')]], 'media it can\'t keep, or a hole, leaves the log as it was');
      assert.throws(() => blockAsStored(null as unknown as ContentBlock), { message: /^blockAsStored: block is null, not a content block\.$/ });
      assert.throws(() => blockAsStored(toolResult('t1', [t('ok'), 'x']) as ContentBlock), { message: /^blockAsStored: block\.content\[1\] is a string, not a content block\.$/ });
      assert.throws(() => blockAsStored(toolUse('u1', 10n) as ContentBlock), { message: /^blockAsStored: block\.input is a bigint, not an object\.$/ });
      assert.deepEqual(blockAsStored(toolUse('u1') as ContentBlock), toolUse('u1', {}), 'a call with no input is stored with {}, unmarked');
      assert.deepEqual(
        blockAsStored({ ...toolUse('u1', null), rawXml: '<function_calls>null</function_calls>' } as ContentBlock),
        { ...toolUse('u1', {}), unparseableInput: 'null' },
        'a mended call keeps its input in unparseableInput, and gives up its raw replay form',
      );
      assert.deepEqual(blockAsStored(toolResult('t1', 'fine') as ContentBlock), toolResult('t1', 'fine'));
    });
  });

  it('a write mends a tool_use whose input isn\'t an object, and stores what a read of it gives', async () => {
    await withStore(async (store) => {
      const sharedXml = '<function_calls><invoke name="probe">null</invoke><invoke name="probe"></invoke></function_calls>';
      const ownXml = '<function_calls><invoke name="probe"></invoke></function_calls>';
      const content = [
        { ...toolUse('m1', null), rawXml: sharedXml },
        { ...toolUse('m2', {}), rawXml: sharedXml },
        { ...toolUse('m3', {}), rawXml: ownXml },
        toolUse('m4'),
        toolUse('m5', [1]),
        toolUse('m6', 'x'),
        // A marker the block already carries is kept.
        { ...toolUse('m7', 7), unparseableInput: '{"q": ' },
      ];
      const mended = [
        { ...toolUse('m1', {}), unparseableInput: 'null' },
        toolUse('m2', {}),
        { ...toolUse('m3', {}), rawXml: ownXml },
        toolUse('m4', {}),
        { ...toolUse('m5', {}), unparseableInput: '[1]' },
        { ...toolUse('m6', {}), unparseableInput: '"x"' },
        { ...toolUse('m7', {}), unparseableInput: '{"q": ' },
      ];
      const manager = await ContextManager.open({ store });
      try {
        const events: Array<{ type: string; message?: { content: unknown } }> = [];
        manager.onMessage((event) => { events.push(event as never); });
        manager.addMessage('Claude', content as ContentBlock[]);
        assert.deepEqual(manager.getAllMessages()[0]!.content, mended, 'stored mended, and the shared raw form given up');
        assert.deepEqual(events[0]!.message!.content, mended, 'and the add event carries what was stored');
        assert.deepEqual((store.getStateJson('messages') as Array<{ content: unknown[] }>)[0]!.content, mended);
        // A tool_use inside a tool_result's content is mended too.
        manager.addMessage('User', [toolResult('m1', [toolUse('n1', null)]) as ContentBlock]);
        assert.deepEqual(manager.getAllMessages()[1]!.content, [toolResult('m1', [{ ...toolUse('n1', {}), unparseableInput: 'null' }])]);
      } finally {
        manager.close();
      }
      // The same content written past the write, as an older store holds it, reads as the write stored it.
      writeRaw(store, 'Claude', content);
      await errorLines(() => {
        assert.deepEqual(new MessageStore(store).getAll()[2]!.content, mended, 'a read gives what a write stores');
      });
    });
  });

  it('every write path stores what a write mends, append returns it, and a marker a block carries is kept', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      ContextLog.register(store);
      const messages = new MessageStore(store);
      const appended = messages.append('Claude', [toolUse('m1', null)] as ContentBlock[]);
      const mended = { ...toolUse('m1', {}), unparseableInput: 'null' };
      assert.deepEqual(appended.content, [mended], 'MessageStore.append returns what it stored');
      assert.deepEqual(messages.get(appended.id)!.content, [mended]);
      messages.edit(appended.id, [toolUse('m1', 'x')] as ContentBlock[]);
      assert.deepEqual(messages.get(appended.id)!.content, [{ ...toolUse('m1', {}), unparseableInput: '"x"' }], 'MessageStore.edit');
      // A block that already carries a marker keeps it, whatever its input.
      const marked = messages.append('Claude', [{ ...toolUse('m2', 10n), unparseableInput: '{"q": ' }] as ContentBlock[]);
      assert.deepEqual(messages.get(marked.id)!.content, [{ ...toolUse('m2', {}), unparseableInput: '{"q": ' }]);
      const log = new ContextLog(store);
      log.append('Claude', [toolUse('c1', null)] as ContentBlock[]);
      assert.deepEqual(log.getAll()[0]!.content, [{ ...toolUse('c1', {}), unparseableInput: 'null' }], 'ContextLog.append');
      log.edit(0, [toolUse('c1', [1])] as ContentBlock[]);
      assert.deepEqual(log.getAll()[0]!.content, [{ ...toolUse('c1', {}), unparseableInput: '[1]' }], 'ContextLog.edit');
      log.replaceAll([{ participant: 'Claude', content: [toolUse('c2', 'y')] as ContentBlock[] }]);
      assert.deepEqual(log.getAll()[0]!.content, [{ ...toolUse('c2', {}), unparseableInput: '"y"' }], 'ContextLog.replaceAll');
    });
  });

  it('malformedContentPlaces names what a write refuses, without throwing, and the refusal carries its answer', async () => {
    assert.deepEqual(malformedContentPlaces([t('fine'), toolUse('u1', {})]), []);
    assert.deepEqual(malformedContentPlaces([toolUse('u1', null), toolUse('u2')]), [], 'a write mends these, so it refuses nothing');
    for (const [content, kind] of [[null, 'null'], [undefined, 'undefined'], ['a string', 'a string'], [{}, 'an object']] as const) {
      assert.deepEqual(malformedContentPlaces(content), [`content is ${kind}, not an array of content blocks`], `content that is ${kind}`);
    }
    const content = [t('ok'), null, toolResult('t1', [{ type: 'text' }]), { type: 'blob_ref', ref: { hash: 'h' } }];
    const places = [
      'content[1] is null, not a content block',
      'content[2].content[0].text is undefined, not a string',
      'content[3] is a blob_ref, which only the store writes (a read with blobs resolved, the default, gives the block to write)',
    ];
    assert.deepEqual(malformedContentPlaces(content), places);
    await withStore(async (store) => {
      const manager = await ContextManager.open({ store });
      try {
        assert.throws(() => manager.addMessage('User', content as ContentBlock[]), (error: unknown) => {
          assert.ok(error instanceof MalformedContentError);
          assert.deepEqual(error.places, malformedContentPlaces(content));
          assert.equal(error.message, `Message refused: ${places.join('; ')}.`);
          return true;
        });
        assert.throws(() => manager.addMessage('User', null as unknown as ContentBlock[]), {
          name: 'MalformedContentError',
          message: 'Message refused: content is null, not an array of content blocks.',
        });
        assert.equal(manager.getAllMessages().length, 0, 'nothing stored');
      } finally {
        manager.close();
      }
    });
  });
});
