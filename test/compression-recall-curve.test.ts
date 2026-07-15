import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { ContentBlock, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
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
  | { stop: 'refusal' | 'end_turn' | 'max_tokens'; text?: string; inputTokens?: number }
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
        const result = response(handler.stop, handler.text ?? '');
        if (handler.inputTokens !== undefined) result.usage.inputTokens = handler.inputTokens;
        return result;
      },
    } as never,
  };
}

function quarantineEvents(manager: ContextManager): Array<Record<string, unknown>> {
  const value = manager.getStore().getStateJson(
    'default/autobio:compression-refusal-quarantine-events',
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

  it('admits the full rendered family, not stale recall token metadata, and continues after overflow', async () => {
    const mock = flexibleMembrane([
      { stop: 'refusal', inputTokens: 12_000 },
      { stop: 'end_turn', text: 'older bounded curve succeeded', inputTokens: 13_000 },
    ]);
    const fx = await fixture(mock.membrane, {
      compressionContextBudgetTokens: 30_000,
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

  it('continues across empty output and provider error, then accepts persistable max_tokens text', async () => {
    const providerError = Object.assign(new Error('synthetic variant failure'), { type: 'invalid_request' });
    const mock = flexibleMembrane([
      { stop: 'refusal' },
      { stop: 'end_turn', text: '' },
      { error: providerError },
      { stop: 'max_tokens', text: 'persistable truncated memory' },
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
    assert.equal(produced?.content, 'persistable truncated memory');
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

  it('preserves canonical non-refusal empty, max_tokens, and error behavior', async () => {
    {
      const mock = flexibleMembrane([{ stop: 'end_turn', text: '' }]);
      const fx = await fixture(mock.membrane);
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(fx.target.compressed, false);
      assert.equal(quarantineEvents(fx.manager).filter((event) => event.kind === 'exhausted').length, 0);
      fx.manager.close();
    }
    {
      const mock = flexibleMembrane([{ stop: 'max_tokens', text: 'canonical partial memory' }]);
      const fx = await fixture(mock.membrane);
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      assert.equal(fx.target.compressed, true);
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
    const record = events.find((event) => event.kind === 'claim')?.record as Record<string, unknown>;
    assert.ok(record);
    assert.equal(record.model, MODEL);
    assert.match(String(record.key), /^[a-f0-9]{64}$/);
    assert.match(String(record.chunkSourceHash), /^[a-f0-9]{64}$/);
    assert.match(String(record.frontierHash), /^[a-f0-9]{64}$/);
    assert.match(String(record.canonicalRequestHash), /^[a-f0-9]{64}$/);
    assert.equal((record.variants as unknown[]).length, 2);
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

  it('emits metadata traces for refusal, curve attempt, success, and persistence', async () => {
    const logPath = `${freshPath()}-trace.jsonl`;
    paths.push(logPath);
    const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    try {
      const mock = scriptedMembrane(['refusal', 'end_turn']);
      const fx = await fixture(mock.membrane);
      await fx.strategy.run(fx.target, managerContext(fx.manager));
      fx.manager.close();

      const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(
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
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
    }
  });

  it('concurrent producers consult durable summaries and persist only one L1', async () => {
    const mock = scriptedMembrane(['end_turn', 'end_turn']);
    // The durable claim suppresses the second same-key producer before it
    // reaches Membrane; hold the first briefly so the race is real.
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
    assert.equal(mock.calls.length, 1, 'same-key claim permits only one provider call');
    const persisted = first.manager.getStore().getStateJson('default/autobio:summaries');
    const targetKey = first.target.messages.map((message) => message.id).join(':');
    const matching = (Array.isArray(persisted) ? persisted : []).filter(
      (entry: SummaryEntry) => entry.level === 1 && entry.sourceIds.join(':') === targetKey,
    );
    assert.equal(matching.length, 1);
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
    assert.equal(events.filter((event) => event.kind === 'claim').length, 1);
    assert.equal(events.filter((event) => event.kind === 'exhausted').length, 1);
    assert.equal(events.filter((event) => event.kind === 'alert_pending').length, 1);
    assert.equal(events.filter((event) => event.kind === 'alert_sent').length, 1);
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
    assert.equal(events.filter((event) => event.kind === 'claim').length, 2);
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
    const firstClaim = quarantineEvents(fx.manager).find((event) => event.kind === 'claim')!;
    const key = String((firstClaim.record as Record<string, unknown>).key);
    await fx.strategy.clearCompressionRefusalQuarantine(key);
    await fx.strategy.run({ ...fx.target, compressed: false }, ctx);
    const claims = quarantineEvents(fx.manager).filter((event) => event.kind === 'claim');
    assert.equal(claims.length, 2);
    fx.manager.getStore().appendToStateJson(
      'default/autobio:compression-refusal-quarantine-events',
      {
        kind: 'clear',
        key,
        targetClaimId: firstClaim.eventId,
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
    assert.equal(mock.calls.length, 2, 'new claim survives stale clear event');
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
