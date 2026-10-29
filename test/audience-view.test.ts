import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import type { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextLog, ContextManager, MalformedContentError, MessageStore, PassthroughStrategy, contentForReader } from '../src/index.js';
import { audienceMessageStoreView } from '../src/message-view.js';
import type { MessageStoreView, StoredMessage } from '../src/index.js';

const BUDGET = { maxTokens: 1_000_000, reserveForResponse: 0 };
const t = (text: string): ContentBlock => ({ type: 'text', text });
const forReaders = (text: string, ...audience: string[]): ContentBlock => ({ type: 'text', text, audience } as ContentBlock);

interface ApiMessage { participant: string; content: ContentBlock[] }

function summarizer() {
  const payloads: string[] = [];
  const requests: string[] = [];
  return {
    payloads,
    requests,
    membrane: {
      complete: async (request: { messages: ApiMessage[] }) => {
        const input = request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
        payloads.push(input);
        requests.push(JSON.stringify(request.messages));
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: `[memory of ${input.length} chars] ${'x '.repeat(40)}` }],
          usage: { input_tokens: Math.ceil(input.length / 4), output_tokens: 25 },
        };
      },
    } as never,
  };
}

const memory = () => new AutobiographicalStrategy({
  compressionModel: 'test-compression-model',
  targetChunkTokens: 300,
  headWindowTokens: 0,
  recentWindowTokens: 0,
  hierarchical: true,
});

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('strategy never became ready');
}

async function withReaders(
  run: (m: { ann: ContextManager; bob: ContextManager; nobody: ContextManager; annSummaries: string[]; bobSummaries: string[]; nobodySummaries: string[]; requests: () => string[] }) => Promise<void>,
  strategy: () => AutobiographicalStrategy | PassthroughStrategy = memory,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-audience-'));
  const a = summarizer();
  const b = summarizer();
  const c = summarizer();
  const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: strategy(), membrane: a.membrane, viewReader: 'ann' });
  const bob = await ContextManager.open({ store: ann.getStore(), namespace: 'agents/bob', strategy: strategy(), membrane: b.membrane, viewReader: 'bob' });
  const nobody = await ContextManager.open({ store: ann.getStore(), namespace: 'agents/nobody', strategy: strategy(), membrane: c.membrane });
  try {
    await run({ ann, bob, nobody, annSummaries: a.payloads, bobSummaries: b.payloads, nobodySummaries: c.payloads, requests: () => [...a.requests, ...b.requests, ...c.requests] });
  } finally {
    await nobody.close();
    await bob.close();
    await ann.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const texts = (messages: readonly { content: readonly ContentBlock[] }[]): string =>
  messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
const anyAudience = (messages: readonly { content: readonly ContentBlock[] }[]): boolean =>
  JSON.stringify(messages).includes('"audience"');

describe('a block with an audience', () => {
  it('reaches only its readers\' compiles, without its audience, and a manager with no reader sees none', async () => {
    await withReaders(async ({ ann, bob, nobody }) => {
      ann.addMessage('user', [forReaders('[for ann]', 'ann'), forReaders('[for bob]', 'bob'), t('Hello, both.')]);
      ann.addMessage('user', [forReaders('[for both]', 'ann', 'bob'), t('Second.')]);
      const annSees = (await ann.compile(BUDGET)).messages;
      const bobSees = (await bob.compile(BUDGET)).messages;
      const nobodySees = (await nobody.compile(BUDGET)).messages;
      assert.equal(texts(annSees), '[for ann]\nHello, both.\n[for both]\nSecond.');
      assert.equal(texts(bobSees), '[for bob]\nHello, both.\n[for both]\nSecond.');
      assert.equal(texts(nobodySees), 'Hello, both.\nSecond.');
      assert.ok(![annSees, bobSees, nobodySees].some(anyAudience), 'no compiled block carries its audience');
      assert.equal(ann.getAllMessages()[0]!.content.length, 3, 'the store keeps every block');
    }, () => new PassthroughStrategy());
  });

  it('leaves a message whose every block is someone else\'s out of the view, sending no empty message', async () => {
    await withReaders(async ({ ann, bob }) => {
      ann.addMessage('user', [t('Before.')]);
      ann.addMessage('user', [forReaders('[only bob]', 'bob')]);
      ann.addMessage('user', [t('After.')]);
      const annSees = (await ann.compile(BUDGET)).messages;
      assert.equal(annSees.length, 2);
      assert.equal(texts(annSees), 'Before.\nAfter.');
      assert.equal(texts((await bob.compile(BUDGET)).messages), 'Before.\n[only bob]\nAfter.');
    }, () => new PassthroughStrategy());
  });

  it('reaches only its reader\'s summaries, pinned ranges and renderAsNewest', async () => {
    await withReaders(async ({ ann, bob, nobody, annSummaries, bobSummaries, nobodySummaries, requests }) => {
      const filler = (i: number) => `message ${i} ${'word '.repeat(8)}`;
      const ids: string[] = [];
      for (let i = 0; i < 90; i++) {
        ids.push(ann.addMessage(i % 2 ? 'agent' : 'user', i % 3 === 0
          ? [forReaders(`ANN-ONLY-${i}`, 'ann'), forReaders(`BOB-ONLY-${i}`, 'bob'), t(filler(i))]
          : [t(filler(i))]));
      }
      for (const [manager, payloads] of [[ann, annSummaries], [bob, bobSummaries], [nobody, nobodySummaries]] as const) {
        await manager.compile(BUDGET);
        for (let i = 0; i < 300 && payloads.length === 0; i++) await manager.tick();
        await drain(manager);
      }
      assert.ok(annSummaries.length > 0, 'ann summarized');
      assert.ok(bobSummaries.length > 0, 'bob summarized');
      assert.ok(annSummaries.join('\n').includes('ANN-ONLY-'), 'ann\'s summaries hold her blocks');
      assert.ok(!annSummaries.join('\n').includes('BOB-ONLY-'), 'and never bob\'s');
      assert.ok(bobSummaries.join('\n').includes('BOB-ONLY-'));
      assert.ok(!bobSummaries.join('\n').includes('ANN-ONLY-'));
      assert.ok(nobodySummaries.length > 0, 'a manager with no reader summarized');
      assert.ok(!/ANN-ONLY-|BOB-ONLY-/.test(nobodySummaries.join('\n')), 'and its summaries hold no block that has an audience');
      assert.ok(requests().length > 0, 'the premise: summariser requests were made');
      assert.ok(!requests().some((r) => r.includes('"audience"')), 'no summariser request carries an audience field');

      const early = texts((await ann.compile(BUDGET)).messages);
      assert.ok(!early.includes('ANN-ONLY-3'), 'the premise: message 3 is summarized, not sent raw');
      ann.pinRange(ids[3]! as never, ids[3]! as never);
      const pinnedCompile = (await ann.compile(BUDGET)).messages;
      const pinned = texts(pinnedCompile);
      assert.ok(pinned.includes('ANN-ONLY-3') && !pinned.includes('BOB-ONLY-3'), 'a pinned range holds only the reader\'s blocks');
      assert.ok(!anyAudience(pinnedCompile));

      const rendered = ann.renderAsNewest([ids[87]!])!;
      assert.ok(rendered[0], 'rendered');
      assert.ok(texts([{ content: rendered[0]! }]).includes('ANN-ONLY-87'), 'renderAsNewest holds the reader\'s own block');
      assert.equal(texts([{ content: rendered[0]! }]).includes('BOB-ONLY-87'), false, 'and only the reader\'s');
      assert.ok(!anyAudience([{ content: rendered[0]! }]));
    });
  });

  it('renders a preview of the reader\'s view', async () => {
    const adaptive = () => new AutobiographicalStrategy({ compressionModel: 'test-compression-model', targetChunkTokens: 5_000, recentWindowTokens: 50_000, adaptiveResolution: true });
    await withReaders(async ({ ann }) => {
      for (let i = 0; i < 6; i++) ann.addMessage(i % 2 ? 'agent' : 'user', [forReaders(`ANN-ONLY-${i}`, 'ann'), forReaders(`BOB-ONLY-${i}`, 'bob'), t(`shared ${i}`)]);
      const preview = ann.previewContext(BUDGET, undefined, { render: true });
      assert.ok(preview?.entries, 'the premise: a rendered preview');
      const previewed = texts(preview.entries);
      assert.ok(previewed.includes('ANN-ONLY-5') && !previewed.includes('BOB-ONLY-'), 'a preview holds only the reader\'s blocks');
      assert.ok(!anyAudience(preview.entries));
    }, adaptive);
  });

  it('writes an edit\'s copies in the context log as the reader sees them, and drops them where it sees nothing', async () => {
    await withReaders(async ({ ann }) => {
      const id = ann.addMessage('user', [t('Original.')]);
      const other = ann.addMessage('user', [t('Other.')]);
      const log = (ann as unknown as { contextLog: { replaceAll(entries: unknown[]): void; getAll(): Array<{ sourceMessageId?: string; content: ContentBlock[] }> } }).contextLog;
      log.replaceAll([
        { participant: 'user', content: [t('Original.')], sourceMessageId: id, sourceRelation: 'copy' },
        { participant: 'user', content: [t('Other.')], sourceMessageId: other, sourceRelation: 'copy' },
      ]);
      assert.equal(log.getAll().filter((e) => e.sourceMessageId === other).length, 1, 'the premise: the other message has its copy');
      ann.editMessage(id, [forReaders('[for ann]', 'ann'), forReaders('[for bob]', 'bob'), t('Edited.')]);
      assert.deepEqual(log.getAll().find((e) => e.sourceMessageId === id)!.content, [t('[for ann]'), t('Edited.')]);
      ann.editMessage(other, [forReaders('[for bob]', 'bob')]);
      assert.equal(log.getAll().some((e) => e.sourceMessageId === other), false, 'an edit that leaves ann nothing removes her copy');
    }, () => new PassthroughStrategy());
  });

  it('keeps the reader\'s view after one block for another reader is edited away while another remains', async () => {
    await withReaders(async ({ ann }) => {
      ann.addMessage('user', [t('Before.')]);
      assert.ok(texts((await ann.compile(BUDGET)).messages).includes('Before.'), 'the premise: a compile reads the slot while it holds no audience block');
      const first = ann.addMessage('user', [forReaders('[first, for bob]', 'bob'), t('One.')]);
      ann.addMessage('user', [forReaders('[second, for bob]', 'bob'), t('Two.')]);
      ann.editMessage(first, [t('One, edited.')]);
      const compiled = texts((await ann.compile(BUDGET)).messages);
      assert.ok(compiled.includes('One, edited.') && compiled.includes('Two.'), 'the premise: both messages compile');
      assert.ok(!compiled.includes('for bob'), 'the other message\'s block for bob stays out of ann\'s compile');
    }, () => new PassthroughStrategy());
  });

  it('keeps a message that holds an audience block whole, never sharded at ingress', async () => {
    const sharding = () => new AutobiographicalStrategy({ compressionModel: 'test-compression-model', adaptiveResolution: true, targetChunkTokens: 100, headWindowTokens: 0, recentWindowTokens: 1_000_000 });
    await withReaders(async ({ ann, bob }) => {
      const long = 'plain words '.repeat(400);
      ann.addMessage('user', [t(long)]);
      const sharded = ann.getAllMessages().length;
      assert.ok(sharded > 1, 'the premise: a long message with no audience block is sharded');
      ann.addMessage('user', [forReaders('[for ann]', 'ann'), t(long)]);
      assert.equal(ann.getAllMessages().length, sharded + 1, 'stored whole');
      assert.ok(!texts((await bob.compile(BUDGET)).messages).includes('[for ann]'), 'and another reader never sees the block');
    }, sharding);
  });

  it('hands the strategy\'s onNewMessage the reader\'s view of a message, and none it sees nothing of', async () => {
    const heard: ContentBlock[][] = [];
    class Listening extends PassthroughStrategy {
      override async onNewMessage(message: StoredMessage, ctx: Parameters<PassthroughStrategy['onNewMessage']>[1]): Promise<void> {
        heard.push(message.content);
        return super.onNewMessage(message, ctx);
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'cm-audience-'));
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new Listening(), viewReader: 'ann' });
    try {
      ann.addMessage('user', [forReaders('[for ann]', 'ann'), forReaders('[for bob]', 'bob'), t('Shared.')]);
      ann.addMessage('user', [forReaders('[only bob]', 'bob')]);
      assert.deepEqual(heard, [[t('[for ann]'), t('Shared.')]]);
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a reader\'s compile, provenance, binding and namespace', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'cm-audience-'));

  it('reports raw bodies and their completeness by the reader\'s view, with a viewFilter set as without', async () => {
    for (const viewFilter of [undefined, () => true]) {
      const dir = tmp();
      const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann', ...(viewFilter ? { viewFilter } : {}) });
      try {
        const id = ann.addMessage('user', [forReaders('[for bob]', 'bob'), forReaders('[for ann]', 'ann'), t('Shared.')]);
        const result = await ann.compile(BUDGET);
        const bodies = result.rawBodies?.get(id);
        assert.deepEqual(bodies?.map((b) => b.content), [[t('[for ann]'), t('Shared.')]], `rawBodies hold the reader's view (viewFilter ${viewFilter ? 'set' : 'unset'})`);
        const source = result.provenance?.messages[0];
        assert.ok(source?.kind === 'raw' && source.bodies[0]!.complete, `the body is complete (viewFilter ${viewFilter ? 'set' : 'unset'})`);
      } finally {
        await ann.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('records a namespace\'s reader and refuses another, while an open with no reader is allowed and sees no audience block', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      ann.addMessage('user', [forReaders('[for ann]', 'ann'), t('Hi.')]);
      assert.equal(ann.getStore().getStateJson('agents/ann/reader'), 'ann', 'a fresh namespace records its reader');
      await assert.rejects(
        ContextManager.open({ store: ann.getStore(), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'bob' }),
        /namespace "agents\/ann" compiles for reader "ann", not "bob"/,
      );
      const inspector = await ContextManager.open({ store: ann.getStore(), namespace: 'agents/ann', strategy: new PassthroughStrategy() });
      try {
        assert.equal(texts((await inspector.compile(BUDGET)).messages), 'Hi.');
      } finally {
        await inspector.close();
      }
      const again = await ContextManager.open({ store: ann.getStore(), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
      await again.close();
      await assert.rejects(
        ContextManager.open({ store: ann.getStore(), namespace: 'agents/fresh', isolate: true, strategy: new PassthroughStrategy(), viewReader: 'carol', auxiliaryMessageViews: [{ namespace: 'agents/fresh' }] }),
        /is this manager's own message slot/,
      );
      const failing = Object.assign(new PassthroughStrategy(), { initialize: async () => { throw new Error('the strategy failed to start'); } });
      await assert.rejects(
        ContextManager.open({ store: ann.getStore(), namespace: 'agents/fresh', isolate: true, strategy: failing, viewReader: 'erin' }),
        /the strategy failed to start/,
      );
      await assert.rejects(
        ContextManager.open({ store: ann.getStore(), namespace: 'agents/fresh', isolate: true, strategy: new PassthroughStrategy(), viewReader: 'dan' }),
        /namespace "agents\/fresh" compiles for reader "erin", not "dan"/,
        'a failed start keeps its claim',
      );
      const erin = await ContextManager.open({ store: ann.getStore(), namespace: 'agents/fresh', isolate: true, strategy: new PassthroughStrategy(), viewReader: 'erin' });
      await erin.close();
      ann.getStore().setStateJson('agents/fresh/reader', null);
      const dan = await ContextManager.open({ store: ann.getStore(), namespace: 'agents/fresh', isolate: true, strategy: new PassthroughStrategy(), viewReader: 'dan' });
      await dan.close();
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an audience at write wherever the view doesn\'t read one: a tool call or result, a system change, a block inside another', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      assert.throws(
        () => ann.addMessage('agent', [{ type: 'tool_use', id: 'c1', name: 'search', input: {}, audience: ['ann'] } as ContentBlock]),
        /content\[0\] is a tool_use with an audience; a tool call and its result go to every reader of the message/,
      );
      assert.throws(
        () => ann.addMessage('user', [{ type: 'tool_result', toolUseId: 'c1', content: 'ok', audience: ['ann'] } as ContentBlock]),
        /content\[0\] is a tool_result with an audience/,
      );
      assert.throws(
        () => ann.addMessage('user', [{ type: 'tool_result', toolUseId: 'c1', content: [{ type: 'text', text: 'inner', audience: ['ann'] }] } as unknown as ContentBlock]),
        /content\[0\]\.content\[0\] has an audience; an audience is read on a message's own blocks only/,
      );
      assert.throws(
        () => ann.addMessage('user', [{ type: 'system_change', audience: ['ann'], addSystem: ['A line.'] } as unknown as ContentBlock]),
        /content\[0\] is a system_change with an audience; a system change goes to every reader/,
      );
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      assert.throws(
        () => ann.addMessage('user', [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: png }, audience: ['ann'] } as unknown as ContentBlock]),
        /content\[0\] is inline image with an audience; the store keeps inline media as a blob, which carries no audience/,
      );
      assert.throws(() => ann.addMessage('user', [{ type: 'text', text: 'odd', audience: 'bob' } as unknown as ContentBlock]), /content\[0\]\.audience isn't a list of reader names: it's a string/);
      assert.throws(() => ann.addMessage('user', [{ type: 'text', text: 'odd', audience: ['ann', 42] } as unknown as ContentBlock]), /content\[0\]\.audience isn't a list of reader names: it's a list holding something other than a string/);
      const sparse: unknown[] = [];
      sparse[1] = 'ann';
      assert.throws(() => ann.addMessage('user', [{ type: 'text', text: 'odd', audience: sparse } as unknown as ContentBlock]), /content\[0\]\.audience isn't a list of reader names: it's a list holding something other than a string/);
      assert.equal(ann.getAllMessages().length, 0, 'nothing was stored');
      ann.addMessage('user', [{ type: 'tool_result', toolUseId: 'c1', content: [{ type: 'text', text: 'MCP', annotations: { audience: ['user'], priority: 1 } }] } as unknown as ContentBlock]);
      ann.addMessage('user', [{ type: 'text', text: 'MCP at the top', annotations: { audience: ['assistant'] } } as unknown as ContentBlock]);
      ann.addMessage('agent', [{ type: 'tool_use', id: 'c3', name: 'post', input: { post: { type: 'announcement', audience: 'team', body: [{ type: 'text', audience: ['x'] }] } } } as ContentBlock]);
      assert.equal(ann.getAllMessages().length, 3, "MCP's annotations.audience and a tool call's own arguments are no audience of the view's, and are stored");
      const kept = JSON.stringify(ann.getAllMessages().map((m) => m.content));
      assert.ok(kept.includes('"annotations":{"audience":["user"],"priority":1}') && kept.includes('"audience":"team"') && kept.includes('"audience":["x"]'), 'as written');
      assert.throws(
        () => ann.addMessage('user', [{ type: 'tool_result', toolUseId: 'c3', content: [{ type: 'tool_result', toolUseId: 'c4', content: [{ type: 'text', text: 'deep', audience: ['ann'] }] }] } as unknown as ContentBlock]),
        /content\[0\]\.content\[0\]\.content\[0\] has an audience/,
        'a block nested in a tool result is refused',
      );
      let deep: Record<string, unknown> = { type: 'text', text: 'deepest', audience: ['ann'] };
      for (let i = 0; i < 70; i++) deep = { type: 'tool_result', toolUseId: `d${i}`, content: [deep] };
      assert.throws(() => ann.addMessage('user', [deep as unknown as ContentBlock]), /has an audience; an audience is read on a message's own blocks only/, 'at any depth');
      const id = ann.addMessage('user', [t('Fine.')]);
      assert.throws(
        () => ann.editMessage(id, [{ type: 'tool_use', id: 'c2', name: 'search', input: {}, audience: ['ann'] } as ContentBlock]),
        /is a tool_use with an audience/,
        'an edit is refused the same way',
      );
      assert.throws(() => ann.editMessage(id, [{ type: 'tool_result', toolUseId: 'c5', content: [{ type: 'text', text: 'inner', audience: ['ann'] }] } as unknown as ContentBlock]), /content\[0\]\.content\[0\] has an audience/);
      assert.throws(() => ann.editMessage(id, [{ type: 'system_change', audience: ['ann'], addSystem: ['A line.'] } as unknown as ContentBlock]), /is a system_change with an audience/);
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a switch to a branch whose namespace compiles for another reader, and stays where it was', async () => {
    const dir = tmp();
    const first = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/x', strategy: new PassthroughStrategy() });
    const root = first.getStore();
    first.addMessage('user', [t('Before any reader.')]);
    root.createBranch('side');
    const side = await ContextManager.open({ store: (root as unknown as { view(name: string): JsStore }).view('side'), namespace: 'agents/x', strategy: new PassthroughStrategy(), viewReader: 'bob' });
    await side.close();
    const ann = await ContextManager.open({ store: root, namespace: 'agents/x', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      const from = ann.currentBranch().name;
      await assert.rejects(ann.switchBranch('side'), /ContextManager\.switchBranch: namespace "agents\/x" compiles for reader "bob", not "ann"/);
      assert.equal(ann.currentBranch().name, from, 'it stays where it was');
      assert.equal(texts((await ann.compile(BUDGET)).messages), 'Before any reader.');
    } finally {
      await ann.close();
      await first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a namespace\'s reader record', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'cm-audience-'));
  const asRoot = (store: JsStore) => store as unknown as { view(name: string): JsStore };
  const recordOffset = (store: JsStore) => (store as unknown as { stateHeadOffset(id: string): number | null }).stateHeadOffset('agents/ann/reader');

  it('refuses a second reader opening while the first one\'s strategy is still starting', async () => {
    const dir = tmp();
    const first = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/x', strategy: new PassthroughStrategy() });
    let release: (() => void) | undefined;
    const slow = Object.assign(new PassthroughStrategy(), { initialize: () => new Promise<void>((resolve) => { release = resolve; }) });
    const opening = ContextManager.open({ store: first.getStore(), namespace: 'agents/ann', strategy: slow, viewReader: 'ann' });
    try {
      for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(release, 'the premise: ann\'s strategy is starting');
      await assert.rejects(
        ContextManager.open({ store: first.getStore(), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'bob' }),
        /namespace "agents\/ann" compiles for reader "ann", not "bob"/,
      );
      release!();
      const ann = await opening;
      await ann.close();
    } finally {
      release?.();
      await first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses another reader before registering anything, auxiliary slots included', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      const store = ann.getStore();
      const sequence = store.currentSequence();
      const states = store.listStates().map((state) => state.id).sort();
      await assert.rejects(
        ContextManager.open({ store, namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'bob', auxiliaryMessageViews: [{ namespace: 'agents/zed' }] }),
        /compiles for reader "ann", not "bob"/,
      );
      assert.deepEqual(store.listStates().map((state) => state.id).sort(), states, 'the refused open registered nothing');
      assert.equal(store.currentSequence(), sequence, 'and wrote nothing');
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the record across a close and an open by path, and refuses an empty reader', async () => {
    const dir = tmp();
    const path = join(dir, 'store');
    const ann = await ContextManager.open({ path, namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    await ann.close();
    try {
      await assert.rejects(
        ContextManager.open({ path, namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'bob' }),
        /compiles for reader "ann", not "bob"/,
      );
      await assert.rejects(
        ContextManager.open({ path, namespace: 'agents/zed', strategy: new PassthroughStrategy(), viewReader: '' }),
        /ContextManager\.open: viewReader is empty/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the record once: reopening for the same reader leaves it as it was', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      const before = recordOffset(ann.getStore());
      assert.notEqual(before, null, 'the premise: the record is written');
      const again = await ContextManager.open({ store: ann.getStore(), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
      await again.close();
      assert.equal(recordOffset(ann.getStore()), before);
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the reader on a branch it switches to that had none', async () => {
    const dir = tmp();
    const first = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/x', strategy: new PassthroughStrategy() });
    const root = first.getStore();
    first.addMessage('user', [t('Before any reader.')]);
    root.createBranch('side');
    const ann = await ContextManager.open({ store: root, namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      await ann.switchBranch('side');
      await assert.rejects(
        ContextManager.open({ store: asRoot(root).view('side'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'bob' }),
        /compiles for reader "ann", not "bob"/,
      );
    } finally {
      await ann.close();
      await first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses setStrategy on a branch whose namespace compiles for another reader', async () => {
    const dir = tmp();
    const first = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/x', strategy: new PassthroughStrategy() });
    const root = first.getStore();
    first.addMessage('user', [t('Before any reader.')]);
    root.createBranch('side');
    const bob = await ContextManager.open({ store: asRoot(root).view('side'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'bob' });
    await bob.close();
    const ann = await ContextManager.open({ store: root, namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      root.switchBranch('side');
      await assert.rejects(ann.setStrategy(new PassthroughStrategy()), /ContextManager\.setStrategy: namespace "agents\/ann" compiles for reader "bob", not "ann"/);
      assert.throws(() => ann.addMessage('user', [t('After.')]), /ContextManager\.addMessage requires successful strategy initialization/, 'the refused replacement is not taken as started');
    } finally {
      await ann.close();
      await first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps summaries written before a reader claims the namespace, and that reader\'s compiles use them', async () => {
    const dir = tmp();
    const path = join(dir, 'store');
    const marked = (mark: string) => ({
      complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: `${mark} ${'x '.repeat(40)}` }], usage: { input_tokens: 10, output_tokens: 25 } }),
    }) as never;
    const before = await ContextManager.open({ path, namespace: 'agents/ann', strategy: memory(), membrane: marked('PRE-CLAIM') });
    try {
      for (let i = 0; i < 60; i++) before.addMessage(i % 2 ? 'agent' : 'user', [t(`message ${i} ${'word '.repeat(8)}`)]);
      await before.compile(BUDGET);
      await drain(before);
      assert.ok(JSON.stringify((await before.compile(BUDGET)).messages).includes('PRE-CLAIM'), 'the premise: the namespace holds summaries before any reader');
    } finally {
      await before.close();
    }
    const ann = await ContextManager.open({ path, namespace: 'agents/ann', strategy: memory(), membrane: marked('POST-CLAIM'), viewReader: 'ann' });
    try {
      assert.ok(JSON.stringify((await ann.compile(BUDGET)).messages).includes('PRE-CLAIM'));
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claims an unclaimed branch for setStrategy before the strategy starts', async () => {
    const dir = tmp();
    const first = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/x', strategy: new PassthroughStrategy() });
    const root = first.getStore();
    first.addMessage('user', [t('Before any reader.')]);
    root.createBranch('side');
    const ann = await ContextManager.open({ store: root, namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    let release: (() => void) | undefined;
    try {
      root.switchBranch('side');
      const slow = Object.assign(new PassthroughStrategy(), { initialize: () => new Promise<void>((resolve) => { release = resolve; }) });
      const replacing = ann.setStrategy(slow);
      for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(release, 'the premise: the replacement is starting');
      await assert.rejects(
        ContextManager.open({ store: asRoot(root).view('side'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'bob' }),
        /compiles for reader "ann", not "bob"/,
      );
      release!();
      await replacing;
    } finally {
      release?.();
      await ann.close();
      await first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies the reader\'s view after the view filter, which sees the message as stored', async () => {
    const dir = tmp();
    const viewFilter = (message: StoredMessage) => !message.content.some((block) => (block as { text?: string }).text === 'DROP-ME');
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann', viewFilter });
    try {
      ann.addMessage('user', [t('Kept.')]);
      ann.addMessage('user', [forReaders('DROP-ME', 'bob'), t('Dropped by the filter.')]);
      assert.equal(texts((await ann.compile(BUDGET)).messages), 'Kept.');
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps one record for an empty namespace and an omitted one, which share a context log', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: '', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      await assert.rejects(
        ContextManager.open({ store: ann.getStore(), strategy: new PassthroughStrategy(), viewReader: 'bob' }),
        /compiles for reader "ann", not "bob"/,
      );
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an audience in a context entry, where no view reads one', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      const log = (ann as unknown as { contextLog: ContextLog }).contextLog;
      assert.throws(() => log.append('user', [forReaders('[for bob]', 'bob')]), /content\[0\] has an audience; a context entry is its namespace's reader's/);
      log.append('user', [t('Fine.')]);
      assert.throws(() => log.replaceAll([{ participant: 'user', content: [t('Other.')] }, { participant: 'user', content: [forReaders('[for bob]', 'bob')] }]), /Context entry 1 of the replacement refused: content\[0\] has an audience/);
      assert.throws(() => log.edit(0, [forReaders('[for bob]', 'bob')]), /Edit of context entry 0 refused: content\[0\] has an audience/);
      assert.deepEqual(log.getAll().map((entry) => entry.content), [[t('Fine.')]]);
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a compile given an injection that declares an audience, before it selects anything', async () => {
    const dir = tmp();
    let selects = 0;
    class Counting extends PassthroughStrategy {
      override select(...args: Parameters<PassthroughStrategy['select']>): ReturnType<PassthroughStrategy['select']> {
        selects++;
        return super.select(...args);
      }
    }
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new Counting(), viewReader: 'ann' });
    const inject = (position: 'system' | 'beforeUser' | 'afterUser', content: unknown[]) => [{ namespace: 'probe', position, content: content as ContentBlock[] }];
    const refused = (pattern: RegExp) => (error: unknown) => error instanceof MalformedContentError && pattern.test(error.message);
    try {
      ann.addMessage('user', [t('Hello.')]);
      await assert.rejects(ann.compile(BUDGET, inject('afterUser', [t('Fine.'), forReaders('[for bob]', 'bob')])), refused(/ContextManager\.compile refused its injections: injections\[0\]\.content\[1\] has an audience; an injection goes into the request as given/));
      await assert.rejects(ann.compile(BUDGET, inject('system', [forReaders('[for ann]', 'ann')])), refused(/injections\[0\]\.content\[0\] has an audience/));
      await assert.rejects(ann.compile(BUDGET, inject('beforeUser', [{ type: 'tool_result', toolUseId: 'x', content: [forReaders('inner', 'ann')] }])), refused(/injections\[0\]\.content\[0\]\.content\[0\] has an audience/));
      await assert.rejects(ann.compile(BUDGET, undefined, { messageInjections: [[t('Fine.'), forReaders('[for bob]', 'bob')]] }), refused(/ContextManager\.compile refused its injections: opts\.messageInjections\[0\]\[1\] has an audience/));
      assert.equal(selects, 0, 'a refused compile selects nothing');
      assert.ok(texts((await ann.compile(BUDGET, inject('afterUser', [t('Plain.')]))).messages).includes('Plain.'), 'an injection with no audience is placed as before');
      await assert.doesNotReject(ann.compile(BUDGET, undefined, { messageInjections: [[t('Plain too.')]] }), 'messageInjections with no audience compile');
      assert.ok(selects > 0, 'the premise: a compile that goes ahead selects');
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the same nested audiences at write and in a compile\'s injection', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    const result = (content: unknown[]) => ({ type: 'tool_result', toolUseId: 'r', content }) as unknown as ContentBlock;
    const shapes: Array<[ContentBlock, string[]]> = [
      [result([t('plain'), forReaders('inner', 'ann')]), ['[1]']],
      [result([result([t('plain'), forReaders('deep', 'bob')])]), ['[0].content[1]']],
      [result([{ type: 'text', text: 'MCP', annotations: { audience: ['user'] } }]), []],
      [result([{ type: 'tool_use', id: 'u', name: 'post', input: { audience: 'team' } }]), []],
    ];
    const placesOf = (error: unknown) => (error instanceof MalformedContentError ? error.places.map((place) => place.split(' ')[0]) : [String(error)]);
    try {
      ann.addMessage('user', [t('Hello.')]);
      for (const [block, inner] of shapes) {
        let atWrite: string[] = [];
        try { ann.addMessage('user', [block]); } catch (error) { atWrite = placesOf(error); }
        let atCompile: string[] = [];
        try { await ann.compile(BUDGET, [{ namespace: 'probe', position: 'afterUser', content: [block] }]); } catch (error) { atCompile = placesOf(error); }
        assert.deepEqual(atWrite, inner.map((place) => `content[0].content${place}`));
        assert.deepEqual(atCompile, inner.map((place) => `injections[0].content[0].content${place}`));
      }
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forks for its own reader, on a head that records it and on one an operator cleared', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    const root = ann.getStore() as unknown as { view(name: string): JsStore; setStateJson(id: string, value: unknown): void };
    try {
      ann.addMessage('user', [t('Hello.')]);
      const home = ann.currentBranch().name;
      await ann.fork('mine');
      assert.equal(root.view('mine').getStateJson('agents/ann/reader'), 'ann', 'a fork on a head that records ann records ann');
      await ann.switchBranch(home);
      root.setStateJson('agents/ann/reader', null);
      await ann.fork('after-clear');
      assert.equal(root.view('after-clear').getStateJson('agents/ann/reader'), 'ann', 'a fork on a cleared head claims the new branch for ann');
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a preview given select options whose messageInjections declare an audience', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      ann.addMessage('user', [t('Hello.')]);
      assert.throws(
        () => ann.previewContext(BUDGET, undefined, { messageInjections: [[forReaders('[for bob]', 'bob')]] }),
        (error: unknown) => error instanceof MalformedContentError && /ContextManager\.previewContext refused its injections: opts\.messageInjections\[0\]\[0\] has an audience/.test(error.message),
      );
      assert.equal(ann.previewContext(BUDGET, undefined, { messageInjections: [[t('Plain.')]] }), null, 'one with no audience goes on to the strategy, which has no preview');
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a fork when the head records another reader, before it makes a branch', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      ann.addMessage('user', [t('Hello.')]);
      ann.getStore().setStateJson('agents/ann/reader', 'bob');
      await assert.rejects(ann.fork('held'), /ContextManager\.fork: namespace "agents\/ann" compiles for reader "bob", not "ann"/);
      assert.ok(!ann.listBranches().some((branch) => branch.name === 'held'), 'no branch is left behind');
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a fork, a setStrategy and a switch on a record that isn\'t a reader\'s name, naming it as such', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    const root = ann.getStore();
    try {
      ann.addMessage('user', [t('Hello.')]);
      root.createBranch('side');
      (root as unknown as { view(name: string): JsStore }).view('side').setStateJson('agents/ann/reader', '');
      root.setStateJson('agents/ann/reader', 42);
      await assert.rejects(ann.fork('damaged'), /ContextManager\.fork: namespace "agents\/ann" records its reader as 42, not a reader's name/);
      assert.ok(!ann.listBranches().some((branch) => branch.name === 'damaged'), 'no branch is left behind');
      await assert.rejects(ann.setStrategy(new PassthroughStrategy()), /ContextManager\.setStrategy: namespace "agents\/ann" records its reader as 42, not a reader's name/);
      const from = ann.currentBranch().name;
      await assert.rejects(ann.switchBranch('side'), /ContextManager\.switchBranch: namespace "agents\/ann" records its reader as "", not a reader's name/);
      assert.equal(ann.currentBranch().name, from, 'the refused switch stays where it was');
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps one record for an omitted namespace and 'default'", async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      await assert.rejects(
        ContextManager.open({ store: ann.getStore(), namespace: 'default', strategy: new PassthroughStrategy(), viewReader: 'bob' }),
        /compiles for reader "ann", not "bob"/,
      );
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a store whose slots hold no audience block', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'cm-audience-'));
  const asRoot = (store: JsStore) => store as unknown as { view(name: string): JsStore };

  it('reads its slot through the plain view on every write, until a block with an audience is stored', async () => {
    const getAll = mock.method(MessageStore.prototype, 'getAll');
    const proto = MessageStore.prototype as unknown as { mayHoldAudience(): boolean; getAllInternal(): unknown[] };
    const check = proto.mayHoldAudience;
    const scan = proto.getAllInternal;
    let inCheck = 0;
    let scans = 0;
    const checks = mock.method(proto, 'mayHoldAudience', function (this: unknown) {
      inCheck++;
      try { return check.call(this); } finally { inCheck--; }
    });
    const scanned = mock.method(proto, 'getAllInternal', function (this: unknown) {
      if (inCheck > 0) scans++;
      return scan.call(this);
    });
    const reads: number[] = [];
    const scansPerWrite: number[] = [];
    class Measuring extends PassthroughStrategy {
      override async onNewMessage(message: StoredMessage, ctx: Parameters<PassthroughStrategy['onNewMessage']>[1]): Promise<void> {
        const before = getAll.mock.callCount();
        ctx.messageStore.length();
        reads.push(getAll.mock.callCount() - before);
        return super.onNewMessage(message, ctx);
      }
    }
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new Measuring(), viewReader: 'ann' });
    try {
      for (const content of [[t('One.')], [t('Two.')], [forReaders('[for bob]', 'bob'), t('Three.')], [t('Four.')]]) {
        const before = scans;
        ann.addMessage('user', content);
        scansPerWrite.push(scans - before);
      }
      assert.deepEqual(reads, [0, 0, 1, 1], "the length of a plain view is the store's own; the reader's view lists the slot to count what it keeps");
      assert.ok(checks.mock.callCount() > 0, 'the premise: the check ran');
      assert.deepEqual(scansPerWrite.slice(1), [0, 0, 0], 'after the first, no write makes the check scan the slot');
    } finally {
      scanned.mock.restore();
      checks.mock.restore();
      getAll.mock.restore();
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the reader\'s view once a manager on the same store object stores a block with an audience', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    const bob = await ContextManager.open({ store: ann.getStore(), namespace: 'agents/bob', strategy: new PassthroughStrategy(), viewReader: 'bob' });
    try {
      ann.addMessage('user', [t('Plain.')]);
      assert.equal(texts((await ann.compile(BUDGET)).messages), 'Plain.');
      bob.addMessage('user', [forReaders('[for bob]', 'bob'), t('Hello.')]);
      const compiled = (await ann.compile(BUDGET)).messages;
      assert.ok(texts(compiled).includes('Hello.') && !texts(compiled).includes('[for bob]'));
      assert.ok(!anyAudience(compiled));
    } finally {
      await bob.close();
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads its slot again after a write through another handle on its branch', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    const root = ann.getStore();
    try {
      ann.addMessage('user', [t('Plain.')]);
      assert.equal(texts((await ann.compile(BUDGET)).messages), 'Plain.');
      const carol = await ContextManager.open({ store: asRoot(root).view(root.currentBranch().name), namespace: 'agents/carol', strategy: new PassthroughStrategy(), viewReader: 'carol' });
      carol.addMessage('user', [forReaders('[for carol]', 'carol'), t('Hello.')]);
      await carol.close();
      const compiled = (await ann.compile(BUDGET)).messages;
      assert.ok(texts(compiled).includes('Hello.'), 'the premise: ann reads the other handle\'s write');
      assert.ok(!texts(compiled).includes('[for carol]') && !anyAudience(compiled));
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers a view held across a write as the reader sees the slot at each read', async () => {
    const held: { view?: MessageStoreView } = {};
    class Holding extends PassthroughStrategy {
      override async onNewMessage(message: StoredMessage, ctx: Parameters<PassthroughStrategy['onNewMessage']>[1]): Promise<void> {
        held.view ??= ctx.messageStore;
        return super.onNewMessage(message, ctx);
      }
    }
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new Holding(), viewReader: 'ann' });
    try {
      ann.addMessage('user', [t('Plain.')]);
      const view = held.view!;
      assert.equal(view.length(), 1, 'the premise: the view was taken while no block had an audience');
      const shared = ann.addMessage('user', [forReaders('[for bob]', 'bob'), t('Shared.')]);
      const onlyBob = ann.addMessage('user', [forReaders('[only bob]', 'bob')]);
      for (const [read, messages] of [['getAll', view.getAll()], ['getTail', view.getTail(5)], ['getFrom', view.getFrom(0)]] as const) {
        assert.equal(texts(messages), 'Plain.\nShared.', `${read} holds the reader's view`);
        assert.ok(!anyAudience(messages), `${read} carries no audience field`);
      }
      assert.equal(view.length(), 2, 'length counts the messages the reader sees');
      assert.deepEqual(view.get(shared as never)!.content, [t('Shared.')], 'get holds the reader\'s view');
      assert.equal(view.sequenceOf!(onlyBob as never), undefined, 'sequenceOf answers none for a message the reader sees nothing of');
      assert.notEqual(view.sequenceOf!(shared as never), undefined);
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a speculative drain that began before any audience block to the reader\'s view', async () => {
    const payloads: string[] = [];
    let release: (() => void) | undefined;
    let calls = 0;
    let released = false;
    const membrane = {
      complete: async (request: { messages: ApiMessage[] }) => {
        calls++;
        const input = request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
        payloads.push(`${released ? 'AFTER' : 'BEFORE'} ${input}`);
        if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `[memory ${calls}] ${'x '.repeat(40)}` }], usage: { input_tokens: 10, output_tokens: 25 } };
      },
    } as never;
    const strategy = new AutobiographicalStrategy({ compressionModel: 'test-compression-model', targetChunkTokens: 300, headWindowTokens: 150, recentWindowTokens: 0, hierarchical: true, autoTickOnNewMessage: true });
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy, membrane, viewReader: 'ann' });
    try {
      const words = 'words of the conversation '.repeat(12);
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) ids.push(ann.addMessage(i % 2 ? 'Claude' : 'user', [t(`message ${i} ${words}`)]));
      for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(release, 'the premise: the drain\'s first model call is held');
      ann.editMessage(ids[0]! as never, [t(`message 0 ${words}`), forReaders('SECRET-head', 'bob')]);
      for (let i = 12; i < 24; i++) ann.addMessage(i % 2 ? 'Claude' : 'user', [t(`message ${i} ${words}`)]);
      released = true;
      release!();
      const readHeadAfter = () => payloads.some((p) => p.startsWith('AFTER ') && p.includes('message 0 ') && /message (1[3-9]|2[0-3]) /.test(p));
      for (let i = 0; i < 1000 && !readHeadAfter(); i++) await new Promise((r) => setTimeout(r, 10));
      const after = payloads.filter((p) => p.startsWith('AFTER '));
      const shown = payloads.map((p) => `${p.slice(0, 6)}[${[...new Set([...p.matchAll(/message (\d+) /g)].map((m) => m[1]))].join(',')}]${p.includes('SECRET-head') ? ' SECRET' : ''}`).join(' ');
      assert.ok(after.some((p) => p.includes('message 0 ')), `the premise: the drain read the head after the edit (requests: ${shown})`);
      assert.equal(payloads.filter((p) => p.includes('SECRET-head')).length, 0, `no summariser request carries the block for bob (requests: ${shown})`);
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the reader\'s view once an edit brings the slot its first audience block', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      const id = ann.addMessage('user', [t('Plain.')]);
      assert.equal(texts((await ann.compile(BUDGET)).messages), 'Plain.');
      ann.editMessage(id, [t('Plain.'), forReaders('[for bob]', 'bob')]);
      const compiled = (await ann.compile(BUDGET)).messages;
      assert.equal(texts(compiled), 'Plain.');
      assert.ok(!anyAudience(compiled));
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads its slot again when another handle\'s write is followed by a counted one', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    const root = ann.getStore();
    try {
      ann.addMessage('user', [t('Plain.')]);
      assert.equal(texts((await ann.compile(BUDGET)).messages), 'Plain.');
      const carol = await ContextManager.open({ store: asRoot(root).view(root.currentBranch().name), namespace: 'agents/carol', strategy: new PassthroughStrategy(), viewReader: 'carol' });
      carol.addMessage('user', [forReaders('[for carol]', 'carol'), t('Hello.')]);
      await carol.close();
      ann.addMessage('user', [t('After.')]);
      const compiled = (await ann.compile(BUDGET)).messages;
      assert.equal(texts(compiled), 'Plain.\nHello.\nAfter.');
      assert.ok(!anyAudience(compiled));
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the reader\'s view when an auxiliary slot holds an audience block', async () => {
    const dir = tmp();
    const other = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/other', isolate: true, strategy: new PassthroughStrategy() });
    try {
      other.addMessage('user', [forReaders('[for bob]', 'bob'), t('Aux.')]);
      const ann = await ContextManager.open({ store: other.getStore(), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann', auxiliaryMessageViews: [{ namespace: 'agents/other' }] });
      try {
        ann.addMessage('user', [t('Own.')]);
        const compiled = (await ann.compile(BUDGET)).messages;
        assert.ok(texts(compiled).includes('Aux.') && texts(compiled).includes('Own.'), 'the premise: the auxiliary slot is read');
        assert.ok(!texts(compiled).includes('[for bob]') && !anyAudience(compiled));
      } finally {
        await ann.close();
      }
    } finally {
      await other.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads its slot again on a switch to another branch', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    const root = ann.getStore();
    try {
      ann.addMessage('user', [t('Plain.')]);
      assert.equal(texts((await ann.compile(BUDGET)).messages), 'Plain.');
      root.createBranch('side');
      const carol = await ContextManager.open({ store: asRoot(root).view('side'), namespace: 'agents/carol', strategy: new PassthroughStrategy(), viewReader: 'carol' });
      carol.addMessage('user', [forReaders('[for carol]', 'carol'), t('On the side.')]);
      await carol.close();
      await ann.switchBranch('side');
      const compiled = (await ann.compile(BUDGET)).messages;
      assert.ok(texts(compiled).includes('On the side.'), 'the premise: ann reads the side branch');
      assert.ok(!texts(compiled).includes('[for carol]') && !anyAudience(compiled));
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('audienceMessageStoreView', () => {
  const stored = (id: string, content: ContentBlock[], sequence: number): StoredMessage =>
    ({ id, participant: 'user', content, sequence, timestamp: new Date(0) } as unknown as StoredMessage);
  const viewOf = (messages: StoredMessage[]): MessageStoreView => ({
    getAll: () => messages,
    get: (id) => messages.find((m) => m.id === id) ?? null,
    getFrom: (i) => messages.slice(i),
    getTail: (n) => messages.slice(-n),
    length: () => messages.length,
    estimateTokens: (m) => m.content.length,
  });

  it('is the view\'s own listing and objects where no block has an audience', () => {
    const listing = [stored('a', [t('one')], 1), stored('b', [t('two')], 2)];
    const view = viewOf(listing);
    for (const reader of ['ann', undefined]) {
      const seen = audienceMessageStoreView(view, reader);
      assert.equal(seen.getAll(), listing);
      assert.equal(seen.get('b'), listing[1]);
    }
  });

  it('gives one object per message and reader while the stored object lives', () => {
    const listing = [stored('a', [forReaders('[ann]', 'ann'), t('one')], 1), stored('b', [t('two')], 2)];
    const view = viewOf(listing);
    const first = audienceMessageStoreView(view, 'ann');
    const second = audienceMessageStoreView(view, 'ann');
    assert.equal(first.getAll(), second.getAll(), 'one listing per source listing and reader');
    assert.equal(first.get('a'), second.getAll()[0], 'get and the listing agree');
    assert.equal(first.getAll()[1], listing[1], 'a message with no audience block is the stored object');
    assert.notEqual(audienceMessageStoreView(view, 'bob').getAll()[0], first.getAll()[0]);
    listing[0]!.content[1] = t('replaced');
    assert.deepEqual(audienceMessageStoreView(view, 'ann').get('a')!.content, [t('[ann]'), t('replaced')], 'a block replaced in place is seen');
  });

  it('reads a tail through the view\'s window, and the listing only where the window leaves a message out', () => {
    const listing = [stored('a', [forReaders('[bob]', 'bob')], 1), stored('b', [t('two')], 2), stored('c', [forReaders('[ann]', 'ann'), t('three')], 3)];
    let listed = 0;
    const view = { ...viewOf(listing), getAll: () => { listed++; return listing; }, getTail: (n: number) => listing.slice(-n).map((m) => ({ ...m })) };
    const ann = audienceMessageStoreView(view, 'ann');
    const tail = ann.getTail(2);
    assert.deepEqual(tail.map((m) => m.content), [[t('two')], [t('[ann]'), t('three')]]);
    assert.equal(listed, 0, 'a tail with nothing left out reads no listing');
    assert.deepEqual(ann.getTail(3).map((m) => m.id), ['b', 'c'], 'a message left out is gone from the tail');
    assert.equal(listed, 1, 'and that tail is the listing\'s');
  });

  it('treats an audience that isn\'t a list of strings as naming no one', () => {
    const listing = [
      stored('a', [{ type: 'text', text: 'odd', audience: 'ann' } as ContentBlock, t('kept')], 1),
      stored('b', [{ type: 'text', text: 'mixed', audience: ['ann', 42] } as unknown as ContentBlock, t('kept too')], 2),
    ];
    const ann = audienceMessageStoreView(viewOf(listing), 'ann');
    assert.deepEqual(ann.get('a')!.content, [t('kept')]);
    assert.deepEqual(ann.get('b')!.content, [t('kept too')], 'a list with a member that isn\'t a string names no one');
  });

  it('answers sequenceOf as get does, with none for a message the reader sees nothing of', () => {
    const listing = [stored('a', [forReaders('[bob]', 'bob')], 1), stored('b', [t('two')], 2)];
    const view: MessageStoreView = { ...viewOf(listing), sequenceOf: (id) => listing.find((m) => m.id === id)?.sequence };
    const ann = audienceMessageStoreView(view, 'ann');
    assert.equal(ann.get('a'), null);
    assert.equal(ann.sequenceOf!('a'), undefined);
    assert.equal(ann.sequenceOf!('b'), 2);
  });

  it('answers sequenceOf from the view\'s own index while no slot may hold an audience block', () => {
    const listing = [stored('a', [t('one')], 1)];
    let gets = 0;
    const view: MessageStoreView = { ...viewOf(listing), get: (id) => { gets++; return listing.find((m) => m.id === id) ?? null; }, sequenceOf: (id) => listing.find((m) => m.id === id)?.sequence };
    assert.equal(audienceMessageStoreView(view, 'ann', { mayHold: () => false }).sequenceOf!('a'), 1);
    assert.equal(gets, 0, 'no message read');
    assert.equal(audienceMessageStoreView(view, 'ann', { mayHold: () => true }).sequenceOf!('a'), 1);
  });

  it('reads getFrom by the reader\'s own listing', () => {
    const listing = [stored('a', [forReaders('[bob]', 'bob')], 1), stored('b', [t('two')], 2), stored('c', [t('three')], 3)];
    const ann = audienceMessageStoreView(viewOf(listing), 'ann');
    assert.deepEqual(ann.getFrom(0).map((m) => m.id), ['b', 'c']);
    assert.deepEqual(ann.getFrom(1).map((m) => m.id), ['c'], 'an index counts the reader\'s listing');
  });

  it('takes a hidden block\'s raw replay form off the blocks that share it', () => {
    const item = { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'shared' }, { type: 'output_text', text: 'secret' }] };
    const shared = { type: 'text', text: 'shared', rawItem: item } as unknown as ContentBlock;
    const secret = { type: 'text', text: 'secret', rawItem: item, audience: ['bob'] } as unknown as ContentBlock;
    assert.deepEqual(contentForReader([shared, secret], 'ann'), [t('shared')], 'ann\'s copy is rendered from its fields, not the item that holds bob\'s text');
    assert.deepEqual(contentForReader([shared, secret], 'bob'), [shared, { type: 'text', text: 'secret', rawItem: item }], 'bob sees both, item and all');
  });
});
