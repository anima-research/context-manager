import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy, MessageStore } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StoredMessage, StrategyContext, SummaryEntry } from '../src/types/index.js';

const BASE = './test-compression-recall-curve';
const MODEL = 'same-model';
let sequence = 0;
const paths: string[] = [];

function freshPath(): string {
  const path = `${BASE}-${sequence++}`;
  paths.push(path);
  return path;
}

function cleanup(): void {
  for (const path of paths) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}

interface RecordedCall {
  request: NormalizedRequest;
}

function response(stopReason: 'refusal' | 'end_turn' | 'max_tokens', text = '') {
  return {
    content: text ? [{ type: 'text', text }] : [],
    stopReason,
    usage: { inputTokens: 100, outputTokens: text ? 20 : 0 },
    raw: {
      response: {
        stop_details: stopReason === 'refusal'
          ? { category: 'reasoning_extraction' }
          : null,
      },
    },
  };
}

function scriptedMembrane(stops: Array<'refusal' | 'end_turn' | 'max_tokens'>) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        const index = calls.length;
        calls.push({
          request: structuredClone(request),
        });
        const stop = stops[index] ?? stops[stops.length - 1] ?? 'refusal';
        return response(stop, stop === 'end_turn' ? `successful memory from attempt ${index}` : '');
      },
    } as never,
  };
}

type AttemptHandler =
  | {
      stop: 'refusal' | 'end_turn' | 'max_tokens';
      text?: string;
      inputTokens?: number;
      omitUsage?: boolean;
    }
  | { raw: unknown }
  | { error: Error & { type?: string } };

function flexibleMembrane(handlers: AttemptHandler[]) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        const handler = handlers[calls.length] ?? handlers[handlers.length - 1]!;
        calls.push({ request: structuredClone(request) });
        if ('error' in handler) throw handler.error;
        if ('raw' in handler) return handler.raw;
        const result = response(handler.stop, handler.text ?? '');
        if (handler.inputTokens !== undefined) result.usage.inputTokens = handler.inputTokens;
        if (handler.omitUsage) delete (result as { usage?: unknown }).usage;
        return result;
      },
    } as never,
  };
}

function quarantineEvents(manager: ContextManager): Array<Record<string, unknown>> {
  return quarantineEventsFor(manager, 'default');
}

function quarantineEventsFor(
  manager: ContextManager,
  namespace: string,
): Array<Record<string, unknown>> {
  const value = manager.getStore().getStateJson(
    `${namespace}/autobio:compression-refusal-quarantine-events`,
  );
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void {
    this.pushSummary(entry);
  }

  linkChild(child: SummaryEntry, parentId: string): void {
    this.setMergedInto(child, parentId);
  }

  summariesView(): SummaryEntry[] {
    return [...this.summaries];
  }

  flushSummaries(): void {
    this.store?.setStateJson(this.summariesStateId, this.summaries);
  }

  dropSummaryForStress(id: string): void {
    this.summaries = this.summaries.filter((entry) => entry.id !== id);
    const stored = this.store?.getStateJson(this.summariesStateId);
    if (!this.store || !Array.isArray(stored)) return;
    const index = (stored as SummaryEntry[]).findIndex((entry) => entry?.id === id);
    if (index >= 0) this.store.redactStateItems(this.summariesStateId, index, index + 1);
  }

  setSummaryCounterForStress(value: number): void {
    this.summaryIdCounter = value;
    this.store?.setStateJson(this.counterStateId, value);
  }

  setCompressionModel(model: string): void {
    this.config.compressionModel = model;
  }

  chunksView(): Chunk[] {
    return [...this.chunks];
  }

  queueOnly(chunkIndex: number): void {
    for (const chunk of this.chunks) chunk.compressed = chunk.index !== chunkIndex;
    this.compressionQueue = [chunkIndex];
    this.mergeQueue = [];
  }

  mergeQueueView(): Array<{ level: number; sourceIds: string[] }> {
    return this.mergeQueue.map((item) => ({ level: item.level, sourceIds: [...item.sourceIds] }));
  }

  pinsView(): ReadonlyArray<import('../src/types/index.js').ProtectedRange> {
    return this.pins;
  }

  enqueueMergeForStress(level: number, sourceIds: string[]): void {
    this.enqueueMerge({ level, sourceIds });
  }

  appendChunkRecordForStress(record: import('../src/strategies/autobiographical.js').ChunkRecord): void {
    this.appendChunkRecord(record);
  }

  quarantineKeysView(): string[] {
    const projection = (this as unknown as {
      compressionRefusalQuarantine: Map<string, unknown>;
    }).compressionRefusalQuarantine;
    return [...projection.keys()].sort();
  }

  run(chunk: Chunk, ctx: StrategyContext): Promise<void> {
    return this.compressChunkHierarchical(chunk, ctx);
  }
}

function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

function text(text: string): ContentBlock {
  return { type: 'text', text };
}

function carrierBlocks(tag: string, text: string): ContentBlock[] {
  return [
    { type: 'thinking', thinking: `private-${tag}`, signature: `sig-${tag}` } as ContentBlock,
    { type: 'redacted_thinking', data: `enc-${tag}` } as ContentBlock,
    { type: 'text', text },
  ];
}

function summary(
  id: string,
  level: number,
  sourceIds: string[],
  first: string,
  last: string,
  tokens = 20,
  content = `authored ${id}`,
): SummaryEntry {
  return {
    id,
    level,
    content,
    tokens,
    sourceLevel: level - 1,
    sourceIds,
    sourceRange: { first, last },
    created: Number(id.replace(/\D/g, '')) || 1,
  };
}

interface Fixture {
  manager: ContextManager;
  strategy: ProbeStrategy;
  ids: string[];
  target: Chunk;
  parents: [SummaryEntry, SummaryEntry];
  children: SummaryEntry[];
}

async function fixture(
  membrane: unknown,
  options: ConstructorParameters<typeof ProbeStrategy>[0] = {},
  path = freshPath(),
): Promise<Fixture> {
  const strategy = new ProbeStrategy({
    compressionModel: MODEL,
    targetChunkTokens: 100,
    recentWindowTokens: 0,
    headWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    mergeThreshold: 99,
    compressionRefusalCurveFallbacks: 3,
    ...options,
  });
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  const ids: string[] = [];
  for (let i = 0; i < 14; i++) {
    ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [
      text(`raw-${i} ` + 'substantive '.repeat(18)),
    ]));
  }

  const children = [
    summary('L1-100', 1, [ids[0]!, ids[1]!], ids[0]!, ids[1]!),
    summary('L1-101', 1, [ids[2]!, ids[3]!], ids[2]!, ids[3]!),
    summary('L1-102', 1, [ids[4]!, ids[5]!], ids[4]!, ids[5]!),
    summary('L1-103', 1, [ids[6]!, ids[7]!], ids[6]!, ids[7]!),
  ];
  for (const child of children) strategy.seed(child);

  // Deliberately reverse direct sourceIds. Expansion must still render the
  // authored children by raw source range while proving the same leaf set.
  const older = summary(
    'L2-200',
    2,
    [children[1]!.id, children[0]!.id],
    ids[0]!,
    ids[3]!,
  );
  const newer = summary(
    'L2-201',
    2,
    [children[3]!.id, children[2]!.id],
    ids[4]!,
    ids[7]!,
  );
  strategy.seed(older);
  strategy.seed(newer);
  for (const child of children.slice(0, 2)) strategy.linkChild(child, older.id);
  for (const child of children.slice(2)) strategy.linkChild(child, newer.id);

  const messages = managerContext(manager).messageStore.getAll();
  const targetMessages = messages.filter((message) => ids.slice(10, 12).includes(message.id));
  const target: Chunk = {
    index: 999,
    startIndex: 10,
    endIndex: 12,
    messages: targetMessages,
    tokens: 100,
    compressed: false,
  };
  return { manager, strategy, ids, target, parents: [older, newer], children };
}

function recallIds(request: NormalizedRequest): string[] {
  return request.messages.flatMap((message) => message.content.flatMap((block) => {
    if (block.type !== 'text') return [];
    const match = /^\[CM\] Recall memory (.+)\.$/.exec(block.text);
    return match ? [match[1]!] : [];
  }));
}

function seedEquivalentRecallTree(strategy: ProbeStrategy, fx: Fixture): void {
  const children = fx.children.map((entry) => {
    const copy = structuredClone(entry);
    delete copy.mergedInto;
    strategy.seed(copy);
    return copy;
  });
  const parents = fx.parents.map((entry) => {
    const copy = structuredClone(entry);
    delete copy.mergedInto;
    strategy.seed(copy);
    return copy;
  });
  for (const child of children.slice(0, 2)) strategy.linkChild(child, parents[0]!.id);
  for (const child of children.slice(2)) strategy.linkChild(child, parents[1]!.id);
}

function removeRecallPairs(request: NormalizedRequest, ids: Set<string>): NormalizedRequest['messages'] {
  const messages = request.messages;
  const kept: NormalizedRequest['messages'] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const block = message.content.length === 1 ? message.content[0] : undefined;
    const match = block?.type === 'text'
      ? /^\[CM\] Recall memory (.+)\.$/.exec(block.text)
      : null;
    if (match && ids.has(match[1]!)) {
      i++;
      continue;
    }
    kept.push(message);
  }
  return kept;
}

describe('compression refusal recall curves', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('canonical success stores once and makes no fallback call', async () => {
    const mock = scriptedMembrane(['end_turn']);
    const fx = await fixture(mock.membrane);
    await fx.strategy.run(fx.target, managerContext(fx.manager));

    assert.equal(mock.calls.length, 1);
    const golden = JSON.parse(readFileSync(
      'test/fixtures/compression-canonical-request.json', 'utf8',
    )) as NormalizedRequest;
    golden.tools = undefined;
    assert.deepEqual(mock.calls[0]!.request, golden, 'pre-change canonical request remains byte-shaped');
    assert.deepEqual(recallIds(mock.calls[0]!.request), ['L2-200', 'L2-201']);
    assert.equal(fx.strategy.summariesView().filter((entry) => entry.level === 1).length, 5);
    assert.equal(fx.target.compressed, true);
    assert.equal(quarantineEvents(fx.manager).length, 0, 'normal success appends no quarantine events');
    fx.manager.close();
  });

  it('canonical tool_use gets ONE no-tools retry before the curve plan burns (lena 2026-08-06)', async () => {
    // Curve variants vary the recall frontier, not the response mode — a
    // think-first model fails every variant identically. The retry must be
    // the canonical request plus exactly one sentence.
    const mock = flexibleMembrane([
      {
        raw: {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'think', input: { content: 'draft…' } }],
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      },
      { stop: 'end_turn', text: 'a memory written as prose after the no-tools retry' },
    ]);
    const fx = await fixture(mock.membrane);
    await fx.strategy.run(fx.target, managerContext(fx.manager));

    assert.equal(mock.calls.length, 2, 'one retry, zero curve-fallback calls');
    assert.ok(
      !JSON.stringify(mock.calls[0]!.request).includes('do not call any tools'),
      'first attempt stays byte-identical to the canonical prompt',
    );
    const retry = mock.calls[1]!.request;
    const lastMessage = retry.messages[retry.messages.length - 1]!;
    const lastText = lastMessage.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    assert.ok(
      lastText.includes('do not call any tools for this'),
      'retry carries the no-tools line on the final instruction message',
    );
    assert.equal(fx.target.compressed, true, 'retry output persists as the L1');
    assert.equal(quarantineEvents(fx.manager).length, 0, 'a healed tool_use leaves no quarantine debt');
    fx.manager.close();
  });

  it('two thousand canonical successes append zero quarantine events', async () => {
    let calls = 0;
    const membrane = {
      complete: async () => {
        calls++;
        return response('end_turn', `stress memory ${calls}`);
      },
    } as never;
    const fx = await fixture(membrane);
    fx.strategy.setSummaryCounterForStress(1_000);
    const targetKey = fx.target.messages.map((message) => message.id).join(':');
    for (let i = 0; i < 2_000; i++) {
      await fx.strategy.run({ ...fx.target, compressed: false }, managerContext(fx.manager));
      const produced = fx.strategy.summariesView().find((entry) =>
        entry.level === 1 && entry.sourceIds.join(':') === targetKey,
      );
      assert.ok(produced);
      fx.strategy.dropSummaryForStress(produced.id);
    }
    assert.equal(calls, 2_000);
    assert.equal(quarantineEvents(fx.manager).length, 0);
    fx.manager.close();
  });

  it('canonical refusal expands newest parent first and stores first successful output', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    await fx.strategy.run(fx.target, managerContext(fx.manager));

    assert.equal(mock.calls.length, 2);
    assert.deepEqual(recallIds(mock.calls[0]!.request), ['L2-200', 'L2-201']);
    assert.deepEqual(
      recallIds(mock.calls[1]!.request),
      ['L2-200', 'L1-102', 'L1-103'],
      'newer L2 is expanded first and children follow source chronology',
    );
    const produced = fx.strategy.summariesView().filter(
      (entry) => entry.level === 1 && entry.sourceIds.join(':') === fx.target.messages.map((m) => m.id).join(':'),
    );
    assert.equal(produced.length, 1);
    assert.equal(produced[0]!.content, 'successful memory from attempt 1');
    fx.manager.close();
  });

  it('builds the expected variant from the frozen canonical fixture by one exact pair replacement', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    await fx.strategy.run(fx.target, managerContext(fx.manager));

    const frozen = JSON.parse(readFileSync(
      'test/fixtures/compression-canonical-request.json', 'utf8',
    )) as NormalizedRequest;
    frozen.tools = undefined;
    assert.deepEqual(mock.calls[0]!.request, frozen);
    const pairIndex = frozen.messages.findIndex((message) =>
      message.content.length === 1 &&
      message.content[0]?.type === 'text' &&
      message.content[0].text === '[CM] Recall memory L2-201.',
    );
    assert.ok(pairIndex >= 0);
    const participant = frozen.messages[pairIndex + 1]!.participant;
    const replacement = fx.children.slice(2).flatMap((child) => [
      { participant: 'Context Manager', content: [text(`[CM] Recall memory ${child.id}.`)] },
      { participant, content: [text(child.content)] },
    ]);
    const expected: NormalizedRequest = {
      ...frozen,
      messages: [
        ...frozen.messages.slice(0, pairIndex),
        ...replacement,
        ...frozen.messages.slice(pairIndex + 2),
      ],
    };
    assert.deepEqual(mock.calls[1]!.request, expected);
    fx.manager.close();
  });

  it('expands the newest Mythos-shaped L3 parent into six L2 children with deeper exact leaves', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const strategy = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 3,
    });
    const manager = await ContextManager.open({
      path: freshPath(), strategy, membrane: mock.membrane,
    });
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`mythos-raw-${i}`)]));
    }
    const topParents: SummaryEntry[] = [];
    for (let family = 0; family < 2; family++) {
      const l2s: SummaryEntry[] = [];
      for (let childIndex = 0; childIndex < 6; childIndex++) {
        const rawIndex = family * 12 + childIndex * 2;
        const l1 = summary(
          `L1-${400 + family * 10 + childIndex}`,
          1,
          [ids[rawIndex]!, ids[rawIndex + 1]!],
          ids[rawIndex]!,
          ids[rawIndex + 1]!,
        );
        const l2 = summary(
          `L2-${500 + family * 10 + childIndex}`,
          2,
          [l1.id],
          ids[rawIndex]!,
          ids[rawIndex + 1]!,
        );
        strategy.seed(l1);
        strategy.seed(l2);
        strategy.linkChild(l1, l2.id);
        l2s.push(l2);
      }
      const top = summary(
        `L3-${600 + family}`,
        3,
        l2s.map((child) => child.id),
        ids[family * 12]!,
        ids[family * 12 + 11]!,
      );
      strategy.seed(top);
      for (const child of l2s) strategy.linkChild(child, top.id);
      topParents.push(top);
    }
    const all = managerContext(manager).messageStore.getAll();
    const target: Chunk = {
      index: 1000,
      startIndex: 26,
      endIndex: 28,
      messages: all.slice(26, 28),
      tokens: 20,
      compressed: false,
    };

    await strategy.run(target, managerContext(manager));
    assert.deepEqual(recallIds(mock.calls[0]!.request), topParents.map((parent) => parent.id));
    assert.deepEqual(
      recallIds(mock.calls[1]!.request),
      ['L3-600', 'L2-510', 'L2-511', 'L2-512', 'L2-513', 'L2-514', 'L2-515'],
    );
    assert.equal(target.compressed, true);
    manager.close();
  });

  it('first curve refusal then second success stores only the second output', async () => {
    const mock = scriptedMembrane(['refusal', 'refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    await fx.strategy.run(fx.target, managerContext(fx.manager));

    assert.deepEqual(recallIds(mock.calls[1]!.request), ['L2-200', 'L1-102', 'L1-103']);
    assert.deepEqual(recallIds(mock.calls[2]!.request), ['L1-100', 'L1-101', 'L2-201']);
    const produced = fx.strategy.summariesView().filter(
      (entry) => entry.level === 1 && entry.sourceIds[0] === fx.target.messages[0]!.id,
    );
    assert.equal(produced.length, 1);
    assert.equal(produced[0]!.content, 'successful memory from attempt 2');
    fx.manager.close();
  });

  it('proves exact leaf coverage and leaves every non-replaced message/config/tool deep-equal', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    const tools: ToolDefinition[] = [{
      name: 'private_tool',
      description: 'synthetic',
      inputSchema: { type: 'object', properties: { secret: { type: 'string' } } },
    }];
    fx.manager.setToolDefinitions(tools);
    fx.target.messages = [
      {
        ...fx.target.messages[0]!,
        participant: 'Claude',
        content: [
          text('<think>private control state</think> skip_reply'),
          { type: 'tool_use', id: 'tool-1', name: 'private_tool', input: { secret: 'unchanged' } },
        ],
      },
      {
        ...fx.target.messages[1]!,
        participant: 'User',
        content: [{
          type: 'tool_result',
          toolUseId: 'tool-1',
          content: [
            text('private tool output unchanged'),
            { type: 'thinking', thinking: 'nested private state', signature: 'synthetic-signature' },
          ],
        }],
      },
    ];

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const canonical = mock.calls[0]!.request;
    const variant = mock.calls[1]!.request;
    assert.deepEqual(variant.config, canonical.config);
    assert.deepEqual(variant.tools, canonical.tools);
    assert.deepEqual(
      removeRecallPairs(variant, new Set(['L1-102', 'L1-103'])),
      removeRecallPairs(canonical, new Set(['L2-201'])),
      'fallback changes only the selected authored recall pair',
    );
    const serialized = JSON.stringify(variant);
    assert.match(serialized, /private control state/);
    assert.match(serialized, /skip_reply/);
    assert.match(serialized, /private tool output unchanged/);
    assert.match(serialized, /nested private state/);
    assert.match(serialized, /synthetic-signature/);
    assert.deepEqual(recallIds(variant), ['L2-200', 'L1-102', 'L1-103']);
    fx.manager.close();
  });

  it('uses the canonical authored node when historical duplicate IDs diverge in content and merge state', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    const duplicate = {
      ...structuredClone(fx.children[2]!),
      content: 'corrupt historical alternate content',
      mergedInto: undefined,
    };
    fx.manager.getStore().appendToStateJson('default/autobio:summaries', duplicate);

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    const variant = mock.calls[1]!.request;
    assert.match(JSON.stringify(variant), /authored L1-102/);
    assert.doesNotMatch(JSON.stringify(variant), /corrupt historical alternate content/);
    assert.deepEqual(recallIds(variant), ['L2-200', 'L1-102', 'L1-103']);
    fx.manager.close();
  });

  it('canonicalizes duplicate IDs seeded before open in both orders without fallback state edits', async () => {
    for (const corruptFirst of [true, false]) {
      const path = freshPath();
      const store = JsStore.openOrCreate({ path });
      MessageStore.register(store);
      store.registerState({
        id: 'default/autobio:summaries',
        strategy: 'append_log',
        deltaSnapshotEvery: 50,
        fullSnapshotEvery: 10,
      });
      const messages = new MessageStore(store);
      const ids: string[] = [];
      for (let i = 0; i < 14; i++) {
        ids.push(messages.append(i % 2 ? 'Claude' : 'User', [
          text(`preopen-${i} ` + 'substantive '.repeat(18)),
        ]).id);
      }
      const children = [
        summary('L1-100', 1, [ids[0]!, ids[1]!], ids[0]!, ids[1]!),
        summary('L1-101', 1, [ids[2]!, ids[3]!], ids[2]!, ids[3]!),
        summary('L1-102', 1, [ids[4]!, ids[5]!], ids[4]!, ids[5]!),
        summary('L1-103', 1, [ids[6]!, ids[7]!], ids[6]!, ids[7]!),
      ];
      const older = summary('L2-200', 2, ['L1-100', 'L1-101'], ids[0]!, ids[3]!);
      const newer = summary('L2-201', 2, ['L1-102', 'L1-103'], ids[4]!, ids[7]!);
      children[0]!.mergedInto = older.id;
      children[1]!.mergedInto = older.id;
      children[2]!.mergedInto = newer.id;
      children[3]!.mergedInto = newer.id;
      const corrupt = {
        ...structuredClone(children[2]!),
        content: 'divergent historical duplicate',
        mergedInto: undefined,
      };
      const orderedDuplicate = corruptFirst ? [corrupt, children[2]!] : [children[2]!, corrupt];
      for (const entry of [
        children[0]!, children[1]!, ...orderedDuplicate, children[3]!, older, newer,
      ]) store.appendToStateJson('default/autobio:summaries', entry);

      const mock = scriptedMembrane(['refusal']);
      const strategy = new ProbeStrategy({
        compressionModel: MODEL,
        targetChunkTokens: 100,
        recentWindowTokens: 0,
        headWindowTokens: 0,
        autoTickOnNewMessage: false,
        minChunkCharsForLLM: 0,
        mergeThreshold: 99,
        compressionRefusalCurveFallbacks: 2,
      });
      const manager = await ContextManager.open({ store, strategy, membrane: mock.membrane });
      const before = structuredClone(store.getStateJson('default/autobio:summaries'));
      const ctx = managerContext(manager);
      await strategy.run({
        index: 999,
        startIndex: 10,
        endIndex: 12,
        messages: ids.slice(10, 12).map((id) => ctx.messageStore.get(id)!),
        tokens: 100,
        compressed: false,
      }, ctx);
      assert.equal(mock.calls.length, 3);
      assert.match(JSON.stringify(mock.calls[1]!.request), /authored L1-102/);
      assert.doesNotMatch(JSON.stringify(mock.calls[1]!.request), /divergent historical duplicate/);
      assert.deepEqual(
        store.getStateJson('default/autobio:summaries'),
        before,
        'fallback must not edit, reorder, or merge persisted authored nodes',
      );
      manager.close();

      const restartMock = scriptedMembrane(['refusal']);
      const restarted = new ProbeStrategy({
        compressionModel: MODEL,
        targetChunkTokens: 100,
        recentWindowTokens: 0,
        headWindowTokens: 0,
        minChunkCharsForLLM: 0,
        mergeThreshold: 99,
        compressionRefusalCurveFallbacks: 2,
      });
      const restartedManager = await ContextManager.open({
        store, strategy: restarted, membrane: restartMock.membrane,
      });
      const restartCtx = managerContext(restartedManager);
      await restarted.run({
        index: 999,
        startIndex: 10,
        endIndex: 12,
        messages: ids.slice(10, 12).map((id) => restartCtx.messageStore.get(id)!),
        tokens: 100,
        compressed: false,
      }, restartCtx);
      assert.equal(restartMock.calls.length, 0);
      assert.deepEqual(store.getStateJson('default/autobio:summaries'), before);
      restartedManager.close();
      store.close();
    }
  });

  it('rejects malformed levels on a deeper recursive edge', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane);
    const top = summary(
      'L3-300', 3, fx.parents.map((parent) => parent.id), fx.ids[0]!, fx.ids[7]!,
    );
    for (const parent of fx.parents) fx.strategy.linkChild(parent, top.id);
    fx.strategy.seed(top);
    fx.children[0]!.sourceLevel = 7;
    fx.strategy.flushSummaries();

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'invalid L3 -> L2 -> L1 edge prevents expansion');
    assert.deepEqual(recallIds(mock.calls[0]!.request), ['L3-300']);
    fx.manager.close();
  });

  it('rejects missing/empty child and duplicate-leaf candidates without fallback provider calls', async () => {
    {
      const mock = scriptedMembrane(['refusal']);
      const fx = await fixture(mock.membrane);
      fx.parents[0].sourceIds = ['missing-child'];
      fx.children[2]!.content = '';
      fx.strategy.flushSummaries();
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(mock.calls.length, 1, 'missing/empty children yield canonical call only');
      fx.manager.close();
    }
    {
      const mock = scriptedMembrane(['refusal']);
      const fx = await fixture(mock.membrane);
      fx.parents[0].sourceIds = ['missing-child'];
      fx.children[2]!.sourceIds = [fx.ids[4]!, fx.ids[4]!];
      fx.strategy.flushSummaries();
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(mock.calls.length, 1, 'duplicate recursive leaves fail exact coverage proof');
      fx.manager.close();
    }
  });

  it('bounds the full normalized request without provider usage and continues after overflow', async () => {
    const mock = flexibleMembrane([
      { stop: 'refusal', omitUsage: true },
      { stop: 'end_turn', text: 'older bounded curve succeeded', inputTokens: 13_000 },
    ]);
    const fx = await fixture(mock.membrane, {
      compressionContextBudgetTokens: 50_000,
      headWindowTokens: 100_000,
    });
    for (const child of fx.children) child.tokens = 1;
    fx.children[2]!.content = 'large newest child '.repeat(900);
    fx.children[3]!.content = 'large newest child '.repeat(900);
    fx.strategy.flushSummaries();
    fx.manager.setToolDefinitions([{
      name: 'large_inventory_tool',
      description: 'schema inventory '.repeat(300),
      inputSchema: {
        type: 'object',
        properties: { payload: { type: 'string', description: 'large field '.repeat(300) } },
      },
    }]);
    fx.target.messages = fx.target.messages.map((message) => ({
      ...message,
      content: [text('large raw chunk '.repeat(300))],
    }));

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'oversized newest variant is never sent');
    assert.deepEqual(recallIds(mock.calls[1]!.request), ['L1-100', 'L1-101', 'L2-201']);
    assert.equal(fx.target.compressed, true, 'later bounded candidate still succeeds');
    fx.manager.close();
  });

  it('authoritative canonical input usage dominates the estimate and blocks every fallback', async () => {
    const mock = flexibleMembrane([
      { stop: 'refusal', inputTokens: 90_000 },
      { stop: 'end_turn', text: 'must never be called' },
    ]);
    const fx = await fixture(mock.membrane, {
      compressionContextBudgetTokens: 50_000,
      compressionRefusalCurveFallbacks: 3,
    });

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'canonical usage over budget suppresses provider fallbacks');
    const record = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!
      .record as Record<string, unknown>;
    assert.equal(record.canonicalProviderInputTokens, 90_000);
    assert.match(String(record.accountingSource), /canonical_provider_input/);
    const plan = record.plan as Array<Record<string, unknown>>;
    assert.ok(plan.length > 0);
    assert.ok(plan.every((item) => item.disposition === 'admission_rejected'));
    assert.ok(plan.every((item) => item.accountingSource === 'canonical_provider_usage_plus_expansion'));
    assert.ok(plan.every((item) => Number(item.boundedInputTokens) > 90_000));
    fx.manager.close();
  });

  it('usage absence counts complete huge tools, head, raw input, and normalized config', async () => {
    const mock = flexibleMembrane([{ stop: 'refusal', omitUsage: true }]);
    const hugeModel = `same-model-${'config'.repeat(4_000)}`;
    const fx = await fixture(mock.membrane, {
      compressionContextBudgetTokens: 60_000,
      compressionRefusalCurveFallbacks: 3,
      headWindowTokens: 100_000,
    });
    fx.strategy.setCompressionModel(hugeModel);
    fx.manager.setToolDefinitions([{
      name: 'complete_bound_tool',
      description: 'tool-description '.repeat(1_500),
      inputSchema: {
        type: 'object',
        properties: {
          payload: { type: 'string', description: 'schema-description '.repeat(1_500) },
        },
      },
    }]);
    fx.target.messages = fx.target.messages.map((message) => ({
      ...message,
      content: [text('huge raw request field '.repeat(1_000))],
    }));

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'complete deterministic request bound rejects every variant');
    const record = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!
      .record as Record<string, unknown>;
    assert.equal(record.canonicalProviderInputTokens, undefined);
    assert.deepEqual(
      (record.normalizedConfig as Record<string, unknown>).requestConfig,
      mock.calls[0]!.request.config,
    );
    const canonicalSerializedBytes = Buffer.byteLength(JSON.stringify(mock.calls[0]!.request), 'utf8');
    assert.ok(Number(record.canonicalRequestBoundTokens) > canonicalSerializedBytes);
    const plan = record.plan as Array<Record<string, unknown>>;
    assert.ok(plan.length > 0);
    assert.ok(plan.every((item) => item.accountingSource === 'complete_normalized_request_bound'));
    assert.ok(plan.every((item) => item.boundedInputTokens === item.deterministicInputBoundTokens));
    assert.ok(plan.every((item) => Number(item.outputReserveTokens) === 16_000));
    assert.ok(plan.every((item) => item.disposition === 'admission_rejected'));
    fx.manager.close();
  });

  it('stale child token metadata is irrelevant to the exact bounded plan and key', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 2 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const first = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!
      .record as Record<string, unknown>;
    await fx.strategy.clearCompressionRefusalQuarantine(String(first.key));
    for (const child of fx.children) child.tokens = 9_999_999;
    fx.strategy.flushSummaries();

    await fx.strategy.run({ ...fx.target, compressed: false }, managerContext(fx.manager));
    const exhaustions = quarantineEvents(fx.manager).filter((event) => event.kind === 'exhausted');
    const second = exhaustions[1]!.record as Record<string, unknown>;
    assert.equal(second.key, first.key);
    assert.deepEqual(second.plan, first.plan);
    assert.equal(mock.calls.length, 6);
    fx.manager.close();
  });

  it('continues across empty output and provider error, then accepts persistable end_turn text', async () => {
    const providerError = Object.assign(new Error('synthetic variant failure'), { type: 'invalid_request' });
    const mock = flexibleMembrane([
      { stop: 'refusal' },
      { stop: 'end_turn', text: '' },
      { error: providerError },
      { stop: 'end_turn', text: 'persistable recovered memory' },
    ]);
    const fx = await fixture(mock.membrane);
    const extraChildren = [
      summary('L1-104', 1, [fx.ids[8]!], fx.ids[8]!, fx.ids[8]!),
      summary('L1-105', 1, [fx.ids[9]!], fx.ids[9]!, fx.ids[9]!),
    ];
    const newest = summary(
      'L2-202', 2, extraChildren.map((child) => child.id), fx.ids[8]!, fx.ids[9]!,
    );
    for (const child of extraChildren) {
      fx.strategy.seed(child);
      fx.strategy.linkChild(child, newest.id);
    }
    fx.strategy.seed(newest);

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 4);
    assert.deepEqual(
      recallIds(mock.calls[1]!.request).filter((id) => id === 'L1-104' || id === 'L1-105'),
      ['L1-104', 'L1-105'],
    );
    assert.equal(fx.target.compressed, true);
    const produced = fx.strategy.summariesView().find(
      (entry) => entry.sourceIds.join(':') === fx.target.messages.map((message) => message.id).join(':'),
    );
    assert.equal(produced?.content, 'persistable recovered memory');
    assert.equal(quarantineEvents(fx.manager).filter((event) => event.kind === 'exhausted').length, 0);
    fx.manager.close();
  });

  it('quarantines a refused family when every fallback is empty or errors', async () => {
    const providerError = Object.assign(new Error('synthetic size rejection'), { type: 'context_length' });
    const mock = flexibleMembrane([
      { stop: 'refusal' },
      { stop: 'end_turn', text: '' },
      { error: providerError },
    ]);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 2 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(fx.target.compressed, false);
    const exhausted = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted');
    assert.ok(exhausted);
    assert.deepEqual(
      (exhausted.outcomes as Array<{ outcome: string }>).map((outcome) => outcome.outcome),
      ['refusal', 'unusable_empty', 'provider_error'],
    );
    await fx.strategy.run({ ...fx.target, compressed: false }, managerContext(fx.manager));
    assert.equal(mock.calls.length, 3, 'durable active family suppresses retries');
    fx.manager.close();
  });

  it('classifies every malformed fallback response inside its bounded attempt', async () => {
    const malformed: Array<{ name: string; value: unknown; errorType: string }> = [
      { name: 'missing content', value: { stopReason: 'end_turn' }, errorType: 'malformed_content' },
      { name: 'refusal missing content', value: { stopReason: 'refusal' }, errorType: 'malformed_content' },
      { name: 'null response', value: null, errorType: 'malformed_response' },
      { name: 'string response', value: 'not a response', errorType: 'malformed_response' },
      { name: 'null content', value: { stopReason: 'end_turn', content: null }, errorType: 'malformed_content' },
      { name: 'string content', value: { stopReason: 'end_turn', content: 'text' }, errorType: 'malformed_content' },
      {
        name: 'null block',
        value: { stopReason: 'end_turn', content: [null] },
        errorType: 'malformed_content_block',
      },
      {
        name: 'malformed text block',
        value: { stopReason: 'end_turn', content: [{ type: 'text', text: 42 }] },
        errorType: 'malformed_text_block',
      },
    ];
    for (const item of malformed) {
      const mock = flexibleMembrane([
        { stop: 'refusal' },
        { raw: item.value },
      ]);
      const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 1 });
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(mock.calls.length, 2, item.name);
      assert.equal(fx.target.compressed, false, item.name);
      const exhausted = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!;
      const outcomes = exhausted.outcomes as Array<{ outcome: string; errorType?: string }>;
      assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['refusal', 'provider_error'], item.name);
      assert.equal(outcomes[1]!.errorType, item.errorType, item.name);
      fx.manager.close();
    }
  });

  it('continues after a malformed fallback and persists later end_turn text', async () => {
    const mock = flexibleMembrane([
      { stop: 'refusal' },
      { raw: { stopReason: 'end_turn', content: [null] } },
      { stop: 'end_turn', text: 'later bounded memory' },
    ]);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 2 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 3);
    assert.equal(fx.target.compressed, true);
    assert.equal(quarantineEvents(fx.manager).length, 0);
    fx.manager.close();
  });

  it('preserves canonical empty/error behavior; canonical max_tokens is never canonized', async () => {
    {
      const mock = flexibleMembrane([{ stop: 'end_turn', text: '' }]);
      const fx = await fixture(mock.membrane);
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(fx.target.compressed, false);
      assert.equal(quarantineEvents(fx.manager).filter((event) => event.kind === 'exhausted').length, 0);
      fx.manager.close();
    }
    for (const malformed of [
      { stopReason: 'end_turn' },
      { stopReason: 'end_turn', content: null },
      { stopReason: 'end_turn', content: 'text' },
      { stopReason: 'end_turn', content: [null] },
    ]) {
      const mock = flexibleMembrane([{ raw: malformed }]);
      const fx = await fixture(mock.membrane);
      await assert.rejects(fx.strategy.run(fx.target, managerContext(fx.manager)));
      assert.equal(quarantineEvents(fx.manager).length, 0);
      fx.manager.close();
    }
    {
      // Terminal-disposition gate (2026-08-01): a truncated canonical
      // generation must NOT become a permanent memory, however plausible its
      // text. It rides the bounded fallback machinery ('incomplete') and,
      // with every attempt truncated, exhausts into quarantine.
      const mock = flexibleMembrane([{ stop: 'max_tokens', text: 'canonical partial memory' }]);
      const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 2 });
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(fx.target.compressed, false, 'truncated memory must never be canonized');
      const produced = fx.strategy.summariesView().find(
        (entry) => entry.content === 'canonical partial memory',
      );
      assert.equal(produced, undefined);
      const exhausted = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted');
      assert.ok(exhausted, 'exhaustion is receipted durably');
      const outcomes = (exhausted!.outcomes as Array<{ outcome: string; stopReason?: string }>);
      assert.equal(outcomes[0]!.outcome, 'incomplete');
      assert.equal(outcomes[0]!.stopReason, 'max_tokens');
      assert.ok(outcomes.every((outcome) => outcome.outcome === 'incomplete'));
      fx.manager.close();
    }
    {
      const mock = flexibleMembrane([{ error: new Error('canonical transport failure') }]);
      const fx = await fixture(mock.membrane);
      await assert.rejects(fx.strategy.run(fx.target, managerContext(fx.manager)));
      await assert.rejects(fx.strategy.run(fx.target, managerContext(fx.manager)));
      assert.equal(mock.calls.length, 2, 'canonical errors remain retryable and are not quarantined');
      fx.manager.close();
    }
  });

  it('all-refused persists quarantine, stores nothing, and restart skips every provider call', async () => {
    const path = freshPath();
    const firstMock = scriptedMembrane(['refusal']);
    const first = await fixture(firstMock.membrane, { compressionRefusalCurveFallbacks: 2 }, path);
    const targetIds = first.target.messages.map((message) => message.id);
    await first.strategy.run(first.target, managerContext(first.manager));
    assert.equal(firstMock.calls.length, 3);
    assert.equal(first.target.compressed, false);
    assert.equal(
      first.strategy.summariesView().filter((entry) => entry.sourceIds.join(':') === targetIds.join(':')).length,
      0,
    );
    const quarantine = first.manager.getStore().getStateJson(
      'default/autobio:compression-refusal-quarantine-events',
    );
    const events = quarantine as Array<Record<string, unknown>>;
    const record = events.find((event) => event.kind === 'exhausted')?.record as Record<string, unknown>;
    assert.ok(record);
    assert.equal(record.model, MODEL);
    assert.match(String(record.key), /^[a-f0-9]{64}$/);
    assert.match(String(record.chunkSourceHash), /^[a-f0-9]{64}$/);
    assert.match(String(record.frontierHash), /^[a-f0-9]{64}$/);
    assert.match(String(record.canonicalRequestHash), /^[a-f0-9]{64}$/);
    assert.equal(record.fallbackLimit, 2);
    assert.equal((record.plan as unknown[]).length, 2);
    first.manager.close();

    const restartMock = scriptedMembrane(['refusal']);
    const restarted = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 2,
    });
    const manager = await ContextManager.open({ path, strategy: restarted, membrane: restartMock.membrane });
    const ctx = managerContext(manager);
    const messages = targetIds.map((id) => ctx.messageStore.get(id)).filter(Boolean) as StoredMessage[];
    await restarted.run({
      index: 999,
      startIndex: 10,
      endIndex: 12,
      messages,
      tokens: 100,
      compressed: false,
    }, ctx);
    assert.equal(restartMock.calls.length, 0, 'durable quarantine survives process restart');
    manager.close();
  });

  it('ignores a crash-stale legacy claim that has no exhaustion event', async () => {
    const path = freshPath();
    const firstMock = scriptedMembrane(['refusal']);
    const first = await fixture(firstMock.membrane, { compressionRefusalCurveFallbacks: 0 }, path);
    const targetIds = first.target.messages.map((message) => message.id);
    await first.strategy.run(first.target, managerContext(first.manager));
    const exhausted = quarantineEvents(first.manager).find((event) => event.kind === 'exhausted')!;
    const record = exhausted.record as Record<string, unknown>;
    await first.strategy.clearCompressionRefusalQuarantine(String(record.key));
    first.manager.getStore().appendToStateJsonWithIdentity(
      'default/autobio:compression-refusal-quarantine-events',
      { kind: 'claim', key: record.key, record, created: Date.now() },
      'eventId',
      'sequence',
    );
    first.manager.close();

    const restartMock = scriptedMembrane(['end_turn']);
    const restarted = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const manager = await ContextManager.open({ path, strategy: restarted, membrane: restartMock.membrane });
    const ctx = managerContext(manager);
    const chunk: Chunk = {
      index: 999,
      startIndex: 10,
      endIndex: 12,
      messages: targetIds.map((id) => ctx.messageStore.get(id)!).filter(Boolean),
      tokens: 100,
      compressed: false,
    };
    await restarted.run(chunk, ctx);
    assert.equal(restartMock.calls.length, 1, 'stale claim cannot suppress canonical retry');
    assert.equal(chunk.compressed, true);
    manager.close();
  });

  it('restart with fallback limit 1→3 invalidates the exhausted plan key', async () => {
    const path = freshPath();
    const firstMock = scriptedMembrane(['refusal']);
    const first = await fixture(firstMock.membrane, { compressionRefusalCurveFallbacks: 1 }, path);
    const targetIds = first.target.messages.map((message) => message.id);
    await first.strategy.run(first.target, managerContext(first.manager));
    assert.equal(firstMock.calls.length, 2);
    const firstRecord = quarantineEvents(first.manager).find((event) => event.kind === 'exhausted')!
      .record as Record<string, unknown>;
    assert.equal(firstRecord.fallbackLimit, 1);
    assert.equal((firstRecord.plan as unknown[]).length, 1);
    first.manager.close();

    const restartMock = scriptedMembrane(['refusal', 'end_turn']);
    const restarted = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 3,
    });
    const manager = await ContextManager.open({ path, strategy: restarted, membrane: restartMock.membrane });
    const ctx = managerContext(manager);
    await restarted.run({
      index: 999,
      startIndex: 10,
      endIndex: 12,
      messages: targetIds.map((id) => ctx.messageStore.get(id)!).filter(Boolean),
      tokens: 100,
      compressed: false,
    }, ctx);
    assert.equal(restartMock.calls.length, 2, 'changed normalized limit retries canonical then fallback');
    manager.close();
  });

  it('restart with a changed admission budget invalidates the exact plan key', async () => {
    const path = freshPath();
    const firstMock = scriptedMembrane(['refusal']);
    const first = await fixture(firstMock.membrane, {
      compressionRefusalCurveFallbacks: 3,
      compressionContextBudgetTokens: 19_000,
    }, path);
    const targetIds = first.target.messages.map((message) => message.id);
    await first.strategy.run(first.target, managerContext(first.manager));
    assert.equal(firstMock.calls.length, 1, 'low budget rejects every fallback before provider work');
    const record = quarantineEvents(first.manager).find((event) => event.kind === 'exhausted')!
      .record as Record<string, unknown>;
    assert.ok((record.plan as Array<{ disposition: string }>).every(
      (item) => item.disposition === 'admission_rejected',
    ));
    first.manager.close();

    const restartMock = scriptedMembrane(['refusal', 'end_turn']);
    const restarted = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 3,
      compressionContextBudgetTokens: 200_000,
    });
    const manager = await ContextManager.open({ path, strategy: restarted, membrane: restartMock.membrane });
    const ctx = managerContext(manager);
    await restarted.run({
      index: 999,
      startIndex: 10,
      endIndex: 12,
      messages: targetIds.map((id) => ctx.messageStore.get(id)!).filter(Boolean),
      tokens: 100,
      compressed: false,
    }, ctx);
    assert.equal(restartMock.calls.length, 2);
    manager.close();
  });

  it('frontier, chunk, and model changes each invalidate the quarantine key', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 1);

    const frontier = summary('L1-new-frontier', 1, [fx.ids[8]!], fx.ids[8]!, fx.ids[8]!);
    fx.strategy.seed(frontier);
    await fx.strategy.run({ ...fx.target, compressed: false }, managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'changed frontier permits canonical retry');

    const ctx = managerContext(fx.manager);
    const changedChunkMessages = fx.ids.slice(11, 13)
      .map((id) => ctx.messageStore.get(id)).filter(Boolean) as StoredMessage[];
    await fx.strategy.run({
      ...fx.target,
      messages: changedChunkMessages,
      compressed: false,
    }, ctx);
    assert.equal(mock.calls.length, 3, 'changed chunk permits canonical retry');
    fx.strategy.setCompressionModel('changed-model');
    await fx.strategy.run({ ...fx.target, compressed: false }, ctx);
    assert.equal(mock.calls.length, 4, 'changed model invalidates prior quarantine');
    assert.equal(mock.calls[3]!.request.config.model, 'changed-model');
    fx.manager.close();
  });

  it('operator clear explicitly permits a canonical-first retry', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    const ctx = managerContext(fx.manager);
    await fx.strategy.run(fx.target, ctx);
    await fx.strategy.run({ ...fx.target, compressed: false }, ctx);
    assert.equal(mock.calls.length, 1, 'unchanged exhausted key is suppressed');

    await fx.strategy.clearCompressionRefusalQuarantine();
    await fx.strategy.run({ ...fx.target, compressed: false }, ctx);
    assert.equal(mock.calls.length, 2, 'clear permits exactly a new canonical attempt');
    assert.deepEqual(recallIds(mock.calls[1]!.request), ['L2-200', 'L2-201']);
    fx.manager.close();
  });

  it('checkpoints and compacts exhausted history under a finite logical bound', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    MessageStore.register(store);
    const messageStore = new MessageStore(store);
    const messages: StoredMessage[] = [];
    for (let i = 0; i < 90; i++) {
      messages.push(messageStore.append(i % 2 ? 'Claude' : 'User', [text(`refused-${i}`)]));
    }
    let calls = 0;
    const membrane = {
      complete: async () => {
        calls++;
        return response('refusal');
      },
    } as never;
    const strategy = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const manager = await ContextManager.open({ store, strategy, membrane });
    const ctx = managerContext(manager);
    const previousError = console.error;
    console.error = () => {};
    try {
      for (let i = 0; i < messages.length; i++) {
        await strategy.run({
          index: 20_000 + i,
          startIndex: i,
          endIndex: i + 1,
          messages: [messages[i]!],
          tokens: 10,
          compressed: false,
        }, ctx);
      }
    } finally {
      console.error = previousError;
    }
    const events = quarantineEvents(manager);
    assert.equal(calls, 90);
    assert.ok(events.some((event) => event.kind === 'checkpoint'));
    assert.ok(events.length < 256, `checkpoint should bound ledger, got ${events.length}`);
    await strategy.run({
      index: 20_000,
      startIndex: 0,
      endIndex: 1,
      messages: [messages[0]!],
      tokens: 10,
      compressed: false,
    }, ctx);
    assert.equal(calls, 90, 'checkpoint projection preserves every active exhaustion');
    manager.close();
    store.close();
  });

  it('queue-driven canonical refusal then curve success converges and stores one L1', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    const actual = fx.strategy.chunksView().find(
      (chunk) => chunk.messages.every((message) => !fx.children.some((child) => child.sourceIds.includes(message.id))),
    );
    assert.ok(actual, 'fixture has an uncovered persisted chunk');
    fx.strategy.queueOnly(actual.index);

    await fx.manager.tick();
    assert.equal(mock.calls.length, 2);
    assert.equal(actual.compressed, true);
    assert.equal(fx.strategy.summariesView().filter(
      (entry) => entry.level === 1 && entry.sourceIds.join(':') === actual.messages.map((m) => m.id).join(':'),
    ).length, 1);
    assert.equal(fx.manager.isReady(), true, 'compression queue converges');
    fx.manager.close();
  });

  it('a curve-produced L1 still feeds the ordinary merge queue exactly once', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane, { mergeThreshold: 2 });
    const spare = summary(
      'L1-spare', 1, [fx.ids[8]!, fx.ids[9]!], fx.ids[8]!, fx.ids[9]!,
    );
    fx.strategy.seed(spare);

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const produced = fx.strategy.summariesView().find(
      (entry) => entry.sourceIds.join(':') === fx.target.messages.map((message) => message.id).join(':'),
    );
    assert.ok(produced);
    const matching = fx.strategy.mergeQueueView().filter(
      (item) => item.level === 2 && item.sourceIds.includes(spare.id) && item.sourceIds.includes(produced.id),
    );
    assert.equal(matching.length, 1);
    fx.manager.close();
  });

  it('authored recall-curve expansion preserves carrier-bearing summary bodies verbatim', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane);
    const carrierById = new Map<string, ContentBlock[]>();
    for (const entry of fx.strategy.summariesView()) {
      const blocks = carrierBlocks(entry.id, entry.content);
      entry.responseContent = blocks;
      carrierById.set(entry.id, blocks);
    }
    fx.strategy.flushSummaries();

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);

    const canonical = mock.calls[0]!.request;
    const canonicalParentHeader = canonical.messages.findIndex((message) =>
      message.participant === 'Context Manager' &&
      message.content[0]?.type === 'text' &&
      message.content[0].text === '[CM] Recall memory L2-200.',
    );
    assert.ok(canonicalParentHeader >= 0);
    assert.deepEqual(
      canonical.messages[canonicalParentHeader + 1]!.content,
      carrierById.get('L2-200'),
    );

    const variant = mock.calls[1]!.request;
    assert.equal(
      variant.messages.some((message) =>
        message.participant === 'Context Manager' &&
        message.content[0]?.type === 'text' &&
        message.content[0].text === '[CM] Recall memory L2-201.',
      ),
      false,
    );
    for (const id of ['L1-102', 'L1-103']) {
      const headerIndex = variant.messages.findIndex((message) =>
        message.participant === 'Context Manager' &&
        message.content[0]?.type === 'text' &&
        message.content[0].text === `[CM] Recall memory ${id}.`,
      );
      assert.ok(headerIndex >= 0, `${id} should appear in the fallback expansion`);
      assert.deepEqual(
        variant.messages[headerIndex + 1]!.content,
        carrierById.get(id),
      );
    }
    assert.equal(quarantineEvents(fx.manager).length, 0);
    fx.manager.close();
  });

  it('emits metadata traces for refusal, curve attempt, success, and persistence', async () => {
    const logPath = `${freshPath()}-trace.jsonl`;
    paths.push(logPath);
    const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    try {
      const mock = scriptedMembrane(['refusal', 'end_turn']);
      const fx = await fixture(mock.membrane);
      for (const entry of fx.strategy.summariesView()) {
        entry.responseContent = carrierBlocks(entry.id, entry.content);
      }
      fx.strategy.flushSummaries();
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      fx.manager.close();

      const rawLog = readFileSync(logPath, 'utf8');
      const entries = rawLog.trim().split('\n').map(
        (line) => JSON.parse(line) as { event?: string; metadata?: Record<string, unknown> },
      );
      const events = entries.map((entry) => entry.event).filter(Boolean);
      assert.ok(events.includes('compression:canonical-refused'));
      assert.ok(events.includes('compression:curve-attempt'));
      assert.ok(events.includes('compression:curve-succeeded'));
      const attempts = entries.filter((entry) => entry.event === 'compression:attempt');
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0]!.metadata?.persisted, false);
      assert.equal(attempts[0]!.metadata?.refusalCategory, 'reasoning_extraction');
      assert.equal(attempts[1]!.metadata?.persisted, true);
      assert.match(String(attempts[1]!.metadata?.requestHash), /^[a-f0-9]{64}$/);
      assert.match(String(attempts[1]!.metadata?.leafCoverageHash), /^[a-f0-9]{64}$/);
      assert.equal(attempts[1]!.metadata?.refusalCategory, undefined);
      assert.equal(rawLog.includes('substantive'), false, 'raw source text must not enter telemetry');
      assert.equal(rawLog.includes('successful memory from attempt 1'), false, 'summary body must not enter telemetry');
      assert.equal(rawLog.includes('private-L2-200'), false, 'reasoning text must not enter telemetry');
      assert.equal(rawLog.includes('enc-L2-200'), false, 'redacted reasoning payload must not enter telemetry');
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
    }
  });

  it('concurrent producers consult durable summaries and persist only one L1', async () => {
    const mock = scriptedMembrane(['end_turn', 'end_turn']);
    // The process-local branch/family registry coalesces the second producer;
    // hold the first briefly so the race is real.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    const concurrent = {
      complete: async (request: NormalizedRequest) => {
        mock.calls.push({ request: structuredClone(request) });
        entered++;
        await gate;
        return response('end_turn', 'one durable result');
      },
    } as never;
    const path = freshPath();
    const first = await fixture(concurrent, { compressionRefusalCurveFallbacks: 0 }, path);
    const second = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const secondManager = await ContextManager.open({
      store: first.manager.getStore(),
      strategy: second,
      membrane: concurrent,
    });
    const secondCtx = managerContext(secondManager);
    const secondMessages = first.target.messages.map(
      (message) => secondCtx.messageStore.get(message.id),
    ).filter(Boolean) as StoredMessage[];
    const secondChunk = { ...first.target, messages: secondMessages, compressed: false };

    const runs = Promise.all([
      first.strategy.run(first.target, managerContext(first.manager)),
      second.run(secondChunk, secondCtx),
    ]);
    setTimeout(release, 20);
    await runs;
    assert.equal(mock.calls.length, 1, 'same-key in-flight registry permits only one provider call');
    const persisted = first.manager.getStore().getStateJson('default/autobio:summaries');
    const targetKey = first.target.messages.map((message) => message.id).join(':');
    const matching = (Array.isArray(persisted) ? persisted : []).filter(
      (entry: SummaryEntry) => entry.level === 1 && entry.sourceIds.join(':') === targetKey,
    );
    assert.equal(matching.length, 1);
    assert.ok(second.summariesView().some(
      (entry) => entry.level === 1 && entry.sourceIds.join(':') === targetKey,
    ), 'same-namespace waiter reloads the durable summary into its own strategy');
    assert.equal(secondChunk.compressed, true);
    secondManager.close();
    first.manager.close();
  });

  it('same-key concurrent exhaustion makes one provider call and one keyed alert attempt', async () => {
    const mock = scriptedMembrane(['refusal']);
    const path = freshPath();
    const first = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 }, path);
    const second = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const secondManager = await ContextManager.open({
      store: first.manager.getStore(), strategy: second, membrane: mock.membrane,
    });
    const secondCtx = managerContext(secondManager);
    const secondChunk = {
      ...first.target,
      messages: first.target.messages.map((message) => secondCtx.messageStore.get(message.id)!),
      compressed: false,
    };

    await Promise.all([
      first.strategy.run(first.target, managerContext(first.manager)),
      second.run(secondChunk, secondCtx),
    ]);
    const events = quarantineEvents(first.manager);
    assert.equal(mock.calls.length, 1);
    assert.equal(events.filter((event) => event.kind === 'claim').length, 0);
    assert.equal(events.filter((event) => event.kind === 'exhausted').length, 1);
    assert.equal(events.filter((event) => event.kind === 'alert_pending').length, 1);
    assert.equal(events.filter((event) => event.kind === 'alert_sent').length, 1);
    assert.equal(second.quarantineKeysView().length, 1,
      'same-namespace waiter reloads the durable quarantine outcome');
    secondManager.close();
    first.manager.close();
  });

  it('distinct namespaces run concurrent success independently and persist both L1s', async () => {
    const calls: RecordedCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        calls.push({ request: structuredClone(request) });
        await gate;
        return response('end_turn', `namespace success ${calls.length}`);
      },
    } as never;
    const first = await fixture(membrane, { compressionRefusalCurveFallbacks: 0 });
    const second = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const secondManager = await ContextManager.open({
      store: first.manager.getStore(), strategy: second, membrane, namespace: 'beta',
    });
    seedEquivalentRecallTree(second, first);
    const secondCtx = managerContext(secondManager);
    const secondChunk = {
      ...first.target,
      messages: first.target.messages.map((message) => secondCtx.messageStore.get(message.id)!),
      compressed: false,
    };

    const runs = Promise.all([
      first.strategy.run(first.target, managerContext(first.manager)),
      second.run(secondChunk, secondCtx),
    ]);
    setTimeout(release, 20);
    await runs;
    assert.equal(calls.length, 2, 'namespace state identities cannot coalesce');
    const targetKey = first.target.messages.map((message) => message.id).join(':');
    for (const namespace of ['default', 'beta']) {
      const persisted = first.manager.getStore().getStateJson(`${namespace}/autobio:summaries`);
      assert.equal((Array.isArray(persisted) ? persisted as SummaryEntry[] : []).filter(
        (entry) => entry.level === 1 && entry.sourceIds.join(':') === targetKey,
      ).length, 1, `${namespace} owns one durable L1`);
    }
    assert.equal(first.target.compressed, true);
    assert.equal(secondChunk.compressed, true);
    secondManager.close();
    first.manager.close();
  });

  it('distinct namespaces run concurrent exhaustion independently and quarantine both', async () => {
    const calls: RecordedCall[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        calls.push({ request: structuredClone(request) });
        await Promise.resolve();
        return response('refusal');
      },
    } as never;
    const first = await fixture(membrane, { compressionRefusalCurveFallbacks: 0 });
    const second = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const secondManager = await ContextManager.open({
      store: first.manager.getStore(), strategy: second, membrane, namespace: 'beta',
    });
    seedEquivalentRecallTree(second, first);
    const secondCtx = managerContext(secondManager);
    const secondChunk = {
      ...first.target,
      messages: first.target.messages.map((message) => secondCtx.messageStore.get(message.id)!),
      compressed: false,
    };

    await Promise.all([
      first.strategy.run(first.target, managerContext(first.manager)),
      second.run(secondChunk, secondCtx),
    ]);
    assert.equal(calls.length, 2);
    for (const namespace of ['default', 'beta']) {
      const events = quarantineEventsFor(first.manager, namespace);
      assert.equal(events.filter((event) => event.kind === 'exhausted').length, 1);
      assert.equal(events.filter((event) => event.kind === 'alert_sent').length, 1);
    }
    assert.equal(first.strategy.quarantineKeysView().length, 1);
    assert.equal(second.quarantineKeysView().length, 1);
    secondManager.close();
    first.manager.close();
  });

  it('different-key concurrent exhaustion preserves both durable records and alerts', async () => {
    const calls: RecordedCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        calls.push({ request: structuredClone(request) });
        if (calls.length === 2) release();
        await gate;
        return response('refusal');
      },
    } as never;
    const first = await fixture(membrane, { compressionRefusalCurveFallbacks: 0 });
    const second = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const secondManager = await ContextManager.open({
      store: first.manager.getStore(), strategy: second, membrane,
    });
    const secondCtx = managerContext(secondManager);
    const otherMessages = first.ids.slice(12, 14)
      .map((id) => secondCtx.messageStore.get(id)).filter(Boolean) as StoredMessage[];
    const otherChunk: Chunk = {
      ...first.target,
      index: 1001,
      startIndex: 12,
      endIndex: 14,
      messages: otherMessages,
      compressed: false,
    };

    await Promise.all([
      first.strategy.run(first.target, managerContext(first.manager)),
      second.run(otherChunk, secondCtx),
    ]);
    const events = quarantineEvents(first.manager);
    assert.equal(calls.length, 2);
    assert.equal(events.filter((event) => event.kind === 'claim').length, 0);
    assert.equal(events.filter((event) => event.kind === 'exhausted').length, 2);
    assert.equal(events.filter((event) => event.kind === 'alert_sent').length, 2);
    secondManager.close();
    first.manager.close();
  });

  it('a stale tombstone cannot clear a newer same-key quarantine generation', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    const ctx = managerContext(fx.manager);
    await fx.strategy.run(fx.target, ctx);
    const firstExhaustion = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!;
    const key = String((firstExhaustion.record as Record<string, unknown>).key);
    await fx.strategy.clearCompressionRefusalQuarantine(key);
    await fx.strategy.run({ ...fx.target, compressed: false }, ctx);
    const exhaustions = quarantineEvents(fx.manager).filter((event) => event.kind === 'exhausted');
    assert.equal(exhaustions.length, 2);
    fx.manager.getStore().appendToStateJson(
      'default/autobio:compression-refusal-quarantine-events',
      {
        kind: 'clear',
        key,
        targetClaimId: firstExhaustion.eventId,
        created: Date.now(),
      },
    );

    const restarted = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const restartedManager = await ContextManager.open({
      store: fx.manager.getStore(), strategy: restarted, membrane: mock.membrane,
    });
    const restartedCtx = managerContext(restartedManager);
    const restartedChunk = {
      ...fx.target,
      messages: fx.target.messages.map((message) => restartedCtx.messageStore.get(message.id)!),
      compressed: false,
    };
    await restarted.run(restartedChunk, restartedCtx);
    assert.equal(mock.calls.length, 2, 'new exhaustion survives stale clear event');
    restartedManager.close();
    fx.manager.close();
  });

  it('reloads branch-scoped quarantine projection on every branch switch', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    const main = fx.manager.currentBranch().name;
    const fork = fx.manager.getStore().createBranchAt(
      'quarantine-fork', main, fx.manager.getStore().currentSequence(),
    ).name;
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 1);

    await fx.manager.switchBranch(fork);
    const forkCtx = managerContext(fx.manager);
    const forkChunk = {
      ...fx.target,
      messages: fx.target.messages.map((message) => forkCtx.messageStore.get(message.id)!),
      compressed: false,
    };
    await fx.strategy.run(forkChunk, forkCtx);
    assert.equal(mock.calls.length, 2, 'fork inherited pre-quarantine state and may attempt');

    await fx.manager.switchBranch(main);
    const mainCtx = managerContext(fx.manager);
    const mainChunk = {
      ...fx.target,
      messages: fx.target.messages.map((message) => mainCtx.messageStore.get(message.id)!),
      compressed: false,
    };
    await fx.strategy.run(mainChunk, mainCtx);
    assert.equal(mock.calls.length, 2, 'main branch reloads and suppresses its active key');
    fx.manager.close();
  });

  it('discards a pending canonical result when ContextManager switches branches', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: RecordedCall[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        calls.push({ request: structuredClone(request) });
        entered();
        await gate;
        return response('end_turn', 'must be discarded');
      },
    } as never;
    const fx = await fixture(membrane);
    const main = fx.manager.currentBranch().name;
    const fork = fx.manager.getStore().createBranchAt(
      'pending-canonical-fork', main, fx.manager.getStore().currentSequence(),
    ).name;
    const targetKey = fx.target.messages.map((message) => message.id).join(':');
    const run = fx.strategy.run(fx.target, managerContext(fx.manager));
    await started;
    await fx.manager.switchBranch(fork);
    release();
    await run;
    assert.equal(calls.length, 1);
    assert.equal(quarantineEvents(fx.manager).length, 0);
    assert.equal(fx.strategy.summariesView().some(
      (entry) => entry.level === 1 && entry.sourceIds.join(':') === targetKey,
    ), false, 'fork receives no stale summary');

    await fx.manager.switchBranch(main);
    assert.equal(quarantineEvents(fx.manager).length, 0);
    assert.equal(fx.strategy.summariesView().some(
      (entry) => entry.level === 1 && entry.sourceIds.join(':') === targetKey,
    ), false, 'source branch receives no late summary either');
    fx.manager.close();
  });

  it('detects a same-name branch round trip made by another manager on the store', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const membrane = {
      complete: async () => {
        entered();
        await gate;
        return response('end_turn', 'round-trip stale result');
      },
    } as never;
    const fx = await fixture(membrane);
    const otherStrategy = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
    });
    const otherManager = await ContextManager.open({
      store: fx.manager.getStore(), strategy: otherStrategy, membrane,
    });
    const main = fx.manager.currentBranch().name;
    const fork = fx.manager.getStore().createBranchAt(
      'round-trip-fork', main, fx.manager.getStore().currentSequence(),
    ).name;
    const targetKey = fx.target.messages.map((message) => message.id).join(':');
    const run = fx.strategy.run(fx.target, managerContext(fx.manager));
    await started;
    await otherManager.switchBranch(fork);
    await otherManager.switchBranch(main);
    release();
    await run;
    assert.equal(fx.manager.currentBranch().name, main);
    assert.equal(fx.strategy.summariesView().some(
      (entry) => entry.sourceIds.join(':') === targetKey,
    ), false, 'same branch name is insufficient after a switch round trip');
    assert.equal(quarantineEvents(fx.manager).length, 0);
    otherManager.close();
    fx.manager.close();
  });

  it('discards a pending fallback result and writes no cross-branch quarantine', async () => {
    let release!: () => void;
    let fallbackEntered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { fallbackEntered = resolve; });
    const calls: RecordedCall[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        const index = calls.length;
        calls.push({ request: structuredClone(request) });
        if (index === 0) return response('refusal');
        fallbackEntered();
        await gate;
        return response('end_turn', 'stale fallback result');
      },
    } as never;
    const fx = await fixture(membrane);
    const main = fx.manager.currentBranch().name;
    const fork = fx.manager.getStore().createBranchAt(
      'pending-fallback-fork', main, fx.manager.getStore().currentSequence(),
    ).name;
    const targetKey = fx.target.messages.map((message) => message.id).join(':');
    const run = fx.strategy.run(fx.target, managerContext(fx.manager));
    await started;
    await fx.manager.switchBranch(fork);
    release();
    await run;
    assert.equal(calls.length, 2);
    assert.equal(quarantineEvents(fx.manager).length, 0);
    assert.equal(fx.strategy.summariesView().some(
      (entry) => entry.sourceIds.join(':') === targetKey,
    ), false);
    await fx.manager.switchBranch(main);
    assert.equal(quarantineEvents(fx.manager).length, 0);
    assert.equal(fx.strategy.summariesView().some(
      (entry) => entry.sourceIds.join(':') === targetKey,
    ), false);
    fx.manager.close();
  });

  it('rebuilds and can requeue branch-local compression after a discarded provider result', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: RecordedCall[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        const index = calls.length;
        calls.push({ request: structuredClone(request) });
        if (index === 0) {
          entered();
          await gate;
          return response('end_turn', 'discarded queue result');
        }
        return response('end_turn', 'branch-local retry');
      },
    } as never;
    const fx = await fixture(membrane);
    const actual = fx.strategy.chunksView().find((chunk) =>
      chunk.messages.every((message) =>
        !fx.children.some((child) => child.sourceIds.includes(message.id))),
    );
    assert.ok(actual);
    const sourceIds = actual.messages.map((message) => message.id);
    fx.strategy.queueOnly(actual.index);
    const main = fx.manager.currentBranch().name;
    const fork = fx.manager.getStore().createBranchAt(
      'queue-rebuild-fork', main, fx.manager.getStore().currentSequence(),
    ).name;
    const pendingTick = fx.manager.tick();
    await started;
    await fx.manager.switchBranch(fork);
    release();
    await pendingTick;

    const rebuilt = fx.strategy.chunksView().find((chunk) =>
      chunk.messages.map((message) => message.id).join(':') === sourceIds.join(':'),
    );
    assert.ok(rebuilt);
    assert.equal(rebuilt.compressed, false);
    fx.strategy.queueOnly(rebuilt.index);
    await fx.manager.tick();
    assert.equal(calls.length, 2);
    assert.equal(rebuilt.compressed, true, 'new branch can retry after old result is discarded');
    await fx.manager.switchBranch(main);
    assert.equal(fx.strategy.summariesView().some(
      (entry) => entry.sourceIds.join(':') === sourceIds.join(':'),
    ), false, 'retry summary remains branch-local');
    fx.manager.close();
  });

  it('aborts gated initialization after another manager switches either shared-store branch', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, {
      compressionRefusalCurveFallbacks: 0,
      mergeThreshold: 99,
    });
    const store = fx.manager.getStore();
    const main = fx.manager.currentBranch().name;
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    fx.strategy.pinRange(fx.ids[0]!, fx.ids[1]!, { name: 'main-pin' });
    fx.strategy.enqueueMergeForStress(2, ['main-queued-source']);
    const fork = store.createBranchAt(
      'initialize-race-fork', main, store.currentSequence(),
    ).name;

    await fx.manager.switchBranch(fork);
    fx.strategy.seed(summary(
      'L1-fork-only', 1, [fx.ids[8]!], fx.ids[8]!, fx.ids[8]!, 7, 'fork-only summary',
    ));
    fx.strategy.pinRange(fx.ids[2]!, fx.ids[3]!, { name: 'fork-pin' });
    fx.strategy.enqueueMergeForStress(2, ['fork-queued-source']);
    fx.strategy.appendChunkRecordForStress({
      id: 'c-9999', sourceIds: [fx.ids[13]!], compressed: false,
    });
    const forkCtx = managerContext(fx.manager);
    await fx.strategy.run({
      ...fx.target,
      index: 10_001,
      messages: [forkCtx.messageStore.get(fx.ids[12]!)!, forkCtx.messageStore.get(fx.ids[13]!)!],
      compressed: false,
    }, forkCtx);

    const stateIds = [
      'summaries', 'chunks', 'counter', 'mergeQueue', 'pins',
      'compression-refusal-quarantine-events',
    ];
    const snapshot = (): Record<string, unknown> => Object.fromEntries(stateIds.map((suffix) => [
      suffix,
      structuredClone(store.getStateJson(`default/autobio:${suffix}`)),
    ]));
    const derived = (strategy: ProbeStrategy) => ({
      summaries: strategy.summariesView(),
      chunks: strategy.chunksView().map((chunk) => ({
        recordId: chunk.recordId,
        sourceIds: chunk.messages.map((message) => message.id),
        compressed: chunk.compressed,
        summaryId: chunk.summaryId,
      })),
      queue: strategy.mergeQueueView(),
      pins: strategy.pinsView(),
      quarantine: strategy.quarantineKeysView(),
    });

    const emptyDerived = {
      summaries: [], chunks: [], queue: [], pins: [], quarantine: [],
    };
    const assertStaleEntrypointsFailClosed = async (
      expectedState: Record<string, unknown>,
    ) => {
      assert.deepEqual(derived(fx.strategy), emptyDerived, 'stale mirrors are cleared');
      await assert.rejects(
        fx.manager.tick(),
        /requires reinitialization for the current branch generation/,
      );
      const currentCtx = managerContext(fx.manager);
      await assert.rejects(
        fx.strategy.onNewMessage(currentCtx.messageStore.get(fx.ids[0]!)!, currentCtx),
        /requires reinitialization for the current branch generation/,
      );
      await assert.rejects(
        fx.manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }),
        /requires reinitialization for the current branch generation/,
      );
      assert.deepEqual(snapshot(), expectedState, 'stale entrypoints write no durable state');
      assert.deepEqual(derived(fx.strategy), emptyDerived, 'stale entrypoints rebuild no mirrors');
    };

    // Stabilize each branch once before recording its expected durable and
    // derived state. Subsequent changes are therefore evidence of the race,
    // not ordinary migration/rebuild work.
    await fx.manager.switchBranch(main);
    const mainState = snapshot();
    const mainDerived = structuredClone(derived(fx.strategy));
    await fx.manager.switchBranch(fork);
    const forkState = snapshot();
    const forkDerived = structuredClone(derived(fx.strategy));

    const other = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const otherManager = await ContextManager.open({
      store, strategy: other, membrane: mock.membrane,
    });

    const gateNextAlertDelivery = (strategy: ProbeStrategy) => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const target = strategy as unknown as {
        deliverPendingCompressionQuarantineAlerts: (source: unknown) => Promise<void>;
      };
      const original = target.deliverPendingCompressionQuarantineAlerts.bind(strategy);
      target.deliverPendingCompressionQuarantineAlerts = async (source: unknown) => {
        entered();
        await gate;
        await original(source);
      };
      return { release, started };
    };

    // Stale main initializer must not install or persist over fork.
    let gated = gateNextAlertDelivery(fx.strategy);
    const staleMain = fx.manager.switchBranch(main);
    await gated.started;
    await otherManager.switchBranch(fork);
    gated.release();
    await assert.rejects(staleMain, /Branch changed during strategy initialization/);
    assert.deepEqual(snapshot(), forkState);
    assert.deepEqual(derived(other), forkDerived);
    await assertStaleEntrypointsFailClosed(forkState);

    // Reverse the race: stale fork initializer must not touch main.
    gated = gateNextAlertDelivery(fx.strategy);
    const staleFork = fx.manager.switchBranch(fork);
    await gated.started;
    await otherManager.switchBranch(main);
    gated.release();
    await assert.rejects(staleFork, /Branch changed during strategy initialization/);
    assert.deepEqual(snapshot(), mainState);
    assert.deepEqual(derived(other), mainDerived);
    await assertStaleEntrypointsFailClosed(mainState);

    // Branch name equality is insufficient: an away-and-back round trip while
    // initialization is gated must invalidate the requested generation too.
    gated = gateNextAlertDelivery(fx.strategy);
    const staleRoundTrip = fx.manager.switchBranch(main);
    await gated.started;
    await otherManager.switchBranch(fork);
    await otherManager.switchBranch(main);
    gated.release();
    await assert.rejects(staleRoundTrip, /Branch changed during strategy initialization/);
    assert.equal(fx.manager.currentBranch().name, main);
    assert.deepEqual(snapshot(), mainState);
    assert.deepEqual(derived(other), mainDerived);
    await assertStaleEntrypointsFailClosed(mainState);

    otherManager.close();
    fx.manager.close();
  });

  it('replays a durable pending alert with the same key after the crash gap', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    const events = quarantineEvents(fx.manager);
    const pending = events.find((event) => event.kind === 'alert_pending')!;
    const key = String(pending.key);
    const main = fx.manager.currentBranch().name;
    const crashBranch = fx.manager.getStore().createBranchAt(
      'alert-crash-gap', main, Number(pending.sequence),
    ).name;

    await fx.manager.switchBranch(crashBranch);
    const replayed = quarantineEvents(fx.manager);
    const sent = replayed.filter(
      (event) => event.kind === 'alert_sent' && event.alertKey === key,
    );
    assert.equal(sent.length, 1, 'initialization retries the pending keyed alert attempt');
    fx.manager.close();
  });
});
