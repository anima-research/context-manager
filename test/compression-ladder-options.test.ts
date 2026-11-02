import { describe, it, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

type Config = ConstructorParameters<typeof AutobiographicalStrategy>[0];
type Answer = { content: unknown[]; stopReason: string; usage: { inputTokens: number; outputTokens: number }; raw?: unknown };

const MODEL = 'test-compression-model';
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const say = (i: number, mark = '') => `message ${i}: ${mark}` + 'a considered sentence about the work at hand. '.repeat(3);
const answer = (t: string, outputTokens = 20): Answer => ({ content: [text(t)], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens } });
const longMemory = () => answer('a long consolidated memory of the stretch before. '.repeat(400), 5_000);
const REFUSAL: Answer = {
  content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 },
  raw: { response: { stop_details: { category: 'reasoning_extraction' } } },
};
const rejection = () => Object.assign(new Error('zz invalid_request failure'), { type: 'invalid_request', retryable: false, httpStatus: 400 });
const admissionDeferral = () => Object.assign(new Error('zz held by provider admission'), {
  type: 'rate_limit', retryable: true, providerAdmission: 'deferred', retryAfterMs: 0,
});

function requestText(request: NormalizedRequest): string {
  return request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
}
const mergeLevel = (request: NormalizedRequest) => Number(/into a single L(\d+) memory/.exec(requestText(request))?.[1] ?? 0);
const messagesIn = (request: NormalizedRequest) => requestText(request).match(/message \d+:/g) ?? [];
function recallIds(request: NormalizedRequest): string[] {
  return request.messages.flatMap((m) => m.content.flatMap((b) => {
    if (b.type !== 'text') return [];
    const match = /^\[CM\] Recall memory (.+)\.$/.exec(b.text);
    return match ? [match[1]!] : [];
  }));
}

function membraneOf(handler: (request: NormalizedRequest) => Answer) {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        return handler(request);
      },
    } as never,
  };
}

function config(extra: Partial<Config> = {}): Config {
  return {
    compressionModel: MODEL,
    targetChunkTokens: 100,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    l1HoldbackChunks: 0,
    minChunkCharsForLLM: 0,
    ...extra,
  } as Config;
}

function storePath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ladder-options-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store');
}

function pendingChunks(manager: ContextManager): number {
  const match = manager.getPendingWork()?.description.match(/(\d+) chunks/);
  return match ? Number(match[1]) : 0;
}

let said = 0;
function closeChunks(manager: ContextManager, n: number, mark = ''): void {
  const target = pendingChunks(manager) + n;
  for (let added = 0; pendingChunks(manager) < target; added++) {
    assert.ok(added < 50 * n, `premise: ${n} more chunk(s) close (${manager.getPendingWork()?.description})`);
    manager.addMessage(said % 2 ? 'Claude' : 'User', [text(say(said, mark))]);
    said++;
  }
}

function closeChunkOf(manager: ContextManager, size: number): void {
  const before = pendingChunks(manager);
  for (let i = 1; i < size; i++) {
    manager.addMessage(said % 2 ? 'Claude' : 'User', [text(say(said))]);
    said++;
  }
  manager.addMessage(said % 2 ? 'Claude' : 'User', [text(say(said) + 'a long passage of the same thought. '.repeat(120))]);
  said++;
  assert.equal(pendingChunks(manager), before + 1, `premise: a chunk of ${size} closed (${manager.getPendingWork()?.description})`);
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 300 && !manager.isReady(); i++) await manager.tick().catch(() => {});
  assert.ok(manager.isReady(), `premise: the queue drained (${manager.getPendingWork()?.description})`);
}

interface Stored { id: string; level: number; content: string; mergedInto?: string; sourceIds: string[] }
function summaries(manager: ContextManager): Stored[] {
  const stored = manager.getStore().getStateJson('default/autobio:summaries');
  return (Array.isArray(stored) ? stored : []).filter(Boolean) as Stored[];
}
const unmergedAt = (manager: ContextManager, level: number) =>
  summaries(manager).filter((s) => s.level === level && !s.mergedInto);

async function treeWithL2s(manager: ContextManager, l2s: number): Promise<void> {
  for (let i = 0; i < 40 && unmergedAt(manager, 2).length < l2s; i++) {
    closeChunks(manager, 1);
    await drain(manager);
  }
  assert.equal(unmergedAt(manager, 2).length, l2s, `premise: ${l2s} unmerged L2s (${summaries(manager).map((s) => s.id).join(' ')})`);
  assert.equal(unmergedAt(manager, 3).length, 0, 'premise: no L3');
}

describe('compression lifecycle: the ladder and its options', () => {
  it('an L1 request asks for max(16000, summaryTargetTokens × 1.5) output tokens', async (t) => {
    for (const [summaryTargetTokens, maxTokens] of [[12_000, 18_000], [8_000, 16_000]]) {
      const { membrane, calls } = membraneOf(() => answer('A summary.'));
      const manager = await ContextManager.open({
        path: storePath(t),
        strategy: new AutobiographicalStrategy(config({ summaryTargetTokens })),
        membrane,
      });
      closeChunks(manager, 1);
      await manager.tick();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.config.maxTokens, maxTokens, `summaryTargetTokens ${summaryTargetTokens}`);
      manager.close();
    }
  });

  it("compressionMaxTokens caps an L1 request's output tokens", async (t) => {
    const { membrane, calls } = membraneOf(() => answer('A summary.'));
    const manager = await ContextManager.open({
      path: storePath(t),
      strategy: new AutobiographicalStrategy(config({ compressionMaxTokens: 1_000 })),
      membrane,
    });
    closeChunks(manager, 1);
    await manager.tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.config.maxTokens, 1_000);
    manager.close();
  });

  it('the opt-in recovery of a whole <thinking> wrapper reads only an answer of text blocks alone', async (t) => {
    const wrapped: Answer = {
      content: [
        { type: 'thinking', thinking: 'native private reasoning', signature: 'signed' },
        text('<thinking>the wrapped prose</thinking>'),
      ],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 40 },
    };
    const { membrane, calls } = membraneOf(() => (calls.length === 1 ? wrapped : answer('the plain memory')));
    const manager = await ContextManager.open({
      path: storePath(t),
      strategy: new AutobiographicalStrategy(config({ recoverLiteralThinkingWrappedCompression: true })),
      membrane,
    });
    closeChunks(manager, 1);
    await drain(manager);
    assert.deepEqual(summaries(manager).map((s) => s.content), ['the plain memory']);
    manager.close();
  });

  describe('split-stitch', () => {
    const splitConfig = (extra: Partial<Config> = {}) => config({
      compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true,
      compressionSplitFallback: true,
      ...extra,
    });
    const piecesOfOne = (request: NormalizedRequest) => (messagesIn(request).length > 1 ? REFUSAL : answer('piece'));

    it('a rung may make 40 calls for one chunk by default, and no more', async (t) => {
      for (const [size, stitched] of [[21, true], [22, false]] as const) {
        const { membrane, calls } = membraneOf(piecesOfOne);
        const manager = await ContextManager.open({ path: storePath(t), strategy: new AutobiographicalStrategy(splitConfig({ targetChunkTokens: 1_000 })), membrane });
        closeChunkOf(manager, size);
        await manager.tick();
        assert.equal(messagesIn(calls[0]!).length, size, 'premise: the canonical request holds the whole chunk');
        assert.equal(calls.length - 2, 40, `a chunk of ${size} needs ${2 * size - 2} split calls after the canonical request and source-only-final`);
        assert.equal(summaries(manager).length, stitched ? 1 : 0, stitched ? 'the stitched L1 is written' : 'the rung stops at the cap');
        manager.close();
      }
    });

    it('a rung starts only when the ten-minute window, 80 calls by default, has room for a whole attempt', async (t) => {
      mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.after(() => mock.timers.reset());
      {
        const manager = await ContextManager.open({ path: storePath(t), strategy: new AutobiographicalStrategy(splitConfig({ targetChunkTokens: 1_000 })), membrane: membraneOf(piecesOfOne).membrane });
        for (let i = 0; i < 3; i++) closeChunkOf(manager, 21);
        for (let i = 0; i < 3; i++) await manager.tick();
        assert.equal(summaries(manager).length, 2, 'after 40 calls a 40-call attempt fits the 80; after 80 the third waits');
        assert.equal(pendingChunks(manager), 1, 'the third waits, queued');
        mock.timers.setTime(Date.now() + 10 * 60_000 + 1_000);
        await manager.tick();
        assert.equal(summaries(manager).length, 3, 'once its window\'s calls age out, the third is stitched');
        manager.close();
      }
      {
        const manager = await ContextManager.open({
          path: storePath(t),
          strategy: new AutobiographicalStrategy(splitConfig({ targetChunkTokens: 1_000, compressionSplitMaxCallsPerChunk: 39 })),
          membrane: membraneOf(piecesOfOne).membrane,
        });
        closeChunkOf(manager, 11);
        closeChunkOf(manager, 12);
        closeChunkOf(manager, 11);
        for (let i = 0; i < 3; i++) await manager.tick();
        assert.equal(summaries(manager).length, 2, 'after 42 calls a 39-call attempt would take the window to 81');
        assert.equal(pendingChunks(manager), 1, 'the third waits, queued');
        manager.close();
      }
    });

    it('a chunk waiting for its call window stays queued, and the tick goes on to the chunk behind it', async (t) => {
      mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.after(() => mock.timers.reset());
      const { membrane, calls } = membraneOf((request) => {
        const body = requestText(request);
        return body.includes('REFUSE') && !body.includes('KEEP') && messagesIn(request).length > 2 ? REFUSAL : answer('a memory');
      });
      const manager = await ContextManager.open({
        path: storePath(t),
        strategy: new AutobiographicalStrategy(splitConfig({ compressionSplitMaxCallsPer10Min: 3 })),
        membrane,
      });
      closeChunks(manager, 2, 'REFUSE ');
      await manager.tick();
      assert.equal(summaries(manager).length, 1, 'premise: the first chunk was stitched from its pieces');
      await manager.tick();
      assert.equal(pendingChunks(manager), 1, 'premise: the second chunk waits for its window');
      closeChunks(manager, 1, 'KEEP ');
      const before = calls.length;
      await manager.tick();
      assert.ok(calls.length > before, 'the tick goes on past the waiting chunk');
      assert.equal(summaries(manager).length, 2);
      assert.ok(requestText(calls.at(-1)!).includes('KEEP'));
      assert.equal(pendingChunks(manager), 1, 'the waiting chunk is still queued');
      manager.close();
    });
  });

  describe('recall-curve variants and merges', () => {
    const treeConfig = (extra: Partial<Config> = {}) => config({ hierarchical: true, mergeThreshold: 4, ...extra });

    it('after a refusal, three recall-curve variants are tried when no count is given', async (t) => {
      let target = false;
      const { membrane, calls } = membraneOf((request) => (target && requestText(request).includes('TARGET') ? REFUSAL : answer('a memory')));
      const manager = await ContextManager.open({
        path: storePath(t),
        strategy: new AutobiographicalStrategy(treeConfig({ compressionRefusalCurveFallbacks: undefined })),
        membrane,
      });
      await treeWithL2s(manager, 3);
      target = true;
      const before = calls.length;
      closeChunks(manager, 1, 'TARGET ');
      await manager.tick();
      const asked = calls.slice(before);
      assert.equal(asked.length, 4, 'the canonical request and three variants');
      assert.equal(new Set(asked.map((r) => JSON.stringify(recallIds(r)))).size, 4, 'each variant expands a different summary');
      manager.close();
    });

    it("a request-attributable rejection of the canonical request tries no variant", async (t) => {
      let target = false;
      const { membrane, calls } = membraneOf((request) => {
        if (target && requestText(request).includes('TARGET')) throw rejection();
        return answer('a memory');
      });
      const manager = await ContextManager.open({ path: storePath(t), strategy: new AutobiographicalStrategy(treeConfig()), membrane });
      await treeWithL2s(manager, 3);
      target = true;
      const before = calls.length;
      closeChunks(manager, 1, 'TARGET ');
      await manager.tick().catch(() => {});
      assert.equal(calls.length - before, 1);
      manager.close();
    });

    it('compressionSourceOnly leaves the recall of a merge as it is', async (t) => {
      const { membrane, calls } = membraneOf((request) => (mergeLevel(request) ? longMemory() : answer('a memory')));
      const manager = await ContextManager.open({
        path: storePath(t),
        strategy: new AutobiographicalStrategy(treeConfig({ compressionSourceOnly: true })),
        membrane,
      });
      await treeWithL2s(manager, 3);
      const merges = calls.filter((r) => mergeLevel(r) === 2);
      const [first, second] = unmergedAt(manager, 2);
      assert.deepEqual(recallIds(merges.at(-1)!).filter((id) => id.startsWith('L2')), [first!.id, second!.id]);
      manager.close();
    });

    it("each retry of a merge a provider rejected halves the merge's recall budget, down to an 8,000-token floor", async (t) => {
      // A recall pair costs its summary's tokens and some 50 to 120 for its envelope. So 16,000 holds the two
      // 7,800s but not the 300 beside them, and 8,000 holds one 7,800 but not the 300.
      const sizes = [300, 7_800, 7_800];
      const rejected: string[][] = [];
      let merged = 0;
      const { membrane } = membraneOf((request) => {
        if (mergeLevel(request) !== 2) return answer('a memory');
        if (merged < sizes.length) {
          const tokens = sizes[merged++]!;
          return answer('a long consolidated memory. '.repeat(tokens / 7), tokens);
        }
        rejected.push(recallIds(request).filter((id) => id.startsWith('L2')));
        throw rejection();
      });
      const manager = await ContextManager.open({
        path: storePath(t),
        strategy: new AutobiographicalStrategy(treeConfig({ compressionRecallBudgetTokens: 32_000 })),
        membrane,
      });
      await treeWithL2s(manager, 3);
      const [small, older, newest] = unmergedAt(manager, 2).map((s) => s.id);
      closeChunks(manager, 5);
      await drain(manager);
      assert.deepEqual(
        rejected,
        [[small, older, newest], [older, newest], [newest], [newest], [newest]],
        'budgets of 32,000, 16,000 and 8,000, then the 8,000 floor twice, over earlier merges of 300, 7,800 and 7,800 tokens, oldest first',
      );
      manager.close();
    });

    it("a merge the caller's provider admission defers keeps its place and counts no failure", async (t) => {
      let admitted = false;
      const { membrane, calls } = membraneOf((request) => {
        if (mergeLevel(request) && !admitted) throw admissionDeferral();
        return answer('a memory');
      });
      const strategy = new AutobiographicalStrategy(treeConfig());
      const manager = await ContextManager.open({ path: storePath(t), strategy, membrane });
      closeChunks(manager, 10);
      for (let i = 0; i < 40 && pendingChunks(manager) > 0; i++) await manager.tick();
      assert.match(manager.getPendingWork()?.description ?? '', /^[2-9] merges pending/, 'premise: two merges queued');
      await assert.rejects(manager.tick(), /held by provider admission/);
      await assert.rejects(manager.tick(), /held by provider admission/);
      const merges = calls.filter((r) => mergeLevel(r));
      assert.equal(merges.length, 2);
      assert.equal(messagesIn(merges[1]!)[0], messagesIn(merges[0]!)[0], 'the deferred merge is asked again');
      for (let i = 0; i < 8; i++) {
        closeChunks(manager, 1);
        await manager.tick();
        await assert.rejects(manager.tick(), /held by provider admission/, 'an L1 landed, then the merge was deferred again');
        assert.equal(messagesIn(calls.filter((r) => mergeLevel(r)).at(-1)!)[0], messagesIn(merges[0]!)[0], 'the deferred merge is still asked first');
      }
      assert.equal(strategy.getCompressionDebt().mergeQueueMaxAttempts, 0, 'ten deferrals, eight after a landing, record no attempt on any merge');
      admitted = true;
      await drain(manager);
      assert.ok(manager.getMaxSummaryLevel() >= 2, 'the deferred merges land once admitted');
      manager.close();
    });

    it('a held L1 counts toward maxSpeculativeL1s', async (t) => {
      const path = storePath(t);
      {
        const manager = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(treeConfig({ mergeThreshold: 99 })), membrane: membraneOf(() => answer('a memory')).membrane });
        closeChunks(manager, 4);
        await drain(manager);
        closeChunks(manager, 1);
        manager.close();
      }
      const probe = await ContextManager.open({ path, strategy: new AutobiographicalStrategy(treeConfig({ mergeThreshold: 99 })) });
      const oldest = unmergedAt(probe, 1)[0]!.id;
      probe.close();
      const { membrane, calls } = membraneOf(() => answer('a memory'));
      const manager = await ContextManager.open({
        path,
        strategy: new AutobiographicalStrategy(treeConfig({ mergeThreshold: 2, maxSpeculativeL1s: 3, mergeHoldSummaryIds: [oldest] })),
        membrane,
      });
      assert.match(manager.getPendingWork()?.description ?? '', /1 chunks \+ 1 merges pending/, 'premise: a chunk and a merge are queued');
      await manager.tick();
      assert.equal(calls.length, 1);
      assert.equal(mergeLevel(calls[0]!), 2, 'past the cap, the merge goes before the chunk');
      manager.close();
    });
  });
});
