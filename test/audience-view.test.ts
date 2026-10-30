import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import type { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextLog, ContextManager, KnowledgeStrategy, MalformedContentError, MessageStore, PassthroughStrategy, WindowedPassthroughStrategy, contentForReader } from '../src/index.js';
import { audienceMessageStoreView } from '../src/message-view.js';
import type { ContextStrategy, MessageStoreView, StoredMessage, StrategyContext } from '../src/index.js';

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
  strategy: () => ContextStrategy = memory,
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
      const id = ann.addMessage('user', [forReaders('[ann, before]', 'ann'), forReaders('[bob, before]', 'bob'), t('Original.')]);
      const other = ann.addMessage('user', [forReaders('Other.', 'ann', 'bob')]);
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

  it('keeps a transition summary made from a reader\'s view to that reader, and stores a host\'s own transition text as given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-audience-'));
    const echo = {
      complete: async (request: { messages: ApiMessage[] }) => ({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `ECHO ${texts(request.messages)}` }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    } as never;
    const headed = new AutobiographicalStrategy({ compressionModel: 'test-compression-model', targetChunkTokens: 300, headWindowTokens: 2000, recentWindowTokens: 0, hierarchical: true });
    const host = await ContextManager.open({ path: join(dir, 'store'), namespace: 'host', strategy: new PassthroughStrategy() });
    const store = host.getStore();
    let ann = await ContextManager.open({ store, namespace: 'agents/ann', strategy: headed, membrane: echo, viewReader: 'ann' });
    const bob = await ContextManager.open({ store, namespace: 'agents/bob', strategy: new PassthroughStrategy(), viewReader: 'bob' });
    try {
      const opening = ann.addMessage('user', [forReaders('ANN-ONLY opening', 'ann'), forReaders('SHARED opening', 'ann', 'bob')]);
      const made = await ann.resetHeadWindow();
      assert.ok(made.includes('ANN-ONLY'), `the premise: the summary was made from ann's view (${made.slice(0, 120)})`);
      assert.ok(texts((await ann.compile(BUDGET)).messages).includes('[Topic Transition]'), 'ann reads her transition');
      const bobs = texts((await bob.compile(BUDGET)).messages);
      assert.ok(!bobs.includes('ANN-ONLY'), `bob's compile holds nothing of ann's view (it read: ${bobs.slice(0, 160)})`);
      await ann.resetHeadWindow('A host\'s own words.');
      assert.ok(texts((await bob.compile(BUDGET)).messages).includes('A host\'s own words.'), 'a host\'s own transition text is stored as given, for everyone');
      ann.addMessage('user', [forReaders('ANN-AGAIN later', 'ann')]);
      const again = await ann.resetHeadWindow(null as never);
      assert.ok(again.includes('ANN-AGAIN'), `the premise: a null text made a summary from ann's view (${again.slice(0, 120)})`);
      assert.ok(!texts((await bob.compile(BUDGET)).messages).includes('ANN-AGAIN'), 'and one made for a null text is kept to ann too');
      await ann.close();
      ann = await ContextManager.open({ store, namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
      assert.throws(
        () => ann.editMessage(opening, [forReaders('ANN-ONLY opening', 'ann'), forReaders('SHARED opening', 'bob')]),
        /may hide a block from "ann", the reader this manager compiles for, and compression may have read the message/,
        'reopened, a block the transition request read is not narrowed away from ann',
      );
    } finally {
      await ann.close();
      await bob.close();
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an edit that narrows a block\'s audience', () => {
  const both = (text: string) => forReaders(text, 'ann', 'bob');
  const words = 'word '.repeat(8);
  const tmp = () => mkdtempSync(join(tmpdir(), 'cm-audience-'));
  const contentOf = (manager: ContextManager, id: string) => manager.getAllMessages().find((m) => m.id === id)!.content;
  const added = (manager: ContextManager): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      ids.push(manager.addMessage(i % 2 ? 'agent' : 'user', i === 0 ? [t('Opening.'), both(`SECRET-0 ${words}`)] : [both(`SECRET-${i} ${words}`)]));
    }
    return ids;
  };
  const summarized = async (manager: ContextManager, payloads: string[]): Promise<string[]> => {
    const ids = added(manager);
    await manager.compile(BUDGET);
    for (let i = 0; i < 300 && payloads.length === 0; i++) await manager.tick();
    await drain(manager);
    assert.ok(payloads.join('\n').includes('SECRET-3 '), 'the premise: a summary was written from message 3');
    return ids;
  };
  const toBob = (id: string, text: string): [string, ContentBlock[]] => [id, [forReaders(`${text} ${words}`, 'bob')]];
  const ownRefusal = /refused: the edit of message \S+ may hide a block from "ann", the reader this manager compiles for, and compression may have read the message: a chunk holding it or a later message has closed, or a compression request has read it/;

  it('is refused away from the reader once compression has read the message, and the message stays as it was', async () => {
    await withReaders(async ({ ann, annSummaries }) => {
      const ids = await summarized(ann, annSummaries);
      assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
      assert.deepEqual(contentOf(ann, ids[3]!), [both(`SECRET-3 ${words}`)], 'the message stays as it was');
      ann.editMessage(ids[3]!, [both(`SECRET-3, edited ${words}`)]);
      ann.editMessage(ids[3]!, [t(`SECRET-3, for everyone ${words}`)]);
      assert.deepEqual(contentOf(ann, ids[3]!), [t(`SECRET-3, for everyone ${words}`)], 'an edit that hides nothing, or widens, goes through');
      ann.editMessage(ids[0]!, [t('Opening.')]);
      assert.deepEqual(contentOf(ann, ids[0]!), [t('Opening.')], 'and dropping a block is an ordinary edit');
    });
  });

  it('is refused once a chunk holding the message has closed, before any request reads it', async () => {
    await withReaders(async ({ ann, annSummaries }) => {
      const ids = added(ann);
      assert.equal(annSummaries.length, 0, 'the premise: no request has been made');
      assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
      await drain(ann);
      assert.ok(annSummaries.some((p) => p.includes('SECRET-3 ')), 'and its request then reads the message as it stands');
    });
  });

  it('goes through away from the reader on a message newer than anything compression has read', async () => {
    await withReaders(async ({ ann, annSummaries }) => {
      await summarized(ann, annSummaries);
      const late = ann.addMessage('user', [both(`LATE ${words}`), t('Shared.')]);
      ann.editMessage(late, [forReaders(`LATE ${words}`, 'bob'), t('Shared.')]);
      assert.deepEqual(contentOf(ann, late), [forReaders(`LATE ${words}`, 'bob'), t('Shared.')]);
      assert.ok(!texts((await ann.compile(BUDGET)).messages).includes('LATE '), 'ann\'s compile no longer holds it');
    });
  });

  it('is refused while a request that may carry the message is out', async () => {
    let release: (() => void) | undefined;
    const membrane = {
      complete: async () => {
        if (!release) await new Promise<void>((resolve) => { release = resolve; });
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `[memory] ${'x '.repeat(40)}` }], usage: { input_tokens: 10, output_tokens: 25 } };
      },
    } as never;
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: memory(), membrane, viewReader: 'ann' });
    try {
      const ids = added(ann);
      await ann.compile(BUDGET);
      const ticking = ann.tick();
      for (let i = 0; i < 400 && !release; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(release, 'the premise: a summariser call is out');
      assert.equal(JSON.stringify(ann.getStore().getStateJson('agents/ann/autobio:summaries') ?? []), '[]', 'the premise: no summary has been written yet');
      assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
      release!();
      await ticking;
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused where another manager on the namespace has read the message for compression', async () => {
    let release: (() => void) | undefined;
    const blocking = {
      complete: async () => {
        if (!release) await new Promise<void>((resolve) => { release = resolve; });
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `[memory] ${'x '.repeat(40)}` }], usage: { input_tokens: 10, output_tokens: 25 } };
      },
    } as never;
    const dir = tmp();
    const first = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: memory(), membrane: summarizer().membrane, viewReader: 'ann' });
    const second = await ContextManager.open({ store: first.getStore(), namespace: 'agents/ann', strategy: memory(), membrane: blocking, viewReader: 'ann' });
    try {
      const ids = added(second);
      await second.compile(BUDGET);
      const ticking = second.tick();
      for (let i = 0; i < 400 && !release; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(release, 'the premise: the second manager\'s request is out');
      assert.throws(() => first.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
      assert.deepEqual(contentOf(first, ids[3]!), [both(`SECRET-3 ${words}`)]);
      release!();
      await ticking;
    } finally {
      await second.close();
      await first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused after a switch to a strategy that keeps no summaries, where compression read the message before', async () => {
    await withReaders(async ({ ann, annSummaries }) => {
      const ids = await summarized(ann, annSummaries);
      for (const strategy of [new PassthroughStrategy(), new WindowedPassthroughStrategy()]) {
        await ann.setStrategy(strategy);
        assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal, strategy.constructor.name);
      }
      assert.deepEqual(contentOf(ann, ids[3]!), [both(`SECRET-3 ${words}`)]);
    });
  });

  it('goes through under a strategy that keeps no summaries while compression has read nothing', async () => {
    await withReaders(async ({ ann }) => {
      const shared = ann.addMessage('user', [both('Both.')]);
      ann.editMessage(shared, [forReaders('Both.', 'bob')]);
      assert.deepEqual(contentOf(ann, shared), [forReaders('Both.', 'bob')]);
    }, () => new WindowedPassthroughStrategy());
  });

  it('is refused away from another reader, and by a manager compiling for no reader, whatever their summaries', async () => {
    await withReaders(async ({ ann, bob, nobody }) => {
      const pub = ann.addMessage('user', [t('Public.')]);
      assert.throws(() => ann.editMessage(pub, [forReaders('Public.', 'ann')]), /refused: the edit of message \S+ may hide a block from a reader other than "ann", the one this manager compiles for\. This manager can't see what that reader's compression has read/);
      const shared = ann.addMessage('user', [both('Both.')]);
      assert.throws(() => bob.editMessage(shared, [forReaders('Both.', 'bob')]), /may hide a block from a reader other than "bob"/);
      assert.throws(() => nobody.editMessage(shared, [forReaders('Both.', 'bob')]), /may hide a block from a reader other than this manager, which compiles for no reader/);
      assert.deepEqual(contentOf(ann, pub), [t('Public.')]);
      assert.deepEqual(contentOf(ann, shared), [both('Both.')]);
      ann.editMessage(shared, [forReaders('Both.', 'bob')]);
      assert.deepEqual(contentOf(ann, shared), [forReaders('Both.', 'bob')], 'away from its own reader, with nothing read, it goes through');
      nobody.editMessage(shared, [t('Both, for everyone.')]);
      assert.deepEqual(contentOf(ann, shared), [t('Both, for everyone.')], 'a manager with no reader may widen');
    }, () => new PassthroughStrategy());
  });

  it('is refused away from the reader where another namespace on the branch records the same reader', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      const shared = ann.addMessage('user', [both('Both.')]);
      const second = await ContextManager.open({ store: ann.getStore(), namespace: 'agents/ann-too', strategy: new PassthroughStrategy(), viewReader: 'ann' });
      try {
        assert.equal(second.viewReader, 'ann', 'the premise: a second namespace records the same reader');
        for (const manager of [ann, second]) {
          assert.throws(() => manager.editMessage(shared, [forReaders('Both.', 'bob')]), /may hide a block from "ann", the reader this manager compiles for, and another namespace on this branch records the same reader\. This manager can't see what that namespace's compression has read/);
        }
        assert.deepEqual(contentOf(ann, shared), [both('Both.')]);
      } finally {
        await second.close();
      }
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const refusedStart = /refused: the strategy doesn't declare marksCompressionReads, and a manager that compiles for a reader \("ann"\) runs only a strategy that records what compression reads before it reads/;

  it('refuses to start a strategy that doesn\'t say it records what compression reads, for a manager that compiles for a reader, before handing it anything', async () => {
    const touched: string[] = [];
    const undeclared = () => {
      const strategy = memory();
      const hooks = strategy as unknown as Record<string, unknown>;
      hooks.marksCompressionReads = undefined;
      for (const hook of ['initialize', 'onNewMessage', 'prepareFromRenderingFrontier', 'select']) {
        const own = hooks[hook] as ((...args: unknown[]) => unknown) | undefined;
        hooks[hook] = (...args: unknown[]) => {
          touched.push(hook);
          return own?.apply(strategy, args);
        };
      }
      return strategy;
    };
    const dir = tmp();
    const path = join(dir, 'store');
    await assert.rejects(ContextManager.open({ path, namespace: 'agents/ann', strategy: undeclared(), viewReader: 'ann' }), refusedStart, 'by open');
    const ann = await ContextManager.open({ path, namespace: 'agents/ann', strategy: memory(), viewReader: 'ann' });
    try {
      ann.addMessage('user', [both('Both.')]);
      await assert.rejects(ContextManager.open({ store: ann.getStore(), namespace: 'agents/ann', strategy: undeclared() }), refusedStart, 'by open with no viewReader, on a namespace that records one');
      await assert.rejects(ann.derive({ branch: 'derived', strategy: undeclared() }), refusedStart, 'by derive');
      const kid = await ann.derive({ branch: 'kid', strategy: memory() });
      const derivation = kid.getDerivation()!;
      await kid.close();
      await assert.rejects(ContextManager.reopenDerived({ store: ann.getStore(), derivation, strategy: undeclared() }), refusedStart, 'by reopenDerived');
      await assert.rejects(ann.setStrategy(undeclared()), refusedStart, 'by setStrategy');
      await ann.compile(BUDGET);
      ann.addMessage('user', [both('After.')]);
      assert.deepEqual(touched, [], 'no refused strategy was handed anything, and the manager went on with the strategy it had');
      const home = ann.getStore().currentBranch().name;
      const held = (ann as unknown as { strategy: { marksCompressionReads?: unknown } }).strategy;
      held.marksCompressionReads = undefined;
      await assert.rejects(ann.fork('elsewhere'), refusedStart, 'by fork, once the held strategy withdraws its declaration, a breach only this test makes');
      held.marksCompressionReads = true;
      await ann.setStrategy(held as never);
      held.marksCompressionReads = undefined;
      await assert.rejects(ann.switchBranch(home), refusedStart, 'by switch, the same way');
      const nobody = await ContextManager.open({ path: join(dir, 'other'), namespace: 'agents/nobody', strategy: undeclared() });
      await nobody.close();
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused when the record of what compression has read can\'t be read', async () => {
    await withReaders(async ({ ann }) => {
      const store = ann.getStore();
      store.registerState({ id: 'agents/ann/narrowing-floor', strategy: 'snapshot' });
      store.setStateJson('agents/ann/narrowing-floor', 'not a sequence');
      const shared = ann.addMessage('user', [both('Both.')]);
      assert.throws(() => ann.editMessage(shared, [forReaders('Both.', 'bob')]), /may hide a block from "ann", the reader this manager compiles for, and the record of what compression has read can't be read/);
      assert.deepEqual(contentOf(ann, shared), [both('Both.')]);
      ann.editMessage(shared, [both('Both, edited.')]);
      ann.editMessage(shared, [t('Both, for everyone.')]);
      assert.deepEqual(contentOf(ann, shared), [t('Both, for everyone.')], 'an edit that hides nothing, or widens, goes through');
    }, () => new PassthroughStrategy());
  });

  it('sends no request whose messages the record couldn\'t first cover, and later requests read the messages as they stand', async () => {
    const dir = tmp();
    const a = summarizer();
    const error = mock.method(console, 'error', () => {});
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: memory(), membrane: a.membrane, viewReader: 'ann' });
    const store = ann.getStore();
    const real = store.setStateJson.bind(store);
    let refused = 0;
    const write = mock.method(store, 'setStateJson', (id: string, value: unknown) => {
      if (id.endsWith('/narrowing-floor')) {
        refused++;
        throw new Error('the disk is full');
      }
      return real(id, value);
    });
    try {
      const ids = added(ann);
      await ann.compile(BUDGET);
      for (let i = 0; i < 20; i++) await ann.tick();
      assert.ok(refused > 0, 'the premise: closing its chunks tried to raise the record');
      assert.equal(a.payloads.length, 0, 'no request is sent while the record can\'t be raised');
      assert.equal(ann.isReady(), false, 'and its chunks wait, still pending');
      ann.editMessage(...toBob(ids[3]!, 'SECRET-3'));
      write.mock.restore();
      ann.addMessage('user', [both(`AFTER ${words}`)]);
      await drain(ann);
      assert.ok(a.payloads.length > 0, 'the premise: once it can be raised, requests are sent');
      assert.ok(!a.payloads.some((p) => p.includes('SECRET-3 ')), 'and none reads the block narrowed away from ann');
    } finally {
      write.mock.restore();
      error.mock.restore();
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused for a message in a chunk that closed in a rebuild that then failed', async () => {
    const error = mock.method(console, 'error', () => {});
    try {
      await withReaders(async ({ ann }) => {
        const store = ann.getStore();
        const real = store.appendToStateJson.bind(store);
        let appends = 0;
        const append = mock.method(store, 'appendToStateJson', (id: string, item: unknown) => {
          if (id === 'agents/ann/autobio:chunks' && ++appends === 2) throw new Error('the disk is full');
          return real(id, item);
        });
        try {
          const ids = [ann.addMessage('user', [t('Opening.'), both(`SECRET-0 ${words}`)], undefined, undefined, { holdCompression: true })];
          for (let i = 1; i < 60; i++) ids.push(ann.addMessage(i % 2 ? 'agent' : 'user', [both(`SECRET-${i} ${words}`)]));
          ann.releaseCompression([ids[0]!]);
          assert.ok(appends >= 2, 'the premise: the release rebuilt, and its second chunk record failed');
          assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
        } finally {
          append.mock.restore();
        }
      });
    } finally {
      error.mock.restore();
    }
  });

  const preRecordMerge = async (run: (m: { ann: ContextManager; ids: string[]; l1: string[]; payloads: string[] }) => Promise<void>) => {
    const dir = tmp();
    const path = join(dir, 'store');
    const knowledge = (recentWindowTokens: number) => new KnowledgeStrategy({
      compressionModel: 'test-compression-model',
      targetChunkTokens: 150,
      headWindowTokens: 0,
      recentWindowTokens,
      mergeThreshold: 1000,
    });
    const a = summarizer();
    let ann = await ContextManager.open({ path, namespace: 'agents/ann', strategy: knowledge(0), membrane: a.membrane, viewReader: 'ann' });
    try {
      const ids = await summarized(ann, a.payloads);
      const l1 = (ann as unknown as { strategy: { summaries: Array<{ id: string; level: number }> } }).strategy.summaries.filter((s) => s.level === 1).map((s) => s.id);
      assert.ok(l1.length >= 2, `the premise: several L1s (${l1.length})`);
      ann.getStore().setStateJson('agents/ann/narrowing-floor', -1);
      await ann.close();
      ann = await ContextManager.open({ path, namespace: 'agents/ann', strategy: knowledge(1_000_000), membrane: a.membrane, viewReader: 'ann' });
      assert.equal(ann.getStore().getStateJson('agents/ann/narrowing-floor'), -1, 'the premise: reopening closed no chunk over them');
      await run({ ann, ids, l1, payloads: a.payloads });
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const queueMerge = (ann: ContextManager, sourceIds: string[]) =>
    (ann as unknown as { strategy: { enqueueMerge(merge: { level: number; sourceIds: string[] }): void } }).strategy.enqueueMerge({ level: 2, sourceIds });

  it('is refused for a message a merge has read, where nothing else recorded it', async () => {
    await preRecordMerge(async ({ ann, ids, l1, payloads }) => {
      const before = payloads.length;
      queueMerge(ann, l1.slice(0, 2));
      for (let i = 0; i < 50 && payloads.length === before; i++) await ann.tick();
      assert.equal(payloads.length, before + 1, 'the premise: the merge was asked');
      assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
    });
  });

  it('counts nothing against a merge whose read can\'t first be recorded, and runs it once one can', async () => {
    const error = mock.method(console, 'error', () => {});
    try {
      await preRecordMerge(async ({ ann, ids, l1, payloads }) => {
        const store = ann.getStore();
        const real = store.setStateJson.bind(store);
        let refused = 0;
        const write = mock.method(store, 'setStateJson', (id: string, value: unknown) => {
          if (id.endsWith('/narrowing-floor')) {
            refused++;
            throw new Error('the disk is full');
          }
          return real(id, value);
        });
        const lane = (ann as unknown as { strategy: { mergeQueue: Array<{ sourceIds: string[]; attempts?: number }>; mergeFailureRuns: Map<string, unknown>; mergeQuarantine: Map<string, unknown> } }).strategy;
        const before = payloads.length;
        const logged = error.mock.calls.length;
        try {
          queueMerge(ann, l1.slice(0, 2));
          for (let i = 0; i < 5; i++) await ann.tick();
          assert.equal(refused, 1, 'the merge tried once to record what it reads, then waited rather than trying each tick');
          await ann.compile(BUDGET);
          for (let i = 0; i < 5; i++) await ann.tick();
          assert.equal(refused, 2, 'a rebuild tried the record again, and while it still failed the merge kept waiting');
        } finally {
          write.mock.restore();
        }
        const said = error.mock.calls.slice(logged).map((call) => call.arguments.map(String).join(' '));
        assert.equal(said.length, 1, `one diagnostic for the whole wait (${said.join(' | ')})`);
        assert.match(said[0]!, /compression waits: what the L2 merge from \S+ reads can't be recorded as read/, 'and it says the merge waits, not that a merge call failed');
        assert.equal(payloads.length, before, 'no merge was asked');
        assert.deepEqual(lane.mergeQueue.map((m) => [m.sourceIds, m.attempts]), [[l1.slice(0, 2), undefined]], 'the merge waits at the head of the queue, unchanged');
        assert.equal(lane.mergeFailureRuns.size, 0, 'no failure streak');
        assert.equal(lane.mergeQuarantine.size, 0, 'nothing quarantined');
        await ann.compile(BUDGET);
        for (let i = 0; i < 50 && payloads.length === before; i++) await ann.tick();
        assert.equal(payloads.length, before + 1, 'once a record succeeds, the merge is asked');
        assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
      });
    } finally {
      error.mock.restore();
    }
  });

  it('keeps its record of what compression has read when a later mark names an older message', async () => {
    class Lowering extends PassthroughStrategy {
      override async onNewMessage(_message: StoredMessage, ctx: StrategyContext): Promise<void> {
        ctx.markCompressionRead?.(0);
      }
    }
    await withReaders(async ({ ann, annSummaries }) => {
      const ids = await summarized(ann, annSummaries);
      const floor = () => ann.getStore().getStateJson('agents/ann/narrowing-floor') as unknown;
      const before = floor();
      assert.equal(typeof before, 'number', 'the premise: compression raised the record');
      await ann.setStrategy(new Lowering());
      ann.addMessage('user', [t('Later.')]);
      assert.equal(floor(), before, 'the record stays where it was');
      assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
    });
  });

  it('is refused once a chunk holding the message has closed as its strategy starts, over messages another manager added', async () => {
    const dir = tmp();
    const path = join(dir, 'store');
    let ids: string[] = [];
    const writer = await ContextManager.open({ path, namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      ids = added(writer);
    } finally {
      await writer.close();
    }
    const ann = await ContextManager.open({ path, namespace: 'agents/ann', strategy: memory(), membrane: summarizer().membrane, viewReader: 'ann' });
    try {
      assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused once a chunk holding the message has closed in a compile, over messages another manager added', async () => {
    const dir = tmp();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: memory(), membrane: summarizer().membrane, viewReader: 'ann' });
    const writer = await ContextManager.open({ store: ann.getStore(), namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      const ids = added(writer);
      assert.equal(ann.getStore().getStateJson('agents/ann/narrowing-floor'), null, 'the premise: nothing has raised the record yet');
      await ann.compile(BUDGET);
      assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
    } finally {
      await writer.close();
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused once a chunk holding the message has closed as a compression hold is released', async () => {
    await withReaders(async ({ ann }) => {
      const ids = [ann.addMessage('user', [t('Opening.'), both(`SECRET-0 ${words}`)], undefined, undefined, { holdCompression: true })];
      for (let i = 1; i < 60; i++) ids.push(ann.addMessage(i % 2 ? 'agent' : 'user', [both(`SECRET-${i} ${words}`)]));
      assert.equal(ann.getStore().getStateJson('agents/ann/narrowing-floor'), null, 'the premise: while the hold stands, no chunk has closed');
      ann.releaseCompression([ids[0]!]);
      assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
    });
  });

  it('is refused for a message in a closed chunk held back from compression, and for a head message older than a closed chunk', async () => {
    const holding = () => new AutobiographicalStrategy({
      compressionModel: 'test-compression-model',
      targetChunkTokens: 300,
      headWindowTokens: 40,
      recentWindowTokens: 0,
      hierarchical: true,
      l1HoldbackChunks: 1,
    });
    await withReaders(async ({ ann }) => {
      const ids = added(ann);
      const lane = (ann as unknown as { strategy: { chunks: Array<{ index: number; compressed: boolean; messages: StoredMessage[] }>; compressionQueue: number[] } }).strategy;
      const heldBack = lane.chunks.filter((chunk) => !chunk.compressed && !lane.compressionQueue.includes(chunk.index));
      assert.ok(heldBack.length > 0, 'the premise: a closed chunk is held back');
      assert.ok(!lane.chunks.some((chunk) => chunk.messages.some((m) => m.id === ids[0])), 'the premise: the first message is in the head, in no chunk');
      assert.throws(() => ann.editMessage(...toBob(heldBack.at(-1)!.messages.at(-1)!.id, 'HELD')), ownRefusal, 'a message in the held-back chunk');
      assert.throws(() => ann.editMessage(ids[0]!, [t('Opening.'), forReaders(`SECRET-0 ${words}`, 'bob')]), ownRefusal, 'a head message');
    }, holding);
  });

  it('makes no transition request when what it reads can\'t first be recorded', async () => {
    let calls = 0;
    const membrane = {
      complete: async () => {
        calls++;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'A transition.' }], usage: { input_tokens: 10, output_tokens: 10 } };
      },
    } as never;
    const dir = tmp();
    const error = mock.method(console, 'error', () => {});
    const headed = new AutobiographicalStrategy({ compressionModel: 'test-compression-model', targetChunkTokens: 300, headWindowTokens: 2000, recentWindowTokens: 0, hierarchical: true });
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: headed, membrane, viewReader: 'ann' });
    const store = ann.getStore();
    const real = store.setStateJson.bind(store);
    let refused = 0;
    const write = mock.method(store, 'setStateJson', (id: string, value: unknown) => {
      if (id.endsWith('/narrowing-floor')) {
        refused++;
        throw new Error('the disk is full');
      }
      return real(id, value);
    });
    try {
      ann.addMessage('user', [both(`HEAD ${words}`)]);
      await assert.rejects(ann.resetHeadWindow(), /the disk is full/);
      assert.ok(refused > 0, 'the premise: the transition tried to record what it reads');
      assert.equal(calls, 0, 'and asked its model nothing');
    } finally {
      write.mock.restore();
      error.mock.restore();
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused away from the reader where another namespace\'s reader record can\'t be read', async () => {
    await withReaders(async ({ ann }) => {
      const store = ann.getStore();
      store.registerState({ id: 'agents/other/reader', strategy: 'snapshot' });
      store.setState('agents/other/reader', Buffer.from('{'));
      const shared = ann.addMessage('user', [both('Both.')]);
      assert.throws(() => ann.editMessage(shared, [forReaders('Both.', 'bob')]), /another namespace on this branch records the same reader/);
      assert.deepEqual(contentOf(ann, shared), [both('Both.')]);
    }, () => new PassthroughStrategy());
  });

  it('writes no record of what compression has read for a manager that compiles for no reader', async () => {
    const dir = tmp();
    const a = summarizer();
    const nobody = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/nobody', strategy: memory(), membrane: a.membrane });
    try {
      for (let i = 0; i < 60; i++) nobody.addMessage(i % 2 ? 'agent' : 'user', [t(`message ${i} ${words}`)]);
      await nobody.compile(BUDGET);
      await drain(nobody);
      assert.ok(a.payloads.length > 0, 'the premise: it compressed');
      assert.deepEqual(nobody.getStore().listStates().map((state) => state.id).filter((id) => id.endsWith('/narrowing-floor')), []);
    } finally {
      await nobody.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused after a request that wrote no summary, after a reopen too', async () => {
    const dir = tmp();
    const path = join(dir, 'store');
    let calls = 0;
    const failing = { complete: async () => { calls++; throw new Error('the provider is down'); } } as never;
    let ids: string[] = [];
    const first = await ContextManager.open({ path, namespace: 'agents/ann', strategy: memory(), membrane: failing, viewReader: 'ann' });
    try {
      ids = added(first);
      await first.compile(BUDGET);
      for (let i = 0; i < 20 && calls === 0; i++) await first.tick().catch(() => {});
      assert.ok(calls > 0, 'the premise: the strategy called its provider');
      assert.equal(JSON.stringify(first.getStore().getStateJson('agents/ann/autobio:summaries') ?? []), '[]', 'the premise: no summary was written');
      assert.throws(() => first.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal);
    } finally {
      await first.close();
    }
    const ann = await ContextManager.open({ path, namespace: 'agents/ann', strategy: new PassthroughStrategy(), viewReader: 'ann' });
    try {
      assert.throws(() => ann.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal, 'reopened, it is still refused');
      const late = ann.addMessage('user', [both(`LATE ${words}`)]);
      ann.editMessage(...toBob(late, 'LATE'));
      assert.deepEqual(contentOf(ann, late), [forReaders(`LATE ${words}`, 'bob')], 'a message newer than anything compression read may be narrowed');
    } finally {
      await ann.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused on a branch forked after compression read the message, and decided on each branch by its own compression', async () => {
    const dir = tmp();
    const a = summarizer();
    const ann = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/ann', strategy: memory(), membrane: a.membrane, viewReader: 'ann' });
    try {
      const home = ann.getStore().currentBranch().name;
      const early = ann.addMessage('user', [both(`EARLY ${words}`)]);
      await ann.fork('before');
      await ann.switchBranch(home);
      const ids = await summarized(ann, a.payloads);
      await ann.fork('after');
      for (const id of [early, ids[3]!]) assert.throws(() => ann.editMessage(...toBob(id, 'EARLY')), ownRefusal, 'on a branch forked after compression read it');
      const child = await ann.derive({ branch: 'derived', strategy: new PassthroughStrategy() });
      try {
        assert.throws(() => child.editMessage(...toBob(ids[3]!, 'SECRET-3')), ownRefusal, 'and on a context derived from it');
      } finally {
        await child.close();
      }
      await ann.switchBranch('before');
      ann.editMessage(...toBob(early, 'EARLY'));
      assert.deepEqual(contentOf(ann, early), [forReaders(`EARLY ${words}`, 'bob')], 'on a branch whose compression read nothing, it goes through');
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

  it('records a namespace\'s reader and refuses another, while an open with no reader compiles for the namespace\'s', async () => {
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
        assert.equal(texts((await inspector.compile(BUDGET)).messages), '[for ann]\nHi.', 'an open with no reader compiles for the namespace\'s');
        assert.equal(inspector.viewReader, 'ann');
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

  it('compiles and compresses for the namespace\'s reader when opened with no reader, so it neither reads her material as no one nor thins her memory', async () => {
    const markers = () => {
      const seen: string[] = [];
      const calls: number[] = [];
      return {
        seen,
        calls,
        membrane: {
          complete: async (request: { messages: ApiMessage[] }) => {
            calls.push(1);
            const input = request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
            const found = input.match(/ANN-ONLY-\d+/g) ?? [];
            seen.push(...found);
            return { stopReason: 'end_turn', content: [{ type: 'text', text: `SUMMARY ${found.join(' ')} ${'x '.repeat(40)}` }], usage: { input_tokens: Math.ceil(input.length / 4), output_tokens: 25 } };
          },
        } as never,
      };
    };
    const dir = tmp();
    const host = await ContextManager.open({ path: join(dir, 'store'), namespace: 'host', strategy: new PassthroughStrategy() });
    try {
      const store = host.getStore();
      const ann = await ContextManager.open({ store, namespace: 'agents/ann', strategy: memory(), membrane: markers().membrane, viewReader: 'ann' });
      for (let i = 0; i < 60; i++) {
        const words = t(`Message ${i}. ${'filler words '.repeat(20)}`);
        ann.addMessage('user', i % 3 === 0 ? [forReaders(`ANN-ONLY-${i / 3}`, 'ann'), words] : [words]);
      }
      await ann.close();
      const blind = markers();
      const inspector = await ContextManager.open({ store, namespace: 'agents/ann', strategy: memory(), membrane: blind.membrane });
      await drain(inspector);
      const inspected = texts((await inspector.compile(BUDGET)).messages);
      await inspector.close();
      assert.ok(blind.calls.length > 0, 'the premise: the manager opened with no reader compressed');
      const again = await ContextManager.open({ store, namespace: 'agents/ann', strategy: memory(), membrane: markers().membrane, viewReader: 'ann' });
      try {
        const compiled = texts((await again.compile(BUDGET)).messages);
        const lost = Array.from({ length: 20 }, (_, n) => `ANN-ONLY-${n}`).filter((marker) => !new RegExp(`\\b${marker}\\b`).test(compiled));
        assert.deepEqual(lost, [], 'every block of hers is in her compile, raw or in a summary');
        assert.equal(inspected, compiled, 'and the manager opened with no reader compiled what she compiles');
        assert.equal(inspector.viewReader, 'ann');
      } finally {
        await again.close();
      }
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a manager that compiles for no reader a switch, fork or setStrategy where its namespace records one', async () => {
    const dir = tmp();
    const nobody = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/x', strategy: new PassthroughStrategy() });
    try {
      const store = nobody.getStore();
      nobody.addMessage('user', [forReaders('[for ann]', 'ann'), t('Hi.')]);
      const home = store.currentBranch().name;
      store.createBranchAt('claimed', home, store.currentSequence());
      store.switchBranch('claimed');
      const ann = await ContextManager.open({ store, namespace: 'agents/x', strategy: new PassthroughStrategy(), viewReader: 'ann' });
      await ann.close();
      store.switchBranch(home);
      assert.equal(nobody.viewReader, undefined, 'the premise: it was opened where nothing is recorded');
      await assert.rejects(nobody.switchBranch('claimed'), /ContextManager\.switchBranch: namespace "agents\/x" compiles for reader "ann", and this manager compiles for none/);
      assert.equal(store.currentBranch().name, home, 'and it stays on the branch it was on');
      assert.equal(texts((await nobody.compile(BUDGET)).messages), 'Hi.');
      const early = await ContextManager.open({ store, namespace: 'agents/y', strategy: new PassthroughStrategy() });
      const claimer = await ContextManager.open({ store, namespace: 'agents/y', strategy: new PassthroughStrategy(), viewReader: 'ann' });
      await claimer.close();
      const branches = early.listBranches().map((b) => b.name);
      await assert.rejects(early.fork('rejected'), /ContextManager\.fork: namespace "agents\/y" compiles for reader "ann", and this manager compiles for none/, 'opened before the claim, its fork is refused');
      assert.deepEqual(early.listBranches().map((b) => b.name), branches, 'before it writes a branch');
      await assert.rejects(early.setStrategy(new PassthroughStrategy()), /ContextManager\.setStrategy: namespace "agents\/y" compiles for reader "ann", and this manager compiles for none/);
      await early.close();
    } finally {
      await nobody.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a compile, preview, tick or edit once the namespace records a reader the manager doesn\'t compile for', async () => {
    const dir = tmp();
    const host = await ContextManager.open({ path: join(dir, 'store'), namespace: 'host', strategy: new PassthroughStrategy() });
    try {
      const store = host.getStore();
      const home = store.currentBranch().name;
      const nobody = await ContextManager.open({ store, namespace: 'agents/s', strategy: new PassthroughStrategy() });
      const hi = nobody.addMessage('user', [forReaders('[for ann]', 'ann'), t('Hi.')]);
      assert.equal(texts((await nobody.compile(BUDGET)).messages), 'Hi.', 'the premise: it compiles for none before the claim');
      const ann = await ContextManager.open({ store, namespace: 'agents/s', strategy: new PassthroughStrategy(), viewReader: 'ann' });
      await ann.close();
      const stale = /namespace "agents\/s" compiles for reader "ann", and this manager compiles for none/;
      await assert.rejects(nobody.compile(BUDGET), stale, 'a manager opened with no reader before the claim compiles no more');
      assert.throws(() => nobody.previewContext(BUDGET), stale);
      await assert.rejects(nobody.tick(), stale);
      assert.throws(() => nobody.editMessage(hi, [forReaders('[for ann]', 'ann'), t('Hi, edited.')]), /ContextManager\.editMessage: namespace "agents\/s" compiles for reader "ann", and this manager compiles for none/);
      assert.deepEqual(host.getAllMessages().find((m) => m.id === hi)!.content, [forReaders('[for ann]', 'ann'), t('Hi.')], 'and the edit wrote nothing');
      await nobody.close();
      store.createBranchAt('bobs', home, store.currentSequence());
      const annT = await ContextManager.open({ store, namespace: 'agents/t', strategy: new PassthroughStrategy(), viewReader: 'ann' });
      store.switchBranch('bobs');
      const bob = await ContextManager.open({ store, namespace: 'agents/t', strategy: new PassthroughStrategy(), viewReader: 'bob' });
      await bob.close();
      await assert.rejects(annT.compile(BUDGET), /ContextManager\.compile: namespace "agents\/t" compiles for reader "bob", not "ann"/, 'nor on a branch another handle switched to, where another reader is recorded');
      await assert.rejects(annT.tick(), /ContextManager\.tick: namespace "agents\/t" compiles for reader "bob", not "ann"/);
      assert.throws(() => annT.previewContext(BUDGET), /ContextManager\.previewContext: namespace "agents\/t" compiles for reader "bob", not "ann"/);
      store.switchBranch(home);
      await assert.doesNotReject(annT.compile(BUDGET), 'and back on its own branch it compiles');
      await annT.close();
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a compile before a host strategy\'s select runs, once the namespace records a reader the manager doesn\'t compile for', async () => {
    let selects = 0;
    class Counting extends PassthroughStrategy {
      override select(...args: Parameters<PassthroughStrategy['select']>): ReturnType<PassthroughStrategy['select']> {
        selects++;
        return super.select(...args);
      }
    }
    const dir = tmp();
    const nobody = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/h', strategy: new Counting() });
    try {
      nobody.addMessage('user', [t('Hi.')]);
      await nobody.compile(BUDGET);
      assert.equal(selects, 1, 'the premise: a compile runs its select');
      const ann = await ContextManager.open({ store: nobody.getStore(), namespace: 'agents/h', strategy: new PassthroughStrategy(), viewReader: 'ann' });
      await ann.close();
      await assert.rejects(nobody.compile(BUDGET), /ContextManager\.compile: namespace "agents\/h" compiles for reader "ann", and this manager compiles for none/);
      assert.equal(selects, 1, 'its select never ran');
    } finally {
      await nobody.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses every read through a view its strategy holds, once the namespace records a reader the manager doesn\'t compile for', async () => {
    let held: MessageStoreView | undefined;
    class Holding extends PassthroughStrategy {
      override select(...args: Parameters<PassthroughStrategy['select']>): ReturnType<PassthroughStrategy['select']> {
        held = args[0];
        return super.select(...args);
      }
    }
    const dir = tmp();
    const nobody = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/h', strategy: new Holding() });
    try {
      const hi = nobody.addMessage('user', [t('Hi.')]);
      await nobody.compile(BUDGET);
      const view = held as MessageStoreView | undefined;
      assert.ok(view, 'the premise: its compile handed the strategy a view');
      assert.equal(typeof view.sequenceOf, 'function', 'the premise: the view answers sequenceOf');
      const reads: Array<[string, () => unknown]> = [
        ['getAll', () => view.getAll()],
        ['get', () => view.get(hi)],
        ['sequenceOf', () => view.sequenceOf!(hi)],
        ['getFrom', () => view.getFrom(0)],
        ['getTail', () => view.getTail(1)],
        ['length', () => view.length()],
      ];
      for (const [name, read] of reads) assert.doesNotThrow(read, `the premise: ${name} answers before the claim`);
      const ann = await ContextManager.open({ store: nobody.getStore(), namespace: 'agents/h', strategy: new PassthroughStrategy(), viewReader: 'ann' });
      await ann.close();
      for (const [name, read] of reads) {
        assert.throws(read, /ContextManager's reader view: namespace "agents\/h" compiles for reader "ann", and this manager compiles for none/, `${name} through the held view is refused`);
      }
    } finally {
      await nobody.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summarises nothing more of a namespace another manager claimed, through a drain that began before the claim', async () => {
    const dir = tmp();
    let release: (() => void) | undefined;
    const asked: string[] = [];
    const membrane = {
      complete: async (request: { messages: ApiMessage[] }) => {
        asked.push(texts(request.messages));
        if (!release) await new Promise<void>((resolve) => { release = resolve; });
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `[memory] ${'x '.repeat(40)}` }], usage: { input_tokens: 10, output_tokens: 25 } };
      },
    } as never;
    const logged: string[] = [];
    const error = mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')); });
    const host = await ContextManager.open({ path: join(dir, 'store'), namespace: 'host', strategy: new PassthroughStrategy() });
    try {
      const store = host.getStore();
      const strategy = new AutobiographicalStrategy({ compressionModel: 'test-compression-model', targetChunkTokens: 300, headWindowTokens: 0, recentWindowTokens: 0, hierarchical: true, autoTickOnNewMessage: true });
      const nobody = await ContextManager.open({ store, namespace: 'agents/s', strategy, membrane });
      const words = 'words of the conversation '.repeat(12);
      for (let i = 0; i < 24; i++) nobody.addMessage(i % 2 ? 'Claude' : 'user', [forReaders(`ANN-ONLY-${i}`, 'ann'), t(`message ${i} ${words}`)]);
      for (let i = 0; i < 400 && !release; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(release, 'the premise: its drain began before the claim, and its first request is out');
      const ann = await ContextManager.open({ store, namespace: 'agents/s', strategy: memory(), viewReader: 'ann' });
      await ann.close();
      release!();
      const refused = () => logged.some((line) => line.includes('namespace "agents/s" compiles for reader "ann", and this manager compiles for none'));
      for (let i = 0; i < 400 && asked.length === 1 && !refused(); i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(asked.length, 1, `after the claim its drain asks its model nothing more (asked ${asked.length} times)`);
      assert.ok(refused(), `its reads are refused, and the refusal is logged (logged: ${JSON.stringify(logged.slice(0, 3))})`);
      await nobody.close();
    } finally {
      error.mock.restore();
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the claim a switch or a fork wrote when the strategy then fails to start there', async () => {
    const dir = tmp();
    const host = await ContextManager.open({ path: join(dir, 'store'), namespace: 'host', strategy: new PassthroughStrategy() });
    try {
      const store = host.getStore();
      const home = store.currentBranch().name;
      store.createBranchAt('unclaimed', home, store.currentSequence());
      const flaky = () => {
        const strategy = new PassthroughStrategy();
        let fail = false;
        const initialize = (strategy as { initialize?: (ctx: never) => Promise<void> }).initialize?.bind(strategy);
        return Object.assign(strategy, { failNext: () => { fail = true; }, initialize: async (ctx: never) => { if (fail) throw new Error('the strategy failed to start'); return initialize?.(ctx); } });
      };
      const switching = flaky();
      const erin = await ContextManager.open({ store, namespace: 'agents/z', strategy: switching, viewReader: 'erin' });
      switching.failNext();
      await assert.rejects(erin.switchBranch('unclaimed'), /the strategy failed to start/);
      await assert.rejects(
        ContextManager.open({ store, namespace: 'agents/z', strategy: new PassthroughStrategy(), viewReader: 'dan' }),
        /namespace "agents\/z" compiles for reader "erin", not "dan"/,
        'a failed switch keeps its claim on the branch it switched to',
      );
      await erin.close();
      store.switchBranch(home);
      const forking = flaky();
      const fay = await ContextManager.open({ store, namespace: 'agents/w', strategy: forking, viewReader: 'fay' });
      store.setStateJson('agents/w/reader', null);
      forking.failNext();
      await assert.rejects(fay.fork('forked'), /the strategy failed to start/);
      assert.equal(store.currentBranch().name, 'forked', 'the premise: the fork is the branch now selected');
      await assert.rejects(
        ContextManager.open({ store, namespace: 'agents/w', strategy: new PassthroughStrategy(), viewReader: 'dan' }),
        /namespace "agents\/w" compiles for reader "fay", not "dan"/,
        'a failed fork keeps the claim it wrote on the branch it made',
      );
      await fay.close();
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an audience at write wherever a write may not put one: a tool call or result, a system change, a block inside another', async () => {
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
