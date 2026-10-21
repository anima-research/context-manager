/**
 * What sending does to a raw message's tool blocks: a result
 * `toolResultMaxLastN` replaces and a `tool_use` input `toolUseInputMaxTokens`
 * truncates are decided from the whole conversation before the plan, applied
 * before the cap, and priced as sent, so the render stats count what goes out.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { CompileResult, SummaryEntry } from '../src/index.js';
import type { MessageStoreView, StoredMessage } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tool-pruning-price-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let stores = 0;

const PROSE = 'lorem ipsum dolor sit amet consectetur '.repeat(200).slice(0, 5_800);
const BUDGET = { maxTokens: 1_000_000, reserveForResponse: 0 };
const SELECTORS = [['adaptive', { adaptiveResolution: true }], ['hierarchical', { adaptiveResolution: false }]] as const;

type StoreInternals = {
  estimateTokens(m: StoredMessage): number;
  estimateBaseTokens(content: readonly ContentBlock[]): number;
  getTokenCalibration(): number;
};
type StrategyInternals = {
  _calibration: number;
  calibrationStateId: string;
  store: { setStateJson(id: string, value: unknown): void; getStateJson(id: string): unknown } | null;
};

class SeedableStrategy extends AutobiographicalStrategy {
  seed(entry: Omit<SummaryEntry, 'created'>): void {
    this.pushSummary({ ...entry, created: 0 });
  }
  formOf(store: MessageStoreView, msg: StoredMessage): StoredMessage {
    return this.prunedForSend(store, msg);
  }
}
const viewOf = (cm: ContextManager) => (cm as unknown as { strategyMessageView(): MessageStoreView }).strategyMessageView();

async function open(config: Record<string, unknown>, path = join(dir, `store-${stores++}`)) {
  const strategy = new SeedableStrategy({ compressionModel: 'mock', headWindowTokens: 0, recentWindowTokens: 1_000_000, ...config } as never);
  const cm = await ContextManager.open({ path, strategy });
  const store = (cm as unknown as { messageStore: StoreInternals }).messageStore;
  return { cm, strategy, store, internals: strategy as unknown as StrategyInternals, path };
}

const text = (body: string): ContentBlock[] => [{ type: 'text', text: body }];
const call = (id: string, name = 'lookup', input: Record<string, unknown> = { q: id }) =>
  ({ type: 'tool_use', id, name, input }) as ContentBlock;
const result = (id: string, body: string) => ({ type: 'tool_result', toolUseId: id, content: body }) as ContentBlock;

/** Lookups `from` to `from + count - 1`, each a call and a result of about 2,500 tokens. */
function lookups(cm: ContextManager, count: number, from = 1): string[] {
  const ids: string[] = [];
  for (let k = from; k < from + count; k++) {
    ids.push(cm.addMessage('a', [call(`call-${k}`)]), cm.addMessage('u', [result(`call-${k}`, `${k} ${PROSE}`)]));
  }
  return ids;
}

/** The render stats' total: the estimate calibration compares provider usage against. */
function estimateOf(cm: ContextManager): number {
  const rs = cm.getRenderStats()!;
  return rs.head.tokens + rs.tail.tokens + rs.middleRaw.tokens + rs.summaries.l1.tokens + rs.summaries.l2.tokens + rs.summaries.l3.tokens;
}
/** The store's estimate of the compiled messages as they go out. */
const sentOf = (store: StoreInternals, compiled: CompileResult): number =>
  compiled.messages.reduce((sum, m) => sum + store.estimateTokens({ content: m.content } as unknown as StoredMessage), 0);
const resultOf = (compiled: CompileResult, id: string): string | undefined => {
  for (const m of compiled.messages) {
    for (const b of m.content) if (b.type === 'tool_result' && b.toolUseId === id) return String(b.content);
  }
  return undefined;
};
const MARKER = "[result of tool 'lookup' left out: this context shows only the tool's last result]";

describe('tool pruning, priced as sent', () => {
  for (const [name, selector] of SELECTORS) {
    it(`${name}: prices the results the per-tool limit replaces as their markers`, async () => {
      const { cm, store } = await open({ ...selector, toolResultMaxLastN: 1 });
      cm.addMessage('u', text('look these up'));
      lookups(cm, 3);
      cm.addMessage('a', text('ok'));
      cm.addMessage('u', text('next'));
      const compiled = await cm.compile(BUDGET);
      assert.deepEqual(['call-1', 'call-2', 'call-3'].map((id) => resultOf(compiled, id) === MARKER), [true, true, false]);
      assert.equal(estimateOf(cm), sentOf(store, compiled), 'the render stats count what goes out');
      cm.close();
    });

    it(`${name}: prices a tool_use input the input cap truncates as truncated`, async () => {
      const { cm, store } = await open({ ...selector, toolUseInputMaxTokens: 100 });
      const inputOf = (k: number) => ({ path: `f${k}`, body: `${k} ${PROSE}`, mode: 'w', owner: 'me', group: 'us', size: k, tag: 't' });
      cm.addMessage('u', text('write these'));
      for (let k = 1; k <= 3; k++) {
        cm.addMessage('a', [call(`w-${k}`, 'write', inputOf(k))]);
        cm.addMessage('u', [result(`w-${k}`, 'written')]);
      }
      cm.addMessage('a', text('ok'));
      cm.addMessage('u', text('next'));
      const compiled = await cm.compile(BUDGET);
      const inputs = compiled.messages.flatMap((m) => m.content)
        .flatMap((b) => (b.type === 'tool_use' ? [b.input as Record<string, unknown>] : []));
      assert.deepEqual(inputs, [1, 2, 3].map((k) => ({
        _truncated: true,
        _originalTokens: Math.ceil(JSON.stringify(inputOf(k)).length / 4),
        // The store gives an object back with its keys sorted.
        _keys: ['body', 'group', 'mode', 'owner', 'path'],
      })), 'the input is truncated to its size and its first five keys');
      assert.equal(estimateOf(cm), sentOf(store, compiled), 'the render stats count what goes out');
      cm.close();
    });

    it(`${name}: replaces a result before the cap would cut it, and prices its marker`, async () => {
      // Each result is about 2,500 tokens, over a cap of 500: the newest is
      // cut, and the older ones are sent and priced as their markers. The
      // first result's message also carries a note after it, which a cap
      // taken before the replacement would have cut away with the result.
      const { cm, store } = await open({ ...selector, toolResultMaxLastN: 1, maxMessageTokens: 500 });
      cm.addMessage('u', text('look these up'));
      cm.addMessage('a', [call('call-1')]);
      cm.addMessage('u', [result('call-1', `1 ${PROSE}`), { type: 'text', text: 'a note after the result' }]);
      lookups(cm, 2, 2);
      cm.addMessage('a', text('ok'));
      cm.addMessage('u', text('next'));
      const compiled = await cm.compile(BUDGET);
      assert.equal(resultOf(compiled, 'call-1'), MARKER);
      assert.ok(compiled.messages.some((m) => m.content.some((b) => b.type === 'text' && b.text === 'a note after the result')),
        'the note after the replaced result is sent whole');
      assert.equal(resultOf(compiled, 'call-2'), MARKER);
      assert.match(resultOf(compiled, 'call-3')!, /truncated — original was/);
      assert.equal(estimateOf(cm), sentOf(store, compiled), 'the render stats count what goes out');
      cm.close();
    });
  }

  it('hierarchical, with recall pairs combined: prices the middle\'s replaced results as their markers', async () => {
    // No chunk forms and the head window is empty, so the lookups render raw
    // in the middle, after the combined recall pair.
    const { cm, store } = await open({
      adaptiveResolution: false, positionedRecallPairs: false, toolResultMaxLastN: 1, recentWindowTokens: 200, targetChunkTokens: 1_000_000,
    });
    cm.addMessage('u', text('look these up'));
    lookups(cm, 3);
    for (let k = 0; k < 4; k++) cm.addMessage(k % 2 ? 'a' : 'u', text(`chat ${k}`));
    const compiled = await cm.compile(BUDGET);
    assert.deepEqual(['call-1', 'call-2'].map((id) => resultOf(compiled, id)), [MARKER, MARKER]);
    assert.equal(estimateOf(cm), sentOf(store, compiled), 'the render stats count what goes out');
    cm.close();
  });

  it('leaves the multiplier at 1 when provider usage matches what was sent', async () => {
    // Four prose messages, then three results under a limit of 2, so one is
    // replaced. Each compile's sample is the base estimate of what went out.
    const { cm, strategy, store } = await open({ adaptiveResolution: true, toolResultMaxLastN: 2 });
    for (let k = 0; k < 4; k++) cm.addMessage(k % 2 ? 'a' : 'u', text(`p${k} ${PROSE}`));
    cm.addMessage('u', text('look these up'));
    lookups(cm, 3);
    cm.addMessage('a', text('ok'));
    for (let round = 0; round < 5; round++) {
      cm.addMessage('u', text(`next ${round}`));
      const compiled = await cm.compile(BUDGET);
      assert.equal(resultOf(compiled, 'call-1'), "[result of tool 'lookup' left out: this context shows only the tool's last 2 results]");
      strategy.reportRealInputTokens(compiled.messages.reduce((n, m) => n + store.estimateBaseTokens(m.content), 0));
    }
    assert.equal(store.getTokenCalibration(), 1);
    assert.equal((strategy as unknown as { _calibrationEma: number | null })._calibrationEma, 1, 'the samples were taken, at a ratio of 1');
    cm.close();
  });

  it('keeps a result replaced once its newer results fold, so the fold changes nothing before it', async () => {
    // The first lookup sits in the head window. Two newer lookups follow in
    // the middle, and the recent window holds none. Folding the middle into
    // a summary takes the newer results out of the selection, which counted
    // among the entries used to bring the first one back whole.
    // No chunk forms, so the hierarchical selection renders the middle raw
    // until a summary covers it.
    const { cm, strategy, store } = await open({
      adaptiveResolution: false, toolResultMaxLastN: 1, headWindowTokens: 3_000, recentWindowTokens: 200, targetChunkTokens: 1_000_000,
    });
    cm.addMessage('u', text('look this up'));
    lookups(cm, 1);
    cm.addMessage('a', text('noted'));
    // Too long for what's left of the head window, so the head ends before it.
    cm.addMessage('u', text(`and these ${PROSE}`));
    const middle = lookups(cm, 2, 2);
    cm.addMessage('a', text('done'));
    for (let k = 0; k < 4; k++) cm.addMessage(k % 2 ? 'a' : 'u', text(`chat ${k}`));
    const before = await cm.compile(BUDGET);
    assert.equal(resultOf(before, 'call-1'), MARKER);
    assert.equal(resultOf(before, 'call-2'), MARKER);
    assert.notEqual(resultOf(before, 'call-3'), undefined, 'the newest result renders raw before the fold');
    // The head and the middle are priced as sent too.
    assert.equal(estimateOf(cm), sentOf(store, before), 'the render stats count what goes out');
    strategy.seed({ id: 'L1-0', level: 1, content: 'two lookups', tokens: 4, sourceLevel: 0,
      sourceIds: middle, sourceRange: { first: middle[0]!, last: middle.at(-1)! } });
    const after = await cm.compile(BUDGET);
    assert.equal(resultOf(after, 'call-3'), undefined, 'the fold takes the newer results out');
    assert.equal(resultOf(after, 'call-1'), MARKER, 'the first result renders as it did');
    cm.close();
  });

  for (const [label, limit] of [
    ['null, as a caller outside TypeScript can pass', null],
    ['null for the tool', { lookup: null }],
    ['a negative number', -1],
    ['a negative number for the tool', { lookup: -1 }],
    ['a string for the tool, read as a number before', { lookup: '1' }],
    ['true for the tool, read as 1 before', { lookup: true }],
  ] as const) {
    it(`sets no limit for ${label}`, async () => {
      const { cm } = await open({ adaptiveResolution: true, toolResultMaxLastN: limit });
      cm.addMessage('u', text('look these up'));
      lookups(cm, 2);
      cm.addMessage('a', text('ok'));
      cm.addMessage('u', text('next'));
      const compiled = await cm.compile(BUDGET);
      assert.match(resultOf(compiled, 'call-1')!, /^1 lorem/);
      cm.close();
    });
  }

  it('counts a result whose call is on the first shard of a sharded message', async () => {
    // Ingress chunking puts a message's non-text blocks on its first shard,
    // so the call and its result aren't adjacent in the store: more shards
    // come between them than pairing repair looks ahead over. The count
    // follows calls, not adjacency, and the head and recent windows join a
    // body's shards, so the result answers its call and takes a slot.
    const { cm } = await open({ adaptiveResolution: true, targetChunkTokens: 100, toolResultMaxLastN: 1 });
    cm.addMessage('u', text('look these up'));
    cm.addMessage('a', [{ type: 'text', text: `thinking aloud ${PROSE}` }, call('call-1')]);
    assert.ok(cm.getAllMessages().filter((m) => m.bodyGroupId).length > 7, 'more shards than pairing repair looks ahead over');
    cm.addMessage('u', [result('call-1', 'short one')]);
    cm.addMessage('a', [call('call-2')]);
    cm.addMessage('u', [result('call-2', 'short two')]);
    cm.addMessage('a', text('ok'));
    cm.addMessage('u', text('next'));
    const compiled = await cm.compile(BUDGET);
    assert.equal(resultOf(compiled, 'call-1'), MARKER);
    assert.equal(resultOf(compiled, 'call-2'), 'short two');
    cm.close();
  });

  it('replaces only the older of two results whose calls reuse one id', async () => {
    const { cm } = await open({ adaptiveResolution: true, toolResultMaxLastN: 1 });
    cm.addMessage('u', text('look'));
    cm.addMessage('a', [call('t1')]);
    cm.addMessage('u', [result('t1', 'the first answer')]);
    cm.addMessage('a', text('ok'));
    cm.addMessage('u', text('again'));
    cm.addMessage('a', [call('t1')]);
    cm.addMessage('u', [result('t1', 'the second answer')]);
    cm.addMessage('a', text('ok'));
    cm.addMessage('u', text('next'));
    const compiled = await cm.compile(BUDGET);
    const answers = compiled.messages.flatMap((m) => m.content).flatMap((b) => (b.type === 'tool_result' ? [String(b.content)] : []));
    assert.deepEqual(answers, [MARKER, 'the second answer']);
    cm.close();
  });

  it('replaces a result far from its call where the render brings it back beside its call', async () => {
    // Eight messages come between the first call and its result, more than
    // pairing repair looks ahead over, so the repair drops the result while
    // they render raw. Folded into a recall pair, they no longer keep the
    // result from its call, and the repair moves it up beside the call.
    const { cm, strategy } = await open({
      adaptiveResolution: false, toolResultMaxLastN: 1, recentWindowTokens: 200, targetChunkTokens: 1_000_000,
    });
    cm.addMessage('u', text('look this up'));
    cm.addMessage('a', [call('call-1')]);
    const gap: string[] = [];
    for (let k = 0; k < 8; k++) gap.push(cm.addMessage(k % 2 ? 'a' : 'u', text(`meanwhile ${k}`)));
    cm.addMessage('u', [result('call-1', `1 ${PROSE}`)]);
    lookups(cm, 1, 2);
    for (let k = 0; k < 4; k++) cm.addMessage(k % 2 ? 'a' : 'u', text(`chat ${k}`));
    const before = await cm.compile(BUDGET);
    assert.equal(resultOf(before, 'call-1')?.startsWith('1 lorem'), false, 'with the gap raw, the result is not sent whole');
    strategy.seed({ id: 'L1-0', level: 1, content: 'meanwhile', tokens: 4, sourceLevel: 0,
      sourceIds: gap, sourceRange: { first: gap[0]!, last: gap.at(-1)! } });
    const after = await cm.compile(BUDGET);
    assert.equal(resultOf(after, 'call-1'), MARKER, 'beside its call, the result is sent as its marker');
    cm.close();
  });

  for (const [name, selector] of SELECTORS) {
    it(`${name}: keeps the results of one message's calls that are stored last`, async () => {
      // Calls made together, answered in one message in the order they
      // finished: the render sends the results as stored, and the limit keeps
      // the ones stored last, so the whole results follow the replaced ones.
      const sent = async (limit: number, calls: number, stored: number[]) => {
        const { cm } = await open({ ...selector, toolResultMaxLastN: limit });
        cm.addMessage('u', text('look these up'));
        cm.addMessage('a', Array.from({ length: calls }, (_, k) => call(`call-${k + 1}`)));
        cm.addMessage('u', stored.map((k) => result(`call-${k}`, `answer ${k}`)));
        cm.addMessage('a', text('ok'));
        cm.addMessage('u', text('next'));
        const compiled = await cm.compile(BUDGET);
        cm.close();
        return compiled.messages.flatMap((m) => m.content).flatMap((b) => (b.type === 'tool_result' ? [String(b.content)] : []));
      };
      const LAST_TWO = "[result of tool 'lookup' left out: this context shows only the tool's last 2 results]";
      assert.deepEqual(await sent(1, 2, [2, 1]), [MARKER, 'answer 1']);
      assert.deepEqual(await sent(2, 3, [3, 1, 2]), [LAST_TWO, 'answer 1', 'answer 2']);
      assert.deepEqual(await sent(1, 2, [1, 2]), [MARKER, 'answer 2'], 'answered in the order made');
    });
  }

  it("decides a further result for an answered call as its call, so a fold can't send it whole", async () => {
    // The first call gets two results. While both render raw, pairing repair
    // sends the first and drops the second. Folding the first leaves the call
    // without its result, and the repair moves the second up beside it.
    const { cm, strategy } = await open({
      adaptiveResolution: false, toolResultMaxLastN: 1, recentWindowTokens: 200, targetChunkTokens: 1_000_000,
    });
    cm.addMessage('u', text('look this up'));
    cm.addMessage('a', [call('call-1')]);
    const first = cm.addMessage('u', [result('call-1', `1 ${PROSE}`)]);
    cm.addMessage('u', [result('call-1', `1 again ${PROSE}`)]);
    lookups(cm, 1, 2);
    for (let k = 0; k < 4; k++) cm.addMessage(k % 2 ? 'a' : 'u', text(`chat ${k}`));
    const resultsOf = (compiled: CompileResult) => compiled.messages.flatMap((m) => m.content)
      .flatMap((b) => (b.type === 'tool_result' && b.toolUseId === 'call-1' ? [String(b.content)] : []));
    const sends = (compiled: CompileResult, words: string) => compiled.messages.some((m) => m.content.some((b) => b.type === 'text' && b.text.includes(words)));
    const before = await cm.compile(BUDGET);
    assert.deepEqual(resultsOf(before), [MARKER], 'the repair sends the first result and drops the further one');
    strategy.seed({ id: 'L1-0', level: 1, content: 'what the first lookup answered', tokens: 6, sourceLevel: 0,
      sourceIds: [first], sourceRange: { first, last: first } });
    const after = await cm.compile(BUDGET);
    assert.ok(sends(after, 'what the first lookup answered'), 'the first result is folded');
    assert.deepEqual(resultsOf(after), [MARKER], "the further result is sent as its call's marker");
    cm.close();
  });

  it('gives a further result for an answered call no slot of its own', async () => {
    const { cm } = await open({ adaptiveResolution: true, toolResultMaxLastN: 2 });
    cm.addMessage('u', text('look this up'));
    cm.addMessage('a', [call('call-1')]);
    cm.addMessage('u', [result('call-1', 'the first answer')]);
    cm.addMessage('u', [result('call-1', 'the same answer again')]);
    cm.addMessage('a', [call('call-2')]);
    cm.addMessage('u', [result('call-2', 'the second answer')]);
    cm.addMessage('a', text('ok'));
    cm.addMessage('u', text('next'));
    const compiled = await cm.compile(BUDGET);
    assert.equal(resultOf(compiled, 'call-1'), 'the first answer', 'two calls, so a limit of 2 keeps both');
    cm.close();
  });

  it('leaves a result stored before any call with its id out of the count', async () => {
    const { cm } = await open({ adaptiveResolution: true, toolResultMaxLastN: 1 });
    cm.addMessage('u', text('look'));
    cm.addMessage('a', [call('call-1')]);
    cm.addMessage('u', [result('call-1', 'the first answer')]);
    cm.addMessage('u', [result('call-2', 'an answer before its call')]);
    cm.addMessage('a', [call('call-2')]);
    cm.addMessage('u', text('never mind'));
    cm.addMessage('a', text('ok'));
    const compiled = await cm.compile(BUDGET);
    assert.equal(resultOf(compiled, 'call-1'), 'the first answer', 'the early result answers no call, so takes no slot');
    cm.close();
  });

  it('answers the earliest unanswered call where a host reuses an id', async () => {
    // The first call has no result yet when the host reuses its id. Pairing
    // repair moves the first result up to the first call and gives the
    // second to the second call, and the count does the same: two answered
    // calls, so a limit of 1 sends the first result as its marker.
    const { cm } = await open({ adaptiveResolution: true, toolResultMaxLastN: 1 });
    cm.addMessage('u', text('look'));
    cm.addMessage('a', [call('t1')]);
    cm.addMessage('u', text('hold on'));
    cm.addMessage('a', [call('t1')]);
    cm.addMessage('u', [result('t1', 'the first answer')]);
    cm.addMessage('u', [result('t1', 'the second answer')]);
    cm.addMessage('a', text('ok'));
    cm.addMessage('u', text('next'));
    const compiled = await cm.compile(BUDGET);
    const answers = compiled.messages.flatMap((m) => m.content).flatMap((b) => (b.type === 'tool_result' ? [String(b.content)] : []));
    assert.deepEqual(answers, [MARKER, 'the second answer']);
    cm.close();
  });

  it("leaves a result in its own call's message out of the count, as pairing repair drops it", async () => {
    const { cm } = await open({ adaptiveResolution: true, toolResultMaxLastN: 1 });
    cm.addMessage('u', text('look these up'));
    cm.addMessage('a', [call('call-1')]);
    cm.addMessage('u', [result('call-1', 'one')]);
    // A tool cycle bundled into one message, as some hosts store them.
    cm.addMessage('a', [call('call-2'), result('call-2', 'two'), { type: 'text', text: 'and that was two' }]);
    cm.addMessage('u', text('next'));
    const compiled = await cm.compile(BUDGET);
    assert.equal(resultOf(compiled, 'call-1'), 'one', 'the dropped result takes no slot');
    cm.close();
  });

  it('keeps the whole part of a fractional limit', async () => {
    const { cm } = await open({ adaptiveResolution: true, toolResultMaxLastN: 1.5 });
    cm.addMessage('u', text('look these up'));
    lookups(cm, 3);
    cm.addMessage('u', text('next'));
    const compiled = await cm.compile(BUDGET);
    const LAST_ONE_AND_A_HALF = "[result of tool 'lookup' left out: this context shows only the tool's last 1.5 results]";
    assert.deepEqual(['call-1', 'call-2'].map((id) => resultOf(compiled, id)), [LAST_ONE_AND_A_HALF, LAST_ONE_AND_A_HALF],
      'the marker names the limit as given, as it always has');
    assert.match(resultOf(compiled, 'call-3')!, /^3 lorem/);
    cm.close();
  });

  it('decides once or twice for each thing that prices every message, not once for each message', async () => {
    let decisions = 0;
    let depth = 0;
    let deepest = 0;
    class CountingStrategy extends AutobiographicalStrategy {
      protected override toolPruning(store: MessageStoreView) {
        decisions++;
        return super.toolPruning(store);
      }
      // An override that calls its parent, as a host's would: it must run
      // once for each call, inside a selection or outside one.
      protected override postStripEstimates(store: MessageStoreView): number[] {
        deepest = Math.max(deepest, ++depth);
        try {
          return super.postStripEstimates(store);
        } finally {
          depth--;
        }
      }
    }
    for (const adaptiveResolution of [true, false]) {
      const label = adaptiveResolution ? 'adaptive' : 'hierarchical';
      const strategy = new CountingStrategy({ compressionModel: 'mock', adaptiveResolution, headWindowTokens: 0, recentWindowTokens: 1_000_000, toolResultMaxLastN: 1 } as never);
      const cm = await ContextManager.open({ path: join(dir, `store-${stores++}`), strategy });
      cm.addMessage('u', text('look these up'));
      lookups(cm, 20);
      decisions = 0;
      cm.addMessage('u', text('next'));
      assert.ok(decisions >= 1 && decisions <= 2, `${label}: ${decisions} decisions for one new message`);
      decisions = 0;
      cm.getRenderStats();
      assert.ok(decisions >= 1 && decisions <= 2, `${label}: ${decisions} decisions for the render stats before the first compile`);
      if (adaptiveResolution) {
        // Only the adaptive selection has a fold plan to preview.
        decisions = 0;
        cm.previewContext(BUDGET);
        assert.ok(decisions >= 1 && decisions <= 2, `${label}: ${decisions} decisions for a preview`);
      }
      decisions = 0;
      const compiled = await cm.compile(BUDGET);
      assert.ok(decisions >= 1 && decisions <= 2, `${label}: ${decisions} decisions for one compile of 42 messages`);
      assert.equal(resultOf(compiled, 'call-19'), MARKER);
      assert.match(resultOf(compiled, 'call-20')!, /^20 lorem/);
      assert.equal(deepest, 1, `${label}: postStripEstimates' override ran inside itself`);
      cm.close();
    }
  });

  it("sends the adaptive middle's raw shards in the form an override of prunedForSend gives them", async () => {
    // A body sharded at ingress, kept raw in the middle, goes out through the
    // middle's shard path, which sends its shards' text.
    class LoudStrategy extends SeedableStrategy {
      protected override prunedForSend(store: MessageStoreView, msg: StoredMessage): StoredMessage {
        const sent = super.prunedForSend(store, msg);
        return msg.bodyGroupId
          ? { ...sent, content: sent.content.map((b) => (b.type === 'text' ? { ...b, text: b.text.toUpperCase() } : b)) }
          : sent;
      }
    }
    const strategy = new LoudStrategy({ compressionModel: 'mock', adaptiveResolution: true, targetChunkTokens: 100, headWindowTokens: 0, recentWindowTokens: 200 } as never);
    const cm = await ContextManager.open({ path: join(dir, `store-${stores++}`), strategy });
    cm.addMessage('u', text(`a document ${PROSE}`));
    assert.ok(cm.getAllMessages().filter((m) => m.bodyGroupId).length > 1, 'the document is sharded');
    for (let k = 0; k < 6; k++) cm.addMessage(k % 2 ? 'a' : 'u', text(`chat ${k}`));
    const compiled = await cm.compile(BUDGET);
    const sent = compiled.messages.flatMap((m) => m.content).flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
    assert.match(sent, /A DOCUMENT LOREM IPSUM/);
    assert.doesNotMatch(sent, /a document lorem ipsum/);
    cm.close();
  });

  it("keeps a message's pruned form while a new decision leaves it as it was", async () => {
    // A form is a new message object, so its estimates are cached on it: a
    // new message, which makes a new decision, mustn't re-form the others.
    const { cm, strategy } = await open({ adaptiveResolution: true, toolResultMaxLastN: 1, toolUseInputMaxTokens: 100 });
    cm.addMessage('u', text('look these up'));
    lookups(cm, 3);
    cm.addMessage('a', [call('w-1', 'write', { body: PROSE })]);
    cm.addMessage('u', [result('w-1', 'written')]);
    const formsNow = () => {
      const view = viewOf(cm);
      return view.getAll().map((m) => strategy.formOf(view, m));
    };
    const before = formsNow();
    assert.ok(before.filter((form, i) => form !== viewOf(cm).getAll()[i]).length >= 3, 'two replaced results and a truncated input');
    cm.addMessage('u', text('next'));
    const after = formsNow();
    assert.deepEqual(after.slice(0, before.length).map((form, i) => form === before[i]), before.map(() => true));
    cm.close();
  });

  it('prices the render stats before the first compile as the first compile sends them', async () => {
    const { cm, store } = await open({ adaptiveResolution: true, toolResultMaxLastN: 1, toolUseInputMaxTokens: 100 });
    cm.addMessage('u', text('look these up'));
    lookups(cm, 3);
    cm.addMessage('a', [call('w-1', 'write', { body: PROSE })]);
    cm.addMessage('u', [result('w-1', 'written')]);
    cm.addMessage('u', text('next'));
    const reconstructed = cm.getRenderStats()!.tail.tokens;
    const compiled = await cm.compile(BUDGET);
    assert.equal(reconstructed, sentOf(store, compiled), 'they count what the first compile sends');
    assert.equal(reconstructed, cm.getRenderStats()!.tail.tokens);
    cm.close();
  });

  it('decides again when a map of limits changes in place', async () => {
    const limits: Record<string, number> = { lookup: 2 };
    const { cm } = await open({ adaptiveResolution: true, toolResultMaxLastN: limits });
    cm.addMessage('u', text('look these up'));
    lookups(cm, 3);
    cm.addMessage('u', text('next'));
    const first = await cm.compile(BUDGET);
    assert.equal(resultOf(first, 'call-1'), "[result of tool 'lookup' left out: this context shows only the tool's last 2 results]");
    assert.equal(resultOf(first, 'call-2')!.startsWith('2 lorem'), true);
    limits.lookup = 1;
    const second = await cm.compile(BUDGET);
    assert.equal(resultOf(second, 'call-1'), MARKER, 'the same result, replaced under a new marker');
    assert.equal(resultOf(second, 'call-2'), MARKER);
    cm.close();
  });

  it('forms each message again for a preview under another input cap, and again after it', async () => {
    const { cm } = await open({ adaptiveResolution: true, toolUseInputMaxTokens: 100 });
    cm.addMessage('u', text('write this'));
    cm.addMessage('a', [call('w-1', 'write', { body: PROSE })]);
    cm.addMessage('u', [result('w-1', 'written')]);
    cm.addMessage('u', text('next'));
    const truncated = (blocks: readonly ContentBlock[]) => blocks
      .flatMap((b) => (b.type === 'tool_use' ? [(b.input as Record<string, unknown>)._truncated === true] : []));
    assert.deepEqual(truncated((await cm.compile(BUDGET)).messages.flatMap((m) => m.content)), [true]);
    const preview = cm.previewContext(BUDGET, { toolUseInputMaxTokens: 1_000_000 }, { render: true })!;
    assert.deepEqual(truncated(preview.entries!.flatMap((e) => e.content)), [false], 'the preview sends the input whole');
    assert.deepEqual(truncated((await cm.compile(BUDGET)).messages.flatMap((m) => m.content)), [true], 'and the next compile truncates it again');
    cm.close();
  });

  describe('calibration pricing epoch 4', () => {
    async function reopenWith(record: Record<string, unknown>, config: Record<string, unknown>) {
      const first = await open({ adaptiveResolution: true, ...config });
      first.cm.addMessage('u', text('look these up'));
      lookups(first.cm, 3);
      first.cm.addMessage('a', text('ok'));
      first.cm.addMessage('u', text('next'));
      await first.cm.compile(BUDGET);
      first.internals.store!.setStateJson(first.internals.calibrationStateId, record);
      first.cm.close();
      const reopened = await open({ adaptiveResolution: true, ...config }, first.path);
      await reopened.cm.compile(BUDGET);
      return reopened;
    }

    it('discards a multiplier from epoch 3 in a store holding a result the per-tool limit replaces', async () => {
      const reopened = await reopenWith({ multiplier: 0.89, at: 1, pricing: 3 }, { toolResultMaxLastN: 1 });
      assert.equal(reopened.internals._calibration, 1);
      assert.equal(reopened.cm.getRenderStats()!.calibration!.reset?.fromEpoch, 3);
      assert.equal(reopened.cm.getRenderStats()!.calibration!.provisional, true);
      reopened.cm.close();
    });

    it('discards a multiplier from epoch 3 in a store whose limit for a tool was null', async () => {
      // A null limit for a tool replaced each of its results before, priced
      // whole; now it sets no limit, so a multiplier learned then is stale.
      const reopened = await reopenWith({ multiplier: 0.89, at: 1, pricing: 3 }, { toolResultMaxLastN: { lookup: null } });
      assert.equal(reopened.internals._calibration, 1);
      assert.equal(reopened.cm.getRenderStats()!.calibration!.reset?.fromEpoch, 3);
      reopened.cm.close();
    });

    it('keeps a multiplier from epoch 3, re-stamped, where the limit replaces nothing', async () => {
      const reopened = await reopenWith({ multiplier: 0.89, at: 1, pricing: 3 }, { toolResultMaxLastN: 5 });
      assert.equal(reopened.internals._calibration, 0.89);
      const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as { pricing?: number };
      assert.equal(saved.pricing, AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH);
      reopened.cm.close();
    });

    it("epoch 4's predicate: a result the limit replaces, or an input over the cap", () => {
      const reprices = AutobiographicalStrategy.CALIBRATION_EPOCH_REPRICES[4]!;
      let seq = 0;
      const msg = (participant: string, content: ContentBlock[]) =>
        ({ id: `m${seq}`, sequence: ++seq, participant, content, timestamp: new Date(0) }) as StoredMessage;
      const conversation = (results: number, input: Record<string, unknown> = { q: 1 }) => [
        msg('u', text('go')),
        ...Array.from({ length: results }, (_, k) => [msg('a', [call(`c${k}`, 'lookup', input)]), msg('u', [result(`c${k}`, 'r')])]).flat(),
      ];
      const view = (messages: StoredMessage[]) => ({ getAll: () => messages }) as unknown as MessageStoreView;
      const at = (config: Record<string, unknown>) => new AutobiographicalStrategy(config as never);
      const two = conversation(2);
      assert.equal(reprices(two, at({ toolResultMaxLastN: 1 }), view(two)), true, 'a replaced result');
      assert.equal(reprices(two, at({ toolResultMaxLastN: 2 }), view(two)), false, 'a limit nothing reaches');
      assert.equal(reprices(two, at({}), view(two)), false, 'no limit');
      assert.equal(reprices(two, at({ toolResultMaxLastN: { lookup: null } }), view(two)), true, "a tool's null limit, read as 0 before");
      assert.equal(reprices(two, at({ toolResultMaxLastN: { lookup: '1' } }), view(two)), true, "a tool's string limit, read as a number before");
      assert.equal(reprices(two, at({ toolResultMaxLastN: { lookup: true } }), view(two)), true, "a tool's limit of true, read as 1 before");
      assert.equal(reprices(two, at({ toolResultMaxLastN: Object.create({ lookup: null }) }), view(two)), true, 'an inherited null limit, which the count reads too');
      assert.equal(reprices(two, at({ toolResultMaxLastN: { other: null } }), view(two)), false, 'a null limit for a tool with no results');
      assert.equal(reprices(two, at({ toolResultMaxLastN: { lookup: undefined } }), view(two)), false, 'a limit left undefined, which set none before either');
      assert.equal(reprices(two, at({ toolResultMaxLastN: { lookup: 5 } }), view(two)), false, 'a number the results never pass');
      assert.equal(reprices(two, at({ toolResultMaxLastN: null }), view(two)), false, 'a null for every tool, which threw before, so learned nothing');
      // A value that isn't a number discards only where main's arithmetic
      // read it as a limit below the tool's answered calls.
      assert.equal(reprices(two, at({ toolResultMaxLastN: { lookup: '2' } }), view(two)), false, 'a string limit the results never passed');
      assert.equal(reprices(two, at({ toolResultMaxLastN: { lookup: 'abc' } }), view(two)), false, 'a string that reads as no number, which replaced nothing');
      assert.equal(reprices(two, at({ toolResultMaxLastN: { lookup: '-1' } }), view(two)), false, 'a string that reads as a negative number, which set no limit');
      assert.equal(reprices(two, at({ toolResultMaxLastN: { lookup: Symbol('limit') } }), view(two)), false, 'a symbol, which threw before');
      assert.equal(reprices(two, at({ toolResultMaxLastN: { lookup: Object.create(null) } }), view(two)), false, 'an object with no way to a primitive, which threw before');
      const member = [msg('u', text('go')), msg('a', [call('k1', 'constructor')]), msg('u', [result('k1', 'r')])];
      assert.equal(reprices(member, at({ toolResultMaxLastN: { other: 2 } }), view(member)), false, 'a tool named like an Object member, whose lookup finds a function');
      // Only an answered call counts, paired as the count pairs them.
      const unanswered = [msg('u', text('go')), msg('a', [call('n1', 'lookup')]), msg('u', text('never mind')),
        msg('a', [call('o1', 'other')]), msg('u', [result('o1', 'r')])];
      assert.equal(reprices(unanswered, at({ toolResultMaxLastN: { lookup: null } }), view(unanswered)), false, 'a call no result answers');
      const bundled = [msg('u', text('go')), msg('a', [call('b1', 'lookup'), result('b1', 'r')]), msg('u', text('next'))];
      assert.equal(reprices(bundled, at({ toolResultMaxLastN: { lookup: null } }), view(bundled)), false, "a result in its call's own message");
      const reused = [msg('u', text('go')), msg('a', [call('x1', 'lookup')]), msg('u', text('wait')),
        msg('a', [call('x1', 'other')]), msg('u', [result('x1', 'r')])];
      assert.equal(reprices(reused, at({ toolResultMaxLastN: { lookup: null } }), view(reused)), true, 'a reused id answers its earliest call');
      const big = conversation(1, { body: 'x'.repeat(2_000) });
      assert.equal(reprices(big, at({ toolUseInputMaxTokens: 100 }), view(big)), true, 'an input over the cap');
      assert.equal(reprices(big, at({ toolUseInputMaxTokens: 1_000 }), view(big)), false, 'an input under the cap');
    });
  });
});
