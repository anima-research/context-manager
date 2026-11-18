import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getMintRequestPreimageBytes } from '../src/index.js';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy, type AutobiographicalOptions, type SummaryEntry, type StrategyContext } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import { ZeroRecallSurgeryStrategy } from '../src/surgery/zero-recall-strategy.js';
import { transformZeroRecallCompression, assertZeroRecallConstruction, assertZeroRecallSourceSafe, transformConstructedZeroRecallCompression, captureZeroRecallConstruction } from '../src/surgery/zero-recall-compression.js';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const thinking: ContentBlock = { type: 'thinking', thinking: 'reasoning', signature: 'signed' };
class Probe extends ZeroRecallSurgeryStrategy {
  observed = 0;
  protected override observeL1CompressionRequest(request: NormalizedRequest, ids: readonly string[]) {
    this.observed++;
    super.observeL1CompressionRequest(request, ids);
  }
  minted() { return this.summaries.find(s => s.id !== 'L1-100'); }
  seed(summary: SummaryEntry) { this.pushSummary(summary); }
  compress(chunk: Chunk, ctx: StrategyContext) { return this.compressChunkHierarchical(chunk, ctx); }
}

async function exercise(content: ContentBlock[], options: AutobiographicalOptions = {}, rejectCarriers = false,
  inspect?: (request: NormalizedRequest, expected: ContentBlock[]) => void, rawResult = false, transientFirst = false) {
  const dir = mkdtempSync(join(tmpdir(), 'zc-'));
  const priorLog = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  const logPath = join(dir, 'compression.jsonl');
  process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
  const strategy = new Probe({ compressionModel: 'mock', headWindowTokens: 0, recentWindowTokens: 0,
    targetChunkTokens: 100, minChunkCharsForLLM: 0, mergeThreshold: 99, autoTickOnNewMessage: false,
    persistMintPreimages: true, quarantineAlarmIntervalMs: 0, compressionRefusalCurveFallbacks: 0, ...options });
  const requests: NormalizedRequest[] = [];
  const membrane = { complete: async (request: NormalizedRequest) => {
    const constructed = strategy.construction!;
    assert.ok(constructed, 'construction observer ran before transport');
    // Legacy transport surgery is reproduced when authoring has not run:
    // this makes the provenance regression fail on the pre-fix strategy.
    const authored = (strategy as unknown as { authoredRequest?: NormalizedRequest }).authoredRequest;
    const sent = authored ? request : {
      ...request, messages: transformConstructedZeroRecallCompression(request, strategy.opening(), constructed).messages,
    };
    if (authored) assertZeroRecallConstruction(request, authored);
    const expected = constructed.expectedAnswers.find(a => a.id === 'L1-100')!;
    assert.ok(expected, 'retained prior memory is actually recalled');
    const edited = transformConstructedZeroRecallCompression(constructed.request, strategy.opening(), constructed);
    assert.deepEqual(edited.removedRecallIds, ['L1-100']);
    assert.deepEqual(sent.messages, edited.messages, 'provider receives the zero-recall request');
    assert.ok(edited.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('source turn'))));
    assert.ok(edited.messages.some(m => m.content.some(b => b.type === 'text' && b.text === 'raw middle')),
      'same-speaker raw history is not blessed as part of a recall answer');
    // An interceptor cannot alter either the answer or any other request field.
    for (const changed of [
      { ...request, config: { ...request.config, model: 'different' } },
      { ...request, messages: request.messages.map((m, i) => i === 1 ? { ...m, content: [text('wrong')] } : m) },
    ]) assert.throws(() => assertZeroRecallConstruction(changed, authored ?? constructed.request), /differs from trusted/);
    inspect?.(sent, expected.answer.content);
    requests.push(structuredClone(sent));
    if (transientFirst && requests.length === 1) throw new Error('offline transient');
    if (rejectCarriers && requests.length === 1) throw Object.assign(new Error('invalid_request: thinking cannot be modified'), { httpStatus: 400, type: 'invalid_request', retryable: false });
    return { content: [text('new summary')], stopReason: 'end_turn' };
  } };
  const manager = await ContextManager.open({ path: dir, strategy, membrane: membrane as never });
  try {
    manager.setToolDefinitions([{ name: 'mock', description: 'mock', inputSchema: { type: 'object' } }] as never);
    const first = manager.addMessage('user', [text('prior covered turn')]);
    manager.addMessage('Claude', rawResult
      ? [{ type: 'tool_result', toolUseId: 'raw-call', content: [text('raw result')] }] : [text('raw middle')]);
    const source = manager.addMessage('user', [text('source turn '.repeat(50))]);
    strategy.seed({ id: 'L1-100', level: 1, content: 'stored summary', responseContent: content,
      tokens: 20, sourceLevel: 0, sourceIds: [first], sourceRange: { first, last: first }, created: 0 });
    const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
    const messages = ctx.messageStore.getAll().filter(m => m.id === source);
    const chunk: Chunk = { index: 1, startIndex: 2, endIndex: 3, messages, tokens: 100, compressed: false };
    let compression = strategy.compress(chunk, ctx);
    if (transientFirst) {
      await assert.rejects(compression, /offline transient/);
      const runs = (strategy as unknown as { compressionFailureRuns: Map<string, { run: { key: string } }> }).compressionFailureRuns;
      assert.equal(runs.size, 1);
      const [runSubject, value] = [...runs][0];
      assert.equal(value.run.key, createHash('sha256').update(JSON.stringify({ runSubject, curveLabel: 'canonical', stripped: false })).digest('hex'),
        'authoring is not a carrier-stripped retry');
      compression = strategy.compress(chunk, ctx);
      await compression;
      assert.equal(runs.size, 0, 'successful non-carrier retry clears the failed run');
    }
    if (rawResult) {
      await assert.rejects(compression, /Raw tool result collapsed into recall answer/);
    } else if (!content.some(b => b.type === 'text' && b.text.trim())) {
      await assert.rejects(compression, /Unstable or empty recall answer/);
    } else if (content.some(b => b.type === 'tool_result')) {
      await assert.rejects(compression, /Split recall answer/);
      assert.equal(strategy.observed, 1, 'refusal happened in the construction observer, not a missing-tools deferral');
    } else {
      await compression;
      const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const trace = entries.reverse().find(entry => entry.event === 'compression:attempt').metadata;
      assert.deepEqual(trace.recallIds, []);
      assert.deepEqual(trace.recallLevels, []);
      assert.equal(trace.leafCoverageHash, createHash('sha256').update('[]').digest('hex'));
      const receipt = entries.find(entry => entry.operation === 'compress_l1' && entry.messages);
      assert.equal(receipt.metadata.prior_summary_count_kept, 0);
      assert.equal(receipt.metadata.prior_summary_tokens, 0);
      assert.ok(!JSON.stringify(receipt.messages).includes('[CM] Recall memory'));
      const hash = strategy.minted()!.provenance!.requestHash;
      const sentBytes = JSON.stringify(requests.at(-1));
      assert.equal(hash, createHash('sha256').update(sentBytes).digest('hex'),
        'summary hash binds the full request actually sent, after recall removal');
      assert.equal(getMintRequestPreimageBytes(manager.getStore(), hash)!.toString('utf8'), sentBytes,
        'persisted provenance reconstructs the request the provider received');
    }
    return requests;
  } finally {
    manager.close(); rmSync(dir, { recursive: true, force: true });
    if (priorLog === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = priorLog;
  }
}

test('constructed expectations share empty-text sanitization and cache-control stripping', async () => {
  const input = [thinking, text(''), { ...text('summary'), cache_control: { type: 'ephemeral' } } as ContentBlock];
  const original = structuredClone(input);
  const calls = await exercise(input, {}, false, (_r, expected) => {
    assert.deepEqual(expected, [thinking, text('summary')]);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(input, original, 'stored summary blocks are not edited');
});

test('constructed expectations share serialized-media preparation in answers and opening', async () => {
  const url = 'data:image/png;base64,' + 'A'.repeat(10000);
  const calls = await exercise([thinking, text('summary ' + url)], {
    compressionInstructions: { templates: { opening: 'OPEN ' + url } },
  }, false, (request, expected) => {
    assert.ok(!JSON.stringify(expected).includes(url));
    assert.ok(!JSON.stringify(request).includes(url));
    assert.match(JSON.stringify(expected), /summary/);
  });
  assert.equal(calls.length, 1);
});

test('constructed expectations share whole-request image replacement', async () => {
  const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA'.repeat(100) } } as unknown as ContentBlock;
  const calls = await exercise([thinking, text('summary'), image], { maxCompressionImageBytes: 1 }, false,
    (_request, expected) => assert.ok(expected.every(b => b.type !== 'image')));
  assert.equal(calls.length, 1);
});

test('recall reasoning is removed before transport along with its answer', async () => {
  const calls = await exercise([thinking, text('summary')], {}, false, (_request, expected) => {
    assert.ok(expected.some(b => b.type === 'text'));
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].messages.every(m => m.content.every(b => b.type !== 'thinking')));
});

test('constructed expectations share unpaired-tool stripping', async () => {
  const calls = await exercise([thinking, text('summary'), { type: 'tool_use', id: 'orphan', name: 'mock', input: {} }], {}, false,
    (_r, expected) => assert.ok(expected.every(b => b.type !== 'tool_use')));
  assert.equal(calls.length, 1);
});

test('mixed-tool answers fail closed instead of treating a normalized fragment as a whole memory', async () => {
  const calls = await exercise([thinking, text('summary'),
    { type: 'tool_use', id: 'call', name: 'mock', input: {} },
    { type: 'tool_result', toolUseId: 'call', content: [text('result')] }, text('continuation')]);
  assert.equal(calls.length, 0);
});

test('source-safety binding rejects an ordinary raw turn equal to the opening', () => {
  assert.throws(() => assertZeroRecallSourceSafe([
    { participant: 'Context Manager', content: [text('OPEN')] },
  ], 'OPEN'), /collides with compression opening/);
});

test('cache stripping kill switch preserves imported answer cache metadata', async () => {
  const cached = { ...text('summary'), cache_control: { type: 'ephemeral' } } as ContentBlock;
  const calls = await exercise([thinking, cached], { compressionCacheMarkers: false }, false,
    (_r, expected) => assert.deepEqual(expected, [thinking, cached]));
  assert.equal(calls.length, 1);
});


test('construction-bound surgery refuses a raw false opening that truncates recall removal', () => {
  const request = { config: {}, messages: [
    { participant: 'Context Manager', content: [text('[CM] Recall memory L1-1.')] },
    { participant: 'Claude', content: [text('first')] },
    { participant: 'Context Manager', content: [text('OPEN')] },
    { participant: 'user', content: [text('raw')] },
    { participant: 'Context Manager', content: [text('[CM] Recall memory L1-2.')] },
    { participant: 'Claude', content: [text('second')] },
  ] } as NormalizedRequest;
  const construction = captureZeroRecallConstruction(request, ['L1-1', 'L1-2']);
  assert.throws(() => transformConstructedZeroRecallCompression(request, 'OPEN', construction), /Incomplete constructed recall removal/);
});

test('empty and carrier-only stored answers cannot capture an unrelated raw turn', async () => {
  for (const content of [[text('')], [thinking]]) {
    assert.equal((await exercise(content)).length, 0);
  }
});

test('raw tool results cannot collapse into a user-participant recall answer', async () => {
  const calls = await exercise([text('summary'),
    { type: 'tool_use', id: 'raw-call', name: 'mock', input: {} }],
    { summaryParticipant: 'user' }, false, undefined, true);
  assert.equal(calls.length, 0, 'refuse before raw source can be removed or sent');
});

// Keep a refused canonical rung durable by interrupting its source-only rung,
// then read that same branch through the other strategy's authoring mode.
for (const surgeryFirst of [true, false]) {
  test(`refusal progress is isolated between surgery and ordinary authoring (${surgeryFirst})`, async () => {
    class SwitchingProbe extends Probe {
      surgery = surgeryFirst;
      protected override compressionOutcomeNamespace() {
        return this.surgery ? super.compressionOutcomeNamespace() : undefined;
      }
      protected override authorL1CompressionRequest(request: NormalizedRequest, ids: readonly string[]) {
        return this.surgery ? super.authorL1CompressionRequest(request, ids) : request;
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'zi-'));
    const strategy = new SwitchingProbe({ compressionModel: 'mock', headWindowTokens: 0,
      recentWindowTokens: 0, targetChunkTokens: 100, minChunkCharsForLLM: 0,
      mergeThreshold: 99, autoTickOnNewMessage: false, compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true, quarantineAlarmIntervalMs: 0 });
    let phase = 0;
    const calls: NormalizedRequest[][] = [[], []];
    const membrane = { complete: async (request: NormalizedRequest) => {
      calls[phase].push(structuredClone(request));
      if (phase === 0) {
        if (calls[0].length === 1) return { content: [], stopReason: 'refusal' };
        throw new Error('offline interruption');
      }
      return { content: [text('new summary')], stopReason: 'end_turn' };
    } };
    const manager = await ContextManager.open({ path: dir, strategy, membrane: membrane as never });
    try {
      const first = manager.addMessage('user', [text('prior covered turn')]);
      manager.addMessage('Claude', [text('raw middle')]);
      const source = manager.addMessage('user', [text('source turn '.repeat(50))]);
      strategy.seed({ id: 'L1-100', level: 1, content: 'stored summary', tokens: 20,
        sourceLevel: 0, sourceIds: [first], sourceRange: { first, last: first }, created: 0 });
      const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
      const chunk: Chunk = { index: 1, startIndex: 2, endIndex: 3,
        messages: ctx.messageStore.getAll().filter(m => m.id === source), tokens: 100, compressed: false };
      await assert.rejects(strategy.compress(chunk, ctx), surgeryFirst
        ? /No recall pairs found; refusing zero-recall surgery/ : /offline interruption/);
      assert.equal(calls[0].length, surgeryFirst ? 1 : 2);
      const progressId = (strategy as unknown as { compressionFamilyProgressStateId: string }).compressionFamilyProgressStateId;
      const progress = manager.getStore().getStateJson(progressId) as Array<{
        outcomes: Array<{ curveLabel: string; outcome: string; requestHash: string }>;
      }>;
      assert.equal(progress.length, 1);
      assert.ok(progress[0]!.outcomes.some(outcome => outcome.curveLabel === 'canonical'
        && outcome.outcome === 'refusal' && outcome.requestHash.length === 64),
      'canonical refusal is persisted before the interrupted retry');
      phase = 1;
      strategy.surgery = !surgeryFirst;
      await strategy.compress(chunk, ctx);
      assert.equal(calls[1].length, 1, 'other strategy must dispatch its own canonical request');
      const hasRecall = JSON.stringify(calls[1][0]).includes('[CM] Recall memory L1-100.');
      assert.equal(hasRecall, surgeryFirst, 'ordinary canonical retains recall; surgery canonical removes it');
      assert.ok(strategy.minted(), 'the other strategy can mint despite the prior refusal');
    } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('authored canonical transient failures use and clear the non-carrier failure run', async () => {
  assert.equal((await exercise([text('summary')], {}, false, undefined, false, true)).length, 2);
});

for (const surgeryFirst of [true, false]) {
  test(`quarantine shape caps are isolated between authoring modes (${surgeryFirst})`, async () => {
    class SwitchingProbe extends Probe {
      surgery = surgeryFirst;
      budget(value: number) { this.config.compressionContextBudgetTokens = value; }
      heldSources() {
        return (this as unknown as { quarantinedChunkSources(): Map<string, readonly string[]> }).quarantinedChunkSources();
      }
      checkRetention() {
        const internal = this as unknown as {
          compressionRefusalQuarantineLedgerStateId: string;
          captureCompressionBranch(): unknown;
          checkpointCompressionQuarantineIfNeeded(source: unknown): void;
        };
        const id = internal.compressionRefusalQuarantineLedgerStateId;
        type Event = { kind: string; key: string; created: number; record: {
          key: string; familyKey: string; normalizedConfig: { outcomeNamespace?: string };
        } };
        const events = this.store!.getStateJson(id) as Event[];
        const examples = [undefined, 'zero-recall-surgery-v1'].map(namespace =>
          events.find(e => e.kind === 'exhausted' && e.record.normalizedConfig.outcomeNamespace === namespace)!);
        // A full newer namespace must not evict the older namespace at a
        // checkpoint. Each namespace independently drops its oldest excess.
        const crowded = examples.flatMap((example, mode) => Array.from({ length: 1025 }, (_, index) => {
          const key = `retention-${mode}-${index}`;
          return { ...example, key, eventId: key, sequence: mode * 1025 + index,
            created: mode * 1025 + index,
            record: { ...example.record, key, familyKey: key, created: mode * 1025 + index } };
        }));
        this.store!.setStateJson(id, crowded);
        internal.checkpointCompressionQuarantineIfNeeded(internal.captureCompressionBranch());
        const retained = (this.store!.getStateJson(id) as Array<{ kind: string; active?: Array<{ record: { key: string; normalizedConfig: { outcomeNamespace?: string } } }> }>).find(e => e.kind === 'checkpoint')!.active!;
        for (const [mode, namespace] of [undefined, 'zero-recall-surgery-v1'].entries()) {
          const keys = retained.filter(item => item.record.normalizedConfig.outcomeNamespace === namespace).map(item => item.record.key);
          assert.equal(keys.length, 1024);
          assert.ok(!keys.includes(`retention-${mode}-0`), 'oldest is evicted');
          assert.ok(keys.includes(`retention-${mode}-1024`), 'newest is retained');
        }
        assert.equal(this.getCompressionQuarantineStatus().count, 2048,
          'checkpoint retains up to 1024 records independently in each namespace');
      }
      protected override compressionOutcomeNamespace() {
        return this.surgery ? super.compressionOutcomeNamespace() : undefined;
      }
      protected override authorL1CompressionRequest(request: NormalizedRequest, ids: readonly string[]) {
        return this.surgery ? super.authorL1CompressionRequest(request, ids) : request;
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'zc-'));
    const strategy = new SwitchingProbe({ compressionModel: 'mock', headWindowTokens: 0,
      recentWindowTokens: 0, targetChunkTokens: 100, minChunkCharsForLLM: 0,
      mergeThreshold: 99, autoTickOnNewMessage: false, compressionRefusalCurveFallbacks: 0,
      quarantineAlarmIntervalMs: 0 });
    const calls: NormalizedRequest[] = [];
    const membrane = { complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request));
      return { content: [], stopReason: 'refusal' };
    } };
    const manager = await ContextManager.open({ path: dir, strategy, membrane: membrane as never });
    try {
      const first = manager.addMessage('user', [text('prior covered turn')]);
      manager.addMessage('Claude', [text('raw middle')]);
      const source = manager.addMessage('user', [text('source turn '.repeat(50))]);
      strategy.seed({ id: 'L1-100', level: 1, content: 'stored summary', tokens: 20,
        sourceLevel: 0, sourceIds: [first], sourceRange: { first, last: first }, created: 0 });
      const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
      const chunk: Chunk = { index: 1, startIndex: 2, endIndex: 3,
        messages: ctx.messageStore.getAll().filter(m => m.id === source), tokens: 100, compressed: false };
      for (const budget of [100_000, 101_000, 102_000]) {
        strategy.budget(budget);
        const before = calls.length;
        await strategy.compress(chunk, ctx);
        assert.ok(calls.length > before, 'each of three shapes must exhaust its own ladder');
      }
      assert.equal(strategy.getCompressionQuarantineStatus().count, 3);
      strategy.budget(103_000);
      const before = calls.length;
      await strategy.compress(chunk, ctx);
      assert.equal(calls.length, before, 'the first mode is capped at three quarantined shapes');
      strategy.surgery = !surgeryFirst;
      assert.equal(strategy.heldSources().size, surgeryFirst ? 0 : 1, 'source selection always follows ordinary quarantine');
      await strategy.compress(chunk, ctx);
      assert.ok(calls.length > before, 'the other mode must not inherit the exhausted shape cap');
      assert.equal(JSON.stringify(calls[before]).includes('[CM] Recall memory L1-100.'), surgeryFirst);
      assert.equal(strategy.getCompressionQuarantineStatus().count, 4, 'both modes retain their own exhaustion');
      strategy.surgery = surgeryFirst;
      assert.equal(strategy.heldSources().size, 1);
      strategy.surgery = !surgeryFirst;
      assert.equal(strategy.heldSources().size, 1);
      strategy.checkRetention();
    } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('ordinary telemetry retains collapsed headers and recall budget overhead on prose retry', async () => {
  class OrdinaryProbe extends Probe {
    protected override authorL1CompressionRequest(request: NormalizedRequest): NormalizedRequest {
      // Reproduce the multi-block CM turn produced by adjacent-turn collapse.
      return { ...request, messages: request.messages.map(message =>
        message.participant === 'Context Manager' && message.content.some(block =>
          block.type === 'text' && block.text === '[CM] Recall memory L1-100.')
          ? { ...message, content: [text('adjacent raw CM turn'), ...message.content] } : message) };
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'zt-'));
  const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  process.env.CONTEXT_MANAGER_COMPRESSION_LOG = join(dir, 'log');
  const strategy = new OrdinaryProbe({ compressionModel: 'mock', headWindowTokens: 0,
    recentWindowTokens: 0, minChunkCharsForLLM: 0, mergeThreshold: 99, autoTickOnNewMessage: false,
    quarantineAlarmIntervalMs: 0, compressionRefusalCurveFallbacks: 0 });
  let calls = 0;
  const manager = await ContextManager.open({ path: dir, strategy, membrane: { complete: async () => {
    calls++;
    return { content: calls === 1 ? [] : [text('summary')], stopReason: 'end_turn' };
  } } as never });
  try {
    const first = manager.addMessage('user', [text('covered')]);
    manager.addMessage('Claude', [text('raw middle')]);
    const source = manager.addMessage('user', [text('source turn '.repeat(50))]);
    strategy.seed({ id: 'L1-100', level: 1, content: 'stored summary', tokens: 20,
      sourceLevel: 0, sourceIds: [first], sourceRange: { first, last: first }, created: 0 });
    const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
    await strategy.compress({ index: 1, startIndex: 2, endIndex: 3,
      messages: ctx.messageStore.getAll().filter(m => m.id === source), tokens: 100, compressed: false }, ctx);
    assert.equal(calls, 2, 'empty response exercises the prose retry');
    const entries = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const traces = entries.filter(entry => entry.event === 'compression:attempt');
    assert.equal(traces.length, 2);
    for (const { metadata } of traces) {
      assert.deepEqual(metadata.recallIds, ['L1-100']);
      assert.deepEqual(metadata.recallLevels, [1]);
      assert.equal(metadata.leafCoverageHash, createHash('sha256').update(JSON.stringify([first])).digest('hex'));
    }
    const log = entries.find(entry => entry.operation === 'compress_l1' && entry.messages);
    assert.equal(log.metadata.prior_summary_count_kept, 1);
    assert.ok(log.metadata.prior_summary_tokens >= 70, 'includes pair and envelope overhead, not just 20 body tokens');
  } finally {
    manager.close(); rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
  }
});

test('an earlier reused call id cannot hide a deleted raw-result predecessor', () => {
  const use: ContentBlock = { type: 'tool_use', id: 'X', name: 'mock', input: {} };
  const result: ContentBlock = { type: 'tool_result', toolUseId: 'X', content: [text('result')] };
  const request = { config: {}, messages: [
    { participant: 'Claude', content: [use] },
    { participant: 'user', content: [result] },
    { participant: 'Context Manager', content: [text('[CM] Recall memory L1-1.')] },
    { participant: 'Claude', content: [text('summary'), use] },
    { participant: 'user', content: [result] },
    { participant: 'Context Manager', content: [text('OPEN')] },
  ] } as NormalizedRequest;
  const construction = captureZeroRecallConstruction(request, ['L1-1']);
  assert.throws(() => transformConstructedZeroRecallCompression(request, 'OPEN', construction), /Tool pair crosses/);
});


for (const headWindowTokens of [0, 10]) {
  test(`surgery and ordinary requests select identical quarantined sources (head=${headWindowTokens})`, async () => {
    class SelectionProbe extends Probe {
      surgery = false;
      captured?: NormalizedRequest;
      protected override compressionOutcomeNamespace() {
        return this.surgery ? super.compressionOutcomeNamespace() : undefined;
      }
      protected override authorL1CompressionRequest(request: NormalizedRequest): NormalizedRequest {
        this.captured = structuredClone(request);
        throw new Error('captured before dispatch');
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'zs-'));
    const strategy = new SelectionProbe({ compressionModel: 'mock', headWindowTokens,
      recentWindowTokens: 0, minChunkCharsForLLM: 0, mergeThreshold: 99,
      autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0 });
    const manager = await ContextManager.open({ path: dir, strategy, membrane: {
      complete: async () => { throw new Error('must not dispatch'); },
    } as never });
    try {
      const head = manager.addMessage('user', [text('ordinary held head')]);
      const surgeryOnly = manager.addMessage('Claude', [text('surgery only held must remain '.repeat(10))]);
      const middle = manager.addMessage('user', [text('ordinary held middle')]);
      const source = manager.addMessage('Claude', [text('target source '.repeat(50))]);
      Object.defineProperty(strategy, 'readCompressionQuarantineProjection', { value: () => new Map([
        ['ordinary', { record: { chunkSourceHash: 'ordinary', sourceIds: [head, middle],
          normalizedConfig: { accountingVersion: 2 } } }],
        ['surgery', { record: { chunkSourceHash: 'surgery', sourceIds: [surgeryOnly],
          normalizedConfig: { accountingVersion: 2, outcomeNamespace: 'zero-recall-surgery-v1' } } }],
      ]) });
      const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
      const chunk: Chunk = { index: 1, startIndex: 3, endIndex: 4,
        messages: ctx.messageStore.getAll().filter(m => m.id === source), tokens: 100, compressed: false };
      await assert.rejects(strategy.compress(chunk, ctx), /captured before dispatch/);
      const ordinary = strategy.captured!;
      const bytes = JSON.stringify(ordinary);
      assert.ok(!bytes.includes('ordinary held'), 'ordinary quarantine excludes head and raw middle');
      assert.ok(bytes.includes('surgery only held must remain'), 'surgery outcomes never filter source');
      strategy.surgery = true;
      await assert.rejects(strategy.compress(chunk, ctx), /captured before dispatch/);
      assert.deepEqual(strategy.captured, ordinary, 'before recall removal both modes author the same request');
    } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const enabled of [false, true]) {
  test(`public tick discards after close without telemetry masking the outcome (logging=${enabled})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zl-'));
    const previous = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    if (enabled) process.env.CONTEXT_MANAGER_COMPRESSION_LOG = join(dir, 'log');
    else delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    let started!: () => void;
    let release!: (response: unknown) => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise(resolve => { release = resolve; });
    const strategy = new AutobiographicalStrategy({ compressionModel: 'mock', headWindowTokens: 0,
      recentWindowTokens: 0, targetChunkTokens: 100, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
      mergeThreshold: 99, autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0 });
    const manager = await ContextManager.open({ path: dir, strategy, membrane: {
      complete: async () => { started(); return response; },
    } as never });
    try {
      for (let i = 0; i < 5; i++) manager.addMessage(i % 2 ? 'Claude' : 'user', [text('raw source '.repeat(100))]);
      assert.match(manager.getPendingWork()?.description ?? '', /chunks pending/);
      const tick = manager.tick();
      await entered;
      manager.close();
      release({ content: [text('stale summary')], stopReason: 'end_turn' });
      await tick;
      assert.deepEqual((strategy as unknown as { summaries: unknown[] }).summaries, []);
    } finally {
      manager.close();
      if (previous === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
      else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}


test('standalone transform refuses deleting a result whose raw tool use survives', () => {
  const answer = { participant: 'Claude', content: [
    { type: 'tool_result' as const, toolUseId: 'raw-call', content: [text('result')] },
  ] };
  assert.throws(() => transformZeroRecallCompression([
    { participant: 'Claude', content: [{type:'tool_use', id:'raw-call', name:'mock', input:{}}] },
    { participant: 'Context Manager', content: [text('[CM] Recall memory L1-1.')] },
    answer,
    { participant: 'Context Manager', content: [text('OPEN')] },
    { participant: 'user', content: [text('raw')] },
  ], 'OPEN', [{id:'L1-1', answer}]), /Tool pair crosses recall deletion boundary/);
});
