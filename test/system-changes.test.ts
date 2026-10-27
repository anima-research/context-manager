/**
 * System changes (membrane's `system_change` block, SystemChangeContent): a
 * message of them changes the tools and system text the model is offered from
 * its place on (src/system-changes.ts). context-manager prices one from its
 * JSON, keeps one alone in its message (a write refuses one that isn't, and
 * a read leaves it out), compiles one in place and unaltered under every
 * strategy (the autobiographical strategy keeps it raw as a pin keeps a
 * message, and puts the ones before a reset head in the head, ahead of the
 * head window; the passthrough strategies keep it when their window starts
 * after it), refuses over budget when the changes alone don't fit (beyond
 * grace, where enforcement is on), or, under the passthrough strategies,
 * when the newest conversation message doesn't fit beside them,
 * and leaves it out of what compression reads. A committing compile reports
 * `firstChanged`, where its messages first differ from the last committing
 * compile's.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AutobiographicalStrategy,
  ContextManager,
  KnowledgeStrategy,
  MalformedContentError,
  OverBudgetError,
  PassthroughStrategy,
  UncoveredDropError,
  WindowedPassthroughStrategy,
  malformedContentPlaces,
} from '../src/index.js';
import { jsonTokenEstimator } from '../src/message-store.js';
import { wellFormedContent } from '../src/well-formed-content.js';
import { systemChangePositions } from '../src/system-changes.js';
import type { CompileResult, ContextStrategy, StoredMessage, TokenBudget } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'cm-system-changes-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let opened = 0;

const tool = { name: 'get_weather', description: 'Weather.', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } };
const change = (extra: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'system_change', defineTools: [tool], addSystem: ['Use metric units.'], ...extra }) as unknown as ContentBlock;
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'get_weather', input: { city: 'Oslo' } }) as ContentBlock;
const toolResult = (id: string, t = 'Sunny.'): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: t }) as ContentBlock;
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };

async function open(strategy: ContextStrategy, membrane?: unknown): Promise<ContextManager> {
  return ContextManager.open({ path: join(dir, `store-${opened++}`), strategy, ...(membrane ? { membrane: membrane as never } : {}) });
}

const holdsChange = (content: unknown[]): boolean => content.some((b) => (b as { type?: string }).type === 'system_change');
/** The content of each compiled message that holds a change, in order. */
const changesSent = (compiled: CompileResult): unknown[] => compiled.messages.filter((m) => holdsChange(m.content)).map((m) => m.content);
/** The tools a compile's changes leave offered, each applied in compiled order as membrane applies one: its removals, then its definitions. */
const toolsAfter = (compiled: CompileResult): string[] => {
  const offered = new Set<string>();
  for (const m of compiled.messages) {
    for (const b of m.content as Array<{ type?: string; removeTools?: string[]; defineTools?: Array<{ name: string }> }>) {
      if (b.type !== 'system_change') continue;
      for (const name of b.removeTools ?? []) offered.delete(name);
      for (const t of b.defineTools ?? []) offered.add(t.name);
    }
  }
  return [...offered];
};
const estimateOf = (cm: ContextManager, id: string): number =>
  (cm as unknown as { messageStore: { estimateTokens(m: StoredMessage): number } }).messageStore.estimateTokens(cm.getMessage(id)!);
/** The stored message ids a compile sends raw, in its order (a summary's recall pair adds none). */
const rawIds = (compiled: CompileResult): string[] =>
  compiled.provenance!.messages.flatMap((s) => (s.kind === 'raw' ? s.bodies.map((b) => b.messageId) : []));
/** What a compile sends of the store, priced by the store: every raw message's estimate. */
const sentTokens = (cm: ContextManager, compiled: CompileResult): number => rawIds(compiled).reduce((n, id) => n + estimateOf(cm, id), 0);
const KV_UNIFIED = {
  policy: {
    alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
    cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25,
    continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10, continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
};
/** A summarizer stand-in that records every request it gets. */
function recordingMembrane(): { requests: unknown[]; membrane: unknown } {
  const requests: unknown[] = [];
  return { requests, membrane: { complete: async (req: unknown) => {
    requests.push(JSON.parse(JSON.stringify(req)));
    return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${requests.length}.` }], usage: { inputTokens: 500, outputTokens: 100 } };
  } } };
}
async function settle(cm: ContextManager, requests: unknown[]): Promise<void> {
  let before = -1;
  for (let r = 0; r < 200 && requests.length !== before; r++) { before = requests.length; await cm.compile(); await cm.tick(); await cm.tick(); }
}

describe('a system change, written and priced', () => {
  it('is priced from its JSON, where it used to cost nothing', async () => {
    const cm = await open(new PassthroughStrategy());
    const block = change();
    const id = cm.addMessage('Harness', [block]);
    const store = (cm as unknown as { messageStore: { estimateTokens(m: StoredMessage): number } }).messageStore;
    const estimate = store.estimateTokens(cm.getMessage(id)!);
    assert.equal(estimate, jsonTokenEstimator(JSON.stringify(block)));
    assert.ok(estimate > 0);
    // The context log prices it by the same rule, with its own estimator.
    const log = (cm as unknown as { contextLog: { estimateTokens(entry: { content: ContentBlock[] }): number; tokenEstimator(t: string): number } }).contextLog;
    assert.equal(log.estimateTokens({ content: [block] }), log.tokenEstimator(JSON.stringify(block)));
  });

  it('is refused beside other blocks, or inside a tool result, by name', async () => {
    assert.deepEqual(malformedContentPlaces([text('hi'), change()]), [
      'content[1] is a system_change beside other blocks; a system change goes in a message of its own',
    ]);
    assert.deepEqual(malformedContentPlaces([{ type: 'tool_result', toolUseId: 't1', content: [change()] }]), [
      'content[0].content[0] is a system_change inside a tool_result; a system change goes in a message of its own',
    ]);
    const cm = await open(new PassthroughStrategy());
    assert.throws(() => cm.addMessage('Harness', [text('hi'), change()]), MalformedContentError);
    // Beside a hole, which counts as another entry.
    const sparse: unknown[] = [change()];
    sparse.length = 2;
    assert.ok(malformedContentPlaces(sparse).includes('content[0] is a system_change beside other blocks; a system change goes in a message of its own'), JSON.stringify(malformedContentPlaces(sparse)));
    assert.throws(() => cm.addMessage('Harness', sparse as ContentBlock[]), MalformedContentError);
    assert.equal(cm.getAllMessages().length, 0);
  });

  it('is refused while the nearest call before it has no result between them, by the manager before an expired hold is released and by the store, and taken after the result', async () => {
    const clock = { t: 0 };
    let released = 0;
    const strategy = new (class extends PassthroughStrategy {
      onCompressionHoldsReleased(): void { released++; }
    })();
    const cm = await ContextManager.open({ path: join(dir, `store-${opened++}`), strategy, now: () => clock.t });
    cm.addMessage('User', [text('Weather in Oslo?')], undefined, undefined, { holdCompression: { timeoutMs: 100 } });
    const call = cm.addMessage('Claude', [toolUse('t1')]);
    clock.t = 150;
    assert.throws(() => cm.addMessage('Harness', [change()]), (e: Error) => e.message ===
      `Message refused: a system change can't go between a tool call and its result, and message ${call} holds a tool_use (t1) with no result between it and this change. ` +
      'Write it after the result, where membrane sends it anyway; for a call that will get none, store a result for it first or remove the call.');
    assert.equal(released, 0, 'refused before the expired hold was released');
    const store = (cm as unknown as { messageStore: { append(participant: string, content: ContentBlock[]): unknown } }).messageStore;
    assert.throws(() => store.append('Harness', [change()]), /a system change can't go between a tool call and its result/);
    assert.equal(cm.getAllMessages().length, 2);
    cm.addMessage('User', [toolResult('t1')]);
    assert.equal(released, 1);
    // After the result, and after another change there.
    cm.addMessage('Harness', [change()]);
    cm.addMessage('Harness', [change({ addSystem: ['Be brief.'] })]);
    assert.equal(cm.getAllMessages().length, 5);
  });

  it('is refused while any of parallel calls is unanswered, their results in messages of their own, and taken once the last lands', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Weather in Oslo and Bergen?')]);
    const call = cm.addMessage('Claude', [toolUse('a'), toolUse('b')]);
    cm.addMessage('User', [toolResult('a')]);
    assert.throws(() => cm.addMessage('Harness', [change()]), (e: Error) => e.message ===
      `Message refused: a system change can't go between a tool call and its result, and message ${call} holds a tool_use (b) with no result between it and this change. ` +
      'Write it after the result, where membrane sends it anyway; for a call that will get none, store a result for it first or remove the call.');
    cm.addMessage('User', [toolResult('b')]);
    cm.addMessage('Harness', [change()]);
    assert.equal(cm.getAllMessages().length, 5);
  });

  it("is refused after a call on a sharded body's first shard, whichever shard is last, and the refusal names the shard holding the call", async () => {
    const cm = await open(new PassthroughStrategy());
    const store = (cm as unknown as { messageStore: { append(participant: string, content: ContentBlock[], metadata?: unknown, causedBy?: unknown, extra?: unknown): StoredMessage } }).messageStore;
    cm.addMessage('User', [text('Summarize this and look it up.')]);
    // Ingress sharding puts a message's non-text blocks on its body's first shard.
    const first = store.append('Claude', [text('part one '), toolUse('t1')], undefined, undefined, { bodyGroupId: 'g', shardIndex: 0, shardCount: 2 });
    store.append('Claude', [text('part two')], undefined, undefined, { bodyGroupId: 'g', shardIndex: 1, shardCount: 2 });
    assert.throws(() => cm.addMessage('Harness', [change()]), new RegExp(`message ${first.id} holds a tool_use \\(t1\\) with no result between it and this change`));
    cm.addMessage('User', [toolResult('t1')]);
    cm.addMessage('Harness', [change()]);
  });

  it("reads a sharded results message whole, from its first shard, walking back from a change and forward from an edited call", async () => {
    const cm = await open(new PassthroughStrategy());
    const store = (cm as unknown as { messageStore: { append(participant: string, content: ContentBlock[], metadata?: unknown, causedBy?: unknown, extra?: unknown): StoredMessage } }).messageStore;
    cm.addMessage('User', [text('Weather in Oslo and Bergen?')]);
    const call = cm.addMessage('Claude', [toolUse('a'), toolUse('b')]);
    // Ingress sharding puts a message's results on its first shard, its long text after.
    store.append('User', [toolResult('a')], undefined, undefined, { bodyGroupId: 'r', shardIndex: 0, shardCount: 2 });
    store.append('User', [text('a long note beside the result')], undefined, undefined, { bodyGroupId: 'r', shardIndex: 1, shardCount: 2 });
    assert.throws(() => cm.addMessage('Harness', [change()]), new RegExp(`message ${call} holds a tool_use \\(b\\) with no result between it and this change`));
    cm.addMessage('User', [toolResult('b')]);
    const later = cm.addMessage('Harness', [change()]);
    // Forward: an edit giving a message calls that the sharded results answer only in part, before the change.
    cm.editMessage(call, [text('Checking.')]);
    assert.throws(() => cm.editMessage(call, [toolUse('a'), toolUse('c')]), (e: Error) => e.message ===
      `Edit of ${call} refused: a tool_use (c) can't go before a system change (message ${later}) that comes before its result; a change goes after the call's result.`);
    cm.editMessage(call, [toolUse('a'), toolUse('b')]);
    assert.equal(cm.getAllMessages().length, 6);
  });

  it('takes a change after a bundled cycle, whose own later blocks answer its calls, an edit giving one to a message right before a change, and an edit giving a call to a message a plain one follows', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Weather?')]);
    // A bundled cycle, as claude.ai exports store one: the compile splits it (splitMixedToolMessages).
    cm.addMessage('Claude', [text('Checking.'), toolUse('t1'), toolResult('t1'), text('Sunny.')]);
    cm.addMessage('Harness', [change()]);
    const reply = cm.addMessage('Claude', [text('Anything else?')]);
    cm.addMessage('Harness', [change({ addSystem: ['Be brief.'] })]);
    cm.editMessage(reply, [toolUse('t2'), toolResult('t2')]);
    // A plain message between a call and the next change ends the forward walk, as it ends the back walk.
    const asked = cm.addMessage('Claude', [text('Let me see.')]);
    cm.addMessage('User', [text('ok')]);
    cm.addMessage('Harness', [change({ addSystem: ['Be kind.'] })]);
    cm.editMessage(asked, [toolUse('t3')]);
    // A call given to the last message: the forward walk ends with the store.
    const last = cm.addMessage('Claude', [text('Bye.')]);
    cm.editMessage(last, [toolUse('t4')]);
    assert.deepEqual(cm.getAllMessages().map((m) => m.content.map((b) => b.type).join('+')),
      ['text', 'text+tool_use+tool_result+text', 'system_change', 'tool_use+tool_result', 'system_change', 'tool_use', 'text', 'system_change', 'tool_use']);
  });

  it("leaves open a bundled message's call that none of its later blocks answers: a parallel call beside an answered one, and a call after its result", async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Weather?')]);
    const parallel = cm.addMessage('Claude', [toolUse('a'), toolUse('b'), toolResult('a')]);
    assert.throws(() => cm.addMessage('Harness', [change()]), new RegExp(`message ${parallel} holds a tool_use \\(b\\) with no result`));
    cm.addMessage('User', [toolResult('b')]);
    cm.addMessage('Harness', [change()]);
    // A result before its call in the same message answers nothing: the compile splits it ahead of the call.
    const reversed = cm.addMessage('Claude', [toolResult('c'), toolUse('c')]);
    assert.throws(() => cm.addMessage('Harness', [change()]), new RegExp(`message ${reversed} holds a tool_use \\(c\\) with no result`));
    // And an edit giving a message right before a change such a call is refused.
    assert.throws(() => cm.editMessage(cm.getAllMessages()[2]!.id, [toolUse('d'), toolUse('e'), toolResult('d')]), /a tool_use \(e\) can't go before a system change/);
  });

  it('refuses nothing for a call further back than a message of another kind, whose result never came', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Weather?')]);
    cm.addMessage('Claude', [toolUse('t1')]);
    // An interrupted round: the call's result never came, and the conversation went on.
    cm.addMessage('User', [text('Never mind.')]);
    cm.addMessage('Harness', [change()]);
    assert.equal(cm.getAllMessages().length, 4);
  });

  it('refuses a tool result answering a call that a change follows, as a removal can leave them, and another change there', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Weather?')]);
    const call = cm.addMessage('Claude', [toolUse('t1'), toolUse('t2')]);
    const result = cm.addMessage('User', [toolResult('t1')]);
    cm.addMessage('User', [toolResult('t2')]);
    const first = cm.addMessage('Harness', [change()]);
    // Removing a result leaves its call unanswered before the change.
    cm.removeMessage(result);
    assert.throws(() => cm.addMessage('User', [toolResult('t1')]), (e: Error) => e.message ===
      `Message refused: a tool_result can't follow a system change (message ${first}) that follows its tool call (t1, message ${call}). ` +
      'Remove the change and write it after the result.');
    assert.throws(() => cm.addMessage('Harness', [change({ addSystem: ['Be brief.'] })]), new RegExp(`message ${call} holds a tool_use \\(t1\\)`));
    // A result answering no call there isn't refused.
    cm.addMessage('User', [toolResult('other')]);
    cm.addMessage('User', [text('Never mind.')]);
    assert.equal(cm.getAllMessages().length, 6);
  });

  it('refuses an edit that puts a change between a call and its result, from either side, through the manager and the store, and takes one that keeps them together', async () => {
    const cm = await open(new PassthroughStrategy());
    const store = (cm as unknown as { messageStore: { edit(id: string, content: ContentBlock[]): void } }).messageStore;
    cm.addMessage('User', [text('Weather?')]);
    const call = cm.addMessage('Claude', [toolUse('t1')]);
    const result = cm.addMessage('User', [toolResult('t1')]);
    const reply = cm.addMessage('Claude', [text('Sunny.')]);
    const partial = cm.addMessage('User', [toolResult('t2')]);
    const later = cm.addMessage('Harness', [change()]);
    assert.throws(() => cm.editMessage(result, [change()]), (e: Error) => e.message ===
      `Edit of ${result} refused: a system change can't go between a tool call and its result, and message ${call} holds a tool_use (t1) with no result between it and this change. ` +
      'Write it after the result, where membrane sends it anyway; for a call that will get none, store a result for it first or remove the call.');
    assert.throws(() => store.edit(result, [change()]), /a system change can't go between a tool call and its result/);
    // A call whose results, in the messages after it, run into a change first.
    assert.throws(() => cm.editMessage(reply, [toolUse('t2'), toolUse('t3')]), (e: Error) => e.message ===
      `Edit of ${reply} refused: a tool_use (t3) can't go before a system change (message ${later}) that comes before its result; a change goes after the call's result.`);
    cm.editMessage(reply, [toolUse('t2')]);
    cm.editMessage(result, [toolResult('t1', 'Rainy.')]);
    assert.deepEqual(cm.getAllMessages().map((m) => m.content[0]!.type), ['text', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'system_change']);
    assert.equal(cm.getAllMessages()[4]!.id, partial);
  });

  it('is refused when a field that carries its content has the wrong type, each field and element by name, and taken with several changes alone', () => {
    for (const [fields, place] of [
      [{ removeTools: 'get_time' }, 'content[0].removeTools is a string, not an array of tool names'],
      [{ removeTools: ['get_time', 1] }, 'content[0].removeTools[1] is a number, not a tool name (a string)'],
      [{ defineTools: tool }, 'content[0].defineTools is an object, not an array of tool definitions'],
      [{ defineTools: [tool, [tool]] }, 'content[0].defineTools[1] is an array, not a tool definition (an object)'],
      [{ defineTools: [{ ...tool, name: '' }] }, 'content[0].defineTools[0].name is an empty string, not a tool name'],
      [{ defineTools: [{ ...tool, name: 7 }] }, 'content[0].defineTools[0].name is a number, not a tool name (a string)'],
      [{ defineTools: [{ name: 'x', inputSchema: tool.inputSchema }] }, 'content[0].defineTools[0].description is undefined, not a string'],
      [{ defineTools: [{ ...tool, inputSchema: 'object' }] }, 'content[0].defineTools[0].inputSchema is a string, not a JSON Schema (an object)'],
      [{ defineTools: [{ ...tool, inputSchema: {} }] }, "content[0].defineTools[0].inputSchema.type is undefined, not 'object'"],
      [{ defineTools: [{ ...tool, inputSchema: { type: 'string' } }] }, "content[0].defineTools[0].inputSchema.type is a string, not 'object'"],
      [{ addSystem: 'Use metric units.' }, 'content[0].addSystem is a string, not an array of strings'],
      [{ addSystem: [null] }, 'content[0].addSystem[0] is null, not a string'],
    ] as const) {
      assert.deepEqual(malformedContentPlaces([change(fields)]), [place], JSON.stringify(fields));
    }
    assert.deepEqual(malformedContentPlaces([change(), change({ removeTools: ['get_time'], defineTools: undefined, addSystem: undefined })]), []);
  });

  it('is left out by a read where a write would refuse it, the rest kept, with one line naming where', () => {
    const lines: string[] = [];
    const log = { error: (line: string) => { lines.push(line); }, warn: () => {}, info: () => {}, debug: () => {} } as never;
    const read = (content: unknown[]): unknown[] => wellFormedContent(content as never, 'message m-1', new Set(), log);
    // Alone and well formed: as stored, and nothing logged.
    const alone = [change(), change({ removeTools: ['get_time'] })];
    assert.equal(read(alone), alone);
    assert.equal(lines.length, 0);
    // Beside other blocks: the change goes, the conversation stays.
    assert.deepEqual(read([text('hi'), change()]), [text('hi')]);
    assert.match(lines.pop()!, /message m-1: .*content\[1\] is a system_change beside other blocks/);
    // Inside a tool result: the result keeps what else it holds.
    assert.deepEqual(read([{ type: 'tool_result', toolUseId: 't1', content: [text('42'), change()] }]), [{ type: 'tool_result', toolUseId: 't1', content: [text('42')] }]);
    assert.match(lines.pop()!, /content\[0\]\.content\[1\] is a system_change inside a tool_result/);
    assert.deepEqual(read([{ type: 'tool_result', toolUseId: 't2', content: [change()] }]), [{ type: 'tool_result', toolUseId: 't2', content: [] }]);
    assert.match(lines.pop()!, /content\[0\]\.content\[0\] is a system_change inside a tool_result/);
    // A field of the wrong type: the change goes.
    assert.deepEqual(read([change({ addSystem: [2] })]), []);
    assert.match(lines.pop()!, /content\[0\]\.addSystem\[0\] is a number, not a string/);
    // A definition without the fields the provider needs: the change goes.
    assert.deepEqual(read([change({ defineTools: [{ name: 'x' }] })]), []);
    assert.match(lines.pop()!, /content\[0\]\.defineTools\[0\]\.description is undefined, not a string/);
    // A schema that isn't of type 'object', which the API refuses: the change goes.
    assert.deepEqual(read([change({ defineTools: [{ ...tool, inputSchema: {} }] })]), []);
    assert.match(lines.pop()!, /content\[0\]\.defineTools\[0\]\.inputSchema\.type is undefined, not 'object'/);
    // Beside a hole, which counts as another entry: the change goes.
    const sparse: unknown[] = [change()];
    sparse.length = 2;
    assert.deepEqual(read(sparse), []);
    assert.match(lines.pop()!, /content\[0\] is a system_change beside other blocks/);
    // A damaged tool result whose content is one change object, not an array: left out, and named.
    assert.deepEqual(read([{ type: 'tool_result', toolUseId: 't3', content: change() }]), [{ type: 'tool_result', toolUseId: 't3', content: [] }]);
    assert.match(lines.pop()!, /message m-1: .*content\[0\]\.content/);
  });
});

describe('the autobiographical strategy and a system change', () => {
  /** Every stored position a compiled message stands for: its raw bodies, or its summaries' source ranges. */
  const spansOf = (cm: ContextManager, strategy: AutobiographicalStrategy, compiled: CompileResult): Array<[number, number] | null> => {
    const position = new Map(cm.getAllMessages().map((m, i) => [m.id, i] as const));
    return compiled.provenance!.messages.map((s) => {
      const at: number[] = s.kind === 'raw' ? s.bodies.map((b) => position.get(b.messageId)!)
        : s.kind === 'summary' ? s.summaries.flatMap((x) => {
          const range = strategy.getSummary(x.id)!.sourceRange;
          return [position.get(range.first)!, position.get(range.last)!];
        }) : [];
      return at.length ? [Math.min(...at), Math.max(...at)] : null;
    });
  };

  for (const [label, overrides, headWindowTokens] of [
    ['hierarchical', {}, 0],
    ['adaptive', { adaptiveResolution: true }, 0],
    ['hierarchical, the head window holding a change', {}, 300],
    ['adaptive, the head window holding a change', { adaptiveResolution: true }, 300],
  ] as const) {
    it(`${label}: no fold takes it, it compiles exactly in place as stored, and no summarizer request reads it`, async () => {
      const { requests, membrane } = recordingMembrane();
      const strategy = new AutobiographicalStrategy({
        compressionModel: 'm', targetChunkTokens: 200, headWindowTokens, recentWindowTokens: 0, autoTickOnNewMessage: false,
        minChunkCharsForLLM: 0, summaryParticipant: 'Claude', hierarchical: true, mergeThreshold: 6, ...overrides,
      });
      const cm = await open(strategy, membrane);
      const block = change();
      const headBlock = change({ addSystem: ['Answer briefly.'] });
      let changeId = '';
      for (let i = 0; i < 160; i++) {
        if (i === 41) changeId = cm.addMessage('Harness', [block]);
        else if (i === 1 && headWindowTokens > 0) cm.addMessage('Harness', [headBlock]);
        else cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
      }
      await settle(cm, requests);
      assert.ok(requests.length > 5, `setup: the strategy compressed (${requests.length} calls)`);
      const compiled = await cm.compile({ maxTokens: 4000, reserveForResponse: 0 });
      const changes = compiled.messages.filter((m) => holdsChange(m.content));
      assert.equal(changes.length, headWindowTokens > 0 ? 2 : 1, 'the changes are in the compile');
      const at = compiled.messages.indexOf(changes.at(-1)!);
      assert.deepEqual(compiled.messages[at]!.content, [block]);
      assert.ok(compiled.messages.length < 160, 'setup: the history folded');
      // Everything before it stands for history before it, and everything after for history after.
      const spans = spansOf(cm, strategy, compiled);
      const position = cm.getAllMessages().findIndex((m) => m.id === changeId);
      spans.forEach((span, i) => {
        if (!span || i === at) return;
        if (i < at) assert.ok(span[1] < position, `compiled ${i} (${span}) comes before the change at ${position}`);
        else assert.ok(span[0] > position, `compiled ${i} (${span}) comes after the change at ${position}`);
      });
      assert.ok(!JSON.stringify(requests).includes('system_change'), 'no summarizer request carries one');
      const chunks = (strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }> }> }).chunks;
      assert.ok(chunks.length > 0 && chunks.every((c) => c.messages.every((m) => m.id !== changeId)), 'no chunk holds it');
    });
  }

  for (const [label, overrides, opts] of [
    ['hierarchical', {}, undefined],
    ['adaptive', { adaptiveResolution: true }, undefined],
    ['kv-unified', { adaptiveResolution: true, foldingStrategy: 'kv-unified', kvUnified: KV_UNIFIED }, { kvUnifiedImmutablePrefixHash: 'v1' }],
  ] as const) {
    it(`${label}: after a head-window reset, the changes before the head are part of it, ahead of the head window, in order, once`, async () => {
      const strategy = new AutobiographicalStrategy({ headWindowTokens: 400, recentWindowTokens: 100, autoTickOnNewMessage: false, ...overrides } as never);
      const cm = await open(strategy);
      const define = change();
      const remove = change({ defineTools: undefined, addSystem: undefined, removeTools: ['get_weather'] });
      const inHead = change({ defineTools: undefined, addSystem: ['Answer briefly.'] });
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) {
        if (i === 5) ids.push(cm.addMessage('Harness', [define]));
        else if (i === 12) ids.push(cm.addMessage('Harness', [remove]));
        else if (i === 22) ids.push(cm.addMessage('Harness', [inHead]));
        else ids.push(cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(10)}`)]));
      }
      strategy.resetHeadWindow(ids[20]!);
      // No render stats before a live compile (#311).
      assert.equal(cm.getRenderStats(), null, 'no render stats before a compile');
      const compiled = await cm.compile(BIG, undefined, opts as never);
      const order = rawIds(compiled);
      const where = (i: number): number => order.indexOf(ids[i]!);
      assert.ok(where(21) === where(20) + 1 && where(0) > where(20), 'setup: the head runs from message 20, and the history before it comes after it');
      assert.deepEqual([where(5), where(12), where(20), where(21), where(22)], [0, 1, 2, 3, 4], 'the changes lead, in their order, then the head window, a change inside it in its place');
      assert.equal(order.filter((id) => id === ids[5] || id === ids[12] || id === ids[22]).length, 3, 'each once');
      assert.deepEqual(toolsAfter(compiled), [], 'the removal applies after the definition it removes');
      // The head costs what it sends: the changes before it and the window, each once.
      const head = order.slice(0, where(0));
      const headTokens = head.reduce((n, id) => n + estimateOf(cm, id), 0);
      assert.deepEqual(cm.getRenderStats()!.head, { messages: head.length, tokens: headTokens }, "the compile's render stats");
      // The adaptive paths reserve the head at that price: below it they refuse the head and tail, and say what the head cost.
      if (label !== 'hierarchical') {
        await assert.rejects(cm.compile({ maxTokens: headTokens - 1, reserveForResponse: 0 }, undefined, opts as never), (err: unknown) => {
          assert.ok(err instanceof OverBudgetError, String(err));
          assert.equal(err.diagnostics.headTokens, headTokens);
          return true;
        });
      }
    });
  }

  for (const [label, overrides, opts] of [
    ['hierarchical', {}, undefined],
    ['adaptive', { adaptiveResolution: true }, undefined],
    ['kv-unified', { adaptiveResolution: true, foldingStrategy: 'kv-unified', kvUnified: KV_UNIFIED }, { kvUnifiedImmutablePrefixHash: 'v1' }],
  ] as const) {
    it(`${label}: with the head window disabled, a reset sends the history before it once, in order, a change in it in its place`, async () => {
      const strategy = new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 100, autoTickOnNewMessage: false, ...overrides } as never);
      const cm = await open(strategy);
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) ids.push(i === 15 ? cm.addMessage('Harness', [change()]) : cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(10)}`)]));
      // A reset before the recent window starts, and one inside it.
      for (const at of [20, 27]) {
        strategy.resetHeadWindow(ids[at]!);
        assert.deepEqual(rawIds(await cm.compile(BIG, undefined, opts as never)), ids, `reset at ${at}`);
      }
    });
  }

  it('adaptive: a change after the newest turn is no turn, so a structural repair that drops that turn still refuses', async () => {
    const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, headWindowTokens: 400, recentWindowTokens: 0, autoTickOnNewMessage: false });
    const cm = await open(strategy);
    cm.addMessage('User', [text('message ' + 'word '.repeat(10))]);
    cm.addMessage('Claude', [text('calling'), { type: 'tool_use', id: 't1', name: 'read', input: {} } as ContentBlock]);
    const result = cm.addMessage('User', [{ type: 'tool_result', toolUseId: 't1', content: 'read.' } as ContentBlock]);
    const trailing = cm.addMessage('Harness', [change()]);
    // Removing the result leaves an unanswered call as the newest turn, right
    // before the change (a write can't put one there). A reset at the change
    // puts it in the head, so the call is the last compiled message, and the
    // structural repair trims it.
    cm.removeMessage(result);
    strategy.resetHeadWindow(trailing);
    await assert.rejects(cm.compile(BIG), (err: unknown) => {
      assert.ok(err instanceof OverBudgetError, String(err));
      assert.match(err.message, /^Structural repair did not retain the newest turn/);
      return true;
    });
  });

  it('a transition summary reads no change: a head message of changes alone adds no entry to its request', async () => {
    const { requests, membrane } = recordingMembrane();
    const cm = await open(new AutobiographicalStrategy({
      compressionModel: 'm', headWindowTokens: 100_000, recentWindowTokens: 100_000, autoTickOnNewMessage: false,
    }), membrane);
    cm.addMessage('User', [text('first')]);
    cm.addMessage('Harness', [change()]);
    cm.addMessage('Claude', [text('second')]);
    await cm.resetHeadWindow();
    assert.equal(requests.length, 1);
    const sent = JSON.stringify(requests[0]);
    assert.ok(sent.includes('User: first') && sent.includes('Claude: second'), 'setup: the head is in the request');
    assert.ok(!sent.includes('Harness'), 'no entry for the message of changes');
  });

  it('the coverage check names an unrendered change before the head\'s start as the head\'s only while the head window holds messages', async () => {
    const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false });
    const cm = await open(strategy);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(i === 3 ? cm.addMessage('Harness', [change()]) : cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i}`)]));
    const messages = cm.getAllMessages() as StoredMessage[];
    // Every message but the change, as a compile that lost it would hand the check.
    const entries = messages.filter((m) => m.id !== ids[3]).map((m, index) => ({ index, sourceMessageId: m.id, sourceRelation: 'raw' as const, participant: m.participant, content: m.content }));
    const check = strategy as unknown as { assertFullCoverage(e: unknown[], m: StoredMessage[], r: { headStart: number; headEnd: number; recentStart: number }): void };
    const label = (headStart: number, headEnd: number): string => {
      try { check.assertFullCoverage(entries, messages, { headStart, headEnd, recentStart: 8 }); } catch (err) {
        assert.ok(err instanceof UncoveredDropError, String(err));
        return err.site;
      }
      return assert.fail('no refusal');
    };
    // After a reset at 5 with the head window holding messages, the change at 3 is the head's (headPositions).
    assert.match(label(5, 8), /in-head-not-rendered=1/);
    // With the head window empty or disabled, no head holds it: it's history before the head's start.
    assert.match(label(5, 5), /before-head-start-not-rendered=1/);
    assert.match(label(5, 0), /before-head-start-not-rendered=1/);
  });

  it('KnowledgeStrategy: no chunk holds or spans a change, and a chunk closes there', async () => {
    const { requests, membrane } = recordingMembrane();
    const strategy = new KnowledgeStrategy({
      compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0, summaryParticipant: 'Claude', mergeThreshold: 6,
    });
    const cm = await open(strategy, membrane);
    let changeId = '';
    for (let i = 0; i < 80; i++) {
      if (i === 21) changeId = cm.addMessage('Harness', [change()]);
      else cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
    }
    await settle(cm, requests);
    await cm.compile({ maxTokens: 4000, reserveForResponse: 0 });
    const position = new Map(cm.getAllMessages().map((m, i) => [m.id, i] as const));
    const chunks = (strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }> }> }).chunks;
    assert.ok(chunks.some((c) => c.messages.some((m) => position.get(m.id)! < 21)), 'setup: chunks before the change');
    assert.ok(chunks.every((c) => c.messages.every((m) => m.id !== changeId)), 'no chunk holds it');
    for (const chunk of chunks) {
      const at = chunk.messages.map((m) => position.get(m.id)!);
      assert.ok(!(at[0]! < 21 && at.at(-1)! > 21), `chunk ${at[0]}..${at.at(-1)} doesn't span the change`);
    }
    // It closes only the chunk it ends: the chunks after it hold several messages, as the rest do.
    const later = chunks.filter((c) => position.get(c.messages[0]!.id)! > 21);
    assert.ok(later.length > 0 && later.every((c) => c.messages.length > 1), `chunks after it: ${later.map((c) => c.messages.length)}`);
  });

  it('KnowledgeStrategy: no chunk holds or spans a change first, side by side, beside a pin or last, none is empty, and a pair of changes closes one chunk', async () => {
    const { requests, membrane } = recordingMembrane();
    const strategy = new KnowledgeStrategy({
      compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0, summaryParticipant: 'Claude', mergeThreshold: 6,
    });
    const cm = await open(strategy, membrane);
    const at = [0, 30, 31, 51, 79];
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) {
      ids.push(at.includes(i) ? cm.addMessage('Harness', [change()]) : cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]));
    }
    cm.pinRange(ids[50]!, ids[50]!);
    await settle(cm, requests);
    await cm.compile({ maxTokens: 4000, reserveForResponse: 0 });
    const position = new Map(cm.getAllMessages().map((m, i) => [m.id, i] as const));
    const chunks = (strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }> }> }).chunks;
    assert.ok(chunks.length > 4, `setup: ${chunks.length} chunks`);
    assert.ok(chunks.every((c) => c.messages.length > 0), 'no chunk is empty');
    for (const chunk of chunks) {
      const span = chunk.messages.map((m) => position.get(m.id)!);
      for (const c of at) {
        assert.ok(!span.includes(c), `chunk ${span[0]}..${span.at(-1)} doesn't hold the change at ${c}`);
        assert.ok(!(span[0]! < c && span.at(-1)! > c), `chunk ${span[0]}..${span.at(-1)} doesn't span the change at ${c}`);
      }
    }
    // The two changes side by side close one chunk between them, not two.
    const after = chunks.find((c) => position.get(c.messages[0]!.id) === 32);
    assert.ok(after && after.messages.length > 1, `the chunk after the pair holds ${after?.messages.length} messages`);
  });

  it('KnowledgeStrategy: once a change between two compressed chunks is removed, each keeps its span, so compression goes on past them', async () => {
    const { requests, membrane } = recordingMembrane();
    const strategy = new KnowledgeStrategy({
      compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0, summaryParticipant: 'Claude', mergeThreshold: 1000,
    });
    const cm = await open(strategy, membrane);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(i === 22 ? cm.addMessage('Harness', [change()]) : cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]));
    }
    const chunks = (): Array<{ messages: Array<{ id: string }>; compressed: boolean }> =>
      (strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }>; compressed: boolean }> }).chunks;
    const span = (c: { messages: Array<{ id: string }> }): string => c.messages.map((m) => m.id).join(',');
    await settle(cm, requests);
    const compressed = chunks().filter((c) => c.compressed).map(span);
    assert.ok(compressed.some((s) => s.endsWith(ids[21]!)) && compressed.some((s) => s.startsWith(ids[23]!)), 'setup: the chunks either side of the change are compressed');
    cm.removeMessage(ids[22]!);
    for (let i = 30; i < 45; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
    await settle(cm, requests);
    for (const s of compressed) assert.ok(chunks().map(span).includes(s), 'each compressed chunk keeps its span');
    assert.ok(chunks().slice(0, -1).every((c) => c.compressed), `every chunk but the newest is compressed: ${chunks().map((c) => (c.compressed ? 'C' : 'u')).join('')}`);
  });

  it('KnowledgeStrategy: a summary ending at an unanswered call doesn\'t part the call from the result that comes after it', async () => {
    const { requests, membrane } = recordingMembrane();
    const strategy = new KnowledgeStrategy({
      compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0, summaryParticipant: 'Claude', mergeThreshold: 1000,
    });
    const cm = await open(strategy, membrane);
    for (let i = 0; i < 9; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
    const use = cm.addMessage('Claude', [text('calling'), { type: 'tool_use', id: 't1', name: 'read', input: {} } as ContentBlock]);
    await settle(cm, requests);
    const chunks = (): Array<{ messages: Array<{ id: string }>; compressed: boolean }> =>
      (strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }>; compressed: boolean }> }).chunks;
    assert.ok(chunks().some((c) => c.compressed && c.messages.at(-1)!.id === use), 'setup: a summary ends at the call');
    const result = cm.addMessage('User', [{ type: 'tool_result', toolUseId: 't1', content: 'read it' } as ContentBlock]);
    await cm.compile(BIG);
    assert.ok(!chunks().some((c) => c.messages.at(-1)!.id === use), 'no chunk ends at the call now that its result follows it');
    assert.ok(chunks().some((c) => c.messages.some((m) => m.id === use) && c.messages.some((m) => m.id === result)), 'the call and its result share a chunk');
    // As on main, that chunk overlaps the summary, which refuses it, so both go out raw, the result with its call.
    await settle(cm, requests);
    const compiled = await cm.compile(BIG);
    const sent = rawIds(compiled);
    assert.ok(sent.includes(use) && sent.includes(result), 'the call and its result are sent raw');
    const blocks = compiled.messages.flatMap((m) => m.content as Array<{ type: string; id?: string; toolUseId?: string; content?: unknown }>);
    assert.ok(blocks.some((b) => b.type === 'tool_use' && b.id === 't1'), "the call's tool_use is sent");
    assert.ok(blocks.some((b) => b.type === 'tool_result' && b.toolUseId === 't1' && b.content === 'read it'), 'the result is sent with its content');
  });

  it('KnowledgeStrategy: a summary ending at a call that a plain message follows still closes there', async () => {
    const { requests, membrane } = recordingMembrane();
    const strategy = new KnowledgeStrategy({
      compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0, summaryParticipant: 'Claude', mergeThreshold: 1000,
    });
    const cm = await open(strategy, membrane);
    for (let i = 0; i < 9; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
    const use = cm.addMessage('Claude', [text('calling'), { type: 'tool_use', id: 't1', name: 'read', input: {} } as ContentBlock]);
    await settle(cm, requests);
    const chunks = (): Array<{ messages: Array<{ id: string }>; compressed: boolean }> =>
      (strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }>; compressed: boolean }> }).chunks;
    assert.ok(chunks().some((c) => c.compressed && c.messages.at(-1)!.id === use), 'setup: a summary ends at the call');
    // No result comes; the conversation goes on.
    const after = cm.addMessage('User', [text(`never mind ${'word '.repeat(30)}`)]);
    await cm.compile(BIG);
    assert.ok(chunks().some((c) => c.compressed && c.messages.at(-1)!.id === use), 'the summary keeps its chunk');
    assert.ok(!chunks().some((c) => c.messages.some((m) => m.id === use) && c.messages.some((m) => m.id === after)), 'the message after it starts a chunk of its own');
  });

  it('KnowledgeStrategy: a chunk closes where a summary covers its messages, even once the summary\'s last message is pinned, and where an unpinned message precedes a summary', async () => {
    const { requests, membrane } = recordingMembrane();
    const strategy = new KnowledgeStrategy({
      compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0, summaryParticipant: 'Claude', mergeThreshold: 1000,
    });
    const cm = await open(strategy, membrane);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]));
    // A message pinned before anything compresses is in no summary.
    const early = cm.pinRange(ids[12]!, ids[12]!);
    const chunks = (): Array<{ messages: Array<{ id: string }>; compressed: boolean }> =>
      (strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }>; compressed: boolean }> }).chunks;
    const chunkOf = (id: string): Array<{ id: string }> | undefined => chunks().find((c) => c.messages.some((m) => m.id === id))?.messages;
    await settle(cm, requests);
    // The last message of the summary holding M-20, pinned after it compressed.
    const covered = chunks().find((c) => c.compressed && c.messages.some((m) => m.id === ids[20]))!;
    const last = covered.messages.at(-1)!.id;
    const next = ids[ids.indexOf(last) + 1]!;
    assert.ok(chunks().filter((c) => c.compressed).length >= 3 && next !== undefined, 'setup: compressed chunks, and a message after the one pinned');
    cm.pinRange(last, last);
    cm.unpin(early);
    for (let i = 30; i < 45; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
    await settle(cm, requests);
    const beforeLast = covered.messages.at(-2)!.id;
    assert.ok(chunkOf(beforeLast), 'setup: the message before the pinned one is in a chunk');
    assert.ok(!chunkOf(beforeLast)!.some((m) => m.id === next), 'no chunk runs on past a summary whose last message is pinned');
    // Summaries made before it was unpinned, which don't cover it.
    const others = new Set((strategy as unknown as { summaries: Array<{ level: number; sourceIds: string[] }> }).summaries
      .filter((x) => x.level === 1 && !x.sourceIds.includes(ids[12]!)).flatMap((x) => x.sourceIds));
    assert.ok(chunkOf(ids[12]!)!.every((m) => !others.has(m.id)), 'the unpinned message shares no chunk with another summary\'s messages');
  });

  it('KnowledgeStrategy: once a change is removed, the chunks rebuilt around where it was run across that place', async () => {
    const strategy = new KnowledgeStrategy({
      compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0, summaryParticipant: 'Claude', mergeThreshold: 6,
    });
    const cm = await open(strategy);
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      ids.push(i === 22 ? cm.addMessage('Harness', [change()]) : cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]));
    }
    const chunks = (): Array<{ messages: Array<{ id: string }> }> => (strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }> }> }).chunks;
    const spans = (): string[][] => chunks().map((c) => c.messages.map((m) => m.id));
    await cm.compile(BIG);
    assert.ok(spans().some((s) => s.at(-1) === ids[21]) && spans().some((s) => s[0] === ids[23]), 'setup: a chunk ends at the message before the change, and one starts after it');
    cm.removeMessage(ids[22]!);
    await cm.compile(BIG);
    assert.ok(spans().some((s) => s.includes(ids[21]!) && s.includes(ids[23]!)), `a chunk now holds both neighbours: ${JSON.stringify(spans().map((s) => s.length))}`);
  });

  it('KnowledgeStrategy: a store without changes chunks by its other rules, so a chunk can span a pinned message', async () => {
    const { requests, membrane } = recordingMembrane();
    const strategy = new KnowledgeStrategy({
      compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0, summaryParticipant: 'Claude', mergeThreshold: 6,
    });
    const cm = await open(strategy, membrane);
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) ids.push(cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]));
    cm.pinRange(ids[21]!, ids[21]!);
    await settle(cm, requests);
    await cm.compile({ maxTokens: 4000, reserveForResponse: 0 });
    const position = new Map(cm.getAllMessages().map((m, i) => [m.id, i] as const));
    const chunks = (strategy as unknown as { chunks: Array<{ messages: Array<{ id: string }> }> }).chunks;
    assert.ok(chunks.some((c) => {
      const at = c.messages.map((m) => position.get(m.id)!);
      return at[0]! < 21 && at.at(-1)! > 21;
    }), 'a chunk runs across the pin');
  });

  it('stays raw under a level pin over it, where pin bounds are read', async () => {
    const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, foldingStrategy: 'kv-stable', autoTickOnNewMessage: false } as never);
    const cm = await open(strategy);
    const ids = [cm.addMessage('User', [text('a')]), cm.addMessage('Harness', [change()]), cm.addMessage('User', [text('b')])];
    cm.pinRange(ids[0]!, ids[2]!, { name: 'level-1', level: 1 });
    const bounds = (strategy as unknown as { resolvedPinBounds(m: StoredMessage[]): Map<number, unknown> }).resolvedPinBounds(cm.getAllMessages());
    assert.deepEqual([bounds.get(0), bounds.get(1), bounds.get(2)], [{ level: 1 }, 'raw', { level: 1 }]);
  });

  it('compression input passes over a message it left empty: no separator where it sat, and its neighbours join', () => {
    const collapse = (AutobiographicalStrategy.prototype as unknown as {
      collapseConsecutiveMessages(m: Array<{ participant: string; content: ContentBlock[] }>): Array<{ participant: string; content: ContentBlock[] }>;
    }).collapseConsecutiveMessages;
    const sep = text('\n\n---\n\n');
    assert.deepEqual(collapse([{ participant: 'User', content: [text('a')] }, { participant: 'User', content: [] }, { participant: 'User', content: [text('b')] }]),
      [{ participant: 'User', content: [text('a'), sep, text('b')] }]);
    assert.deepEqual(collapse([{ participant: 'User', content: [text('a')] }, { participant: 'Harness', content: [] }, { participant: 'User', content: [text('b')] }]),
      [{ participant: 'User', content: [text('a'), sep, text('b')] }]);
    // An empty first message, and nothing but empty ones.
    assert.deepEqual(collapse([{ participant: 'Harness', content: [] }, { participant: 'User', content: [text('a')] }]),
      [{ participant: 'User', content: [text('a')] }]);
    assert.deepEqual(collapse([{ participant: 'User', content: [] }, { participant: 'Claude', content: [] }]), []);
  });

  it("finds a listing's changes once, and a new listing's afresh", () => {
    const m = (...content: ContentBlock[]): { content: ContentBlock[] } => ({ content });
    const listing = [m(text('a')), m(change()), m(text('b'))];
    assert.deepEqual(systemChangePositions(listing), [1]);
    assert.equal(systemChangePositions(listing), systemChangePositions(listing), 'the same listing: the same answer');
    assert.notEqual(systemChangePositions([...listing]), systemChangePositions(listing), 'a new listing: found again');
  });

  it('a large change is never sharded at ingress', async () => {
    const cm = await open(new AutobiographicalStrategy({ compressionModel: 'm', targetChunkTokens: 200, adaptiveResolution: true, autoTickOnNewMessage: false }));
    cm.addMessage('Harness', [change({ addSystem: ['x '.repeat(5000)] })]);
    assert.equal(cm.getAllMessages().length, 1);
  });
});

describe('the passthrough strategies and a system change before their window', () => {
  /**
   * `first`, a change A, M-00..M-15, a change B, M-16..M-19: B sits among the
   * newest five messages, and the budget fits both changes and those five.
   */
  async function seeded(strategy: ContextStrategy): Promise<{ cm: ContextManager; ids: Map<string, string>; T: number; A: number; B: number }> {
    const cm = await open(strategy);
    const ids = new Map<string, string>();
    ids.set('first', cm.addMessage('User', [text('first ' + 'word '.repeat(50))]));
    ids.set('A', cm.addMessage('Harness', [change()]));
    for (let i = 0; i < 20; i++) {
      if (i === 16) ids.set('B', cm.addMessage('Harness', [change({ addSystem: ['Use metric units, always.'] })]));
      const label = `M-${String(i).padStart(2, '0')}`;
      ids.set(label, cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`${label} ${'word '.repeat(30)}`)]));
    }
    const T = estimateOf(cm, ids.get('M-00')!);
    const A = estimateOf(cm, ids.get('A')!);
    const B = estimateOf(cm, ids.get('B')!);
    assert.ok(B > T / 2, `setup: a change counted twice would cost a message (B ${B}, T ${T})`);
    return { cm, ids, T, A, B };
  }
  const expected = ['A', 'M-15', 'B', 'M-16', 'M-17', 'M-18', 'M-19'];
  const labelsOf = (ids: Map<string, string>, compiled: CompileResult): string[] => {
    const label = new Map([...ids].map(([k, v]) => [v, k] as const));
    return rawIds(compiled).map((id) => label.get(id)!);
  };

  it('passthrough: when the oldest no longer fit, the changes are sent ahead of the rest, counted once, within the budget', async () => {
    const { cm, ids, T, A, B } = await seeded(new PassthroughStrategy());
    const budget = A + B + 5 * T + Math.floor(T / 2);
    const compiled = await cm.compile({ maxTokens: budget, reserveForResponse: 0 });
    assert.deepEqual(labelsOf(ids, compiled), expected);
    assert.ok(sentTokens(cm, compiled) <= budget);
    assert.deepEqual(changesSent(compiled), [cm.getMessage(ids.get('A')!)!.content, cm.getMessage(ids.get('B')!)!.content], 'each as stored');
  });

  it('windowed-passthrough: a re-anchor past a change keeps it ahead of the window, sizes the window as that fraction of the room the changes leave, and no compile exceeds the budget', async () => {
    const strategy = new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 });
    const { cm, ids, T, A, B } = await seeded(strategy);
    const budget = 2 * (A + B + 5 * T) + T;
    const compiled = await cm.compile({ maxTokens: budget, reserveForResponse: 0 });
    assert.ok(strategy.getAnchor() > cm.getMessage(ids.get('A')!)!.sequence, 'setup: the anchor moved past the change');
    const labels = labelsOf(ids, compiled);
    assert.equal(labels[0], 'A', 'the change before the window leads');
    assert.deepEqual(changesSent(compiled), [cm.getMessage(ids.get('A')!)!.content, cm.getMessage(ids.get('B')!)!.content], 'each once, as stored');
    // The window's turns are the newest that fit in half the room the changes leave, and no more.
    const room = (budget - A - B) * 0.5;
    const turns = labels.filter((l) => l.startsWith('M-'));
    const W = turns.reduce((n, l) => n + estimateOf(cm, ids.get(l)!), 0);
    const older = `M-${String(Number(turns[0]!.slice(2)) - 1).padStart(2, '0')}`;
    assert.ok(W <= room && W + estimateOf(cm, ids.get(older)!) > room, `window ${W}, room ${room}, next older ${older}`);
    // Appends grow the window until the next re-anchor, the change before it priced in all along.
    let anchors = 0;
    for (let i = 20; i < 60; i++) {
      const anchor = strategy.getAnchor();
      cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
      const next = await cm.compile({ maxTokens: budget, reserveForResponse: 0 });
      if (strategy.getAnchor() !== anchor) anchors++;
      assert.ok(sentTokens(cm, next) <= budget, `compile after M-${i}: ${sentTokens(cm, next)} within ${budget}`);
      assert.ok(holdsChange(next.messages[0]!.content), 'a change still leads');
    }
    assert.ok(anchors >= 2, `setup: the window moved again (${anchors})`);
  });

  it('windowed-passthrough: when the changes fill the target, the window still starts at the newest turn, not at a trailing change', async () => {
    const cm = await open(new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 }));
    cm.addMessage('User', [text('old ' + 'word '.repeat(40))]);
    const big = cm.addMessage('Harness', [change({ addSystem: ['Rule. '.repeat(60)] })]);
    const user = cm.addMessage('User', [text('the newest turn ' + 'word '.repeat(10))]);
    const last = cm.addMessage('Harness', [change({ addSystem: ['Use metric units.'] })]);
    const C = estimateOf(cm, big) + estimateOf(cm, last);
    const U = estimateOf(cm, user);
    assert.ok(U > (U + 5) * 0.5, 'setup: the turn alone passes the window the changes leave room for, so the progress clause picks it');
    const compiled = await cm.compile({ maxTokens: C + U + 5, reserveForResponse: 0 });
    assert.deepEqual(rawIds(compiled), [big, user, last]);
  });

  it('every strategy refuses with OverBudgetError, rather than drop one, when the changes alone exceed the budget, and names nothing that would clear it', async () => {
    const huge = change({ addSystem: ['Rule. '.repeat(400)] });
    const budget: TokenBudget = { maxTokens: 300, reserveForResponse: 0 };
    for (const [label, strategy] of [
      ['passthrough', new PassthroughStrategy()],
      ['windowed-passthrough', new WindowedPassthroughStrategy()],
      ['hierarchical', new AutobiographicalStrategy({ autoTickOnNewMessage: false })],
      ['adaptive', new AutobiographicalStrategy({ adaptiveResolution: true, autoTickOnNewMessage: false })],
    ] as const) {
      const cm = await open(strategy);
      cm.addMessage('User', [text('hello')]);
      cm.addMessage('Harness', [huge]);
      cm.addMessage('User', [text('again')]);
      await assert.rejects(cm.compile(budget), (err: unknown) => {
        assert.ok(err instanceof OverBudgetError, `${label}: ${String(err)}`);
        assert.deepEqual(err.clearedBy, [], `${label}: only consolidating clears it`);
        if (label === 'passthrough') assert.match(err.message, /^Passthrough kept only its system changes/, label);
        // Its window still holds the newest conversation message, which its numbers count.
        if (label === 'windowed-passthrough') assert.match(err.message, /^Windowed passthrough: its system changes and the newest conversation message/, label);
        if (label === 'hierarchical') assert.match(err.message, /system changes/, label);
        return true;
      });
    }
    // A store of changes alone: over the budget, each passthrough strategy names them alone;
    // filling it exactly, each sends them.
    for (const [label, make, stage] of [
      ['passthrough', () => new PassthroughStrategy(), /^Passthrough kept only its system changes/],
      ['windowed-passthrough', () => new WindowedPassthroughStrategy(), /^Windowed passthrough: its system changes alone/],
    ] as const) {
      const alone = await open(make());
      const id = alone.addMessage('Harness', [huge]);
      await assert.rejects(alone.compile(budget), (err: unknown) => {
        assert.ok(err instanceof OverBudgetError, `${label}: ${String(err)}`);
        assert.match(err.message, stage, label);
        return true;
      });
      assert.deepEqual(rawIds(await alone.compile({ maxTokens: estimateOf(alone, id), reserveForResponse: 0 })), [id], label);
    }
    // A preview reports rather than refuses: passthrough sends the change alone.
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('hello')]);
    const id = cm.addMessage('Harness', [huge]);
    assert.deepEqual(rawIds(await cm.compile(budget, undefined, { dryRun: true })), [id]);
  });

  it('the hierarchical path refuses an eviction from its recent window while the changes fit, as it refuses any', async () => {
    const cm = await open(new AutobiographicalStrategy({ autoTickOnNewMessage: false }));
    cm.addMessage('Harness', [change()]);
    for (let i = 0; i < 12; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
    await assert.rejects(cm.compile({ maxTokens: 300, reserveForResponse: 0 }), UncoveredDropError);
  });

  it('adaptive: a plan that can\'t fit beside a change in the middle names nothing, though compression is queued', async () => {
    const cm = await open(new AutobiographicalStrategy({
      adaptiveResolution: true, compressionModel: 'm', targetChunkTokens: 200, recentWindowTokens: 50, autoTickOnNewMessage: false, minChunkCharsForLLM: 0,
    }));
    for (let i = 0; i < 30; i++) {
      if (i === 10) cm.addMessage('Harness', [change({ addSystem: ['Rule. '.repeat(400)] })]);
      else cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
    }
    await assert.rejects(cm.compile({ maxTokens: 300, reserveForResponse: 0 }), (err: unknown) => {
      assert.ok(err instanceof OverBudgetError, String(err));
      assert.deepEqual(err.clearedBy, []);
      return true;
    });
  });

  it('adaptive: a plan refusal names compression only while the head, the tail and the changes between them fit', async () => {
    const cm = await open(new AutobiographicalStrategy({
      adaptiveResolution: true, compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 200,
      overBudgetGraceRatio: 0, autoTickOnNewMessage: false, minChunkCharsForLLM: 0,
    }));
    let c = '';
    for (let i = 0; i < 30; i++) {
      if (i === 10) c = cm.addMessage('Harness', [change({ addSystem: ['Rule. '.repeat(60)] })]);
      else cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
    }
    const C = estimateOf(cm, c);
    const refusal = async (maxTokens: number): Promise<OverBudgetError> => {
      try { await cm.compile({ maxTokens, reserveForResponse: 0 }); } catch (err) { assert.ok(err instanceof OverBudgetError, String(err)); return err; }
      return assert.fail(`no refusal at ${maxTokens}`);
    };
    // The change alone fits, beside the tail it doesn't: compression can't clear that.
    const tight = await refusal(C + 10);
    assert.ok(tight.diagnostics.tailTokens > 10, `setup: tail ${tight.diagnostics.tailTokens}, change ${C}`);
    assert.deepEqual(tight.clearedBy, []);
    // Room for the tail and the change, but not the unfolded middle: compression can.
    const roomy = await refusal(tight.diagnostics.tailTokens + C + 20);
    assert.deepEqual(roomy.clearedBy, ['compression']);
  });

  it('adaptive: a change in the recent window counts once toward what compression can\'t shrink', async () => {
    const cm = await open(new AutobiographicalStrategy({
      adaptiveResolution: true, compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 400,
      overBudgetGraceRatio: 0, autoTickOnNewMessage: false, minChunkCharsForLLM: 0,
    }));
    let c = '';
    for (let i = 0; i < 30; i++) {
      if (i === 28) c = cm.addMessage('Harness', [change({ addSystem: ['Rule. '.repeat(60)] })]);
      else cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
    }
    const C = estimateOf(cm, c);
    let first: OverBudgetError | undefined;
    try { await cm.compile({ maxTokens: C + 1, reserveForResponse: 0 }); } catch (err) { first = err as OverBudgetError; }
    // The tail holds the change; a budget between the tail and the tail with the change again fits it once, not the middle.
    const tail = first!.diagnostics.tailTokens;
    assert.ok(tail > C, `setup: the tail (${tail}) holds the change (${C})`);
    await assert.rejects(cm.compile({ maxTokens: tail + Math.floor(C / 2), reserveForResponse: 0 }), (err: unknown) => {
      assert.ok(err instanceof OverBudgetError, String(err));
      assert.deepEqual(err.clearedBy, ['compression']);
      return true;
    });
  });

  it('adaptive: a change a reset left in the head counts once toward what compression can\'t shrink', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true, compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 200, recentWindowTokens: 200,
      overBudgetGraceRatio: 0, autoTickOnNewMessage: false, minChunkCharsForLLM: 0,
    });
    const cm = await open(strategy);
    let c = '';
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      if (i === 10) ids.push(c = cm.addMessage('Harness', [change({ addSystem: ['Rule. '.repeat(60)] })]));
      else ids.push(cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]));
    }
    strategy.resetHeadWindow(ids[20]!);
    const C = estimateOf(cm, c);
    let first: OverBudgetError | undefined;
    try { await cm.compile({ maxTokens: 1, reserveForResponse: 0 }); } catch (err) { first = err as OverBudgetError; }
    assert.ok(first instanceof OverBudgetError, String(first));
    const { headTokens, tailTokens } = first.diagnostics;
    assert.ok(headTokens > C, `setup: the head (${headTokens}) holds the change (${C})`);
    // Room for the head and the tail, the change among them once, but not the unfolded middle: compression can.
    await assert.rejects(cm.compile({ maxTokens: headTokens + tailTokens + Math.floor(C / 2), reserveForResponse: 0 }), (err: unknown) => {
      assert.ok(err instanceof OverBudgetError, String(err));
      assert.doesNotMatch(err.message, /Head\/tail reservation exceeded budget/);
      assert.deepEqual(err.clearedBy, ['compression']);
      return true;
    });
  });

  it('adaptive: a refusal of the head and tail finds the newest conversation message past the changes after it, so it names a smaller recent window only when that message fits beside them', async () => {
    const cm = await open(new AutobiographicalStrategy({
      adaptiveResolution: true, headWindowTokens: 0, recentWindowTokens: 100_000, overBudgetGraceRatio: 0, autoTickOnNewMessage: false,
    }));
    for (let i = 0; i < 6; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]);
    const turn = cm.addMessage('User', [text('the newest turn ' + 'word '.repeat(60))]);
    const c = cm.addMessage('Harness', [change()]);
    const U = estimateOf(cm, turn);
    const C = estimateOf(cm, c);
    const refusal = async (maxTokens: number): Promise<OverBudgetError> => {
      try { await cm.compile({ maxTokens, reserveForResponse: 0 }); } catch (err) { assert.ok(err instanceof OverBudgetError, String(err)); return err; }
      return assert.fail(`no refusal at ${maxTokens}`);
    };
    const tight = await refusal(U + C - 1);
    assert.match(tight.message, /Head\/tail reservation exceeded budget/);
    assert.deepEqual(tight.clearedBy, [], 'the newest message and the change after it don\'t fit together');
    const roomy = await refusal(U + C + 5);
    assert.match(roomy.message, /Head\/tail reservation exceeded budget/);
    assert.deepEqual(roomy.clearedBy, ['smaller-recent-window']);
  });

  for (const [label, make] of [
    ['passthrough', () => new PassthroughStrategy()],
    ['windowed-passthrough', () => new WindowedPassthroughStrategy()],
  ] as const) {
    it(`${label}: refuses when the newest conversation message doesn't fit beside its changes, naming a newer one, which clears it, while they leave room for one`, async () => {
      const cm = await open(make());
      const c = cm.addMessage('Harness', [change()]);
      const big = cm.addMessage('User', [text('big ' + 'word '.repeat(400))]);
      const C = estimateOf(cm, c);
      const U = estimateOf(cm, big);
      await assert.rejects(cm.compile({ maxTokens: C + 10 + 50, reserveForResponse: 50 }), (err: unknown) => {
        assert.ok(err instanceof OverBudgetError, String(err));
        assert.deepEqual(err.clearedBy, ['newer-message']);
        assert.match(err.message, /its system changes and the newest conversation message/);
        assert.deepEqual([err.budget, err.actual], [C + 10, C + U], 'the budget less the reserve, and the changes with the newest message');
        assert.deepEqual([err.diagnostics.headTokens, err.diagnostics.tailTokens], [C, U], 'the changes, then the newest message');
        return true;
      });
      // Changes that fill the budget leave no room for any message.
      await assert.rejects(cm.compile({ maxTokens: C, reserveForResponse: 0 }), (err: unknown) => {
        assert.ok(err instanceof OverBudgetError, String(err));
        assert.deepEqual(err.clearedBy, []);
        return true;
      });
      // A change after the newest message: that message is still the one priced as the newest.
      const trailing = cm.addMessage('Harness', [change({ addSystem: ['Answer briefly.'] })]);
      const C2 = estimateOf(cm, trailing);
      await assert.rejects(cm.compile({ maxTokens: C + C2 + 10, reserveForResponse: 0 }), (err: unknown) => {
        assert.ok(err instanceof OverBudgetError, String(err));
        assert.deepEqual([err.diagnostics.headTokens, err.diagnostics.tailTokens], [C + C2, U], 'the changes, then the newest conversation message');
        return true;
      });
      // A newer conversation message that fits beside the changes clears it.
      const small = cm.addMessage('User', [text('ok')]);
      const compiled = await cm.compile({ maxTokens: C + C2 + estimateOf(cm, small), reserveForResponse: 0 });
      assert.deepEqual(rawIds(compiled), [c, trailing, small]);
    });
  }

  it('passthrough: without changes, a newest message over the budget still sends nothing, as on main', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('hello')]);
    const big = cm.addMessage('User', [text('big ' + 'word '.repeat(400))]);
    const compiled = await cm.compile({ maxTokens: estimateOf(cm, big) - 1, reserveForResponse: 0 });
    assert.equal(compiled.messages.length, 0);
    // Nor does a response reserve larger than the budget make it refuse.
    assert.equal((await cm.compile({ maxTokens: 10, reserveForResponse: 20 })).messages.length, 0);
    // The windowed strategy refuses it, naming the newest message alone.
    const windowed = await open(new WindowedPassthroughStrategy());
    windowed.addMessage('User', [text('hello')]);
    const big2 = windowed.addMessage('User', [text('big ' + 'word '.repeat(400))]);
    await assert.rejects(windowed.compile({ maxTokens: estimateOf(windowed, big2) - 1, reserveForResponse: 0 }), (err: unknown) => {
      assert.ok(err instanceof OverBudgetError, String(err));
      assert.match(err.message, /^Windowed passthrough: the newest message alone/);
      return true;
    });
  });

  it('windowed-passthrough: renderAsNewest gives a change before the anchor as select sends it, ahead of the window', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    cm.addMessage('User', [text('a')]);
    const id = cm.addMessage('Harness', [change()]);
    const after = cm.addMessage('User', [text('b')]);
    strategy.setAnchor(cm.getMessage(after)!.sequence);
    const compiled = await cm.compile(BIG);
    assert.deepEqual(changesSent(compiled), [[change()]], 'setup: select sends the change ahead of the window');
    assert.deepEqual(cm.renderAsNewest([id]), changesSent(compiled));
  });

  it('windowed-passthrough: a refused compile leaves the anchor where the last sent window started', async () => {
    const strategy = new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 });
    const cm = await open(strategy);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(cm.addMessage(i % 2 ? 'Claude' : 'User', [text(`M-${i} ${'word '.repeat(30)}`)]));
    const budget: TokenBudget = { maxTokens: 20 * estimateOf(cm, ids[0]!), reserveForResponse: 0 };
    await cm.compile(budget);
    const anchor = strategy.getAnchor();
    const c = cm.addMessage('Harness', [change({ addSystem: ['Rule. '.repeat(2000)] })]);
    cm.addMessage('User', [text('again')]);
    assert.ok(estimateOf(cm, c) > budget.maxTokens, 'setup: the change alone is over the budget');
    await assert.rejects(cm.compile(budget), OverBudgetError);
    assert.equal(strategy.getAnchor(), anchor, 'the refusal moved nothing');
    // Consolidated: the turns that fit are still in the window.
    cm.removeMessage(c);
    assert.equal(rawIds(await cm.compile(budget))[0], ids[0]);
    // Without any change too: a newest message alone over the budget is refused, and a retry with a larger budget sends the older turns.
    const big = cm.addMessage('User', [text('big ' + 'word '.repeat(3000))]);
    assert.ok(estimateOf(cm, big) > budget.maxTokens, 'setup: the newest alone is over the budget');
    await assert.rejects(cm.compile(budget), OverBudgetError);
    assert.equal(strategy.getAnchor(), anchor, 'that refusal moved nothing either');
    assert.equal(rawIds(await cm.compile(BIG))[0], ids[0]);
  });
});

describe('firstChanged', () => {
  it('is null at first, the count when nothing changed, the first new index after an append, and a dry compile neither reads nor moves it', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('a')]);
    cm.addMessage('Claude', [text('b')]);
    assert.equal((await cm.compile(BIG)).firstChanged, null);
    assert.equal((await cm.compile(BIG)).firstChanged, 2);
    cm.addMessage('User', [text('c')]);
    const dry = await cm.compile(BIG, undefined, { dryRun: true });
    assert.equal(dry.firstChanged, undefined);
    assert.equal((await cm.compile(BIG)).firstChanged, 2);
    // An injection placed before the last user message changes from there.
    const injected = await cm.compile(BIG, [{ namespace: 'n', position: 'beforeUser', content: [text('note')] }]);
    assert.equal(injected.firstChanged, 2);
    // Taking it out again changes from there too.
    assert.equal((await cm.compile(BIG)).firstChanged, 2);
    // An injection rebuilt as a new array of the same bytes is the same message.
    await cm.compile(BIG, [{ namespace: 'n', position: 'beforeUser', content: [text('note')] }]);
    const same = await cm.compile(BIG, [{ namespace: 'n', position: 'beforeUser', content: [text('note')] }]);
    assert.equal(same.firstChanged, same.messages.length);
  });

  it('tells a participant apart from content, and sees an edit, a removal, and an injection changed in place', async () => {
    const cm = await open(new PassthroughStrategy());
    const ids = [cm.addMessage('User', [text('a')]), cm.addMessage('Claude', [text('b')]), cm.addMessage('User', [text('c')])];
    await cm.compile(BIG);
    // The same content under another participant: the injection's namespace names it.
    await cm.compile(BIG, [{ namespace: 'one', position: 'afterUser', content: [text('note')] }]);
    assert.equal((await cm.compile(BIG, [{ namespace: 'two', position: 'afterUser', content: [text('note')] }])).firstChanged, 3);
    // An injection's own array, changed in place between compiles.
    const note = [text('note v1')];
    await cm.compile(BIG, [{ namespace: 'n', position: 'afterUser', content: note }]);
    note[0] = text('note v2');
    assert.equal((await cm.compile(BIG, [{ namespace: 'n', position: 'afterUser', content: note }])).firstChanged, 3);
    await cm.compile(BIG);
    cm.editMessage(ids[1]!, [text('b, edited')]);
    assert.equal((await cm.compile(BIG)).firstChanged, 1);
    cm.removeMessage(ids[0]!);
    assert.equal((await cm.compile(BIG)).firstChanged, 0);
  });

  it('takes an injection\'s bytes as it compiles, also when a binding compile sends it without its thinking', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('a')]);
    cm.addMessage('Claude', [text('b')]);
    cm.addMessage('User', [text('c')]);
    const binds = {
      thinkingBinding: { binds: true, participant: 'Claude' },
      identity: { system: 'zz-system', tools: 'zz-tools', model: 'zz-model', request: 'zz-request' },
    };
    const said = text('note v1');
    const note = [{ type: 'thinking', thinking: 'zz-reasoning', signature: 'zz-sig' } as ContentBlock, said];
    const first = await cm.compile(BIG, [{ namespace: 'n', position: 'afterUser', content: note }], binds);
    assert.deepEqual(first.messages[3]!.content, [text('note v1')], 'setup: the injection goes without its thinking, as a new array');
    // A block of the caller's, changed in place between compiles.
    (said as { text: string }).text = 'note v2';
    assert.equal((await cm.compile(BIG, [{ namespace: 'n', position: 'afterUser', content: note }], binds)).firstChanged, 3);
  });

  it('is not compared with a compile that throws before it returns', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('a')]);
    cm.addMessage('Claude', [text('b')]);
    await cm.compile(BIG);
    cm.addMessage('User', [text('c')]);
    const internals = cm as unknown as { renderedLayoutFor: (...args: unknown[]) => unknown };
    const layout = internals.renderedLayoutFor;
    internals.renderedLayoutFor = () => { internals.renderedLayoutFor = layout; throw new Error('layout failed'); };
    await assert.rejects(cm.compile(BIG), /layout failed/);
    // The same three messages again: the last compile that returned sent two.
    assert.equal((await cm.compile(BIG)).firstChanged, 2);
  });

  it('is compared when read, serializing nothing again on a second read, and read after a later compile still compares with the compile before it', async () => {
    // A strategy sending new arrays each compile, as caps and recall pairs
    // do, whose blocks count each serialization.
    let serialized = 0;
    const counted = (block: ContentBlock): ContentBlock => ({ ...block, toJSON: () => { serialized++; return block; } }) as unknown as ContentBlock;
    const strategy = new (class extends PassthroughStrategy {
      select(...args: Parameters<PassthroughStrategy['select']>): ReturnType<PassthroughStrategy['select']> {
        return super.select(...args).map((entry) => ({ ...entry, content: entry.content.map(counted) }));
      }
    })();
    const cm = await open(strategy);
    cm.addMessage('User', [text('a')]);
    cm.addMessage('Claude', [text('b')]);
    const first = await cm.compile(BIG);
    const second = await cm.compile(BIG);
    const before = serialized;
    assert.equal(second.firstChanged, 2, 'the same bytes in new arrays');
    assert.ok(serialized > before, 'the comparison serialized them when read');
    const once = serialized;
    assert.equal(second.firstChanged, 2);
    assert.equal(serialized, once, 'and not again');
    cm.editMessage(cm.getAllMessages()[1]!.id, [text('b, edited')]);
    const third = await cm.compile(BIG);
    cm.addMessage('User', [text('c')]);
    await cm.compile(BIG);
    assert.equal(first.firstChanged, null);
    assert.equal(third.firstChanged, 1, 'read first after a later compile, the third against the second');
    assert.equal(second.firstChanged, 2, 'still the second compile against the first');
  });

  it('serializes nothing on a read where the compiled arrays are the last compile\'s', async () => {
    let serialized = 0;
    const counted = (block: ContentBlock): ContentBlock => ({ ...block, toJSON: () => { serialized++; return block; } }) as unknown as ContentBlock;
    const sent = new Map<string, ContentBlock[]>();
    const strategy = new (class extends PassthroughStrategy {
      select(...args: Parameters<PassthroughStrategy['select']>): ReturnType<PassthroughStrategy['select']> {
        return super.select(...args).map((entry) => {
          const id = entry.sourceMessageId!;
          if (!sent.has(id)) sent.set(id, entry.content.map(counted));
          return { ...entry, content: sent.get(id)! };
        });
      }
    })();
    const cm = await open(strategy);
    cm.addMessage('User', [text('a')]);
    cm.addMessage('Claude', [text('b')]);
    await cm.compile(BIG);
    const second = await cm.compile(BIG);
    const before = serialized;
    assert.equal(second.firstChanged, 2);
    assert.equal(serialized, before, 'the same arrays are compared by identity');
  });

  it('is carried by a copy and JSON, read on a frozen result, takes an assignment, and leaves out system injections', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('a')]);
    await cm.compile(BIG);
    const copied = await cm.compile(BIG);
    assert.equal({ ...copied }.firstChanged, 1);
    assert.equal(JSON.parse(JSON.stringify(copied)).firstChanged, 1);
    const frozen = Object.freeze(await cm.compile(BIG));
    assert.equal(frozen.firstChanged, 1, 'a frozen result reads it');
    const assigned = await cm.compile(BIG);
    assigned.firstChanged = 7;
    assert.equal(assigned.firstChanged, 7);
    const withSystem = await cm.compile(BIG, [{ namespace: 'n', position: 'system', content: [text('system note')] }]);
    assert.equal(withSystem.firstChanged, withSystem.messages.length, 'a system injection goes in the system prompt, not the messages');
  });

  it('does not count cache markers', async () => {
    const cm = await open(new WindowedPassthroughStrategy());
    cm.addMessage('User', [text('a')]);
    let previous = await cm.compile(BIG);
    let moved = false;
    for (let i = 0; i < 6 && !moved; i++) {
      cm.addMessage(i % 2 ? 'User' : 'Claude', [text(`m${i}`)]);
      const next = await cm.compile(BIG);
      moved = previous.messages.some((m, k) => !!m.cacheBreakpoint !== !!next.messages[k]!.cacheBreakpoint);
      if (moved) assert.equal(next.firstChanged, previous.messages.length, 'a marker moved, and nothing else changed');
      previous = next;
    }
    assert.ok(moved, 'setup: a marker moved on a message both compiles hold');
  });

  it('compares bytes across a fork, a branch switch, a switch made on the store itself, and a new strategy, and is null only at the first compile', async () => {
    const cm = await open(new PassthroughStrategy());
    const a = cm.addMessage('User', [text('a')]);
    assert.equal((await cm.compile(BIG)).firstChanged, null);
    assert.equal((await cm.compile(BIG)).firstChanged, 1);
    const main = cm.currentBranch().name;
    await cm.fork();
    const forked = cm.currentBranch().name;
    assert.equal((await cm.compile(BIG)).firstChanged, 1, 'a fork holds the same messages');
    cm.addMessage('Claude', [text('on the fork')]);
    assert.equal((await cm.compile(BIG)).firstChanged, 1);
    await cm.switchBranch(main);
    assert.equal((await cm.compile(BIG)).firstChanged, 1, "back on main, a prefix of the fork's");
    const alt = cm.branchAt(a, 'alt');
    cm.addMessage('User', [text('b')]);
    assert.equal((await cm.compile(BIG)).firstChanged, 1);
    cm.getStore().switchBranch(alt);
    assert.equal((await cm.compile(BIG)).firstChanged, 1, 'after the host switched the store');
    await cm.setStrategy(new PassthroughStrategy());
    assert.equal((await cm.compile(BIG)).firstChanged, 1, 'a new strategy compiling the same messages');
    // Two branches of the same length and participants, whose second messages differ.
    cm.addMessage('Claude', [text('on alt')]);
    assert.equal((await cm.compile(BIG)).firstChanged, 1);
    await cm.switchBranch(forked);
    assert.equal((await cm.compile(BIG)).firstChanged, 1, 'the fork differs from the second message on');
  });
});
