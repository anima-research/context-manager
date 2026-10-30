import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { StoredMessage, SummaryEntry } from '../src/types/index.js';
import type { StrategyContext } from '../src/types/strategy.js';
import type { ContentBlock } from '@animalabs/membrane';

const ROOT = './test-removed-messages';
let counter = 0;
const freshPath = (): string => `${ROOT}-${process.pid}-${counter++}`;
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const body = (marker: string): string => `${marker} ${'word '.repeat(18)}`.slice(0, 110);
const context = (manager: ContextManager): StrategyContext =>
  (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
const MARKER = 'You will soon form a new memory';

class Probe extends AutobiographicalStrategy {
  headStart(ctx: StrategyContext): number {
    return this.getHeadWindowStartIndex(ctx.messageStore);
  }
  all(): SummaryEntry[] {
    return this.summaries;
  }
  labelOrder(ctx: StrategyContext): SummaryEntry[] {
    return this.sortSummariesChronologically(this.summaries, ctx.messageStore.getAll());
  }
  mergePositions(): Map<string, number> {
    return this.mergePositionIndex();
  }
  readOrder(ctx: StrategyContext): void {
    this.refreshStoreOrder(ctx.messageStore.getAll());
  }
  mergeAt(threshold: number): void {
    (this.config as { mergeThreshold: number }).mergeThreshold = threshold;
    this.checkMergeThreshold();
  }
}

async function chunked(
  count: number,
  onCall: (call: number, ids: string[], manager: ContextManager, request: string) =>
    string | Error | { stopReason: string; content: ContentBlock[] } | void,
  extra: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
): Promise<{ manager: ContextManager; strategy: Probe; ids: string[]; requests: string[]; path: string }> {
  const ids: string[] = [];
  const requests: string[] = [];
  let manager!: ContextManager;
  const membrane = {
    complete: async (req: unknown) => {
      requests.push(JSON.stringify(req));
      const answer = onCall(requests.length, ids, manager, requests[requests.length - 1]!);
      if (answer instanceof Error) throw answer;
      if (answer && typeof answer === 'object') return answer;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: answer ?? `MEM[${requests.length}]` }] };
    },
  };
  const strategy = new Probe({
    compressionModel: 'm', headWindowTokens: 1, recentWindowTokens: 0, l1HoldbackChunks: 0, targetChunkTokens: 60,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, ...config,
  } as never);
  const path = freshPath();
  manager = await ContextManager.open({ path, strategy, membrane: membrane as never, ...extra } as never);
  for (let i = 0; i < count; i++) ids.push(manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`))));
  return { manager, strategy, ids, requests, path };
}

function summarized(request: string): string[] {
  const at = request.indexOf(MARKER);
  return [...(at >= 0 ? request.slice(at) : '').matchAll(/\bM(\d+)\b/g)].map((m) => `M${m[1]}`);
}
const named = (ids: string[], sourceIds: readonly string[]): string[] => sourceIds.map((id) => `M${ids.indexOf(id)}`);
const carries = (request: string, name: string): boolean => new RegExp(`\\b${name}\\b`).test(request);

async function tickUntil(manager: ContextManager, done: () => boolean): Promise<void> {
  for (let i = 0; i < 30 && !done(); i++) await manager.tick();
}

async function logged(run: () => Promise<void>): Promise<{ warnings: string[]; errors: string[] }> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const { warn, error } = console;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return { warnings, errors };
}
const DROPPED = /skipping stale queue entry, whose merge check found: (\d+ source\(s\); a merge needs at least two|source level mismatch: |source position unresolved |sources are not adjacent in store order: )/;
const REFUSED = /\[merge-topology\] ⛔ refused/;
const droppedWithWarning = ({ warnings, errors }: { warnings: string[]; errors: string[] }): void => {
  assert.ok(warnings.some((line) => DROPPED.test(line)), 'a warning names what the merge check found');
  assert.ok(!errors.some((line) => REFUSED.test(line)), 'no operator error');
};

describe('removed messages (#321)', () => {
  it('a message removed while its chunk waits is in neither the request nor the summary\'s sources', async () => {
    const { manager, strategy, ids, requests, path } = await chunked(12, (call, ids, manager) => {
      if (call === 1) manager.removeMessage(ids[4]! as never);
    });
    try {
      await tickUntil(manager, () => requests.length >= 2);
      assert.deepStrictEqual(summarized(requests[0]!), ['M0', 'M1', 'M2', 'M3']);
      assert.ok(!summarized(requests[1]!).includes('M4'), `the second request summarizes ${summarized(requests[1]!)}`);
      assert.strictEqual(summarized(requests[1]!)[0], 'M5');
      for (const s of strategy.all()) assert.ok(!s.sourceIds.includes(ids[4]!), `${s.id} names M4 among its sources`);
      assert.deepStrictEqual(named(ids, strategy.all()[1]!.sourceIds).slice(0, 1), ['M5']);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('the answer to a request sent before a message was removed is kept, as a summary written before the removal is', async () => {
    const { manager, strategy, ids, requests, path } = await chunked(12, (call, ids, manager) => {
      if (call === 1) manager.removeMessage(ids[1]! as never);
    });
    try {
      await tickUntil(manager, () => requests.length >= 2);
      assert.deepStrictEqual(summarized(requests[0]!), ['M0', 'M1', 'M2', 'M3']);
      const first = strategy.all().filter((s) => s.sourceIds.includes(ids[0]!));
      assert.strictEqual(first.length, 1, `${first.length} summaries name M0`);
      assert.strictEqual(first[0]!.content, 'MEM[1]');
      assert.deepStrictEqual(named(ids, first[0]!.sourceIds), ['M0', 'M1', 'M2', 'M3']);
      assert.ok(!summarized(requests[1]!).includes('M0'), `the second request summarizes ${summarized(requests[1]!)}`);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a chunk too thin for a model call, which gets a summary written without one, leaves out a message removed while it waited', async () => {
    const { manager, strategy, ids, requests, path } = await chunked(12, () => undefined, {}, { minChunkCharsForLLM: 100_000 });
    try {
      manager.removeMessage(ids[1]! as never);
      await tickUntil(manager, () => strategy.all().some((s) => s.sourceIds.includes(ids[0]!)));
      assert.strictEqual(requests.length, 0, 'premise: no model call');
      const first = strategy.all().find((s) => s.sourceIds.includes(ids[0]!))!;
      assert.deepStrictEqual(named(ids, first.sourceIds), ['M0', 'M2', 'M3']);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a message removed during one of its chunk\'s requests is in none of the chunk\'s later requests', async () => {
    const { manager, strategy, ids, requests, path } = await chunked(12, (call, ids, manager) => {
      if (call === 1) {
        manager.removeMessage(ids[1]! as never);
        return '';
      }
    });
    try {
      await tickUntil(manager, () => strategy.all().some((s) => s.sourceIds.includes(ids[0]!)));
      assert.deepStrictEqual(summarized(requests[0]!), ['M0', 'M1', 'M2', 'M3']);
      for (const [i, request] of requests.entries()) {
        if (i > 0) assert.ok(!summarized(request).includes('M1'), `request ${i + 1} summarizes ${summarized(request)}`);
      }
      const first = strategy.all().find((s) => s.sourceIds.includes(ids[0]!))!;
      assert.deepStrictEqual(named(ids, first.sourceIds), ['M0', 'M2', 'M3']);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  const attempts = (logPath: string): string[] => existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { event?: string }).event ?? '')
    : [];

  for (const left of ['a system change in the head', 'a message of thinking alone in the chunk', 'a message of empty text in the chunk'] as const) {
    it(`a message its request left out, ${left}, removed during one of the chunk\'s requests discards nothing`, async () => {
      const logPath = `${freshPath()}-calls.jsonl`;
      const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
      const at = left === 'a system change in the head' ? 0 : 2;
      const emptied: [string, ContentBlock[]] = left === 'a system change in the head'
        ? ['Harness', [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock]]
        : left === 'a message of thinking alone in the chunk'
          ? ['assistant', [{ type: 'thinking', thinking: 'a thought', signature: 'signature' } as unknown as ContentBlock]]
          : ['assistant', text(' ')];
      const { manager, strategy, ids, requests, path } = await chunked(0, (call, ids, manager) => {
        if (call === 1) {
          manager.removeMessage(ids[at]! as never);
          return '';
        }
      });
      try {
        for (let i = 0; i < 12; i++) ids.push(i === at ? manager.addMessage(...emptied) : manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`))));
        const first = ids[at === 0 ? 1 : 0]!;
        await manager.tick();
        assert.ok(requests.length >= 2 && summarized(requests[0]!).join(',') === summarized(requests[1]!).join(','),
          'the empty answer sent the chunk\'s next rung in the same tick');
        assert.strictEqual(strategy.all().find((s) => s.sourceIds.includes(first))?.content, 'MEM[2]', 'the next rung\'s answer was written');
        const events = attempts(logPath);
        assert.ok(events.filter((event) => event === 'compression:attempt').length >= 2, `premise: both attempts logged; logged: ${events.join(', ')}`);
        assert.ok(!events.includes('compression:removed-message-discarded'), `logged: ${events.join(', ')}`);
      } finally {
        if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
        else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
        await manager.close();
        rmSync(path, { recursive: true, force: true });
        rmSync(logPath, { force: true });
      }
    });
  }

  for (const rung of ['source-only-final', 'a split piece'] as const) {
    it(`a message of thinking alone in the chunk, removed during the chunk's first request, leaves ${rung} to go out and be kept`, async () => {
      const logPath = `${freshPath()}-calls.jsonl`;
      const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
      const refused = { stopReason: 'refusal', content: [] as ContentBlock[] };
      const { manager, strategy, ids, requests, path } = await chunked(0, (call, ids, manager, request) => {
        if (call === 1) {
          manager.removeMessage(ids[2]! as never);
          return refused;
        }
        if (rung === 'a split piece' && summarized(request).length > 1) return refused;
        return `KEPT[${call}]`;
      }, {}, {
        headWindowTokens: 60, compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
        compressionSplitFallback: rung === 'a split piece',
      });
      try {
        for (let i = 0; i < 12; i++) {
          ids.push(i === 2
            ? manager.addMessage('assistant', [{ type: 'thinking', thinking: 'a thought', signature: 'signature' } as unknown as ContentBlock])
            : manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`))));
        }
        await manager.tick();
        assert.ok(['M1', 'M3'].every((name) => summarized(requests[0]!).includes(name)), `premise: the first chunk holds M1 to M3, M2 entering it empty: ${summarized(requests[0]!)}`);
        const written = strategy.all().find((s) => s.sourceIds.includes(ids[1]!));
        const calls = [...(written?.content ?? '').matchAll(/KEPT\[(\d+)\]/g)].map((match) => Number(match[1]));
        assert.ok(calls.length > 0, `written from ${written?.content}; requests: ${requests.length}`);
        for (const call of calls) {
          const request = requests[call - 1]!;
          if (rung === 'source-only-final') {
            assert.ok(carries(requests[0]!, 'M0') && !carries(request, 'M0') && summarized(request).join(',') === summarized(requests[0]!).join(','),
              `request ${call} is source-only-final: the chunk without the head`);
          } else {
            assert.ok(summarized(request).length <= 1 && summarized(request).length < summarized(requests[0]!).length, `request ${call} is a split piece`);
          }
        }
        const events = attempts(logPath);
        assert.ok(!events.includes('compression:removed-message-discarded'), `logged: ${events.join(', ')}`);
      } finally {
        if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
        else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
        await manager.close();
        rmSync(path, { recursive: true, force: true });
        rmSync(logPath, { force: true });
      }
    });
  }

  it('a tool result whose call was removed before its chunk formed, removed during the chunk\'s first request, discards nothing', async () => {
    const logPath = `${freshPath()}-calls.jsonl`;
    const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    const { manager, strategy, ids, requests, path } = await chunked(0, (call, ids, manager) => {
      if (call === 1) {
        manager.removeMessage(ids[1]! as never);
        return '';
      }
    });
    try {
      manager.setToolDefinitions([{ name: 'get_weather', description: 'Weather.', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }]);
      ids.push(manager.addMessage('assistant', [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Oslo' } } as unknown as ContentBlock]));
      ids.push(manager.addMessage('user', [{ type: 'tool_result', toolUseId: 't1', content: 'Sunny.' } as unknown as ContentBlock]));
      for (let i = 2; i < 12; i++) ids.push(manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`))));
      manager.removeMessage(ids[0]! as never);
      await tickUntil(manager, () => requests.length > 0);
      assert.ok(summarized(requests[0]!).includes('M2') && !requests[0]!.includes('Sunny.') && !requests[0]!.includes('"tool_result"'),
        'premise: the first request was the chunk holding the result, and sent none of it');
      assert.ok(requests.length >= 2 && summarized(requests[0]!).join(',') === summarized(requests[1]!).join(','),
        'the empty answer sent the chunk\'s next rung in the same tick');
      assert.strictEqual(strategy.all().find((s) => s.sourceIds.includes(ids[2]!))?.content, 'MEM[2]', 'the next rung\'s answer was written');
      const events = attempts(logPath);
      assert.ok(events.filter((event) => event === 'compression:attempt').length >= 2, `premise: both attempts logged; logged: ${events.join(', ')}`);
      assert.ok(!events.includes('compression:removed-message-discarded'), `logged: ${events.join(', ')}`);
    } finally {
      if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
      await manager.close();
      rmSync(path, { recursive: true, force: true });
      rmSync(logPath, { force: true });
    }
  });

  for (const kept of ['a tool result whose call is in its chunk', 'a message of text and a tool result whose call was removed'] as const) {
    it(`${kept}, removed during the chunk's first request, is in no later request`, async () => {
      const logPath = `${freshPath()}-calls.jsonl`;
      const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
      const { manager, strategy, ids, requests, path } = await chunked(0, (call, ids, manager) => {
        if (call === 1) {
          manager.removeMessage(ids[1]! as never);
          return '';
        }
      });
      try {
        manager.setToolDefinitions([{ name: 'get_weather', description: 'Weather.', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }]);
        ids.push(manager.addMessage('assistant', [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Oslo' } } as unknown as ContentBlock]));
        ids.push(manager.addMessage('user', kept === 'a tool result whose call is in its chunk'
          ? [{ type: 'tool_result', toolUseId: 't1', content: 'Sunny.' } as unknown as ContentBlock]
          : [{ type: 'tool_result', toolUseId: 't1', content: 'Sunny.' } as unknown as ContentBlock, ...text('Sunny, said the result.')]));
        for (let i = 2; i < 12; i++) ids.push(manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`))));
        if (kept !== 'a tool result whose call is in its chunk') manager.removeMessage(ids[0]! as never);
        await tickUntil(manager, () => strategy.all().some((s) => s.sourceIds.includes(ids[2]!)));
        assert.ok(summarized(requests[0]!).includes('M2') && requests[0]!.includes('Sunny'), 'premise: the first request sent the result\'s message');
        for (const [i, request] of requests.entries()) {
          if (i > 0) assert.ok(!request.includes('Sunny'), `request ${i + 1} carries the removed message`);
        }
        assert.ok(attempts(logPath).includes('compression:removed-message-discarded'), 'the discard is logged');
      } finally {
        if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
        else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
        await manager.close();
        rmSync(path, { recursive: true, force: true });
        rmSync(logPath, { force: true });
      }
    });
  }

  it('a message removed while the transport rejects a request\'s reasoning is not in the retry without it', async () => {
    const rejected = Object.assign(new Error('400: thinking blocks cannot be modified'),
      { type: 'invalid_request', retryable: false, httpStatus: 400 });
    const { manager, strategy, ids, requests, path } = await chunked(12, (call, ids, manager) => {
      if (call !== 2) return;
      manager.removeMessage(ids[5]! as never);
      return rejected;
    });
    try {
      await tickUntil(manager, () => strategy.all().length >= 1);
      strategy.all()[0]!.responseContent = [
        { type: 'thinking', thinking: 'carried reasoning', signature: 'signature' } as never,
        { type: 'text', text: 'MEM[1]' },
      ];
      await tickUntil(manager, () => strategy.all().some((s) => s.sourceIds.includes(ids[4]!)));
      assert.ok(requests[1]!.includes('carried reasoning'), 'premise: the second chunk\'s request carried reasoning');
      assert.deepStrictEqual(summarized(requests[1]!), ['M4', 'M5', 'M6', 'M7']);
      for (const [i, request] of requests.entries()) {
        if (i > 1) assert.ok(!summarized(request).includes('M5'), `request ${i + 1} summarizes ${summarized(request)}`);
      }
      const second = strategy.all().find((s) => s.sourceIds.includes(ids[4]!))!;
      assert.deepStrictEqual(named(ids, second.sourceIds), ['M4', 'M6', 'M7']);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a head message removed during a chunk\'s request is in none of the chunk\'s later requests', async () => {
    const { manager, strategy, ids, requests, path } = await chunked(12, (call, ids, manager) => {
      if (call === 1) {
        manager.removeMessage(ids[0]! as never);
        return '';
      }
    }, {}, { headWindowTokens: 60 });
    try {
      await tickUntil(manager, () => strategy.all().some((s) => s.sourceIds.includes(ids[2]!)));
      assert.ok(carries(requests[0]!, 'M0') && !summarized(requests[0]!).includes('M0'),
        'premise: the first request carried M0 as its head');
      assert.ok(requests.length > 1, 'premise: the empty answer was asked again');
      for (const [i, request] of requests.entries()) {
        if (i > 0) assert.ok(!carries(request, 'M0'), `request ${i + 1} carries M0`);
      }
      assert.ok(strategy.all().some((s) => s.sourceIds.includes(ids[2]!)), 'the chunk was summarized');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a message a pin opens among the recall pairs, removed during a later chunk\'s request, is in none of that chunk\'s later requests', async () => {
    const { manager, strategy, ids, requests, path } = await chunked(12, (call, ids, manager) => {
      if (call === 3) {
        manager.removeMessage(ids[6]! as never);
        return '';
      }
    });
    try {
      manager.pinRange(ids[5]! as never, ids[5]! as never, { name: 'opens the second chunk' } as never);
      await tickUntil(manager, () => strategy.all().some((s) => s.sourceIds.includes(ids[8]!)));
      assert.deepStrictEqual(summarized(requests[2]!), ['M8', 'M9', 'M10', 'M11']);
      assert.ok(carries(requests[2]!, 'M6'), 'premise: the third request carried M6, which the pin opened');
      for (const [i, request] of requests.entries()) {
        if (i > 2) assert.ok(!carries(request, 'M6'), `request ${i + 1} carries M6`);
      }
      assert.ok(strategy.all().some((s) => s.sourceIds.includes(ids[8]!)), 'the chunk was summarized');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a raw message between the head and the chunk, removed during the chunk\'s request, is in none of its later requests', async () => {
    const refusal = { stopReason: 'refusal', content: [{ type: 'text', text: '' }] as ContentBlock[] };
    let removedAt = 0;
    const { manager, strategy, ids, requests, path } = await chunked(12, (call, ids, manager, request) => {
      if (summarized(request)[0] === 'M4') return refusal;
      if (summarized(request)[0] === 'M8' && removedAt === 0) {
        removedAt = call;
        manager.removeMessage(ids[5]! as never);
        return '';
      }
    });
    try {
      await tickUntil(manager, () => strategy.all().some((s) => s.sourceIds.includes(ids[8]!)));
      assert.ok(removedAt > 0, 'premise: the third chunk was asked for');
      const first = requests[removedAt - 1]!;
      assert.ok(carries(first, 'M5') && !summarized(first).includes('M5'),
        'premise: the third chunk\'s request carried M5 raw, the second chunk being refused');
      for (const [i, request] of requests.entries()) {
        if (i >= removedAt) assert.ok(!carries(request, 'M5'), `request ${i + 1} carries M5`);
      }
      assert.ok(strategy.all().some((s) => s.sourceIds.includes(ids[8]!)), 'the chunk was summarized');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  for (const rung of ['source-only-final', 'a split piece'] as const) {
    it(`a head message removed during a chunk's request leaves ${rung}, which carries only the chunk, to go out`, async () => {
      const refused = { stopReason: 'refusal', content: [] as ContentBlock[] };
      const { manager, strategy, ids, requests, path } = await chunked(12, (call, ids, manager, request) => {
        if (call === 1) {
          manager.removeMessage(ids[0]! as never);
          return refused;
        }
        if (rung === 'a split piece' && summarized(request).length > 1) return refused;
        return `KEPT[${call}]`;
      }, {}, {
        headWindowTokens: 60, compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
        compressionSplitFallback: rung === 'a split piece',
      });
      try {
        await manager.tick();
        assert.ok(carries(requests[0]!, 'M0'), 'premise: the chunk\'s first request carried M0 as its head');
        assert.deepStrictEqual(summarized(requests[0]!), ['M1', 'M2', 'M3', 'M4'], 'premise: the first chunk is M1 to M4');
        const written = strategy.all().find((s) => named(ids, s.sourceIds).join(',') === 'M1,M2,M3,M4');
        assert.ok(written, `nothing written for M1 to M4; requests: ${requests.length}`);
        assert.ok(written.content.includes('KEPT'), `written from ${written.content}`);
        for (const [i, request] of requests.entries()) {
          if (i > 0) assert.ok(!carries(request, 'M0'), `request ${i + 1} carries M0`);
        }
      } finally {
        await manager.close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  }

  for (const work of ['compression', 'merge'] as const) {
    it(`a ${work}'s retry without reasoning that a removal keeps from going out is not logged as sent`, async () => {
      const rejected = Object.assign(new Error('400: thinking blocks cannot be modified'),
        { type: 'invalid_request', retryable: false, httpStatus: 400 });
      const logPath = `${freshPath()}-calls.jsonl`;
      const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
      const errors: string[] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      const reasoned = { stopReason: 'end_turn', content: [
        { type: 'thinking', thinking: 'carried reasoning', signature: 'signature' } as never, { type: 'text', text: 'MEM' },
      ] as ContentBlock[] };
      const { manager, strategy, ids, requests, path } = await chunked(20, (call, ids, manager) => {
        if (call === (work === 'compression' ? 1 : 5)) return reasoned;
        if (call === (work === 'compression' ? 2 : 6)) {
          manager.removeMessage(ids[0]! as never);
          return rejected;
        }
      }, {}, { hierarchical: true, headWindowTokens: 60 });
      try {
        if (work === 'compression') {
          await tickUntil(manager, () => requests.length >= 2);
        } else {
          await tickUntil(manager, () => strategy.all().length >= 4);
          strategy.mergeAt(2);
          for (let i = 0; i < 30 && requests.length < 6; i++) await manager.tick();
        }
        const rejectedAt = work === 'compression' ? 1 : 5;
        assert.ok(requests[rejectedAt]!.includes('carried reasoning') && carries(requests[rejectedAt]!, 'M0'),
          'premise: the rejected request recalled reasoning and carried M0 as its head');
        assert.strictEqual(requests.length, rejectedAt + 1, 'premise: the retry without reasoning was not sent');
        const entries = existsSync(logPath)
          ? readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event?: string; metadata?: { phase?: string; message_id?: string } })
          : [];
        const events = entries.map((entry) => entry.event);
        assert.ok(!events.includes('compression:carrier-transport-fallback'), `logged: ${events.join(', ')}`);
        assert.ok(!errors.some((line) => line.includes('retrying ONCE')), `printed: ${errors.join(' | ')}`);
        if (work === 'compression') {
          const discarded = entries.find((entry) => entry.event === 'compression:removed-message-discarded');
          assert.ok(discarded, `no removed-message-discarded entry; logged: ${events.join(', ')}`);
          assert.strictEqual(discarded.metadata?.message_id, ids[0]);
          assert.ok(discarded.metadata?.phase?.endsWith(':carrier-rejected:before_call'), `phase ${discarded.metadata?.phase}`);
        }
      } finally {
        console.error = consoleError;
        if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
        else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
        await manager.close();
        rmSync(path, { recursive: true, force: true });
        rmSync(logPath, { force: true });
      }
    });
  }

  it('a head message removed while another instance\'s request for the same chunk is out sends the instance that joined it back to the chunk', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const theirs: string[] = [];
    const { manager, strategy, ids, requests, path } = await chunked(12, () => undefined, {}, { headWindowTokens: 60 });
    const producerMembrane = {
      complete: async (req: unknown) => {
        theirs.push(JSON.stringify(req));
        if (theirs.length === 1) {
          await gate;
          return { stopReason: 'end_turn', content: [{ type: 'text', text: '' }] };
        }
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `THEIRS[${theirs.length}]` }] };
      },
    };
    const sibling = new Probe({
      compressionModel: 'm', headWindowTokens: 60, recentWindowTokens: 0, l1HoldbackChunks: 0, targetChunkTokens: 60,
      autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
    } as never);
    const other = await ContextManager.open({ store: manager.getStore(), strategy: sibling, membrane: producerMembrane as never } as never);
    try {
      const producing = sibling.tick(context(other));
      for (let i = 0; i < 1000 && theirs.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(theirs.length, 1, 'premise: the other instance asked for the first chunk');
      let joinedSettled = false;
      const joining = strategy.tick(context(manager)).then(() => { joinedSettled = true; });
      const compressing = () => (strategy as unknown as { pendingCompressionWork: { chunk: { messages: Array<{ id: string }> } } | null }).pendingCompressionWork;
      for (let i = 0; i < 1000 && compressing() === null && !joinedSettled; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(requests.length, 0, 'premise: this instance joined the call rather than asking itself');
      assert.strictEqual(joinedSettled, false, 'premise: this instance\'s tick waits on the other\'s call');
      assert.strictEqual(compressing()?.chunk.messages[0]?.id, ids[1], 'premise: this instance\'s tick is compressing the chunk the other instance asked for');
      manager.removeMessage(ids[0]! as never);
      release();
      await producing;
      await joining;
      assert.strictEqual(theirs.length, 1, 'premise: the other instance sent nothing after M0 left');
      const forChunk = (): string | undefined => requests.find((request) => summarized(request)[0] === 'M1');
      for (let i = 0; i < 10 && forChunk() === undefined; i++) await strategy.tick(context(manager));
      assert.ok(forChunk() !== undefined, 'this instance never went back to the chunk');
      assert.deepStrictEqual(summarized(forChunk()!), ['M1', 'M2', 'M3', 'M4']);
      assert.ok(!carries(forChunk()!, 'M0'), 'its request carries M0');
    } finally {
      await other.close();
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a message a filter hides while its chunk waits is left out of the summary, and the store opens again', async () => {
    const viewFilter = (m: StoredMessage): boolean =>
      !m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('HIDE'));
    const { manager, strategy, ids, requests, path } = await chunked(12, (call, ids, manager) => {
      if (call === 1) manager.editMessage(ids[5]! as never, text(body('HIDE M5')));
    }, { viewFilter });
    let reopened: ContextManager | undefined;
    try {
      await tickUntil(manager, () => requests.length >= 2 && strategy.all().length >= 2);
      assert.deepStrictEqual(named(ids, strategy.all()[1]!.sourceIds), ['M4', 'M6', 'M7']);
      await manager.close();
      const again = new Probe({
        compressionModel: 'm', headWindowTokens: 1, recentWindowTokens: 0, l1HoldbackChunks: 0, targetChunkTokens: 60,
        autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
      } as never);
      reopened = await ContextManager.open({ path, strategy: again, membrane: { complete: async () => ({ stopReason: 'end_turn', content: text('MEM') }) } as never, viewFilter } as never);
      assert.deepStrictEqual(again.all().map((s) => named(ids, s.sourceIds).join(',')), ['M0,M1,M2,M3', 'M4,M6,M7']);
    } finally {
      await manager.close();
      await reopened?.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a message the view stops showing while its chunk waits is left out the same way', async () => {
    const viewFilter = (m: StoredMessage): boolean =>
      !m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('HIDE'));
    const { manager, strategy, ids, requests, path } = await chunked(12, (call, ids, manager) => {
      if (call === 1) manager.editMessage(ids[5]! as never, text(body('HIDE M5')));
    }, { viewFilter });
    try {
      await tickUntil(manager, () => requests.length >= 2);
      assert.ok(!summarized(requests[1]!).includes('M5'), `the second request summarizes ${summarized(requests[1]!)}`);
      for (const s of strategy.all()) assert.ok(!s.sourceIds.includes(ids[5]!), `${s.id} names M5 among its sources`);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  async function fourSummaries(
    onCall: (call: number, ids: string[], manager: ContextManager) =>
      string | Error | ContentBlock[] | { stopReason: string; content: ContentBlock[] } | void = () => undefined,
    extra: Record<string, unknown> = {},
  ): Promise<{ manager: ContextManager; strategy: Probe; ids: string[]; path: string; requests: string[] }> {
    const requests: string[] = [];
    const ids: string[] = [];
    let manager!: ContextManager;
    const membrane = {
      complete: async (req: unknown) => {
        requests.push(JSON.stringify(req));
        const answer = onCall(requests.length, ids, manager);
        if (answer instanceof Error) throw answer;
        if (answer && typeof answer === 'object' && 'stopReason' in answer) return answer;
        const content = Array.isArray(answer) ? answer : [{ type: 'text', text: answer ?? `MEM[${requests.length}]` }];
        return { stopReason: 'end_turn', content };
      },
    };
    const strategy = new Probe({
      compressionModel: 'm', hierarchical: true, headWindowTokens: 1, recentWindowTokens: 0, l1HoldbackChunks: 0,
      targetChunkTokens: 60, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
    } as never);
    const path = freshPath();
    manager = await ContextManager.open({ path, strategy, membrane: membrane as never, ...extra } as never);
    for (let i = 0; i < 16; i++) ids.push(manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`))));
    await tickUntil(manager, () => strategy.all().length >= 4);
    assert.deepStrictEqual(strategy.all().map((s) => named(ids, s.sourceIds).join(',')),
      ['M0,M1,M2,M3', 'M4,M5,M6,M7', 'M8,M9,M10,M11', 'M12,M13,M14,M15']);
    return { manager, strategy, ids, path, requests };
  }

  const parentOf = (strategy: Probe, requests: string[], content: string): { request: string } | undefined => {
    const child = strategy.all().find((s) => s.content === content)!;
    const parent = strategy.all().find((s) => s.level === 2 && s.sourceIds.includes(child.id));
    const call = parent ? Number(/^MEM\[(\d+)\]$/.exec(parent.content)?.[1]) : NaN;
    return parent ? { request: requests[call - 1]! } : undefined;
  };

  it('a message removed while the transport rejects a merge\'s reasoning is not in the retry without it', async () => {
    const rejected = Object.assign(new Error('400: thinking blocks cannot be modified'),
      { type: 'invalid_request', retryable: false, httpStatus: 400 });
    const { manager, strategy, ids, path, requests } = await fourSummaries((call, ids, manager) => {
      if (call === 5) return [{ type: 'thinking', thinking: 'carried reasoning', signature: 'signature' } as never, { type: 'text', text: 'MEM[5]' }];
      if (call === 6) {
        manager.removeMessage(ids[9]! as never);
        return rejected;
      }
    });
    try {
      strategy.mergeAt(2);
      for (let i = 0; i < 30; i++) await manager.tick();
      assert.ok(requests[5]!.includes('carried reasoning') && requests[5]!.includes('M9 '),
        'premise: the second merge\'s request carried reasoning and summarized M9');
      for (const [i, request] of requests.entries()) {
        if (i > 5) assert.ok(!request.includes('M9 '), `request ${i + 1} summarizes M9`);
      }
      assert.ok(requests.length > 6, 'the merge ran again');
      const written = parentOf(strategy, requests, 'MEM[3]');
      assert.ok(written, 'MEM[3] merged');
      assert.ok(!written.request.includes('M9 ') && written.request.includes('M8 '), 'the merge that was written summarized the rest');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a head message removed while the transport rejects a merge\'s reasoning is not in the retry without it, and the discard counts nothing', async () => {
    const rejected = Object.assign(new Error('400: thinking blocks cannot be modified'),
      { type: 'invalid_request', retryable: false, httpStatus: 400 });
    const { manager, strategy, ids, requests, path } = await chunked(20, (call, ids, manager) => {
      if (call === 5) {
        return { stopReason: 'end_turn', content: [
          { type: 'thinking', thinking: 'carried reasoning', signature: 'signature' } as never, { type: 'text', text: 'MEM[5]' },
        ] };
      }
      if (call === 6) {
        manager.removeMessage(ids[0]! as never);
        return rejected;
      }
    }, {}, { hierarchical: true, headWindowTokens: 60 });
    try {
      await tickUntil(manager, () => strategy.all().length >= 4);
      assert.deepStrictEqual(strategy.all().map((s) => named(ids, s.sourceIds).join(',')),
        ['M1,M2,M3,M4', 'M5,M6,M7,M8', 'M9,M10,M11,M12', 'M13,M14,M15,M16'], 'premise: M0 is the head');
      strategy.mergeAt(2);
      const queue = (strategy as unknown as { mergeQueue: Array<{ attempts?: number }> }).mergeQueue;
      for (let i = 0; i < 30 && requests.length < 6; i++) await manager.tick();
      assert.ok(requests[5]!.includes('carried reasoning') && carries(requests[5]!, 'M0'),
        'premise: the second merge\'s request recalled reasoning and carried M0 as its head');
      assert.strictEqual(requests.length, 6, 'the retry without reasoning was not sent');
      assert.strictEqual(queue[0]?.attempts ?? 0, 0, 'the discard counted an attempt');
      for (let i = 0; i < 30 && strategy.all().filter((s) => s.level === 2).length < 2; i++) await manager.tick();
      for (const [i, request] of requests.entries()) {
        if (i > 5) assert.ok(!carries(request, 'M0'), `request ${i + 1} carries M0`);
      }
      assert.strictEqual(strategy.all().filter((s) => s.level === 2).length, 2, 'the second merge was written');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a raw message between the head and a merge\'s range, removed while the transport rejects the merge\'s reasoning, is not in the retry without it', async () => {
    const rejected = Object.assign(new Error('400: thinking blocks cannot be modified'),
      { type: 'invalid_request', retryable: false, httpStatus: 400 });
    const refusal = { stopReason: 'refusal', content: [{ type: 'text', text: '' }] as ContentBlock[] };
    let mergeAt = 0;
    const { manager, strategy, ids, requests, path } = await chunked(16, (call, ids, manager, request) => {
      if (summarized(request)[0] === 'M4') return refusal;
      if (mergeAt === 0 && carries(request, 'M9') && carries(request, 'M13')) {
        mergeAt = call;
        manager.removeMessage(ids[5]! as never);
        return rejected;
      }
    }, {}, { hierarchical: true });
    try {
      await tickUntil(manager, () => strategy.all().filter((s) => s.level === 1).length >= 3);
      assert.deepStrictEqual(strategy.all().filter((s) => s.level === 1).map((s) => named(ids, s.sourceIds).join(',')),
        ['M0,M1,M2,M3', 'M8,M9,M10,M11', 'M12,M13,M14,M15'], 'premise: the second chunk is refused and stays raw');
      strategy.all()[0]!.responseContent = [
        { type: 'thinking', thinking: 'carried reasoning', signature: 'signature' } as never,
        { type: 'text', text: 'MEM[1]' },
      ];
      strategy.mergeAt(2);
      for (let i = 0; i < 30 && mergeAt === 0; i++) await manager.tick();
      assert.ok(mergeAt > 0, 'premise: the merge of the last two summaries was asked for');
      const first = requests[mergeAt - 1]!;
      assert.ok(first.includes('carried reasoning') && carries(first, 'M5'),
        'premise: the merge\'s request recalled reasoning and carried M5 raw');
      for (let i = 0; i < 30 && !strategy.all().some((s) => s.level === 2); i++) await manager.tick();
      for (const [i, request] of requests.entries()) {
        if (i >= mergeAt) assert.ok(!carries(request, 'M5'), `request ${i + 1} carries M5`);
      }
      assert.ok(strategy.all().some((s) => s.level === 2), 'the merge was written');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a message of thinking alone in a merge\'s range, removed while the transport rejects the merge\'s reasoning, leaves the retry without it to go out', async () => {
    const rejected = Object.assign(new Error('400: thinking blocks cannot be modified'),
      { type: 'invalid_request', retryable: false, httpStatus: 400 });
    let merging = false;
    let mergeCalls = 0;
    let rejectedAt = 0;
    const { manager, strategy, ids, requests, path } = await chunked(0, (call, ids, manager) => {
      if (!merging) return;
      mergeCalls++;
      if (mergeCalls === 1) {
        return { stopReason: 'end_turn', content: [
          { type: 'thinking', thinking: 'carried reasoning', signature: 'signature' } as never, { type: 'text', text: `MEM[${call}]` },
        ] };
      }
      if (mergeCalls === 2) {
        rejectedAt = call;
        manager.removeMessage(ids[9]! as never);
        return rejected;
      }
    }, {}, { hierarchical: true });
    try {
      for (let i = 0; i < 17; i++) {
        ids.push(i === 9
          ? manager.addMessage('assistant', [{ type: 'thinking', thinking: 'a thought', signature: 'signature' } as unknown as ContentBlock])
          : manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`))));
      }
      await tickUntil(manager, () => strategy.all().filter((s) => s.level === 1).length >= 4);
      const holder = strategy.all().filter((s) => s.level === 1)[2]!;
      assert.ok(holder.sourceIds.includes(ids[9]!) && holder.sourceIds.includes(ids[10]!), 'premise: the third summary covers the message of thinking alone');
      merging = true;
      strategy.mergeAt(2);
      for (let i = 0; i < 30 && mergeCalls < 3; i++) await manager.tick();
      const sent = requests[rejectedAt - 1]!;
      assert.ok(rejectedAt > 0 && sent.includes('carried reasoning') && carries(sent, 'M10'),
        'premise: the merge holding it recalled reasoning and was rejected');
      const next = requests[rejectedAt];
      const names = (request: string): string => [...new Set(request.match(/\bM\d+\b/g) ?? [])].sort().join(',');
      assert.ok(next !== undefined && !next.includes('carried reasoning') && names(next) === names(sent),
        `the retry without reasoning went out next: ${next === undefined ? 'nothing' : names(next)} after ${names(sent)}`);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('the answer to a merge request sent before a message it summarizes was removed is kept', async () => {
    const { manager, strategy, ids, path } = await fourSummaries((call, ids, manager) => {
      if (call === 5) manager.removeMessage(ids[2]! as never);
    });
    try {
      strategy.mergeAt(2);
      for (let i = 0; i < 30 && !strategy.all().some((s) => s.level === 2); i++) await manager.tick();
      const parent = strategy.all().find((s) => s.level === 2)!;
      assert.strictEqual(parent.content, 'MEM[5]');
      assert.deepStrictEqual(parent.sourceIds.map((id) => strategy.all().find((s) => s.id === id)!.content), ['MEM[1]', 'MEM[2]']);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a queued merge whose source lost every message is dropped and its other sources offered, not refused as crossed', async () => {
    const { manager, strategy, ids, path } = await fourSummaries();
    try {
      strategy.mergeAt(2);
      const queue = (strategy as unknown as { mergeQueue: Array<{ sourceIds: string[] }> }).mergeQueue;
      const contents = (sourceIds: string[]) => sourceIds.map((id) => strategy.all().find((s) => s.id === id)?.content).join('+');
      assert.deepStrictEqual(queue.map((m) => contents(m.sourceIds)), ['MEM[1]+MEM[2]'], 'premise: MEM[1] and MEM[2] are queued');
      for (const i of [4, 5, 6, 7]) manager.removeMessage(ids[i]! as never);
      const quarantine = (strategy as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine;
      const emptied = strategy.all().find((s) => s.content === 'MEM[2]')!.id;
      const log = await logged(() => manager.tick());
      droppedWithWarning(log);
      assert.ok(log.warnings.some((line) => line.includes(`whose merge check found: source position unresolved (range endpoints neither in the store listing nor owned by a chunk): ${emptied}`)),
        'the warning names this entry\'s finding: the emptied source can\'t be placed');
      assert.strictEqual(quarantine.size, 0, 'no merge refused');
      assert.ok(!queue.some((m) => contents(m.sourceIds).includes('MEM[2]')), 'the entry with MEM[2] is gone from the queue');
      assert.ok(queue.some((m) => contents(m.sourceIds).startsWith('MEM[1]+MEM[3]')), 'MEM[1] is offered with MEM[3]');
      for (let i = 0; i < 30; i++) await manager.tick();
      const parent = strategy.all().find((s) => s.level === 2 && s.sourceIds.some((id) => strategy.all().find((x) => x.id === id)?.content === 'MEM[1]'));
      assert.ok(parent, 'MEM[1] merged');
      assert.ok(!contents(parent.sourceIds).includes('MEM[2]'), 'MEM[2] is not among its sources');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a queued merge with a source that lost every message is refused as crossed, not dropped, when its other sources aren\'t adjacent', async () => {
    const { manager, strategy, ids, path, requests } = await fourSummaries();
    try {
      const byContent = (content: string) => strategy.all().find((s) => s.content === content)!.id;
      const queue = (strategy as unknown as { mergeQueue: Array<{ level: number; sourceIds: string[]; attempts: number }> }).mergeQueue;
      queue.push({ level: 2, sourceIds: [byContent('MEM[1]'), byContent('MEM[2]'), byContent('MEM[4]')], attempts: 0 });
      for (const i of [4, 5, 6, 7]) manager.removeMessage(ids[i]! as never);
      const sent = requests.length;
      const { errors } = await logged(() => manager.tick());
      assert.strictEqual(requests.length, sent, 'no merge request sent');
      const quarantine = (strategy as unknown as { mergeQuarantine: Map<string, { lastOutcome: string }> }).mergeQuarantine;
      assert.deepStrictEqual([...quarantine.values()].map((r) => r.lastOutcome), ['topology_violation'], 'MEM[1] and MEM[4], with MEM[3] between them, are refused');
      const reason = [...(quarantine.values() as Iterable<{ lastErrorType?: string }>)][0]!.lastErrorType ?? '';
      assert.ok(reason.startsWith('sources are not adjacent in store order: ') && reason.includes(byContent('MEM[1]')) && reason.includes(byContent('MEM[4]')) && !reason.includes(byContent('MEM[2]')),
        `the refusal names the other sources' problem: ${reason}`);
      assert.ok(errors.some((line) => REFUSED.test(line)), 'the refusal is an operator error');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a queued merge with a source that lost every message is dropped when its other sources are adjacent', async () => {
    const { manager, strategy, ids, path, requests } = await fourSummaries();
    try {
      const byContent = (content: string) => strategy.all().find((s) => s.content === content)!.id;
      const queue = (strategy as unknown as { mergeQueue: Array<{ level: number; sourceIds: string[]; attempts: number }> }).mergeQueue;
      queue.push({ level: 2, sourceIds: [byContent('MEM[1]'), byContent('MEM[2]'), byContent('MEM[3]')], attempts: 0 });
      for (const i of [4, 5, 6, 7]) manager.removeMessage(ids[i]! as never);
      const sent = requests.length;
      droppedWithWarning(await logged(() => manager.tick()));
      assert.strictEqual(requests.length, sent, 'no merge request sent');
      assert.ok(!queue.some((m) => m.sourceIds.includes(byContent('MEM[2]'))), 'the entry with MEM[2] left the queue');
      const quarantine = (strategy as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine;
      assert.strictEqual(quarantine.size, 0, 'no merge refused');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a queued merge whose source still has a message in the view is refused as crossed, not dropped, when its sources aren\'t adjacent', async () => {
    const { manager, strategy, ids, path, requests } = await fourSummaries();
    try {
      const byContent = (content: string) => strategy.all().find((s) => s.content === content)!.id;
      const queue = (strategy as unknown as { mergeQueue: Array<{ level: number; sourceIds: string[]; attempts: number }> }).mergeQueue;
      queue.push({ level: 2, sourceIds: [byContent('MEM[2]'), byContent('MEM[4]')], attempts: 0 });
      for (const i of [4, 5]) manager.removeMessage(ids[i]! as never);
      const sent = requests.length;
      const { errors } = await logged(() => manager.tick());
      assert.strictEqual(requests.length, sent, 'no merge request sent');
      const quarantine = (strategy as unknown as { mergeQuarantine: Map<string, { lastOutcome: string }> }).mergeQuarantine;
      assert.deepStrictEqual([...quarantine.values()].map((r) => r.lastOutcome), ['topology_violation'], 'MEM[2], which keeps M6 and M7, and MEM[4], with MEM[3] between them, are refused');
      assert.ok(errors.some((line) => REFUSED.test(line)), 'the refusal is an operator error');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a queued merge whose sources lost every message, the store\'s last, merges nothing and is refused nothing', async () => {
    const { manager, strategy, ids, path, requests } = await fourSummaries();
    try {
      strategy.mergeAt(2);
      assert.ok((strategy as unknown as { mergeQueue: unknown[] }).mergeQueue.length > 0, 'premise: a merge is queued');
      for (const id of ids) manager.removeMessage(id as never);
      const sent = requests.length;
      droppedWithWarning(await logged(async () => {
        for (let i = 0; i < 3; i++) await manager.tick();
      }));
      assert.strictEqual(requests.length, sent, 'no merge request sent');
      assert.deepStrictEqual((strategy as unknown as { mergeQueue: unknown[] }).mergeQueue, [], 'the entry left the queue');
      assert.deepStrictEqual(strategy.all().filter((s) => s.level === 2).map((s) => s.content), [], 'no L2 written');
      const quarantine = (strategy as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine;
      assert.strictEqual(quarantine.size, 0, 'no merge refused');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('two summaries\' parents merge into one above them when nothing was removed', async () => {
    const { manager, strategy, path } = await twoParents();
    try {
      strategy.mergeAt(2);
      for (let i = 0; i < 30; i++) await manager.tick();
      assert.strictEqual(strategy.all().filter((s) => s.level === 3).length, 1);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('the range query spans a summary from the first to the last of its messages still there', async () => {
    const { manager, ids, path } = await fourSummaries();
    try {
      for (const i of [4, 8, 11, 15]) manager.removeMessage(ids[i]! as never);
      const listed = manager.getSummariesInRange({});
      assert.deepStrictEqual(listed.map((s) => s.content), ['MEM[1]', 'MEM[2]', 'MEM[3]', 'MEM[4]']);
      const view = context(manager).messageStore;
      const span = (content: string) => {
        const s = listed.find((x) => x.content === content)!;
        return [s.firstMessageId, s.lastMessageId, s.startMs, s.endMs, s.firstSequence, s.lastSequence];
      };
      const of = (first: number, last: number) => {
        const a = view.get(ids[first]! as never)!;
        const b = view.get(ids[last]! as never)!;
        return [a.id, b.id, a.timestamp.getTime(), b.timestamp.getTime(), a.sequence, b.sequence];
      };
      assert.deepStrictEqual(span('MEM[2]'), of(5, 7));
      assert.deepStrictEqual(span('MEM[3]'), of(9, 10));
      assert.deepStrictEqual(span('MEM[4]'), of(12, 14));
      const start = of(5, 5)[2] as number;
      assert.ok(!manager.getSummariesInRange({ toMs: start - 1 }).some((s) => s.content === 'MEM[2]'), 'a range before its span leaves MEM[2] out');
      assert.ok(manager.getSummariesInRange({ fromMs: start, toMs: start }).some((s) => s.content === 'MEM[2]'), 'a range at its start lists MEM[2]');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('the range query spans a merged summary from the first to the last of its messages still there', async () => {
    const { manager, strategy, ids, path } = await twoParents();
    try {
      manager.removeMessage(ids[0]! as never);
      const parent = strategy.all().find((s) => s.level === 2 && s.sourceIds.some((id) => strategy.all().find((x) => x.id === id)?.content === 'MEM[1]'))!;
      const listed = manager.getSummariesInRange({ level: 2 }).find((s) => s.id === parent.id);
      assert.ok(listed, 'the L2 is listed');
      assert.deepStrictEqual([listed.firstMessageId, listed.lastMessageId], [ids[1], ids[7]]);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('the range query spans a summary over its messages the view\'s filter still shows', async () => {
    const viewFilter = (m: StoredMessage): boolean =>
      !m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('HIDE'));
    const { manager, ids, path } = await fourSummaries(undefined, { viewFilter });
    try {
      manager.editMessage(ids[4]! as never, text(`HIDE ${body('M4')}`));
      manager.editMessage(ids[11]! as never, text(`HIDE ${body('M11')}`));
      for (const i of [12, 13, 14, 15]) manager.editMessage(ids[i]! as never, text(`HIDE ${body(`M${i}`)}`));
      const listed = manager.getSummariesInRange({});
      assert.deepStrictEqual(listed.map((s) => s.content), ['MEM[1]', 'MEM[2]', 'MEM[3]']);
      const ends = (content: string) => {
        const s = listed.find((x) => x.content === content)!;
        return [s.firstMessageId, s.lastMessageId];
      };
      assert.deepStrictEqual(ends('MEM[2]'), [ids[5], ids[7]]);
      assert.deepStrictEqual(ends('MEM[3]'), [ids[8], ids[10]]);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('the range query leaves out a summary with no message left', async () => {
    const { manager, ids, path } = await fourSummaries();
    try {
      for (const i of [4, 5, 6, 7]) manager.removeMessage(ids[i]! as never);
      assert.deepStrictEqual(manager.getSummariesInRange({}).map((s) => s.content), ['MEM[1]', 'MEM[3]', 'MEM[4]']);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a compile places a summary whose first message was removed at its first message still there', async () => {
    const { manager, ids, path } = await fourSummaries();
    try {
      const order = async (): Promise<string[]> => {
        const out = (await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages;
        return [...JSON.stringify(out).matchAll(/MEM\[(\d+)\]/g)].map((m) => `MEM[${m[1]}]`);
      };
      assert.deepStrictEqual(await order(), ['MEM[1]', 'MEM[2]', 'MEM[3]', 'MEM[4]']);
      manager.removeMessage(ids[4]! as never);
      assert.deepStrictEqual(await order(), ['MEM[1]', 'MEM[2]', 'MEM[3]', 'MEM[4]']);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('the combined recall pair\'s label orders its summaries by the same rule', async () => {
    const { manager, strategy, ids, path } = await fourSummaries();
    try {
      manager.removeMessage(ids[4]! as never);
      assert.deepStrictEqual(strategy.labelOrder(context(manager)).map((s) => s.content),
        ['MEM[1]', 'MEM[2]', 'MEM[3]', 'MEM[4]']);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a summary with no message left goes after the rest in a compile', async () => {
    const { manager, ids, path } = await fourSummaries();
    try {
      for (const i of [4, 5, 6, 7]) manager.removeMessage(ids[i]! as never);
      const out = (await manager.compile({ maxTokens: 1_000_000, reserveForResponse: 0 })).messages;
      assert.deepStrictEqual([...JSON.stringify(out).matchAll(/MEM\[(\d+)\]/g)].map((m) => `MEM[${m[1]}]`),
        ['MEM[1]', 'MEM[3]', 'MEM[4]', 'MEM[2]']);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  const mergedWith = (strategy: Probe): string[] => strategy.all().filter((s) => s.level === 2).map((s) =>
    s.sourceIds.map((id) => strategy.all().find((x) => x.id === id)!.content).join('+')).sort();
  const unmergedL1s = (strategy: Probe): string[] =>
    strategy.all().filter((s) => s.level === 1 && !s.mergedInto).map((s) => s.content);

  it('a summary with no message left stays out of merges', async () => {
    const { manager, strategy, ids, path } = await fourSummaries();
    try {
      for (const i of [4, 5, 6, 7]) manager.removeMessage(ids[i]! as never);
      const second = strategy.all().find((s) => s.content === 'MEM[2]')!;
      const unplaced = (positions: Map<string, number>): boolean =>
        !positions.has(second.sourceRange.first) && !positions.has(second.sourceRange.last);
      strategy.readOrder(context(manager));
      const before = strategy.mergePositions();
      assert.ok([...before.values()].every(Number.isFinite), 'a position that is no number');
      assert.ok(unplaced(before), 'MEM[2] is placed before a rebuild');
      manager.addMessage('user', text(body('M16')));
      assert.ok(unplaced(strategy.mergePositions()), 'MEM[2] is placed after a rebuild');
      strategy.mergeAt(2);
      for (let i = 0; i < 30; i++) await manager.tick();
      assert.ok(unmergedL1s(strategy).includes('MEM[2]'), `MEM[2] merged: ${mergedWith(strategy)}`);
      assert.deepStrictEqual(mergedWith(strategy), ['MEM[1]+MEM[3]+MEM[4]'], 'premise: merges run');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a summary whose range starts at a message that isn\'t one of its own stays out of merges', async () => {
    const { manager, strategy, path } = await fourSummaries();
    try {
      const second = strategy.all().find((s) => s.content === 'MEM[2]')!;
      second.sourceRange = { ...second.sourceRange, first: 'gone' };
      strategy.mergeAt(2);
      for (let i = 0; i < 30; i++) await manager.tick();
      assert.ok(unmergedL1s(strategy).includes('MEM[2]'), `MEM[2] merged: ${mergedWith(strategy)}`);
      assert.ok(mergedWith(strategy).includes('MEM[3]+MEM[4]'), 'premise: merges run');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('a summary whose first message was removed merges before anything rebuilds the chunks', async () => {
    const { manager, strategy, ids, path } = await fourSummaries();
    try {
      manager.removeMessage(ids[4]! as never);
      strategy.mergeAt(2);
      for (let i = 0; i < 30; i++) await manager.tick();
      assert.deepStrictEqual(unmergedL1s(strategy), []);
      assert.deepStrictEqual(mergedWith(strategy), ['MEM[1]+MEM[2]', 'MEM[3]+MEM[4]']);
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  async function twoParents(): Promise<{ manager: ContextManager; strategy: Probe; ids: string[]; path: string; requests: string[] }> {
    const four = await fourSummaries();
    const { manager, strategy } = four;
    strategy.mergeAt(2);
    for (let i = 0; i < 30 && strategy.all().filter((s) => s.level === 2).length < 2; i++) await manager.tick();
    assert.deepStrictEqual(mergedWith(strategy), ['MEM[1]+MEM[2]', 'MEM[3]+MEM[4]'], 'premise: two L2s');
    assert.ok(!strategy.all().some((s) => s.level === 3), 'premise: no L3 yet');
    (strategy as unknown as { mergeQueue: unknown[] }).mergeQueue.length = 0;
    (strategy as unknown as { config: { mergeThreshold: number } }).config.mergeThreshold = 99;
    return four;
  }

  for (const [child, removed] of [['first', [0, 1, 2, 3]], ['last', [12, 13, 14, 15]]] as const) {
    it(`a summary whose ${child} child lost every message still merges, by its other children`, async () => {
      const { manager, strategy, ids, path } = await twoParents();
      try {
        for (const i of removed) manager.removeMessage(ids[i]! as never);
        manager.addMessage('user', text(body('M16')));
        strategy.mergeAt(2);
        for (let i = 0; i < 30; i++) await manager.tick();
        assert.strictEqual(strategy.all().filter((s) => s.level === 3).length, 1, 'the two L2s merged');
      } finally {
        await manager.close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  }

  for (const [children, sourceIds] of [['don\'t resolve', ['no-such-child-1', 'no-such-child-2']], ['are none', []]] as const) {
    it(`a queued merge with a parent whose children ${children} is refused as crossed, not dropped as having no message left`, async () => {
      const { manager, strategy, path, requests } = await twoParents();
      try {
        strategy.mergeAt(2);
        const queue = (strategy as unknown as { mergeQueue: Array<{ level: number }> }).mergeQueue;
        assert.deepStrictEqual(queue.map((m) => m.level), [3], 'premise: an L3 merge is queued');
        const damaged = strategy.all().find((s) => s.level === 2)!;
        damaged.sourceIds = [...sourceIds];
        damaged.sourceRange = { ...damaged.sourceRange!, first: 'no-such-message' };
        const sent = requests.length;
        await manager.tick();
        assert.strictEqual(requests.length, sent, 'no merge request sent');
        const quarantine = (strategy as unknown as { mergeQuarantine: Map<string, { lastOutcome: string }> }).mergeQuarantine;
        assert.deepStrictEqual([...quarantine.values()].map((r) => r.lastOutcome), ['topology_violation']);
      } finally {
        await manager.close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  }

  it('a queued merge with a parent whose one child lost every message is dropped though its other child doesn\'t resolve', async () => {
    const { manager, strategy, ids, path, requests } = await twoParents();
    try {
      strategy.mergeAt(2);
      const queue = (strategy as unknown as { mergeQueue: Array<{ level: number }> }).mergeQueue;
      assert.deepStrictEqual(queue.map((m) => m.level), [3], 'premise: an L3 merge is queued');
      for (const i of [0, 1, 2, 3]) manager.removeMessage(ids[i]! as never);
      const damaged = strategy.all().find((s) => s.level === 2 && s.sourceIds.some((id) => strategy.all().find((x) => x.id === id)?.content === 'MEM[1]'))!;
      damaged.sourceIds = [damaged.sourceIds[0]!, 'no-such-child'];
      const sent = requests.length;
      droppedWithWarning(await logged(() => manager.tick()));
      assert.strictEqual(requests.length, sent, 'no merge request sent');
      assert.deepStrictEqual(queue, [], 'the entry left the queue');
      const quarantine = (strategy as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine;
      assert.strictEqual(quarantine.size, 0, 'no merge refused');
    } finally {
      await manager.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  for (const beside of ['doesn\'t resolve', 'has no children', 'isn\'t placed', 'is at another level', 'starts at the emptied source\'s first message', 'ends at the emptied source\'s last message', 'shares the emptied source\'s first message as its own last', 'is stored with no range'] as const) {
    it(`a queued merge with a source that lost every message is dropped though the one source beside it ${beside}`, async () => {
      const { manager, strategy, ids, path, requests } = await twoParents();
      try {
        const byContent = (content: string) => strategy.all().find((s) => s.content === content)!;
        const parentOver = (content: string) => strategy.all().find((s) => s.level === 2 && s.sourceIds.includes(byContent(content).id))!;
        const [emptied, other] = [parentOver('MEM[1]'), parentOver('MEM[3]')];
        for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) manager.removeMessage(ids[i]! as never);
        if (beside === 'doesn\'t resolve') other.sourceIds = [other.sourceIds[0]!, 'no-such-child'];
        if (beside === 'has no children') other.sourceIds = [];
        if (beside === 'starts at the emptied source\'s first message') other.sourceRange = { ...other.sourceRange, first: emptied.sourceRange.first };
        if (beside === 'ends at the emptied source\'s last message') other.sourceRange = { ...other.sourceRange, last: emptied.sourceRange.last };
        if (beside === 'shares the emptied source\'s first message as its own last') {
          const last = byContent('MEM[4]');
          last.sourceIds = [...last.sourceIds, ids[0]!];
          last.sourceRange = { ...last.sourceRange, last: ids[0]! };
          other.sourceRange = { ...other.sourceRange, last: ids[0]! };
        }
        if (beside === 'is stored with no range') (other as { sourceRange?: unknown }).sourceRange = undefined;
        if (beside === 'isn\'t placed') other.sourceRange = { ...other.sourceRange, first: 'no-such-message' };
        if (beside === 'is at another level') (other as { level: number }).level = 3;
        const queue = (strategy as unknown as { mergeQueue: Array<{ level: number; sourceIds: string[]; attempts: number }> }).mergeQueue;
        queue.push({ level: 3, sourceIds: [emptied.id, other.id], attempts: 0 });
        const sent = requests.length;
        droppedWithWarning(await logged(() => manager.tick()));
        assert.strictEqual(requests.length, sent, 'no merge request sent');
        assert.deepStrictEqual(queue, [], 'the entry left the queue');
        const quarantine = (strategy as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine;
        assert.strictEqual(quarantine.size, 0, 'no merge refused');
      } finally {
        await manager.close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  }

  for (const damage of ['is at another level', 'is the entry\'s only source', 'is listed twice in the entry', 'has a range end naming no message', 'has a range end naming a message of the source beside it', 'has no message under it and a stored range with no ends', 'is stored with no range, and its first and last child have no message'] as const) {
    it(damage === 'has no message under it and a stored range with no ends'
      ? 'a queued merge with a source that has no message under it and a stored range with no ends is refused as crossed'
      : `a queued merge whose source lost every message is dropped though that source ${damage}`, async () => {
      const { manager, strategy, ids, path, requests } = await twoParents();
      try {
        const byContent = (content: string) => strategy.all().find((s) => s.content === content)!;
        const parentOver = (content: string) => strategy.all().find((s) => s.level === 2 && s.sourceIds.includes(byContent(content).id))!;
        const [emptied, other] = [parentOver('MEM[1]'), parentOver('MEM[3]')];
        for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) manager.removeMessage(ids[i]! as never);
        if (damage === 'is at another level') (emptied as { level: number }).level = 3;
        if (damage === 'has a range end naming no message') emptied.sourceRange = { ...emptied.sourceRange, first: 'no-such-message' };
        if (damage === 'has a range end naming a message of the source beside it') emptied.sourceRange = { ...emptied.sourceRange, first: ids[8]! };
        if (damage === 'has no message under it and a stored range with no ends') {
          for (const id of emptied.sourceIds) strategy.all().find((s) => s.id === id)!.sourceIds = [];
          emptied.sourceRange = { first: undefined, last: undefined } as unknown as SummaryEntry['sourceRange'];
        }
        if (damage === 'is stored with no range, and its first and last child have no message') {
          const [first, second] = emptied.sourceIds as [string, string];
          strategy.all().find((s) => s.id === first)!.sourceIds = [];
          emptied.sourceIds = [first, second, first];
          (emptied as { sourceRange?: unknown }).sourceRange = undefined;
        }
        const queue = (strategy as unknown as { mergeQueue: Array<{ level: number; sourceIds: string[]; attempts: number }> }).mergeQueue;
        const sourceIds = damage === 'is the entry\'s only source' ? [emptied.id]
          : damage === 'is listed twice in the entry' ? [emptied.id, emptied.id, other.id] : [emptied.id, other.id];
        queue.push({ level: 3, sourceIds, attempts: 0 });
        const sent = requests.length;
        const log = await logged(() => manager.tick());
        assert.strictEqual(requests.length, sent, 'no merge request sent');
        const quarantine = (strategy as unknown as { mergeQuarantine: Map<string, { lastOutcome: string }> }).mergeQuarantine;
        const dropped = damage !== 'has no message under it and a stored range with no ends';
        assert.deepStrictEqual([...quarantine.values()].map((r) => r.lastOutcome), dropped ? [] : ['topology_violation']);
        if (dropped) assert.deepStrictEqual(queue, [], 'the entry left the queue');
        if (dropped) droppedWithWarning(log);
        else assert.ok(log.errors.some((line) => REFUSED.test(line)), 'the refusal is an operator error');
      } finally {
        await manager.close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  }

  for (const end of ['first', 'last'] as const) {
    it(`a summary whose range's ${end} end isn't its ${end} child's stays out of merges`, async () => {
      const { manager, strategy, path } = await twoParents();
      try {
        const child = end === 'first' ? 'MEM[1]' : 'MEM[4]';
        const parent = strategy.all().find((s) => s.level === 2 && s.sourceIds.some((id) => strategy.all().find((x) => x.id === id)?.content === child))!;
        parent.sourceRange = { ...parent.sourceRange, [end]: 'gone' };
        strategy.mergeAt(2);
        for (let i = 0; i < 30; i++) await manager.tick();
        assert.strictEqual(strategy.all().filter((s) => s.level === 3).length, 0, 'the L2s merged');
      } finally {
        await manager.close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  }

  for (const [removed, edge] of [[4, 'first'], [3, 'last']] as const) {
    it(`a summary whose ${edge} message was removed still merges with its neighbours`, async () => {
      const { manager, strategy, ids, path } = await fourSummaries();
      try {
        manager.removeMessage(ids[removed]! as never);
        manager.addMessage('user', text(body('M16')));
        strategy.mergeAt(2);
        for (let i = 0; i < 30; i++) await manager.tick();
        const l1s = strategy.all().filter((s) => s.level === 1);
        assert.deepStrictEqual(l1s.filter((s) => !s.mergedInto).map((s) => s.content), []);
        const l2s = strategy.all().filter((s) => s.level === 2).map((s) =>
          s.sourceIds.map((id) => strategy.all().find((x) => x.id === id)!.content).join('+'));
        assert.deepStrictEqual(l2s.sort(), ['MEM[1]+MEM[2]', 'MEM[3]+MEM[4]']);
      } finally {
        await manager.close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  }

  describe('the transition summary', () => {
    for (const how of ['removed', 'hidden by the view\'s filter'] as const) {
      it(`leaves out of its request a head message ${how} before the reset`, async () => {
        const requests: string[] = [];
        const membrane = {
          complete: async (req: unknown) => {
            requests.push(JSON.stringify(req));
            return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Transition summary.' }] };
          },
        };
        const strategy = new Probe({
          compressionModel: 'm', headWindowTokens: 1_000_000, recentWindowTokens: 0, autoTickOnNewMessage: false,
        } as never);
        const viewFilter = (m: StoredMessage): boolean =>
          !m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('HIDE'));
        const path = freshPath();
        const manager = await ContextManager.open({ path, strategy, membrane: membrane as never, viewFilter } as never);
        try {
          const ids: string[] = [];
          for (let i = 0; i < 4; i++) ids.push(manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`))));
          if (how === 'removed') manager.removeMessage(ids[2]! as never);
          else manager.editMessage(ids[2]! as never, text(`HIDE ${body('M2')}`));
          await manager.resetHeadWindow();
          assert.strictEqual(requests.length, 1);
          assert.ok(carries(requests[0]!, 'M1') && carries(requests[0]!, 'M3'), 'premise: the request carries the head');
          assert.ok(!carries(requests[0]!, 'M2'), `the transition's request carries M2`);
        } finally {
          await manager.close();
          rmSync(path, { recursive: true, force: true });
        }
      });
    }
  });

  describe('the live head\'s start', () => {
    const transitionMembrane = {
      complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'Transition summary.' }] }),
    };
    const open = async (path: string): Promise<{ manager: ContextManager; strategy: Probe }> => {
      const strategy = new Probe({
        compressionModel: 'm', headWindowTokens: 1000, recentWindowTokens: 0, targetChunkTokens: 1_000_000,
        autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99,
      } as never);
      const manager = await ContextManager.open({ path, strategy, membrane: transitionMembrane as never });
      return { manager, strategy };
    };
    const transitions = (ctx: StrategyContext): number[] =>
      ctx.messageStore.getAll().flatMap((m, i) =>
        m.content.some((c) => c.type === 'text' && (c as { text: string }).text.startsWith('[Topic Transition]')) ? [i] : []);

    it('is found again after a removal and an addition leave the message count as it was', async () => {
      const path = freshPath();
      const { manager, strategy } = await open(path);
      try {
        const ids: string[] = [];
        for (let i = 0; i < 6; i++) ids.push(manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`))));
        await manager.resetHeadWindow('A new topic.');
        manager.addMessage('user', text(body('AFTER0')));
        const ctx = context(manager);
        assert.strictEqual(strategy.headStart(ctx), transitions(ctx)[0]);
        manager.removeMessage(ids[2]! as never);
        manager.addMessage('user', text(body('AFTER1')));
        assert.strictEqual(strategy.headStart(ctx), transitions(ctx)[0]);
      } finally {
        await manager.close();
        rmSync(path, { recursive: true, force: true });
      }
    });

    it('starts where a restart would start it once its start message is removed', async () => {
      const path = freshPath();
      let { manager, strategy } = await open(path);
      try {
        for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`)));
        await manager.resetHeadWindow('Topic one.');
        for (let i = 4; i < 8; i++) manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`)));
        await manager.resetHeadWindow('Topic two.');
        manager.addMessage('user', text(body('M8')));
        const ctx = context(manager);
        const [first, second] = transitions(ctx);
        assert.strictEqual(strategy.headStart(ctx), second);
        manager.removeMessage(ctx.messageStore.getAll()[second!]!.id as never);
        const live = strategy.headStart(ctx);
        assert.strictEqual(live, first);
        await manager.close();
        ({ manager, strategy } = await open(path));
        assert.strictEqual(strategy.headStart(context(manager)), live);
      } finally {
        await manager.close();
        rmSync(path, { recursive: true, force: true });
      }
    });

    it('starts at the opening once its start message is removed and no transition is left, as a restart starts it', async () => {
      const path = freshPath();
      let { manager, strategy } = await open(path);
      try {
        for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'assistant' : 'user', text(body(`M${i}`)));
        await manager.resetHeadWindow('The only topic change.');
        manager.addMessage('user', text(body('M4')));
        const ctx = context(manager);
        const [only] = transitions(ctx);
        assert.strictEqual(strategy.headStart(ctx), only);
        manager.removeMessage(ctx.messageStore.getAll()[only!]!.id as never);
        assert.strictEqual(strategy.headStart(ctx), 0);
        await manager.close();
        ({ manager, strategy } = await open(path));
        assert.strictEqual(strategy.headStart(context(manager)), 0);
      } finally {
        await manager.close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  });

});
