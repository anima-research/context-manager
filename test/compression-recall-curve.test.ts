import { createHash } from 'node:crypto';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy, MessageStore, CompressionWithdrawn } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StoredMessage, StrategyContext, SummaryEntry } from '../src/types/index.js';

const BASE = './test-compression-recall-curve';
const MODEL = 'same-model';
let sequence = 0;
const paths: string[] = [];

function freshPath(): string {
  const path = `${BASE}-${sequence++}`;
  paths.push(path);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  return path;
}

function cleanup(): void {
  for (const path of paths) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}

interface RecordedCall {
  request: NormalizedRequest;
  originalRequest?: NormalizedRequest;
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
      topLevelInputTokens?: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
      provider?: string;
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
        calls.push({ request: structuredClone(request), originalRequest: request });
        if ('error' in handler) throw handler.error;
        if ('raw' in handler) return handler.raw;
        const result = response(handler.stop, handler.text ?? '');
        if (handler.inputTokens !== undefined) result.usage.inputTokens = handler.inputTokens;
        if (handler.topLevelInputTokens !== undefined) result.usage.inputTokens = handler.topLevelInputTokens;
        if (handler.cacheCreationTokens !== undefined || handler.cacheReadTokens !== undefined || handler.provider) {
          (result as unknown as { details: { usage: Record<string, number>; model: { provider: string } } }).details = {
            usage: {
              inputTokens: handler.inputTokens ?? result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              ...(handler.cacheCreationTokens !== undefined
                ? { cacheCreationTokens: handler.cacheCreationTokens }
                : {}),
              ...(handler.cacheReadTokens !== undefined
                ? { cacheReadTokens: handler.cacheReadTokens }
                : {}),
            },
            model: { provider: handler.provider ?? 'anthropic' },
          };
        }
        if (handler.omitUsage) {
          delete (result as { usage?: unknown }).usage;
          delete (result as { details?: unknown }).details;
        }
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

/** Wait for `cond`, failing rather than hanging. */
async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * Count lookups in the compression in-flight registry that find a call
 * already in flight: a producer joining it. The registry is module-private,
 * so this watches Map lookups by its key's shape (five \u0000-joined parts:
 * namespace, quarantine ledger id, branch, generation and family) that return
 * a pending result. A state lock's tail (branch and state id, two parts) never
 * matches. Restore it before anything else runs.
 */
function observeInFlightJoins(): { count: () => number; restore: () => void } {
  const realGet = Map.prototype.get;
  let joins = 0;
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    const value = realGet.call(this, key);
    if (
      typeof key === 'string' &&
      key.split('\u0000').length === 5 &&
      key.split('\u0000')[1]!.endsWith('autobio:compression-refusal-quarantine-events') &&
      value instanceof Promise
    ) joins++;
    return value;
  };
  return { count: () => joins, restore: () => { Map.prototype.get = realGet; } };
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

  setTickWork(chunks: Chunk[], queued: number[], merges: Array<{ level: number; sourceIds: string[] }> = []): void {
    for (const chunk of chunks) {
      if (chunk.recordId) continue;
      chunk.recordId = `tick-${chunk.index}`;
      this.appendChunkRecord({
        id: chunk.recordId,
        sourceIds: chunk.messages.map((m) => m.id),
        compressed: chunk.compressed,
      });
    }
    this.chunks = chunks;
    this.compressionQueue = [...queued];
    this.mergeQueue = merges;
  }

  compressionQueueView(): number[] {
    return [...this.compressionQueue];
  }

  afterCompression(action: (chunk: Chunk) => void | Promise<void>): void {
    const compress = this.compressChunkHierarchical.bind(this);
    this.compressChunkHierarchical = async (...args: Parameters<ProbeStrategy['compressChunkHierarchical']>) => {
      await compress(...args);
      await action(args[0]);
    };
  }

  installLegacyCompressionOverride(): void {
    const compress = this.compressChunkHierarchical.bind(this);
    // A pre-existing override may only forward the original two arguments.
    this.compressChunkHierarchical = (chunk: Chunk, ctx: StrategyContext): Promise<void> => compress(chunk, ctx);
  }

  /** Queue a chunk at the tail, with no rebuild, as a plan's demand does (handleProducedOps). */
  queueAtTail(chunkIndex: number): void {
    this.compressionQueue.push(chunkIndex);
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

  inputBound(request: NormalizedRequest): number { return (this as unknown as { compressionRequestInputBoundTokens(r: NormalizedRequest): number }).compressionRequestInputBoundTokens(request); }

  run(chunk: Chunk, ctx: StrategyContext): Promise<void> {
    return this.compressChunkHierarchical(chunk, ctx);
  }

  queueView(): number[] {
    return [...this.compressionQueue];
  }

  splitWindowView(): number[] {
    return [...this.splitCallTimes];
  }

  setSplitWindow(times: number[]): void {
    this.splitCallTimes = [...times];
  }

  clearQueues(): void {
    this.compressionQueue = [];
    this.mergeQueue = [];
  }

  drain(ctx: StrategyContext): void {
    (this as unknown as { driveSpeculativeDrain(c: StrategyContext): void }).driveSpeculativeDrain(ctx);
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

/** Real persisted raw chunks, so onNewMessage can rebuild the queue without test-only boundaries. */
async function queuedRawFixture() {
  const mock = scriptedMembrane(['refusal', 'end_turn']);
  const strategy = new ProbeStrategy({
    compressionModel: MODEL,
    targetChunkTokens: 50,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    autoTickOnNewMessage: false,
    l1HoldbackChunks: 0,
    minChunkCharsForLLM: 0,
    mergeThreshold: 99,
    compressionRefusalCurveFallbacks: 0,
  });
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: mock.membrane });
  try {
    for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'word '.repeat(30))]);
    const ctx = managerContext(manager);
    const chunks = strategy.chunksView();
    assert.equal(chunks.length, 2);
    assert.deepEqual(strategy.compressionQueueView(), [0, 1]);
    await strategy.run(chunks[0], ctx);
    assert.equal(mock.calls.length, 1, 'first raw chunk has a persisted quarantine family');
    return { mock, strategy, manager, ctx, chunks };
  } catch (error) {
    manager.close();
    throw error;
  }
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
    assert.notStrictEqual(mock.calls[0].originalRequest!.messages[0],
      mock.calls[1].originalRequest!.messages[0], 'a mode rewrite owns its unchanged message wrappers');
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
    const exhausted = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!;
    const record = exhausted.record as Record<string, unknown>;
    assert.equal(record.canonicalProviderInputTokens, 90_000);
    assert.match(String(record.accountingSource), /provider_total_input/);
    const plan = record.plan as Array<Record<string, unknown>>;
    assert.ok(plan.length > 0);
    assert.ok(plan.every((item) => item.disposition === 'admission_rejected'));
    assert.ok(plan.every((item) => item.accountingSource === 'canonical_provider_usage_plus_expansion'));
    assert.ok(plan.every((item) => Number(item.boundedInputTokens) > 90_000));
    // The family's record keeps each variant the plan left unsent, with its planned size, after the canonical's refusal.
    const outcomes = exhausted.outcomes as Array<Record<string, unknown>>;
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['refusal', ...plan.map(() => 'admission_rejected')]);
    assert.deepEqual(
      outcomes.slice(1).map((outcome) => [outcome.admittedTokens, outcome.budgetTokens]),
      plan.map((item) => [item.admittedTokens, item.budgetTokens]),
    );
    fx.manager.close();
  });

  it('a recall variant a provider rejects is recorded with its planned size, as a refused one is', async () => {
    const rejected = Object.assign(new Error('zz invalid request'), { type: 'invalid_request', httpStatus: 400, retryable: false });
    const mock = flexibleMembrane([{ stop: 'refusal' }, { error: rejected }]);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 1 });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'the premise: the canonical, then one recall variant');
    const exhausted = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!;
    const plan = (exhausted.record as { plan: Array<Record<string, unknown>> }).plan;
    const variant = (exhausted.outcomes as Array<Record<string, unknown>>).find((outcome) => outcome.outcome === 'provider_error')!;
    assert.equal(variant.errorType, 'invalid_request');
    assert.deepEqual([variant.admittedTokens, variant.budgetTokens], [plan[0]!.admittedTokens, plan[0]!.budgetTokens]);
    fx.manager.close();
  });

  it('provider usage replaces the invariant UTF-8 floor after canonical refusal', async () => {
    const mock = flexibleMembrane([
      { stop: 'refusal', inputTokens: 120_000, cacheCreationTokens: 40_000, cacheReadTokens: 20_000, provider: 'anthropic' },
      { stop: 'end_turn', text: 'provider-counted fallback succeeded', inputTokens: 190_000 },
    ]);
    const fx = await fixture(mock.membrane, {
      compressionContextBudgetTokens: 350_000,
      compressionRefusalCurveFallbacks: 1,
      headWindowTokens: 100_000,
    });
    fx.manager.setToolDefinitions([{
      name: 'huge_invariant_tool_catalog',
      description: 'schema inventory '.repeat(30_000),
      inputSchema: {
        type: 'object',
        properties: { payload: { type: 'string', description: 'large field '.repeat(30_000) } },
      },
    }]);

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'observed canonical usage admits one fallback');
    assert.equal(fx.target.compressed, true);
    const requests = mock.calls.map((call) => Buffer.byteLength(JSON.stringify(call.request), 'utf8'));
    assert.ok(requests[0]! > 350_000, 'invariant serialized request exceeds the token budget numerically');
    const exhausted = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted');
    assert.equal(exhausted, undefined, 'successful fallback leaves no quarantine');
    fx.manager.close();
  });

  it('canonical provider accounting includes cache-write and cache-read tokens', async () => {
    const mock = flexibleMembrane([
      { stop: 'refusal', inputTokens: 2, cacheCreationTokens: 210_000, cacheReadTokens: 130_000, provider: 'anthropic' },
      { stop: 'end_turn', text: 'must never be called' },
    ]);
    const fx = await fixture(mock.membrane, {
      compressionContextBudgetTokens: 350_000,
      compressionRefusalCurveFallbacks: 3,
    });

    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'full cached canonical usage plus output reserve blocks fallbacks');
    const record = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!
      .record as Record<string, unknown>;
    assert.equal(record.canonicalProviderInputTokens, 340_002);
    const plan = record.plan as Array<Record<string, unknown>>;
    assert.ok(plan.length > 0);
    assert.ok(plan.every((item) => item.accountingSource === 'canonical_provider_usage_plus_expansion'));
    assert.ok(plan.every((item) => item.disposition === 'admission_rejected'));
    fx.manager.close();
  });

  it('Bedrock cache counters use the same disjoint accounting contract', async () => {
    const mock = flexibleMembrane([
      { stop: 'refusal', inputTokens: 2, cacheCreationTokens: 210_000, cacheReadTokens: 130_000, provider: 'bedrock' },
    ]);
    const fx = await fixture(mock.membrane, {
      compressionContextBudgetTokens: 350_000,
      compressionRefusalCurveFallbacks: 1,
    });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 1);
    const record = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!
      .record as Record<string, unknown>;
    assert.equal(record.canonicalProviderInputTokens, 340_002);
    fx.manager.close();
  });

  it('prefers detailed provider usage over the top-level basic usage mirror', async () => {
    const mock = flexibleMembrane([
      {
        stop: 'refusal',
        inputTokens: 100_000,
        topLevelInputTokens: 1,
        cacheCreationTokens: 120_000,
        cacheReadTokens: 80_000,
        provider: 'anthropic',
      },
    ]);
    const fx = await fixture(mock.membrane, {
      compressionContextBudgetTokens: 310_000,
      compressionRefusalCurveFallbacks: 1,
    });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'detailed total plus output reserve blocks the fallback');
    const record = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!
      .record as Record<string, unknown>;
    assert.equal(record.canonicalProviderInputTokens, 300_000);
    fx.manager.close();
  });

  it('does not double-count provider cache fields that are subsets of total input', async () => {
    const mock = flexibleMembrane([
      { stop: 'refusal', inputTokens: 200_000, cacheReadTokens: 150_000, provider: 'openai-responses-api' },
      { stop: 'end_turn', text: 'subset-accounted fallback succeeded', inputTokens: 220_000 },
    ]);
    const fx = await fixture(mock.membrane, {
      compressionContextBudgetTokens: 350_000,
      compressionRefusalCurveFallbacks: 1,
    });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'OpenAI cached input is not added twice');
    assert.equal(fx.target.compressed, true);
    fx.manager.close();
  });

  it('zero or partial non-Anthropic usage falls back to the complete request bound', async () => {
    const mock = flexibleMembrane([
      { stop: 'refusal', inputTokens: 0, cacheReadTokens: 5, provider: 'openai-responses-api' },
    ]);
    const fx = await fixture(mock.membrane, {
      compressionContextBudgetTokens: 60_000,
      compressionRefusalCurveFallbacks: 1,
    });
    fx.manager.setToolDefinitions([{
      name: 'large_zero_usage_tool',
      description: 'schema inventory '.repeat(20_000),
      inputSchema: { type: 'object', properties: {} },
    }]);
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'degenerate usage cannot bypass the deterministic floor');
    const record = quarantineEvents(fx.manager).find((event) => event.kind === 'exhausted')!
      .record as Record<string, unknown>;
    assert.equal(record.canonicalProviderInputTokens, undefined);
    assert.ok((record.plan as Array<Record<string, unknown>>).every(
      (item) => item.accountingSource === 'complete_normalized_request_bound',
    ));
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
      // cm #55 (2026-08-06): an empty generation is no longer a silent
      // skip — after the plain-prose retry also comes back empty, the
      // chunk exhausts into durable quarantine (bounded accounting for
      // every non-success outcome; previously this re-attempted on every
      // maintenance pass forever).
      const mock = flexibleMembrane([{ stop: 'end_turn', text: '' }]);
      const fx = await fixture(mock.membrane);
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(fx.target.compressed, false);
      const exhausted = quarantineEvents(fx.manager).filter((event) => event.kind === 'exhausted');
      assert.equal(exhausted.length, 1, 'empty generations exhaust durably now');
      const outcomes = exhausted[0]!.outcomes as Array<{ outcome: string; curveLabel: string }>;
      assert.ok(outcomes.every((o) => o.outcome === 'unusable_empty'));
      assert.ok(outcomes.some((o) => o.curveLabel === 'canonical-plain-prose'), 'prose retry was attempted first');
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

  it('tick skips an already-quarantined chunk and compresses the next eligible chunk (#55)', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      const next: Chunk = { ...fx.target, index: 1, messages: ctx.messageStore.getAll().slice(12, 14) };
      fx.strategy.setTickWork([fx.target, next], []);
      await fx.strategy.run(fx.target, ctx);
      assert.equal(mock.calls.length, 1, 'the first attempt creates real durable quarantine');
      fx.strategy.setTickWork([fx.target, next], [0, 1]);
      await fx.strategy.tick(ctx);
      assert.equal(mock.calls.length, 2, 'one tick must reach the eligible chunk behind quarantine');
      assert.equal(fx.target.compressed, false);
      assert.equal(next.compressed, true);
      assert.deepEqual(fx.strategy.compressionQueueView(), []);
    } finally {
      fx.manager.close();
    }
  });

  it('tick reaches a queued merge after an already-quarantined raw chunk (#55)', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0, hierarchical: true });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      fx.strategy.setTickWork([fx.target], []);
      await fx.strategy.run(fx.target, ctx);
      assert.equal(mock.calls.length, 1);
      fx.strategy.setTickWork([fx.target], [0], [{ level: 3, sourceIds: fx.parents.map((p) => p.id) }]);
      await fx.strategy.tick(ctx);
      assert.equal(mock.calls.length, 2, 'the merge must run in the same tick as the no-op skip');
      assert.deepEqual(fx.strategy.mergeQueueView(), []);
      assert.equal(fx.target.compressed, false);
      assert.ok(fx.strategy.summariesView().some((s) => s.level === 3));
    } finally {
      fx.manager.close();
    }
  });

  it('one tick exhausts an all-quarantined queue without provider calls, warning once per chunk (#55)', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      const next: Chunk = { ...fx.target, index: 1, messages: ctx.messageStore.getAll().slice(12, 14) };
      fx.strategy.setTickWork([fx.target, next], []);
      await fx.strategy.run(fx.target, ctx);
      await fx.strategy.run(next, ctx);
      assert.equal(mock.calls.length, 2);
      const warnings: string[] = [];
      const previous = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
      try {
        for (let repeat = 0; repeat < 2; repeat++) {
          fx.strategy.setTickWork([{ ...fx.target }, { ...next }], [0, 1]);
          await fx.strategy.tick(ctx);
          assert.deepEqual(fx.strategy.compressionQueueView(), []);
        }
      } finally {
        console.warn = previous;
      }
      assert.equal(mock.calls.length, 2, 'quarantine skip must not attempt the provider');
      assert.equal(warnings.filter((w) => w.includes('compression quarantine skipped')).length, 2);
    } finally {
      fx.manager.close();
    }
  });

  it('a newly refused compression still consumes the tick (#55)', async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0, hierarchical: true });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      fx.strategy.setTickWork([fx.target], [0], [{ level: 3, sourceIds: fx.parents.map((p) => p.id) }]);
      await fx.strategy.tick(ctx);
      assert.equal(mock.calls.length, 1, 'a paid attempt must not fall through into a second work item');
      assert.equal(fx.strategy.mergeQueueView().length, 1);
      assert.equal(fx.target.compressed, false);
    } finally {
      fx.manager.close();
    }
  });

  it('a tick bounds quarantine scanning even if an await replenishes the queue (#55)', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0, hierarchical: true });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      fx.strategy.setTickWork([fx.target], []);
      await fx.strategy.run(fx.target, ctx);
      const merges = [{ level: 3, sourceIds: fx.parents.map((p) => p.id) }];
      fx.strategy.setTickWork([fx.target], [0], merges);
      let visited = 0;
      fx.strategy.afterCompression(() => {
        assert.equal(++visited, 1, 'a re-enqueued skip must not extend this tick indefinitely');
        fx.strategy.setTickWork([fx.target], [0], merges);
      });
      await fx.strategy.tick(ctx);
      assert.equal(visited, 1);
      assert.equal(mock.calls.length, 2, 'the bounded scan must still reach a pending merge');
      assert.deepEqual(fx.strategy.compressionQueueView(), [0], 'replenished work belongs to a later tick');
    } finally {
      fx.manager.close();
    }
  });

  it('a legacy two-argument compression override still consumes at most one item per tick (#55)', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0, hierarchical: true });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      fx.strategy.setTickWork([fx.target], []);
      await fx.strategy.run(fx.target, ctx);
      fx.strategy.setTickWork([fx.target], [0], [{ level: 3, sourceIds: fx.parents.map((p) => p.id) }]);
      fx.strategy.installLegacyCompressionOverride();
      await fx.strategy.tick(ctx);
      assert.equal(mock.calls.length, 1);
      assert.equal(fx.strategy.mergeQueueView().length, 1, 'without a skip notification retain the prior scheduling contract');
    } finally {
      fx.manager.close();
    }
  });

  it('a branch switch during a quarantine skip stops the old tick before it can merge (#55)', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0, hierarchical: true });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      fx.strategy.setTickWork([fx.target], []);
      await fx.strategy.run(fx.target, ctx);
      fx.strategy.setTickWork([fx.target], [0]);
      fx.strategy.afterCompression(async () => {
        await fx.manager.fork('after-quarantine-skip');
        fx.strategy.setTickWork([fx.target], [], [{ level: 3, sourceIds: fx.parents.map((p) => p.id) }]);
      });
      await fx.strategy.tick(ctx);
      assert.equal(fx.manager.currentBranch().name, 'after-quarantine-skip');
      assert.equal(mock.calls.length, 1, 'old branch work must not consume the new branch merge queue');
      assert.equal(fx.strategy.mergeQueueView().length, 1);
    } finally {
      fx.manager.close();
    }
  });

  it('stale compression indexes do not block the next queued chunk (#55)', async () => {
    const mock = scriptedMembrane(['end_turn']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      fx.strategy.setTickWork([fx.target], [999, 0]);
      await fx.strategy.tick(ctx);
      assert.equal(mock.calls.length, 1);
      assert.equal(fx.target.compressed, true);
    } finally {
      fx.manager.close();
    }
  });

  it("a scan that yields after a quarantine skip leaves newer pending work alone", async () => {
    const mock = scriptedMembrane(['refusal']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      fx.strategy.setTickWork([fx.target], []);
      await fx.strategy.run(fx.target, ctx);
      fx.strategy.setTickWork([fx.target], [0]);
      const lane = fx.strategy as unknown as { pendingCompression: Promise<void> | null };
      const newer = new Promise<void>(() => {});
      // As after a branch switch: newer work takes the lane while the scan is in its skip.
      fx.strategy.afterCompression(() => { lane.pendingCompression = newer; });
      await fx.strategy.tick(ctx);
      assert.equal(lane.pendingCompression, newer, "the stale scan's finally leaves the newer work's ownership");
    } finally {
      fx.manager.close();
    }
  });

  it('an identity first queued during the scan waits for the next tick', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      const next: Chunk = { ...fx.target, index: 1, messages: ctx.messageStore.getAll().slice(12, 14) };
      fx.strategy.setTickWork([fx.target, next], []);
      await fx.strategy.run(fx.target, ctx);
      assert.equal(mock.calls.length, 1);
      // Only the quarantined chunk is queued when the scan takes its snapshot.
      fx.strategy.setTickWork([fx.target, next], [0]);
      let queuedNext = false;
      fx.strategy.afterCompression(() => {
        if (queuedNext) return;
        queuedNext = true;
        fx.strategy.setTickWork([fx.target, next], [1]);
      });
      await fx.strategy.tick(ctx);
      assert.equal(mock.calls.length, 1, 'the identity queued during the scan waits');
      assert.deepEqual(fx.strategy.compressionQueueView(), [1]);
      await fx.strategy.tick(ctx);
      assert.equal(mock.calls.length, 2, 'and runs at the next tick');
      assert.equal(next.compressed, true);
    } finally {
      fx.manager.close();
    }
  });

  it('a queued chunk compressed during the scan\'s yield is passed over', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      const next: Chunk = { ...fx.target, index: 1, messages: ctx.messageStore.getAll().slice(12, 14) };
      fx.strategy.setTickWork([fx.target, next], []);
      await fx.strategy.run(fx.target, ctx);
      fx.strategy.setTickWork([fx.target, next], [0, 1]);
      // Another producer compresses the next chunk while the scan yields after its skip.
      fx.strategy.afterCompression((chunk) => { if (chunk === fx.target) next.compressed = true; });
      await fx.strategy.tick(ctx);
      assert.equal(mock.calls.length, 1, 'no call for a chunk already compressed');
      assert.deepEqual(fx.strategy.compressionQueueView(), []);
    } finally {
      fx.manager.close();
    }
  });

  it('the speculative drain goes on past a tick that only consumed a quarantine skip', async () => {
    const mock = scriptedMembrane(['refusal', 'end_turn']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      const next: Chunk = { ...fx.target, index: 1, messages: ctx.messageStore.getAll().slice(12, 14) };
      fx.strategy.setTickWork([fx.target, next], []);
      await fx.strategy.run(fx.target, ctx);
      fx.strategy.setTickWork([fx.target, next], [0]);
      let queuedNext = false;
      fx.strategy.afterCompression(() => {
        if (queuedNext) return;
        queuedNext = true;
        fx.strategy.setTickWork([fx.target, next], [1]);
      });
      // The first tick consumes only the skip; the drain must still run the next one.
      (fx.strategy as unknown as { driveSpeculativeDrain(ctx: StrategyContext): void }).driveSpeculativeDrain(ctx);
      const deadline = Date.now() + 10_000;
      while (!next.compressed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(next.compressed, true, 'the drain reached the next chunk');
      assert.equal(mock.calls.length, 2);
      // Let the drain's last hop find the queue empty and stop before the store closes.
      const lane = fx.strategy as unknown as { pendingCompression: Promise<void> | null };
      while (lane.pendingCompression !== null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      fx.manager.close();
    }
  });

  it('quarantine scanning yields to inbound events while keeping pending work owned (#55)', async () => {
    const events: string[] = [];
    let calls = 0;
    const membrane = {
      complete: async () => {
        events.push(`provider-${++calls}`);
        return calls === 1 ? response('refusal') : response('end_turn', 'a successful next memory');
      },
    };
    const fx = await fixture(membrane, { compressionRefusalCurveFallbacks: 0 });
    let event: Promise<void> | undefined;
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      const next: Chunk = { ...fx.target, index: 1, messages: ctx.messageStore.getAll().slice(12, 14) };
      fx.strategy.setTickWork([fx.target, next], []);
      await fx.strategy.run(fx.target, ctx);
      fx.strategy.setTickWork([fx.target, next], [0, 1]);
      let pendingAtEvent = false;
      let callsAfterReentrantTick = 0;
      fx.strategy.afterCompression(() => {
        if (event) return;
        // Schedule an event after the quarantine check, before the next raw
        // chunk. A resolved-promise loop would starve it until the tick ends.
        event = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            events.push('inbound-event');
            pendingAtEvent = !!fx.strategy.checkReadiness().pendingWork;
            fx.strategy.tick(ctx).then(() => {
              callsAfterReentrantTick = calls;
              resolve();
            }, reject);
          }, 0);
        });
      });
      await fx.strategy.tick(ctx);
      await event;
      assert.deepEqual(events, ['provider-1', 'inbound-event', 'provider-2']);
      assert.equal(pendingAtEvent, true, 'the cooperative yield remains owned pending work');
      assert.equal(callsAfterReentrantTick, 1, 'an inbound tick cannot start competing compression');
      assert.equal(next.compressed, true);
    } finally {
      await event;
      fx.manager.close();
    }
  });

  it('an inbound queue rebuild cannot spend the scan twice on the same quarantined chunk (#55)', async () => {
    const fx = await queuedRawFixture();
    const rebuilds: Promise<void>[] = [];
    const replacedObjects: boolean[] = [];
    const inspected: string[][] = [];
    try {
      fx.strategy.afterCompression((chunk) => {
        inspected.push(chunk.messages.map((m) => m.id));
        if (chunk.compressed) return;
        // This event runs during tick's cooperative yield. The real manager
        // invokes onNewMessage, replacing chunk objects and restoring [0, 1].
        rebuilds.push(new Promise<void>((resolve) => setTimeout(() => {
          fx.manager.addMessage('User', [text('inbound while the quarantined chunk yields')]);
          replacedObjects.push(fx.strategy.chunksView()[0] !== chunk);
          resolve();
        }, 0)));
      });
      await fx.strategy.tick(fx.ctx);
      await Promise.all(rebuilds);
      assert.equal(fx.mock.calls.length, 2, 'one tick reaches the eligible raw chunk despite the rebuilt head');
      assert.ok(replacedObjects.length > 0 && replacedObjects.every(Boolean));
      assert.deepEqual(inspected, fx.chunks.map((c) => c.messages.map((m) => m.id)));
      assert.ok(fx.strategy.summariesView().some((s) => s.sourceIds.join(':') === fx.chunks[1].messages.map((m) => m.id).join(':')));
    } finally {
      await Promise.all(rebuilds);
      fx.manager.close();
    }
  });

  it('a skipped quarantined chunk waits behind fresh work after the next rebuild', async () => {
    const fx = await queuedRawFixture();
    try {
      await fx.strategy.tick(fx.ctx);
      assert.equal(fx.mock.calls.length, 2, 'the tick skipped the quarantined chunk and compressed the next');
      // Inbound traffic rebuilds the queue: the quarantined chunk is raw, so
      // it is queued again, beside the chunks the new messages closed.
      for (let i = 0; i < 8; i++) fx.manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`fresh-${i} ` + 'word '.repeat(30))]);
      const quarantinedIds = fx.chunks[0].messages.map((m) => m.id).join(':');
      const chunks = fx.strategy.chunksView();
      const quarantined = chunks.findIndex((chunk) => chunk.messages.map((m) => m.id).join(':') === quarantinedIds);
      const queue = fx.strategy.compressionQueueView();
      assert.ok(quarantined >= 0 && queue.includes(quarantined), 'the quarantined chunk is queued again');
      assert.ok(queue.some((index) => index !== quarantined && !chunks[index]!.compressed), 'fresh chunks are queued');
      assert.equal(queue.at(-1), quarantined, 'it waits behind the fresh chunks, so they are built first');
    } finally {
      fx.manager.close();
    }
  });

  it('a skipped quarantined chunk that a rebuild queues again during its yield still waits behind fresh work', async () => {
    const fx = await queuedRawFixture();
    const quarantinedIds = fx.chunks[0].messages.map((m) => m.id).join(':');
    const rebuilds: Promise<void>[] = [];
    try {
      fx.strategy.afterCompression((chunk) => {
        if (chunk.compressed || chunk.messages.map((m) => m.id).join(':') !== quarantinedIds) return;
        // Inbound traffic during the skip's yield: its rebuild queues the
        // quarantined chunk again, beside the chunks the new messages close,
        // before tick has given it a failure order.
        rebuilds.push(new Promise<void>((resolve) => setTimeout(() => {
          for (let i = 0; i < 8; i++) fx.manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`fresh-${i} ` + 'word '.repeat(30))]);
          resolve();
        }, 0)));
      });
      await fx.strategy.tick(fx.ctx);
      await Promise.all(rebuilds);
      assert.equal(rebuilds.length, 1, 'the premise: the rebuild ran during the skip');
      assert.equal(fx.mock.calls.length, 2, 'the tick skipped the quarantined chunk and compressed the next');
      const chunks = fx.strategy.chunksView();
      const quarantined = chunks.findIndex((chunk) => chunk.messages.map((m) => m.id).join(':') === quarantinedIds);
      const queue = fx.strategy.compressionQueueView();
      assert.ok(quarantined >= 0 && queue.includes(quarantined), 'the quarantined chunk is queued again');
      assert.ok(queue.some((index) => index !== quarantined && !chunks[index]!.compressed), 'fresh chunks are queued');
      assert.equal(queue.at(-1), quarantined, 'it waits behind the fresh chunks, so they are built first');
    } finally {
      await Promise.all(rebuilds);
      fx.manager.close();
    }
  });

  it('a rebuilt scan resolves original source identities at their current queue indexes (#55)', async () => {
    const fx = await queuedRawFixture();
    const rebuilt = fx.chunks.map((chunk, index) => ({ ...chunk, index: 1 - index })).reverse();
    try {
      let visited = 0;
      fx.strategy.afterCompression((chunk) => {
        visited++;
        if (!chunk.compressed) fx.strategy.setTickWork(rebuilt, [1, 0]);
      });
      await fx.strategy.tick(fx.ctx);
      assert.equal(visited, 2);
      assert.equal(fx.mock.calls.length, 2);
      assert.equal(rebuilt[0].compressed, true, 'the relocated eligible chunk, not a stale object, is compressed');
      assert.equal(rebuilt[1].compressed, false);
    } finally {
      fx.manager.close();
    }
  });

  it('a rebuilt queue can withdraw an original candidate without the scan resurrecting it (#55)', async () => {
    const fx = await queuedRawFixture();
    try {
      let inspected = 0;
      fx.strategy.afterCompression(() => {
        inspected++;
        fx.strategy.setTickWork(fx.chunks.map((chunk) => ({ ...chunk })), [0]);
      });
      await fx.strategy.tick(fx.ctx);
      assert.equal(inspected, 1, 'each original source is inspected at most once');
      assert.equal(fx.mock.calls.length, 1, 'withdrawn eligible work must stay withdrawn');
      assert.deepEqual(fx.strategy.compressionQueueView(), [0]);
    } finally {
      fx.manager.close();
    }
  });

  it('an all-stale compression queue clears readiness with no candidate identities (#55)', async () => {
    const mock = scriptedMembrane(['end_turn']);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    try {
      const ctx = managerContext(fx.manager);
      fx.target.index = 0;
      fx.strategy.setTickWork([fx.target], []);
      await fx.strategy.run(fx.target, ctx);
      assert.equal(fx.target.compressed, true);
      const unqueued: Chunk = {
        index: 1, startIndex: 12, endIndex: 14,
        messages: ctx.messageStore.getAll().slice(12, 14),
        tokens: 100, compressed: false,
      };
      fx.strategy.setTickWork([fx.target, unqueued], [999, 0]);
      assert.equal(fx.strategy.checkReadiness().ready, false, 'raw work plus stale queued entries blocks readiness');
      await fx.strategy.tick(ctx);
      assert.equal(mock.calls.length, 1, 'stale cleanup does not call the provider');
      assert.deepEqual(fx.strategy.compressionQueueView(), []);
      assert.equal(unqueued.compressed, false, 'unqueued raw work stays raw');
      assert.equal(fx.strategy.checkReadiness().ready, true, 'removing the stale entries clears readiness');
    } finally {
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

  it('a new accounting version is not blocked by the old per-chunk shape cap', async () => {
    const path = freshPath();
    const firstMock = scriptedMembrane(['refusal']);
    const first = await fixture(firstMock.membrane, { compressionRefusalCurveFallbacks: 0 }, path);
    const targetIds = first.target.messages.map((message) => message.id);
    await first.strategy.run(first.target, managerContext(first.manager));
    const exhausted = quarantineEvents(first.manager).find((event) => event.kind === 'exhausted')!;
    const current = exhausted.record as Record<string, unknown>;
    await first.strategy.clearCompressionRefusalQuarantine(String(current.key));
    for (let i = 0; i < 3; i++) {
      const legacyConfig = { ...(current.normalizedConfig as Record<string, unknown>) };
      delete legacyConfig.accountingVersion;
      const legacy: Record<string, unknown> = {
        ...structuredClone(current),
        key: `legacy-key-${i}`,
        familyKey: `legacy-family-${i}`,
        accountingSource: 'legacy-byte-wall',
        normalizedConfig: legacyConfig,
      };
      if (i === 0) delete legacy.normalizedConfig;
      first.manager.getStore().appendToStateJsonWithIdentity(
        'default/autobio:compression-refusal-quarantine-events',
        { kind: 'exhausted', key: legacy.key, record: legacy, created: Date.now() + i },
        'eventId',
        'sequence',
      );
    }
    first.manager.close();

    const retryMock = scriptedMembrane(['end_turn']);
    const retried = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
    });
    const manager = await ContextManager.open({ path, strategy: retried, membrane: retryMock.membrane });
    const ctx = managerContext(manager);
    const chunk: Chunk = {
      index: 999,
      startIndex: 10,
      endIndex: 12,
      messages: targetIds.map((id) => ctx.messageStore.get(id)!).filter(Boolean),
      tokens: 100,
      compressed: false,
    };
    await retried.run(chunk, ctx);
    assert.equal(retryMock.calls.length, 1, 'v2 accounting earns one fresh canonical attempt');
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
    const firstMock = flexibleMembrane([{ stop: 'refusal', inputTokens: 20_000 }]);
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
    // hold the first until the second has joined, so the race is real.
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

    // Release the held call only once the second producer has joined it:
    // arriving later, it would reload the durable summary instead, and the
    // test would pass without the in-flight registry.
    const joins = observeInFlightJoins();
    let runs: Promise<unknown>;
    try {
      runs = Promise.all([
        first.strategy.run(first.target, managerContext(first.manager)),
        second.run(secondChunk, secondCtx),
      ]);
      await until(() => joins.count() >= 1, 'the second producer to join the in-flight call');
      assert.equal(entered, 1, 'joined while the first call is held');
    } finally {
      joins.restore();
      release();
    }
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

  type LanePause = { statedUntil: number | null; statedBy: string | null; backoffUntil: number; failures: number } | null;
  const lanePause = (strategy: unknown): LanePause => (strategy as { compressionPause: LanePause }).compressionPause;

  /**
   * Two instances on one store, the second joining the first's in-flight call,
   * which fails with `error`. `seed` runs on the second before it joins.
   */
  async function coalescedFailure(
    error: Error,
    seed?: (strategy: ProbeStrategy, ctx: StrategyContext) => void,
    options: { secondMembrane?: unknown } = {},
  ) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const concurrent = {
      complete: async () => {
        calls++;
        await gate;
        throw error;
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
    const secondManager = await ContextManager.open({ store: first.manager.getStore(), strategy: second, membrane: (options.secondMembrane ?? concurrent) as never });
    const secondCtx = managerContext(secondManager);
    const secondMessages = first.target.messages.map(
      (message) => secondCtx.messageStore.get(message.id),
    ).filter(Boolean) as StoredMessage[];
    const secondChunk = { ...first.target, messages: secondMessages, compressed: false };
    seed?.(second, secondCtx);
    const joins = observeInFlightJoins();
    const before = Date.now();
    let runs: Promise<PromiseSettledResult<unknown>[]>;
    try {
      runs = Promise.allSettled([
        first.strategy.run(first.target, managerContext(first.manager)),
        second.run(secondChunk, secondCtx),
      ]);
      await until(() => joins.count() >= 1, 'the second producer to join the in-flight call');
    } finally {
      joins.restore();
      release();
    }
    const [producer, waiter] = await runs;
    assert.equal(calls, 1, "one provider call, the producer's");
    assert.equal(producer!.status, 'rejected');
    assert.equal(waiter!.status, 'rejected');
    assert.equal((waiter as PromiseRejectedResult).reason, error, "the waiter rethrows the producer's failure");
    return {
      before,
      pause: lanePause(second),
      producerPause: lanePause(first.strategy),
      close: () => {
        secondManager.close();
        first.manager.close();
      },
    };
  }

  it("a waiter on another instance's call takes the provider's stated wait from its failure, counting none", async () => {
    const limited = Object.assign(new Error('zz rate limited'), { type: 'rate_limit', httpStatus: 429, retryAfterMs: 120_000 });
    const { before, pause, close } = await coalescedFailure(limited);
    assert.ok(pause && pause.statedUntil !== null && pause.statedUntil >= before + 120_000,
      "the waiter's lane holds for the provider's stated wait, so it doesn't send the same request inside it");
    assert.equal(pause!.failures, 0, 'no failure counted: none of its calls failed');
    assert.equal(pause!.backoffUntil, 0, 'and no backoff of its own');
    close();
  });

  it("a waiter on another membrane takes no pause from the producer's stated wait: the provider stated it for the producer's route", async () => {
    const limited = Object.assign(new Error('zz rate limited'), { type: 'rate_limit', httpStatus: 429, retryAfterMs: 120_000 });
    const elsewhere = { complete: async () => { throw new Error('zz the waiter makes no call of its own'); } };
    const { pause, producerPause, close } = await coalescedFailure(limited, undefined, { secondMembrane: elsewhere });
    assert.ok(producerPause && producerPause.statedUntil !== null, "premise: the producer's own lane holds for the stated wait");
    assert.equal(pause, null, "the waiter's route stated no wait, so its lane takes none");
    close();
  });

  it("with no stated wait, the waiter's lane takes no pause from another instance's failure", async () => {
    const unavailable = Object.assign(new Error('zz overloaded'), { type: 'server', httpStatus: 503, retryable: true });
    const { pause, close } = await coalescedFailure(unavailable);
    assert.equal(pause, null, 'nothing to hold for: its own calls failed none, and the provider stated no wait');
    close();
  });

  it("a waiter with a backoff of its own keeps it, and its failure count, when it takes another instance's stated wait", async () => {
    const limited = Object.assign(new Error('zz rate limited'), { type: 'rate_limit', httpStatus: 429, retryAfterMs: 120_000 });
    const backoffUntil = Date.now() + 600_000;
    const { before, pause, close } = await coalescedFailure(limited, (strategy, ctx) => {
      (strategy as unknown as { compressionPause: unknown }).compressionPause = {
        backoffUntil, statedUntil: null, statedBy: null, failures: 4, membrane: ctx.membrane, model: MODEL, reason: 'zz its own earlier failure',
      };
    });
    assert.ok(pause && pause.statedUntil !== null && pause.statedUntil >= before + 120_000, 'it takes the stated wait');
    assert.equal(pause!.backoffUntil, backoffUntil, 'its own backoff stands');
    assert.equal(pause!.failures, 4, 'and so does its failure count');
    close();
  });

  it("a deferral by the producer's provider admission gives the waiter's lane no pause, since no call was made", async () => {
    const deferral = Object.assign(new Error('zz held; no call was made'), {
      type: 'rate_limit', retryable: true, providerAdmission: 'deferred', retryAfterMs: 120_000,
    });
    const { pause, producerPause, close } = await coalescedFailure(deferral);
    assert.equal(producerPause?.statedBy, 'admission', "the premise: the producer's own lane holds the admission's answer");
    assert.equal(pause, null, "no provider stated a wait: the waiter's next attempt asks the admission itself");
    close();
  });

  it("an aborted call gives the waiter's lane no pause, even with a stated wait on its error", async () => {
    const aborted = Object.assign(new Error('zz aborted'), { name: 'AbortError', retryAfterMs: 60_000 });
    const { pause, close } = await coalescedFailure(aborted);
    assert.equal(pause, null, "only a real call's transient failure paces the waiter");
    close();
  });

  it("a waiter on another instance's compression keeps its own kv-unified submission in flight, and still takes up the store (#166)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const producing = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const concurrent = {
      complete: async () => {
        calls++;
        entered();
        await gate;
        return response('end_turn', 'one durable result');
      },
    } as never;
    const path = freshPath();
    const first = await fixture(concurrent, { compressionRefusalCurveFallbacks: 0 }, path);
    const second = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 100,
      headWindowTokens: 0,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      compressionRefusalCurveFallbacks: 0,
      adaptiveResolution: true,
      foldingStrategy: 'kv-unified',
      kvUnified: {
        policy: {
          alpha: 0.7,
          budgetLowRatio: 0.5,
          budgetHighRatio: 0.9,
          budgetUnderLambda: 10,
          budgetOverLambda: 10,
          cacheLambda: 1,
          cacheScale: 1000,
          cacheReadPrice: 0.1,
          cacheWritePrice: 1.25,
          continuityLambda: 1,
          continuityScale: 1000,
          continuityRecencyHalfLifeTokens: 1000,
          continuityRecencyFloor: 0.2,
          continuityStableHalfLife: 10,
          continuityStableFloor: 0.25,
        },
        tokenBucketSize: 100,
        continuityBucketSize: 100,
        fidelityBucketSize: 100,
        labelCeiling: 10_000,
        adoptEpsilon: 0,
        treeifyNonContiguousSummaries: false,
        preserveGapBearingSummaries: false,
      },
    } as never);
    const secondManager = await ContextManager.open({
      store: first.manager.getStore(),
      strategy: second,
      membrane: concurrent,
    });
    // The waiter has a presentation in flight: compiled and submitted, not yet accepted.
    await secondManager.compile(
      { maxTokens: 10_000, reserveForResponse: 0 },
      undefined,
      { kvUnifiedImmutablePrefixHash: 'immutable-v1' },
    );
    second.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
    const presentation = second as unknown as {
      kvUnifiedDraft: unknown;
      kvUnifiedPendingLayout: unknown;
      kvUnifiedPendingMarkerUnitIndices: number[];
    };
    const draft = presentation.kvUnifiedDraft;
    const submittedLayout = presentation.kvUnifiedPendingLayout;
    assert.ok(draft && submittedLayout, 'compiled and submitted');
    const markerCount = presentation.kvUnifiedPendingMarkerUnitIndices.length;

    const secondCtx = managerContext(secondManager);
    const secondMessages = first.target.messages.map(
      (message) => secondCtx.messageStore.get(message.id),
    ).filter(Boolean) as StoredMessage[];
    const secondChunk = { ...first.target, messages: secondMessages, compressed: false };
    // The waiter's reloads, to show its compression took the coalesced path.
    const reloads: unknown[] = [];
    const probe = second as unknown as { loadPersistedState(options?: unknown): void };
    const reload = probe.loadPersistedState.bind(second);
    probe.loadPersistedState = (options?: unknown) => {
      reloads.push(options);
      reload(options);
    };
    // The first instance's compression is the producer: the second starts only
    // once the first is in its provider call, so it finds the family in flight.
    // compressChunkHierarchical reaches that wait before its first await, so
    // the second has joined it when run() returns its promise.
    const producer = first.strategy.run(first.target, managerContext(first.manager));
    await producing;
    const waiter = second.run(secondChunk, secondCtx);
    // While the second waits, the first writes to the store's shared mirrors.
    const pinId = first.strategy.pinRange(first.ids[12]!, first.ids[13]!);
    release();
    await Promise.all([producer, waiter]);
    assert.equal(calls, 1, 'the second compression waited on the first');
    assert.equal(secondChunk.compressed, true, 'the waiter took up the durable L1');
    assert.ok(second.pinsView().some((pin) => pin.id === pinId), "the waiter took up the other instance's pin");
    const chain = (second as unknown as {
      kvUnifiedReceipts: { inFlightSubmissionId: string | null; head: unknown; cache: { layout: unknown } | null };
    }).kvUnifiedReceipts;
    assert.equal(chain.inFlightSubmissionId, 's1', 'the submission begun before the wait is still in flight');
    assert.deepEqual(reloads, [{ keepKvUnifiedPresentation: true }], 'it took the coalesced path, reloading once');
    assert.equal(presentation.kvUnifiedDraft, draft, 'the draft is kept');
    assert.equal(presentation.kvUnifiedPendingLayout, submittedLayout, 'the submitted layout is kept');

    second.reportKvUnifiedAccepted({
      submissionId: 's1',
      acceptedAt: 123,
      wireReceipt: {
        requestHash: 'wire1',
        markers: Array.from({ length: markerCount }, (_, ordinal) => ({
          ordinal,
          prefixHash: `prefix-${ordinal}`,
          estimatedOffset: ordinal + 1,
        })),
      },
    });
    assert.ok(chain.head, 'the acceptance committed the presentation');
    assert.equal(chain.cache?.layout, submittedLayout, 'with the layout it was submitted with');
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
    // Both calls in flight at once before either is released: had the second
    // joined the first, this would never be reached.
    try {
      await until(() => calls.length >= 2, 'both namespaces to call the provider');
    } finally {
      release();
    }
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

  const kvUnifiedOptions = {
    recentWindowTokens: 100,
    adaptiveResolution: true,
    foldingStrategy: 'kv-unified',
    kvUnified: {
      policy: {
        alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
        cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25,
        continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
        continuityStableHalfLife: 10, continuityStableFloor: 0.25,
      },
      tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
      treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
    },
  } as never;

  /** Another instance on the same store, which compresses the target and merges its L1. */
  async function otherInstance(fx: Fixture, membrane: unknown) {
    const other = new ProbeStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
    });
    const manager = await ContextManager.open({ store: fx.manager.getStore(), strategy: other, membrane: membrane as never });
    const ids = fx.target.messages.map((message) => message.id);
    const write = () => {
      const l1 = summary('L1-900', 1, ids, ids[0]!, ids.at(-1)!, 20, "the other instance's L1");
      other.seed(l1);
      other.seed(summary('L2-901', 2, [l1.id], ids[0]!, ids.at(-1)!, 20, "the other instance's L2"));
      other.linkChild(l1, 'L2-901');
    };
    return { manager, ids, write };
  }

  it("a compression adopts an L1 another instance wrote before it started, with the summary above it, and calls no provider", async () => {
    let calls = 0;
    const membrane = { complete: async () => { calls++; return response('end_turn', 'not needed'); } };
    const fx = await fixture(membrane, { compressionRefusalCurveFallbacks: 0 });
    const other = await otherInstance(fx, membrane);
    other.write();
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(calls, 0, 'no provider call');
    assert.equal(fx.target.compressed, true);
    assert.equal(fx.target.summaryId, 'L1-900');
    const held = new Map(fx.strategy.summariesView().map((entry) => [entry.id, entry]));
    assert.equal(held.get('L1-900')?.mergedInto, 'L2-901', 'it holds the L1 with the summary above it');
    assert.ok(held.has('L2-901'));
    other.manager.close();
    fx.manager.close();
  });

  it("a compression whose L1 another instance writes during the provider call adopts it, keeping its own kv-unified submission in flight", async () => {
    let calls = 0;
    let other!: Awaited<ReturnType<typeof otherInstance>>;
    const membrane = {
      complete: async () => {
        calls++;
        other.write();
        return response('end_turn', 'a paid result the other instance made redundant');
      },
    };
    const fx = await fixture(membrane, { compressionRefusalCurveFallbacks: 0, ...(kvUnifiedOptions as object) });
    other = await otherInstance(fx, membrane);
    await fx.manager.compile({ maxTokens: 10_000, reserveForResponse: 0 }, undefined, { kvUnifiedImmutablePrefixHash: 'immutable-v1' });
    fx.strategy.beginKvUnifiedSubmission({ submissionId: 's1', requestHash: 'wire1', layoutHash: 'layout1' });
    const presentation = fx.strategy as unknown as {
      kvUnifiedDraft: unknown;
      kvUnifiedPendingLayout: unknown;
      kvUnifiedReceipts: { inFlightSubmissionId: string | null };
    };
    const draft = presentation.kvUnifiedDraft;
    const submittedLayout = presentation.kvUnifiedPendingLayout;
    assert.ok(draft && submittedLayout, 'compiled and submitted');
    const reloads: unknown[] = [];
    const probe = fx.strategy as unknown as { loadPersistedState(options?: unknown): void };
    const reload = probe.loadPersistedState.bind(fx.strategy);
    probe.loadPersistedState = (options?: unknown) => {
      reloads.push(options);
      reload(options);
    };
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(calls, 1, 'the compression made its call');
    assert.equal(fx.target.summaryId, 'L1-900', 'then adopted the L1 the other instance wrote meanwhile');
    const overTarget = fx.strategy.summariesView().filter((entry) => entry.level === 1 && entry.sourceIds.join(':') === other.ids.join(':'));
    assert.deepEqual(overTarget.map((entry) => entry.id), ['L1-900'], 'and stored no second L1 over the same messages');
    assert.ok(fx.strategy.summariesView().some((entry) => entry.id === 'L2-901'), 'it holds the summary above it');
    assert.deepEqual(reloads, [{ keepKvUnifiedPresentation: true }], 'the lookup reloaded once, keeping the presentation');
    assert.equal(presentation.kvUnifiedReceipts.inFlightSubmissionId, 's1', 'the submission is still in flight');
    assert.equal(presentation.kvUnifiedDraft, draft, 'the draft is kept');
    assert.equal(presentation.kvUnifiedPendingLayout, submittedLayout, 'the submitted layout is kept');
    other.manager.close();
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
        /requires successful strategy initialization/,
      );
      const currentCtx = managerContext(fx.manager);
      await assert.rejects(
        fx.strategy.onNewMessage(currentCtx.messageStore.get(fx.ids[0]!)!, currentCtx),
        /requires reinitialization for the current branch generation/,
      );
      await assert.rejects(
        fx.manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }),
        /requires successful strategy initialization/,
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

describe('prepared recall expansions', () => {
  after(cleanup);
  it('retains expansion eligibility and prices/hashes the prepared requests for parent and child data URLs', async () => {
    for (const location of ['parent', 'child']) {
      const mock = flexibleMembrane([
        { stop: 'refusal', omitUsage: true }, { stop: 'refusal', omitUsage: true }, { stop: 'refusal', omitUsage: true },
      ]);
      const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 2 });
      const payload = 'U'.repeat(20000);
      const entry = location === 'parent' ? fx.parents[1] : fx.children[2];
      // Two data URLs a JSON escape separates: one preparation must replace both,
      // or the hash recorded for a request differs from the request sent.
      entry.content = 'authored data:image/png;base64,' + payload + '\\ndata:image/png;base64,' + payload;
      fx.strategy.flushSummaries();
      const storedBefore = JSON.stringify(fx.manager.getStore().getStateJson('default/autobio:summaries'));
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(mock.calls.length, 3);
      assert.ok(recallIds(mock.calls[1].request).includes('L1-102'), 'newest parent remains expandable');
      for (const call of mock.calls) assert.ok(!JSON.stringify(call.request).includes(payload));
      const expectedCall = location === 'parent' ? mock.calls[0] : mock.calls[1];
      assert.ok(JSON.stringify(expectedCall.request).includes('omitted from compression prompt'));
      const record = quarantineEvents(fx.manager).map(e => e.record).find(Boolean) as {
        canonicalRequestHash: string; canonicalRequestBoundTokens: number;
        plan: Array<{ requestHash: string; deterministicInputBoundTokens: number }>;
      };
      const hash = (r: NormalizedRequest) => createHash('sha256').update(JSON.stringify(r)).digest('hex');
      assert.equal(record.canonicalRequestHash, hash(mock.calls[0].request));
      assert.equal(record.canonicalRequestBoundTokens, fx.strategy.inputBound(mock.calls[0].request));
      for (const call of mock.calls.slice(1)) {
        const planned = record.plan.find(p => p.requestHash === hash(call.request));
        assert.ok(planned, 'family plan hashes the actual prepared candidate');
        assert.equal(planned.deterministicInputBoundTokens, fx.strategy.inputBound(call.request));
      }
      assert.equal(JSON.stringify(fx.manager.getStore().getStateJson('default/autobio:summaries')), storedBefore);
      fx.manager.close();
    }
  });
});

describe('prepared recall expansions: what is logged', () => {
  after(cleanup);
  it('logs a recall expansion\'s replacements when it is sent, not when it is enumerated', async () => {
    // One fallback: the newer parent's expansion is sent, the older one's
    // is enumerated and never sent.
    for (const location of ['parent', 'child'] as const) {
      const mock = flexibleMembrane([{ stop: 'refusal', omitUsage: true }, { stop: 'refusal', omitUsage: true }]);
      const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 1 });
      const entry = location === 'parent' ? fx.parents[1] : fx.children[2];
      entry.content = 'authored data:image/png;base64,' + 'U'.repeat(20000);
      fx.strategy.flushSummaries();
      const logs: string[] = [];
      const original = console.error;
      console.error = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
      try {
        await fx.strategy.run(fx.target, managerContext(fx.manager));
      } finally { console.error = original; }
      assert.equal(mock.calls.length, 2, 'the canonical request and one recall expansion');
      const sentWithMarker = mock.calls.filter((call) => JSON.stringify(call.request).includes('omitted from compression prompt'));
      const lines = logs.filter((line) => line.includes('serialized data URL(s) with markers'));
      assert.equal(sentWithMarker.length, 1, `${location}: one sent request carried the data URL`);
      assert.equal(lines.length, 1, `${location}: one line, for the request that was sent`);
      assert.equal(lines[0]!.endsWith('[canonical]'), location === 'parent', `${location}: ${lines[0]}`);
      fx.manager.close();
    }
  });
});

describe('prepared requests are logged when they are sent', () => {
  after(cleanup);
  it('logs the prepared source-only request only if it is sent', async () => {
    const payload = 'V'.repeat(20000);
    for (const [stops, sent] of [[['end_turn'], false], [['refusal', 'end_turn'], true]] as const) {
      const mock = scriptedMembrane([...stops]);
      const fx = await fixture(mock.membrane, {
        compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
      });
      fx.target.messages = fx.target.messages.map((m, i) => i ? m : {
        ...m, content: [text('data:image/png;base64,' + payload)],
      });
      const logs: string[] = [];
      const original = console.error;
      console.error = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
      try {
        await fx.strategy.run(fx.target, managerContext(fx.manager));
      } finally { console.error = original; }
      assert.equal(mock.calls.length, sent ? 2 : 1);
      const lines = logs.filter((line) => line.includes('serialized data URL(s) with markers'));
      assert.deepEqual(lines.map((line) => line.slice(line.lastIndexOf('['))), sent ? ['[canonical]', '[source-only-final]'] : ['[canonical]']);
      fx.manager.close();
    }
  });
});

describe('prepared source-only identity', () => {
  after(cleanup);
  it('records the source-only hash from the prepared dispatched request', async () => {
    const mock = scriptedMembrane(['refusal', 'refusal']);
    const fx = await fixture(mock.membrane, {
      compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
    });
    const payload = 'V'.repeat(20000);
    fx.target.messages = fx.target.messages.map((m, i) => i ? m : {
      ...m, content: [text('data:image/png;base64,' + payload)],
    });
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    assert.ok(!JSON.stringify(mock.calls[1].request).includes(payload));
    const record = quarantineEvents(fx.manager).map(e => e.record).find(Boolean) as {
      normalizedConfig: { sourceOnlyFallbackRequestHash: string };
    };
    const actualHash = createHash('sha256').update(JSON.stringify(mock.calls[1].request)).digest('hex');
    assert.equal(record.normalizedConfig.sourceOnlyFallbackRequestHash, actualHash);
    fx.manager.close();
  });
});

describe('prepared tool-prose mode rewrite', () => {
  after(cleanup);
  it('prepares newly constructed result text before recording the rewrite hash', async () => {
    const payload = 'W'.repeat(5000);
    const mock = scriptedMembrane(['refusal', 'refusal']);
    const fx = await fixture(mock.membrane, {
      compressionRefusalCurveFallbacks: 0,
      compressionToolProseFallback: {
        intoTool: 'journal', field: 'content', minChars: 100, fromTools: ['skip_reply'],
        result: 'data:image/png;base64,' + payload,
      },
    });
    fx.manager.setToolDefinitions(['journal', 'skip_reply'].map(name => ({
      name, description: name, inputSchema: { type: 'object' },
    })));
    fx.target.messages = fx.target.messages.map((m, i) => ({
      ...m, participant: i ? 'User' : 'Claude',
      content: i ? [{ type: 'tool_result', toolUseId: 't', content: '{"skipped":true}' } as ContentBlock]
        : [{ type: 'tool_use', id: 't', name: 'skip_reply', input: { reason: 'note '.repeat(100) } } as ContentBlock],
    }));
    await fx.strategy.run(fx.target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    assert.ok(JSON.stringify(mock.calls[1].request).includes('omitted from compression prompt'));
    assert.ok(!JSON.stringify(mock.calls[1].request).includes(payload));
    const exhausted = quarantineEvents(fx.manager).find(e => e.kind === 'exhausted') as {
      outcomes: Array<{ curveLabel: string; requestHash: string }>;
    };
    const outcome = exhausted.outcomes.find(o => o.curveLabel === 'tool-prose-hoist');
    assert.ok(outcome);
    assert.equal(outcome.requestHash, createHash('sha256').update(JSON.stringify(mock.calls[1].request)).digest('hex'));
    fx.manager.close();
  });
});

describe("a host's withdrawal of a compression call (CompressionWithdrawn)", () => {
  after(cleanup);

  // agent-framework's shape: a subclass with its own name.
  class MaintenanceWithdrawnError extends CompressionWithdrawn {
    constructor() {
      super('zz maintenance call withdrawn');
      this.name = 'MaintenanceWithdrawnError';
    }
  }
  // A second copy of this package: no shared class, only the brand.
  const fromAnotherCopy = (): Error => Object.assign(new Error('zz withdrawn by another copy'), {
    [Symbol.for('@animalabs/context-manager:compression-withdrawn')]: true,
  });

  async function quiet<T>(work: () => Promise<T>): Promise<{ logs: string[]; result: PromiseSettledResult<T> }> {
    const logs: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
    try {
      const [result] = await Promise.allSettled([work()]);
      return { logs, result: result! };
    } finally {
      console.error = original;
    }
  }

  // Date.now reads a clock the test moves, for the work it runs.
  async function withClock<T>(clock: { now: number }, work: () => Promise<T>): Promise<T> {
    const real = Date.now;
    Date.now = () => clock.now;
    try {
      return await work();
    } finally {
      Date.now = real;
    }
  }

  // flexibleMembrane's answers, with a hook that runs as each call arrives, given the call's index.
  function hookedMembrane(handlers: AttemptHandler[], onCall: (index: number) => void) {
    const inner = flexibleMembrane(handlers);
    const complete = (inner.membrane as { complete(request: NormalizedRequest): Promise<unknown> }).complete;
    return {
      calls: inner.calls,
      membrane: {
        complete: async (request: NormalizedRequest) => {
          onCall(inner.calls.length);
          return complete(request);
        },
      } as never,
    };
  }

  const splitOptions = { compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true, compressionSplitFallback: true };
  const partSummary = { stop: 'end_turn' as const, text: 'zz a part summarized ' + 'detail '.repeat(20) };

  it('is rethrown unchanged by each rung of the ladder, recording no outcome and quarantining nothing', async () => {
    const shapes = [() => new CompressionWithdrawn(), () => new MaintenanceWithdrawnError(), fromAnotherCopy];
    // The canonical call, the first and second recall fallbacks, and source-only after them.
    for (const at of [0, 1, 2, 3]) {
      for (const shape of shapes) {
        const withdrawn = shape();
        const handlers = [{ stop: 'refusal' as const }, { stop: 'end_turn' as const, text: '' }, { stop: 'end_turn' as const, text: '' }];
        const mock = flexibleMembrane([...handlers.slice(0, at), { error: withdrawn }]);
        const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 2, compressionSourceOnlyFallback: true });
        const { logs, result } = await quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager)));
        assert.equal(result.status, 'rejected', `at ${at}`);
        assert.equal((result as PromiseRejectedResult).reason, withdrawn, `at ${at}: rethrown unchanged`);
        assert.equal(mock.calls.length, at + 1, `at ${at}: nothing after the withdrawal`);
        assert.equal(fx.target.compressed, false);
        assert.deepEqual(quarantineEvents(fx.manager), [], `at ${at}: nothing recorded`);
        assert.ok(!logs.some((line) => line.includes('Failed to compress chunk')), `at ${at}: not logged as a failure`);
        fx.manager.close();
      }
    }
  });

  it('is rethrown unchanged by the tool-prose rung, recording no outcome and quarantining nothing', async () => {
    for (const shape of [() => new CompressionWithdrawn(), () => new MaintenanceWithdrawnError(), fromAnotherCopy]) {
      const withdrawn = shape();
      // The canonical call refuses, so the tool-prose rung runs first; its call is withdrawn.
      const mock = flexibleMembrane([{ stop: 'refusal' }, { error: withdrawn }]);
      const fx = await fixture(mock.membrane, {
        compressionRefusalCurveFallbacks: 0,
        compressionToolProseFallback: { intoTool: 'journal', field: 'content', minChars: 100, fromTools: ['skip_reply'] },
      });
      fx.manager.setToolDefinitions(['journal', 'skip_reply'].map(name => ({
        name, description: name, inputSchema: { type: 'object' },
      })));
      fx.target.messages = fx.target.messages.map((m, i) => ({
        ...m, participant: i ? 'User' : 'Claude',
        content: i ? [{ type: 'tool_result', toolUseId: 't', content: '{"skipped":true}' } as ContentBlock]
          : [{ type: 'tool_use', id: 't', name: 'skip_reply', input: { reason: 'note '.repeat(100) } } as ContentBlock],
      }));
      const { logs, result } = await quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager)));
      assert.equal(result.status, 'rejected');
      assert.equal((result as PromiseRejectedResult).reason, withdrawn, 'rethrown unchanged');
      assert.equal(mock.calls.length, 2, 'nothing after the withdrawal');
      const messagesOf = (call: number) => JSON.stringify((mock.calls[call]!.request as { messages: unknown }).messages);
      assert.ok(!messagesOf(0).includes('"journal"') && messagesOf(1).includes('"journal"'), 'the withdrawn call was the hoisted request');
      assert.equal(fx.target.compressed, false);
      assert.deepEqual(quarantineEvents(fx.manager), [], 'nothing recorded');
      assert.ok(!logs.some((line) => line.includes('Failed to compress chunk')), 'not logged as a failure');
      fx.manager.close();
    }
  });

  it('is rethrown by a split-stitch part, before it counts as an error', async () => {
    const withdrawn = new MaintenanceWithdrawnError();
    // The canonical call and source-only refuse, so the split rung runs; its first part is withdrawn.
    const mock = flexibleMembrane([{ stop: 'refusal' }, { stop: 'refusal' }, { error: withdrawn }]);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true, compressionSplitFallback: true });
    const { result } = await quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager)));
    assert.equal(result.status, 'rejected');
    assert.equal((result as PromiseRejectedResult).reason, withdrawn);
    assert.equal(mock.calls.length, 3, 'the split part was the call withdrawn');
    assert.deepEqual(quarantineEvents(fx.manager), []);
    fx.manager.close();
  });

  it('gives a withdrawn split part\'s own stamp in the split call window back, and keeps the sent part\'s', async () => {
    const withdrawn = new MaintenanceWithdrawnError();
    // The canonical call and source-only refuse, so the split rung runs: its first part lands, and its second is withdrawn.
    // The clock moves a second as each call arrives, so each part's stamp, taken just before its call, is its own.
    const clock = { now: 1_800_000_000_000 };
    const sentAt: number[] = [];
    const mock = hookedMembrane([{ stop: 'refusal' }, { stop: 'refusal' }, partSummary, { error: withdrawn }], () => {
      sentAt.push(clock.now);
      clock.now += 1_000;
    });
    const fx = await fixture(mock.membrane, splitOptions);
    const { result } = await withClock(clock, () => quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager))));
    assert.equal((result as PromiseRejectedResult).reason, withdrawn);
    assert.equal(mock.calls.length, 4, 'the premise: one part was sent before the next was withdrawn');
    assert.notEqual(sentAt[2], sentAt[3], 'the premise: the two parts were sent at different times');
    assert.deepEqual(fx.strategy.splitWindowView(), [sentAt[2]], 'the window keeps the sent part\'s stamp and gives the withdrawn part\'s back');
    assert.deepEqual(quarantineEvents(fx.manager), []);
    fx.manager.close();
  });

  it('lets a later split send parts that a withdrawn part\'s stamp would have refused at a low window cap', async () => {
    const withdrawn = new MaintenanceWithdrawnError();
    // The first run's split sends one part and has its second withdrawn. The second run resumes at the split, since
    // the family's progress keeps the canonical's and source-only's refusals, and its split sends two parts. A split
    // rung starts only when its window has room for a whole attempt, here two calls of the three allowed in ten
    // minutes, so the second run starts only if the withdrawn part's stamp left the window.
    const mock = flexibleMembrane([
      { stop: 'refusal' }, { stop: 'refusal' }, partSummary, { error: withdrawn },
      partSummary, partSummary,
    ]);
    const fx = await fixture(mock.membrane, { ...splitOptions, compressionSplitMaxCallsPer10Min: 3, compressionSplitMaxCallsPerChunk: 2 });
    const first = await quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager)));
    assert.equal((first.result as PromiseRejectedResult).reason, withdrawn);
    assert.equal(mock.calls.length, 4, 'the premise: the first run sent one part before the next was withdrawn');
    const retry = { ...fx.target, compressed: false };
    const second = await quiet(() => fx.strategy.run(retry, managerContext(fx.manager)));
    assert.equal(second.result.status, 'fulfilled');
    assert.equal(mock.calls.length, 6, 'the later split sent both its parts, and nothing else was asked again');
    assert.equal(retry.compressed, true, 'and compressed the chunk');
    assert.equal(fx.strategy.splitWindowView().length, 3, 'the first run\'s sent part and the later split\'s two fill the window');
    assert.deepEqual(quarantineEvents(fx.manager), []);
    fx.manager.close();
  });

  it('removes no other part\'s stamp when the window dropped the withdrawn part\'s own while its call was out', async () => {
    const withdrawn = new MaintenanceWithdrawnError();
    // The canonical call and source-only refuse, so the split rung runs, and its first part is withdrawn. While that
    // call is out, more than ten minutes pass and another split run starts, as a tick can after a branch reload clears
    // the pending compression. Only a split run's start prunes the window: that one drops this part's stamp and adds
    // its own part's.
    const clock = { now: 1_800_000_000_000 };
    let fx!: Fixture;
    let othersStamp = 0;
    const mock = hookedMembrane([{ stop: 'refusal' }, { stop: 'refusal' }, { error: withdrawn }], (index) => {
      if (index !== 2) return;
      clock.now += 11 * 60_000;
      othersStamp = clock.now;
      fx.strategy.setSplitWindow([othersStamp]);
    });
    fx = await fixture(mock.membrane, splitOptions);
    const { result } = await withClock(clock, () => quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager))));
    assert.equal((result as PromiseRejectedResult).reason, withdrawn);
    assert.equal(mock.calls.length, 3, 'the premise: the split\'s first part was the call withdrawn');
    assert.deepEqual(fx.strategy.splitWindowView(), [othersStamp], 'the refund removes no stamp it did not add');
    fx.manager.close();
  });

  it('leaves the family free: a later call compresses the chunk', async () => {
    const mock = flexibleMembrane([{ stop: 'refusal' }, { error: new CompressionWithdrawn() }, { stop: 'end_turn', text: 'zz summary of the chunk' }]);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 1 });
    await quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager)));
    const retry = { ...fx.target, compressed: false };
    await fx.strategy.run(retry, managerContext(fx.manager));
    assert.equal(mock.calls.length, 3, 'nothing suppressed the retry');
    assert.equal(retry.compressed, true, 'the later call compressed the chunk');
    assert.ok(fx.strategy.summariesView().some((s) => s.level === 1 && String(s.content).includes('zz summary of the chunk')), 'its L1 is kept');
    assert.deepEqual(quarantineEvents(fx.manager), []);
    fx.manager.close();
  });

  it('is rethrown to a waiter coalesced on the same chunk, which records nothing either', async () => {
    const withdrawn = new MaintenanceWithdrawnError();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const membrane = { complete: async () => { calls++; await gate; throw withdrawn; } };
    const fx = await fixture(membrane as never);
    const ctx = managerContext(fx.manager);
    const { logs, result } = await quiet(async () => {
      const producer = fx.strategy.run(fx.target, ctx);
      const waiter = fx.strategy.run(fx.target, ctx);
      release();
      return Promise.allSettled([producer, waiter]);
    });
    const [producer, waiter] = (result as PromiseFulfilledResult<PromiseSettledResult<void>[]>).value;
    assert.equal(calls, 1, 'the waiter made no call of its own');
    assert.equal((producer as PromiseRejectedResult).reason, withdrawn);
    assert.equal((waiter as PromiseRejectedResult).reason, withdrawn, 'the waiter rethrows the same withdrawal');
    assert.deepEqual(quarantineEvents(fx.manager), []);
    assert.ok(!logs.some((line) => line.includes('Failed to compress chunk')), 'and nobody logs it as a failure');
    fx.manager.close();
  });

  it('treats an error that is only named CompressionWithdrawn, without the brand, as a failure', async () => {
    const named = Object.assign(new Error('zz not really withdrawn'), { name: 'CompressionWithdrawn' });
    const mock = flexibleMembrane([{ error: named }]);
    const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
    const { logs, result } = await quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager)));
    assert.equal((result as PromiseRejectedResult).reason, named);
    assert.ok(logs.some((line) => line.includes('Failed to compress chunk')), 'reported as the failure it is');
    fx.manager.close();
  });

  it('names itself and says what it is by default', () => {
    const withdrawn = new CompressionWithdrawn();
    assert.equal(withdrawn.name, 'CompressionWithdrawn');
    assert.equal(withdrawn.message, 'compression call withdrawn by the host');
    assert.ok(withdrawn instanceof Error);
  });

  it('says withdrawn, not error, in the opt-in compression log', async () => {
    const log = `${freshPath()}-calls.jsonl`;
    const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = log;
    try {
      const mock = flexibleMembrane([{ error: new MaintenanceWithdrawnError() }]);
      const fx = await fixture(mock.membrane, { compressionRefusalCurveFallbacks: 0 });
      await quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager)));
      fx.manager.close();
      const receipts = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.operation === 'compress_l1' && entry.event === undefined);
      assert.equal(receipts.length, 1, 'one receipt for the call');
      assert.equal((receipts[0]!.metadata as Record<string, unknown>).withdrawn, true);
      assert.ok(!('error' in receipts[0]!), 'and no error');
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
      rmSync(log, { force: true });
    }
  });

  it('says withdrawn in the opt-in compression log when the branch moved while the withdrawn call was out', async () => {
    const log = `${freshPath()}-calls.jsonl`;
    const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = log;
    try {
      let move!: () => Promise<void>;
      const membrane = { complete: async () => { await move(); throw new MaintenanceWithdrawnError(); } } as never;
      const fx = await fixture(membrane, { compressionRefusalCurveFallbacks: 0 });
      const main = fx.manager.currentBranch().name;
      const fork = fx.manager.getStore().createBranchAt('zz-withdrawn-fork', main, fx.manager.getStore().currentSequence()).name;
      move = () => fx.manager.switchBranch(fork);
      const { result } = await quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager)));
      // The premise: the branch moved during the call, so the result is discarded, not rethrown.
      assert.equal(fx.manager.currentBranch().name, fork);
      assert.equal(result.status, 'fulfilled');
      fx.manager.close();
      const entries = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const receipts = entries.filter((entry) => entry.operation === 'compress_l1' && entry.event === undefined);
      assert.equal(receipts.length, 1, 'one receipt for the call');
      assert.equal((receipts[0]!.metadata as Record<string, unknown>).withdrawn, true);
      assert.ok(!('error' in receipts[0]!), 'and no error');
      const discards = entries.filter((entry) => entry.event === 'compression:branch-result-discarded');
      assert.deepEqual(discards.map((entry) => (entry.metadata as Record<string, unknown>).phase), ['canonical_withdrawn'], 'the discard names the withdrawal, not an error');
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
      rmSync(log, { force: true });
    }
  });

  // A later rung's call on a moved branch: its withdrawal propagates as it is to the call's catch, which marks the
  // receipt withdrawn, while an abort there is discarded by the ladder under that rung's own label.
  for (const kind of ['withdrawal', 'abort'] as const) {
    it(`logs a later rung's ${kind} on a branch that moved while its call was out ${kind === 'withdrawal' ? 'as withdrawn' : 'under that rung'}`, async () => {
      const log = `${freshPath()}-calls.jsonl`;
      const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      process.env.CONTEXT_MANAGER_COMPRESSION_LOG = log;
      try {
        let move!: () => Promise<void>;
        let calls = 0;
        const membrane = {
          complete: async () => {
            calls++;
            if (calls === 1) return response('refusal');
            await move();
            throw kind === 'withdrawal'
              ? new MaintenanceWithdrawnError()
              : Object.assign(new Error('zz aborted'), { name: 'AbortError' });
          },
        } as never;
        const fx = await fixture(membrane, { compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true });
        const main = fx.manager.currentBranch().name;
        const fork = fx.manager.getStore().createBranchAt(`zz-${kind}-fork`, main, fx.manager.getStore().currentSequence()).name;
        move = () => fx.manager.switchBranch(fork);
        const { result } = await quiet(() => fx.strategy.run(fx.target, managerContext(fx.manager)));
        // The premises: the canonical call was refused and the source-only rung's call met the move.
        assert.equal(calls, 2);
        assert.equal(fx.manager.currentBranch().name, fork);
        assert.equal(result.status, 'fulfilled');
        fx.manager.close();
        const entries = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
        const receipts = entries.filter((entry) => entry.operation === 'compress_l1' && entry.event === undefined);
        assert.equal(receipts.length, 1, 'one receipt for the call');
        const discards = entries.filter((entry) => entry.event === 'compression:branch-result-discarded');
        const phases = discards.map((entry) => (entry.metadata as Record<string, unknown>).phase);
        if (kind === 'withdrawal') {
          assert.equal((receipts[0]!.metadata as Record<string, unknown>).withdrawn, true);
          assert.ok(!('error' in receipts[0]!), 'and no error');
          assert.deepEqual(phases, ['canonical_withdrawn'], 'the call discards it as a withdrawal');
        } else {
          assert.ok(!('withdrawn' in (receipts[0]!.metadata as Record<string, unknown>)), 'an abort is no withdrawal');
          assert.deepEqual(phases, ['source-only-final:error'], 'the ladder discards it under the rung that met it');
        }
      } finally {
        if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
        else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
        rmSync(log, { force: true });
      }
    });
  }

  it('puts the chunk back at the head of the queue when tick is withdrawn', async () => {
    const withdrawn = new CompressionWithdrawn();
    const mock = flexibleMembrane([{ error: withdrawn }]);
    const fx = await fixture(mock.membrane);
    // A chunk past the seeded L1s, so no guard drops it before the call.
    const covered = new Set(fx.ids.slice(0, 8));
    const chunk = fx.strategy.chunksView().find((c) => c.messages.length > 0 && c.messages.every((m) => !covered.has(m.id)));
    assert.ok(chunk, 'the fixture has a chunk no L1 covers');
    fx.strategy.queueOnly(chunk.index);
    const { logs, result } = await quiet(() => fx.strategy.tick(managerContext(fx.manager)));
    assert.equal(result.status, 'rejected');
    assert.equal((result as PromiseRejectedResult).reason, withdrawn);
    assert.deepEqual(fx.strategy.queueView(), [chunk.index]);
    assert.ok(!logs.some((line) => line.includes('Failed to compress chunk')));
    fx.manager.close();
  });

  it('leaves a withdrawn chunk queued once when a rebuild during the call has queued it again', async () => {
    // The fixture's seeded L1s would let the dedup guard drop the head chunk without a call, so this
    // store has none: the queue's own head is attempted.
    const withdrawn = new CompressionWithdrawn();
    let manager!: ContextManager;
    let head = -1;
    let requeuedDuringCall = false;
    const strategy = new ProbeStrategy({
      compressionModel: MODEL, targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
      autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
    });
    const membrane = {
      complete: async () => {
        // A message arrives while the call is out, and the rebuild it starts queues the pending chunks again.
        manager.addMessage('User', [text('zz arrives mid-call ' + 'word '.repeat(10))]);
        requeuedDuringCall = strategy.queueView().includes(head);
        throw withdrawn;
      },
    };
    manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
    for (let i = 0; i < 14; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(18))]);
    head = strategy.queueView()[0]!;
    assert.ok(head !== undefined, 'a chunk is queued');
    const { result } = await quiet(() => strategy.tick(managerContext(manager)));
    assert.equal((result as PromiseRejectedResult).reason, withdrawn);
    assert.ok(requeuedDuringCall, 'the rebuild during the call queued the chunk again');
    const queue = strategy.queueView();
    assert.equal(queue.filter((index) => index === head).length, 1, `queued once: ${JSON.stringify(queue)}`);
    manager.close();
  });

  /** A store with no seeded L1s, so the queue's own head is attempted; complete is the membrane's whole behaviour. */
  async function ownStore(complete: (manager: ContextManager, strategy: ProbeStrategy) => Promise<never>, config: { adaptiveResolution?: boolean; compressionRefusalCurveFallbacks?: number } = {}) {
    let manager!: ContextManager;
    const strategy = new ProbeStrategy({
      compressionModel: MODEL, targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0,
      autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, ...config,
    });
    manager = await ContextManager.open({ path: freshPath(), strategy, membrane: { complete: () => complete(manager, strategy) } as never });
    for (let i = 0; i < 14; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(18))]);
    return { manager, strategy };
  }

  it('puts a withdrawn chunk back ahead of the chunks queued behind it', async () => {
    const withdrawn = new CompressionWithdrawn();
    const { manager, strategy } = await ownStore(async () => { throw withdrawn; });
    const before = strategy.queueView();
    assert.ok(before.length > 1, `several chunks are queued: ${JSON.stringify(before)}`);
    const { result } = await quiet(() => strategy.tick(managerContext(manager)));
    assert.equal((result as PromiseRejectedResult).reason, withdrawn);
    assert.deepEqual(strategy.queueView(), before, 'the head is back at the head, the rest in their order');
    manager.close();
  });

  it('moves a withdrawn chunk back to the head, once, when something queued it again at the tail during the call without a rebuild', async () => {
    const withdrawn = new CompressionWithdrawn();
    let head = -1;
    let during: number[] = [];
    const { manager, strategy } = await ownStore(async (_m, s) => {
      // As a plan's demand does (handleProducedOps): at the tail, with no rebuild.
      s.queueAtTail(head);
      during = s.queueView();
      throw withdrawn;
    });
    const before = strategy.queueView();
    head = before[0]!;
    const { result } = await quiet(() => strategy.tick(managerContext(manager)));
    assert.equal((result as PromiseRejectedResult).reason, withdrawn);
    // The premise: other chunks were queued, and the chunk was queued again behind them.
    assert.ok(during.length > 1 && during.at(-1) === head && during.indexOf(head) === during.length - 1, `queued again at the tail: ${JSON.stringify(during)}`);
    assert.deepEqual(strategy.queueView(), before, 'back at the head, once, the rest in their order');
    manager.close();
  });

  it('puts a chunk whose call failed for another reason behind the chunks that haven\'t failed', async () => {
    const failure = new Error('zz provider refused');
    const { manager, strategy } = await ownStore(async () => { throw failure; }, { compressionRefusalCurveFallbacks: 0 });
    const head = strategy.queueView()[0]!;
    assert.ok(strategy.queueView().length >= 2, 'the premise: chunks are queued behind it');
    const { result } = await quiet(() => strategy.tick(managerContext(manager)));
    assert.equal((result as PromiseRejectedResult).reason, failure);
    assert.equal(strategy.queueView().at(-1), head, `put back behind the others: ${JSON.stringify(strategy.queueView())}`);
    manager.close();
  });

  it('leaves a withdrawn chunk out of the queue when a hold placed during the call keeps the rebuild from queuing it', async () => {
    const withdrawn = new CompressionWithdrawn();
    let held: string[] = [];
    let head = -1;
    const { manager, strategy } = await ownStore(async (m, s) => {
      // A surgery's hold lands while the call is out; the host withdraws the call, and a message's arrival rebuilds.
      held = s.chunksView()[head]!.messages.map((message) => message.id);
      m.holdCompression(held, { timeoutMs: 60_000 });
      m.addMessage('User', [text('zz arrives mid-call ' + 'word '.repeat(10))]);
      throw withdrawn;
    });
    head = strategy.queueView()[0]!;
    const { result } = await quiet(() => strategy.tick(managerContext(manager)));
    assert.equal((result as PromiseRejectedResult).reason, withdrawn);
    assert.ok(!strategy.queueView().includes(head), `the held chunk stays out: ${JSON.stringify(strategy.queueView())}`);
    manager.releaseCompression(held);
    manager.addMessage('User', [text('zz after the release ' + 'word '.repeat(10))]);
    assert.ok(strategy.queueView().includes(head), 'the rebuild after the release queues it again');
    manager.close();
  });

  it('puts a withdrawn chunk back at the head when a preview ran while the call was out', async () => {
    const withdrawn = new CompressionWithdrawn();
    let previewed = false;
    let rebuildsDuring = 0;
    let during: number[] = [];
    let rebuilds = 0;
    const { manager, strategy } = await ownStore(async (m, s) => {
      // A host previews its context while the call is out: the preview's dry
      // run rebuilds the chunk table, then puts the table and the queue back.
      const before = rebuilds;
      previewed = m.previewContext({ maxTokens: 100_000, reserveForResponse: 0 } as never) !== null;
      rebuildsDuring = rebuilds - before;
      during = s.queueView();
      throw withdrawn;
    }, { adaptiveResolution: true });
    const probe = strategy as unknown as { rebuildChunks(store: unknown): void };
    const rebuild = probe.rebuildChunks.bind(strategy);
    probe.rebuildChunks = (store) => { rebuilds++; rebuild(store); };
    const head = strategy.queueView()[0]!;
    const { result } = await quiet(() => strategy.tick(managerContext(manager)));
    assert.equal((result as PromiseRejectedResult).reason, withdrawn);
    // The premise: the preview ran a rebuild during the call, and left the queue as tick had it, without the chunk.
    assert.ok(previewed, 'the preview ran');
    assert.ok(rebuildsDuring > 0, 'the preview rebuilt the chunk table');
    assert.ok(!during.includes(head), `the chunk was out of the queue during the call: ${JSON.stringify(during)}`);
    assert.equal(strategy.queueView()[0], head, `back at the head: ${JSON.stringify(strategy.queueView())}`);
    manager.close();
  });

  it('stops the speculative drain quietly', async () => {
    const mock = flexibleMembrane([{ error: new MaintenanceWithdrawnError() }]);
    const fx = await fixture(mock.membrane);
    const covered = new Set(fx.ids.slice(0, 8));
    const chunk = fx.strategy.chunksView().find((c) => c.messages.length > 0 && c.messages.every((m) => !covered.has(m.id)))!;
    fx.strategy.queueOnly(chunk.index);
    const { logs } = await quiet(async () => {
      fx.strategy.drain(managerContext(fx.manager));
      // Until the call is made and the chunk is back (the queue is empty while the call is out),
      // then one more turn of the event loop, for the drain's own handling of the rejection.
      const deadline = Date.now() + 10_000;
      while (!(mock.calls.length === 1 && fx.strategy.queueView().length === 1)) {
        assert.ok(Date.now() < deadline, 'the drain settles');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(mock.calls.length, 1, 'the drain made the call');
    assert.ok(!logs.some((line) => line.includes('speculative-drain error')), logs.join('\n'));
    assert.deepEqual(fx.strategy.queueView(), [chunk.index]);
    fx.manager.close();
  });

  it('leaves a withdrawn merge at the head of its queue, with no rejection recorded', async () => {
    const withdrawn = Object.assign(new MaintenanceWithdrawnError(), { retryable: false, type: 'zz_withdrawn' });
    const mock = flexibleMembrane([{ error: withdrawn }]);
    const fx = await fixture(mock.membrane, { hierarchical: true });
    fx.strategy.clearQueues();
    // Two L1s no L2 has merged yet, past the fixture's seeded tree.
    const a = summary('L1-300', 1, [fx.ids[8]!, fx.ids[9]!], fx.ids[8]!, fx.ids[9]!);
    const b = summary('L1-301', 1, [fx.ids[10]!, fx.ids[11]!], fx.ids[10]!, fx.ids[11]!);
    fx.strategy.seed(a);
    fx.strategy.seed(b);
    fx.strategy.enqueueMergeForStress(2, [a.id, b.id]);
    const before = fx.strategy.mergeQueueView();
    const { logs, result } = await quiet(() => fx.strategy.tick(managerContext(fx.manager)));
    assert.equal(mock.calls.length, 1, 'the merge made its call');
    assert.equal(result.status, 'rejected');
    assert.equal((result as PromiseRejectedResult).reason, withdrawn);
    assert.deepEqual(fx.strategy.mergeQueueView(), before);
    // Even carrying retryable: false and a type, as a non-retryable provider error does, it isn't recorded.
    assert.equal(fx.strategy.getMergeQuarantineStatus().count, 0);
    assert.ok(!logs.some((line) => line.includes('Failed to merge summaries')));
    fx.manager.close();
  });

  it('builds no run of failures on a merge however often it is withdrawn, even shaped like a retryable server error', async () => {
    const withdrawn = Object.assign(new MaintenanceWithdrawnError(), { retryable: true, type: 'server' });
    const mock = flexibleMembrane([{ error: withdrawn }]);
    const fx = await fixture(mock.membrane, { hierarchical: true });
    fx.strategy.clearQueues();
    const a = summary('L1-300', 1, [fx.ids[8]!, fx.ids[9]!], fx.ids[8]!, fx.ids[9]!);
    const b = summary('L1-301', 1, [fx.ids[10]!, fx.ids[11]!], fx.ids[10]!, fx.ids[11]!);
    fx.strategy.seed(a);
    fx.strategy.seed(b);
    fx.strategy.enqueueMergeForStress(2, [a.id, b.id]);
    const before = fx.strategy.mergeQueueView();
    const limit = AutobiographicalStrategy.COMPRESSION_PERSISTENT_FAILURES;
    for (let i = 0; i < limit + 8; i++) await quiet(() => fx.strategy.tick(managerContext(fx.manager)));
    assert.equal(mock.calls.length, limit + 8, 'each tick made the merge call');
    assert.deepEqual(fx.strategy.mergeQueueView(), before, 'the merge is still at the head');
    assert.equal(fx.strategy.getMergeQuarantineStatus().count, 0, 'nothing quarantined');
    assert.equal((fx.strategy as unknown as { mergeFailureRuns: Map<string, unknown> }).mergeFailureRuns.size, 0, 'no run of failures');
    fx.manager.close();
  });

  it('rethrows a merge\'s withdrawal shaped like a carrier rejection, without the stripped retry', async () => {
    // A 400 invalid_request carries its type, which makes it a request-attributable rejection: the stripped retry's
    // other precondition.
    const carrierShape = { httpStatus: 400, type: 'invalid_request', message: 'invalid_request: thinking blocks cannot be modified' };
    // A merge whose prior recall pairs carry reasoning, since the summaries before its span answer with it: the
    // stripped retry's precondition.
    const carrierMerge = async (handlers: AttemptHandler[]) => {
      const mock = flexibleMembrane(handlers);
      const fx = await fixture(mock.membrane, { hierarchical: true });
      fx.strategy.clearQueues();
      for (const entry of fx.strategy.summariesView()) entry.responseContent = carrierBlocks(entry.id, entry.content);
      fx.strategy.flushSummaries();
      const a = summary('L1-300', 1, [fx.ids[8]!, fx.ids[9]!], fx.ids[8]!, fx.ids[9]!);
      const b = summary('L1-301', 1, [fx.ids[10]!, fx.ids[11]!], fx.ids[10]!, fx.ids[11]!);
      fx.strategy.seed(a);
      fx.strategy.seed(b);
      fx.strategy.enqueueMergeForStress(2, [a.id, b.id]);
      const before = fx.strategy.mergeQueueView();
      const { logs, result } = await quiet(() => fx.strategy.tick(managerContext(fx.manager)));
      return { mock, fx, before, logs, result };
    };
    // The premise: without the brand, this shape is a transport rejection of the carriers, which gets the stripped retry.
    const control = await carrierMerge([
      { error: Object.assign(new Error(), carrierShape) },
      { stop: 'end_turn', text: 'zz the merge summarized ' + 'detail '.repeat(20) },
    ]);
    assert.equal(control.mock.calls.length, 2, 'the premise: unbranded, this shape gets the stripped retry');
    assert.ok(control.logs.some((line) => line.includes('transport rejected reasoning carriers')), 'the premise: unbranded, it is taken for a transport rejection');
    control.fx.manager.close();

    const withdrawn = Object.assign(new MaintenanceWithdrawnError(), carrierShape);
    const { mock, fx, before, logs, result } = await carrierMerge([{ error: withdrawn }]);
    assert.ok(JSON.stringify(mock.calls[0]!.request.messages).includes('"thinking"'), 'the premise: the merge request carries reasoning');
    assert.equal((result as PromiseRejectedResult).reason, withdrawn, 'rethrown unchanged');
    assert.equal(mock.calls.length, 1, 'no stripped retry');
    assert.ok(!logs.some((line) => line.includes('transport rejected reasoning carriers')), 'not taken for a transport rejection');
    assert.deepEqual(fx.strategy.mergeQueueView(), before);
    fx.manager.close();
  });

  it('says withdrawn, not error, in a merge receipt in the opt-in compression log', async () => {
    const log = `${freshPath()}-merge-calls.jsonl`;
    const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = log;
    try {
      const mock = flexibleMembrane([{ error: new MaintenanceWithdrawnError() }]);
      const fx = await fixture(mock.membrane, { hierarchical: true });
      fx.strategy.clearQueues();
      const a = summary('L1-300', 1, [fx.ids[8]!, fx.ids[9]!], fx.ids[8]!, fx.ids[9]!);
      const b = summary('L1-301', 1, [fx.ids[10]!, fx.ids[11]!], fx.ids[10]!, fx.ids[11]!);
      fx.strategy.seed(a);
      fx.strategy.seed(b);
      fx.strategy.enqueueMergeForStress(2, [a.id, b.id]);
      await quiet(() => fx.strategy.tick(managerContext(fx.manager)));
      fx.manager.close();
      const receipts = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.operation === 'merge_l2' && entry.event === undefined);
      assert.equal(receipts.length, 1, 'one receipt for the merge call');
      assert.equal((receipts[0]!.metadata as Record<string, unknown>).withdrawn, true);
      assert.ok(!('error' in receipts[0]!), 'and no error');
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
      rmSync(log, { force: true });
    }
  });
});
