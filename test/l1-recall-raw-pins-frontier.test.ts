/**
 * #116 review: a raw pin inside a merged summary must open only the branch
 * that contains it. Before the mixed frontier, one pinned message made the
 * canonical L1 prompt replay the whole covering L3 raw (reviewer's repro: 187
 * old messages raw vs 9 in the live view), on every L1 while the pin existed.
 *
 * The chunk a pin opens renders raw at its own position, before the head
 * window too, in source order with the recall pairs; nothing else loses
 * coverage; the raw pins add is spent from the recall budget, and a
 * compression whose pinned raw can't fit it recalls what the pins override,
 * and says so. A pin resolves once, for compression and every selector.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeFormatter } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { RECALL_RESUME_TEXT } from '../src/strategies/autobiographical.js';
import { transformZeroRecallCompression } from '../src/surgery/zero-recall-compression.js';
import type { ProtectedRange } from '../src/types/strategy.js';

const dir = mkdtempSync(join(tmpdir(), 'l1-recall-pins-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const MARKER = 'You will soon form a new memory';

const KV_UNIFIED = {
  policy: {
    alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
    cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25,
    continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10, continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
} as never;

interface Summary { id: string; level: number; content: string; sourceIds: string[]; mergedInto?: string }
type Internals = {
  summaries: Summary[];
  config: Record<string, unknown>;
  estimateTokens(content: unknown[]): number;
  summaryAnswerContent(summary: Summary): unknown[];
  resetHeadWindow(id: string | null): void;
  getHeadWindowStartIndex(store: unknown): number;
  getHeadWindowEnd(store: unknown): number;
};

async function forest(
  name: string,
  overrides: Record<string, unknown> = {},
  afterAdd?: (cm: ContextManager, ids: string[]) => void,
  content: (i: number, text: string) => unknown[] = (_i, text) => [{ type: 'text', text }],
  participant: (i: number) => string = (i) => (i % 2 ? 'Claude' : 'User'),
  respond: (call: number) => unknown[] = (call) => [{ type: 'text', text: `Summary #${call}: ordinary events.` }],
) {
  const requests: any[] = [];
  let calls = 0;
  // How the summarizer answers the next calls, in order; a memory once it's empty.
  const script: Array<'refusal' | 'tool_use' | 'thinking-wrapped'> = [];
  const membrane = { complete: async (req: unknown) => { requests.push(JSON.parse(JSON.stringify(req))); calls++;
    const scripted = script.shift();
    if (scripted === 'refusal') {
      return { stopReason: 'refusal', content: [], usage: { inputTokens: 500, outputTokens: 0 },
        raw: { response: { stop_details: { category: 'reasoning_extraction' } } } };
    }
    if (scripted === 'tool_use') return { stopReason: 'tool_use', content: [], usage: { inputTokens: 500, outputTokens: 10 } };
    const content = scripted === 'thinking-wrapped' ? [{ type: 'text', text: '<thinking>a draft</thinking>' }] : respond(calls);
    return { stopReason: 'end_turn', content, usage: { inputTokens: 500, outputTokens: 100 } }; } };
  const strategy = new AutobiographicalStrategy({ compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, summaryParticipant: 'Claude', hierarchical: true, mergeThreshold: 6, adaptiveResolution: true,
    ...overrides });
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane: membrane as never });
  const ids: string[] = [];
  const textOf = new Map<string, string>();
  for (let i = 0; i < 240; i++) {
    const text = `OLD-${i} ${'word '.repeat(30)}`;
    const id = cm.addMessage(participant(i), content(i, text) as never);
    ids.push(id);
    textOf.set(id, text);
    afterAdd?.(cm, ids);
  }
  for (let r = 0; r < 200; r++) { await cm.compile(); await cm.tick(); if (calls > 150) break; }
  const internals = strategy as unknown as Internals;
  return { cm, strategy, internals, ids, textOf, requests, script };
}

const isL1Request = (request: any): boolean => textsOf(request).some((text) => text.includes(MARKER));

function textsOf(request: any): string[] {
  return request.messages.flatMap((m: any) => m.content).filter((b: any) => typeof b.text === 'string').map((b: any) => b.text);
}

/** Add a fresh stretch of messages, compile and tick once, and return the
 *  first L1 compression request that tick sent, if any. */
async function nextL1(cm: ContextManager, requests: any[]): Promise<any | undefined> {
  requests.length = 0;
  for (let i = 0; i < 20; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `NEW-${i} ${'word '.repeat(30)}` }]);
  await cm.compile(); await cm.tick();
  return requests.find((request) => textsOf(request).some((text) => text.includes(MARKER)));
}

function l1Holding(internals: Internals, id: string): Summary {
  const l1 = internals.summaries.find((s) => s.level === 1 && s.sourceIds.includes(id));
  assert.ok(l1, `setup: an L1 covers ${id}`);
  return l1!;
}

/** A real head window from message 200 on (the forest's own head is empty),
 *  so the messages named lie before it. */
function headFrom200(cm: ContextManager, internals: Internals, ids: string[], before: number[]): void {
  internals.config.headWindowTokens = 400;
  internals.resetHeadWindow(ids[200]);
  const view = (cm as unknown as { strategyMessageView(): unknown }).strategyMessageView();
  const headStart = internals.getHeadWindowStartIndex(view);
  const headEnd = internals.getHeadWindowEnd(view);
  assert.ok(headStart === 200 && headEnd > headStart, `setup: a head window [${headStart}, ${headEnd})`);
  for (const at of before) assert.ok(at < headStart, `setup: message ${at} lies before the head window`);
}

/** Every recall pair sits on the side of the raw turn its source order puts it. */
function assertSourceOrder(texts: string[], rawText: string, rawPosition: number, internals: Internals, ids: string[]): { before: number; after: number } {
  const rawAt = texts.indexOf(rawText);
  assert.ok(rawAt >= 0, 'the raw turn is in the prompt');
  const position = new Map(ids.map((id, i) => [id, i]));
  let before = 0, after = 0;
  texts.forEach((t, at) => {
    const match = /^\[CM\] Recall memory (.+)\.$/.exec(t);
    if (!match) return;
    const summary = internals.summaries.find((s) => s.id === match[1]) as (Summary & { sourceRange: { first: string } }) | undefined;
    const first = summary ? position.get(summary.sourceRange.first) : undefined;
    if (first === undefined) return;
    if (first < rawPosition) { before++; assert.ok(at < rawAt, `memory from message ${first} comes before the raw turn`); }
    else { after++; assert.ok(at > rawAt, `memory from message ${first} comes after the raw turn`); }
  });
  return { before, after };
}

/** The unmerged summary whose leaves hold a message. */
function rootHolding(internals: Internals, id: string): Summary {
  let node: Summary | undefined = l1Holding(internals, id);
  while (node?.mergedInto) node = internals.summaries.find((s) => s.id === node!.mergedInto);
  assert.ok(node, `setup: a root summary holds ${id}`);
  return node!;
}

async function captureWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

describe('raw pins open only their own branch of the L1 recall frontier', () => {
  it('one pinned message deep in a merged summary adds at most its chunk raw', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('one-pin');
    const levels: Record<number, number> = {};
    for (const s of internals.summaries) if (!s.mergedInto) levels[s.level] = (levels[s.level] ?? 0) + 1;
    assert.ok((levels[2] ?? 0) + (levels[3] ?? 0) > 0, `need an L2+ frontier, got ${JSON.stringify(levels)}`);

    const count = (request: any) => {
      const texts = textsOf(request);
      return { oldRaw: texts.filter((t) => t.startsWith('OLD-')).length, recall: texts.filter((t) => t.startsWith('[CM] Recall memory')).length };
    };
    const baseline = count(await nextL1(cm, requests));
    cm.pinRange(ids[5], ids[5], { name: 'one-message' });
    const pinnedRequest = await nextL1(cm, requests);
    const pinned = count(pinnedRequest);
    assert.ok(textsOf(pinnedRequest).includes(textOf.get(ids[5])!), 'the pinned message itself is among the raw');

    // The pinned message's L1 chunk (a handful of messages) opens; nothing else.
    assert.ok(pinned.oldRaw - baseline.oldRaw <= 12, `raw grew by ${pinned.oldRaw - baseline.oldRaw} (was 180+ before the fix)`);
    assert.ok(pinned.oldRaw > baseline.oldRaw, 'the pinned chunk itself is shown raw');
    assert.ok(pinned.recall >= baseline.recall, 'sibling branches stay summarized as recall pairs');
    cm.close();
  });

  it('an opened chunk before the head window renders raw instead of vanishing', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('before-head');
    const opened = l1Holding(internals, ids[5]);
    headFrom200(cm, internals, ids, opened.sourceIds.map((id) => ids.indexOf(id)));
    cm.pinRange(ids[5], ids[5], { name: 'before-head' });
    const request = await nextL1(cm, requests);
    assert.ok(request, 'the L1 request was sent');
    const texts = textsOf(request);
    for (const id of opened.sourceIds) assert.equal(texts.filter((t) => t === textOf.get(id)).length, 1, `opened chunk message ${id} is in the prompt once`);
    assert.ok(!texts.includes(`[CM] Recall memory ${opened.id}.`), 'the opened L1 is not recalled');
    const { after } = assertSourceOrder(texts, textOf.get(ids[5])!, 5, internals, ids);
    assert.ok(after > 0, 'setup: later memories follow it');
    cm.close();
  });

  it('a pinned message no summary covers, before the head window, renders raw', async () => {
    // Pinned as soon as it's added, before the chunk holding it closes, so
    // no chunk takes it; then left behind the head window by a reset.
    const { cm, internals, ids, textOf, requests } = await forest('pinned-before-head', {}, (manager, messageIds) => {
      if (messageIds.length === 4) manager.pinRange(messageIds[3], messageIds[3], { name: 'never-chunked' });
    });
    assert.ok(!internals.summaries.some((s) => s.sourceIds.includes(ids[3])), 'setup: no summary covers it');
    headFrom200(cm, internals, ids, [3]);
    const request = await nextL1(cm, requests);
    assert.ok(request, 'the L1 request was sent');
    assert.equal(textsOf(request).filter((t) => t === textOf.get(ids[3])).length, 1, 'the pinned message is raw in the prompt, once');
    cm.close();
  });

  it('a pinned message no summary covers, between the head window and the chunk, renders raw once', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('pinned-after-head', {}, (manager, messageIds) => {
      if (messageIds.length === 101) manager.pinRange(messageIds[100], messageIds[100], { name: 'never-chunked' });
    });
    assert.ok(!internals.summaries.some((s) => s.sourceIds.includes(ids[100])), 'setup: no summary covers it');
    internals.config.headWindowTokens = 400;
    const view = (cm as unknown as { strategyMessageView(): unknown }).strategyMessageView();
    const headEnd = internals.getHeadWindowEnd(view);
    assert.ok(headEnd > 0 && headEnd < 100, `setup: the head window [0, ${headEnd}) ends before it`);
    const request = await nextL1(cm, requests);
    assert.ok(request, 'the L1 request was sent');
    assert.equal(textsOf(request).filter((t) => t === textOf.get(ids[100])).length, 1, 'the pinned message is raw in the prompt, once');
    cm.close();
  });

  it('a pin after the chunk being compressed opens nothing, and its summary, which comes after the chunk, is not recalled (#317)', async () => {
    // A message the chunker skipped while it was pinned raw, then unpinned, is
    // compressed out of order, after the history that follows it.
    let skippedPin = '';
    const { cm, internals, ids, textOf, requests } = await forest('after-chunk', {}, (manager, messageIds) => {
      if (messageIds.length === 31) skippedPin = manager.pinRange(messageIds[30], messageIds[30], { name: 'skipped' });
    });
    assert.ok(!internals.summaries.some((s) => s.sourceIds.includes(ids[30])), 'setup: the chunker skipped it');
    cm.unpin(skippedPin);
    cm.pinRange(ids[100], ids[100], { name: 'after-the-chunk' });
    const root = rootHolding(internals, ids[100]);
    requests.length = 0;
    for (let i = 0; i < 20; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `NEW-${i} ${'word '.repeat(30)}` }]);
    const compressing = (r: any): boolean => {
      const texts = textsOf(r);
      const marker = texts.findIndex((t) => t.includes(MARKER));
      return marker >= 0 && texts.indexOf(textOf.get(ids[30])!) > marker;
    };
    for (let round = 0; round < 10 && !requests.some(compressing); round++) { await cm.compile(); await cm.tick(); }
    const request = requests.find(compressing);
    assert.ok(request, 'setup: the skipped message was compressed');
    const texts = textsOf(request);
    const rootFirst = ids.indexOf((root as unknown as { sourceRange: { first: string } }).sourceRange.first);
    assert.ok(rootFirst > 30, `setup: the summary holding the later pin starts after the chunk (at ${rootFirst})`);
    assert.ok(!texts.includes(`[CM] Recall memory ${root.id}.`), 'the summary holding the later pin, after the chunk, is not recalled: the request holds only what came before');
    assert.ok(!texts.includes(textOf.get(ids[100])!), 'the later pin adds no raw');
    cm.close();
  });

  it('an opened chunk sits in source order among the recall pairs', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('order');
    const opened = l1Holding(internals, ids[5]);
    cm.pinRange(ids[5], ids[5], { name: 'oldest' });
    const texts = textsOf(await nextL1(cm, requests));
    const firstRaw = texts.indexOf(textOf.get(opened.sourceIds[0])!);
    const firstRecall = texts.findIndex((t) => t.startsWith('[CM] Recall memory'));
    assert.ok(firstRaw >= 0 && firstRecall >= 0, 'setup: the prompt has both');
    assert.ok(firstRaw < firstRecall, `the oldest chunk's raw turns (at ${firstRaw}) precede every later memory (first at ${firstRecall})`);
    cm.close();
  });

  it('an opened chunk between memories sits between them', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('order-middle');
    cm.pinRange(ids[120], ids[120], { name: 'middle' });
    const texts = textsOf(await nextL1(cm, requests));
    const rawAt = texts.indexOf(textOf.get(ids[120])!);
    assert.ok(rawAt >= 0, 'the pinned message is raw');
    const position = new Map(ids.map((id, i) => [id, i]));
    let before = 0, after = 0;
    texts.forEach((t, at) => {
      const match = /^\[CM\] Recall memory (.+)\.$/.exec(t);
      if (!match) return;
      const summary = internals.summaries.find((s) => s.id === match[1]) as (Summary & { sourceRange: { first: string } }) | undefined;
      const first = summary ? position.get(summary.sourceRange.first) : undefined;
      if (first === undefined) return;
      if (first < 120) { before++; assert.ok(at < rawAt, `memory from message ${first} comes before the pinned turn`); }
      else { after++; assert.ok(at > rawAt, `memory from message ${first} comes after the pinned turn`); }
    });
    assert.ok(before > 0 && after > 0, `setup: memories on both sides (${before} before, ${after} after)`);
    cm.close();
  });

  it('a persisted cycle in sourceIds does not recurse without end', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('cycle');
    const leavesOf = (s: Summary, seen = new Set<string>()): Set<string> => {
      const out = new Set<string>();
      if (seen.has(s.id)) return out;
      seen.add(s.id);
      if (s.level === 1) { for (const id of s.sourceIds) out.add(id); return out; }
      for (const childId of s.sourceIds) {
        const child = internals.summaries.find((c) => c.id === childId);
        if (child) for (const id of leavesOf(child, seen)) out.add(id);
      }
      return out;
    };
    const parent = internals.summaries.find((s) => s.level >= 2 && leavesOf(s).has(ids[5]));
    assert.ok(parent, 'setup: an L2+ summary covers the pinned message');
    parent!.sourceIds.push(parent!.id);
    cm.pinRange(ids[5], ids[5], { name: 'under-a-cycle' });
    const request = await nextL1(cm, requests);
    assert.ok(request, 'the L1 request was built and sent');
    assert.ok(textsOf(request).includes(textOf.get(ids[5])!), 'the pinned message is raw in it');
    cm.close();
  });

  it('a merged L1 its parent does not list stays covered, as before', async () => {
    const { cm, internals, textOf, requests } = await forest('bad-linkage');
    const parent = internals.summaries.find((s) => s.level === 2 && s.sourceIds.length >= 2);
    assert.ok(parent, 'setup: an L2 with two children');
    const orphanId = parent!.sourceIds.shift()!;
    const orphan = internals.summaries.find((s) => s.id === orphanId)!;
    assert.equal(orphan.mergedInto, parent!.id, 'setup: the child still names its parent');
    const texts = textsOf(await nextL1(cm, requests));
    for (const id of orphan.sourceIds) assert.ok(!texts.includes(textOf.get(id)!), `unreachable merged L1's message ${id} is not replayed raw`);
    let root: Summary | undefined = parent;
    while (root?.mergedInto) root = internals.summaries.find((s) => s.id === root!.mergedInto);
    assert.ok(root && texts.includes(`[CM] Recall memory ${root.id}.`), 'its parent\'s branch is still recalled');
    cm.close();
  });
});

/** The summary id a recall header names, or undefined for any other message. */
function headerId(message: any): string | undefined {
  if (message?.participant !== 'Context Manager' || message.content.length !== 1) return undefined;
  return /^\[CM\] Recall memory (.+)\.$/.exec(message.content[0]?.text ?? '')?.[1];
}

describe('a recall answer stays apart from the agent\'s own turn after it', () => {
  // The agent speaks on even turns here, so the L1 holding message 212
  // opens on the agent's turn, after the summary that ends at 211.
  const agentOnEven = (i: number) => (i % 2 ? 'User' : 'Claude');

  async function agentFirstChunk(name: string) {
    const built = await forest(name, {}, undefined, undefined, agentOnEven);
    assert.equal(l1Holding(built.internals, built.ids[212]).sourceIds[0], built.ids[212], 'setup: message 212 opens its L1');
    built.cm.pinRange(built.ids[212], built.ids[212], { name: 'agent-first' });
    return built;
  }

  /** The recall pair nearest before a raw turn. */
  function pairBefore(request: any, rawText: string): { raw: number; header: number; id: string } {
    const raw = request.messages.findIndex((m: any) => m.content.some((b: any) => b.text === rawText));
    assert.ok(raw > 0, 'setup: the raw turn is in the prompt');
    let header = raw - 1;
    while (header >= 0 && headerId(request.messages[header]) === undefined) header--;
    assert.ok(header >= 0, 'setup: a recall pair comes before it');
    return { raw, header, id: headerId(request.messages[header])! };
  }

  it('an opened chunk that starts on the agent\'s turn keeps that turn out of the recall answer before it', async () => {
    const { cm, internals, ids, textOf, requests } = await agentFirstChunk('agent-first');
    const request = await nextL1(cm, requests);
    assert.ok(request, 'the L1 request was sent');
    const rawText = textOf.get(ids[212])!;
    const { raw, header, id } = pairBefore(request, rawText);
    const before = internals.summaries.find((s) => s.id === id)!;
    const shape = (m: any) => ({ participant: m.participant, content: m.content });
    assert.deepEqual(request.messages[header + 1].content, internals.summaryAnswerContent(before), 'the recall answer is the memory alone');
    assert.deepEqual(shape(request.messages[header + 2]), { participant: 'Context Manager', content: [{ type: 'text', text: RECALL_RESUME_TEXT }] },
      'the Context Manager takes a turn between them');
    assert.equal(raw, header + 3, 'the raw turn comes right after it');
    assert.deepEqual(shape(request.messages[raw]), { participant: 'Claude', content: [{ type: 'text', text: rawText }] }, 'the raw turn is a message of its own');
    assert.equal(request.messages.filter((m: any) => m.content[0]?.text === RECALL_RESUME_TEXT).length, 1, 'no other boundary gets that turn');
    // The formatter merges consecutive messages of one role at the wire, so
    // without that turn the memory and the raw turn reach the summarizer as
    // one turn.
    const wire = new NativeFormatter().buildMessages(request.messages, { participantMode: 'multiuser', assistantParticipant: 'Claude' } as never)
      .messages as Array<{ role: string; content: unknown }>;
    const memoryTurn = wire.find((m) => m.role === 'assistant' && JSON.stringify(m.content).includes(before.content));
    assert.ok(memoryTurn, 'setup: the memory reaches the wire');
    assert.ok(!JSON.stringify(memoryTurn!.content).includes('OLD-212 '), 'at the wire the raw turn is not part of the memory\'s turn');
    cm.close();
  });

  /** The user's turn 212 carries `between`, which the request drops, so the
   *  agent's turn 213 would follow the recall answer before it. */
  async function separatedPast(name: string, between: unknown[]) {
    const content = (i: number, text: string) => (i === 212 ? between : [{ type: 'text', text }]);
    const { cm, internals, ids, textOf, requests } = await forest(name, {}, undefined, content);
    assert.equal(l1Holding(internals, ids[213]).sourceIds[0], ids[212], 'setup: message 212 opens the L1 holding 213');
    cm.pinRange(ids[213], ids[213], { name: 'after-212' });
    const request = await nextL1(cm, requests);
    assert.ok(request, 'the L1 request was sent');
    const { raw, header, id } = pairBefore(request, textOf.get(ids[213])!);
    const before = internals.summaries.find((s) => s.id === id)!;
    assert.deepEqual(request.messages[header + 1].content, internals.summaryAnswerContent(before), 'the recall answer is the memory alone');
    assert.equal(request.messages[header + 2].content[0]?.text, RECALL_RESUME_TEXT, 'the Context Manager takes a turn between them');
    assert.equal(raw, header + 3, 'the agent\'s raw turn comes right after it');
    const wire = new NativeFormatter().buildMessages(request.messages, { participantMode: 'multiuser', assistantParticipant: 'Claude' } as never)
      .messages as Array<{ role: string; content: unknown }>;
    const memoryTurn = wire.find((m) => m.role === 'assistant' && JSON.stringify(m.content).includes(before.content));
    assert.ok(memoryTurn, 'setup: the memory reaches the wire');
    assert.ok(!JSON.stringify(memoryTurn!.content).includes('OLD-213 '), 'at the wire the raw turn is not part of the memory\'s turn');
    cm.close();
  }

  it('and so does one that a message with no content comes between, which the request drops', async () => {
    await separatedPast('blank-between', [{ type: 'text', text: '   ' }]);
  });

  it('and so does one that a tool result whose call no message carries comes between with blank text, which the request strips and drops', async () => {
    await separatedPast('unpaired-between', [{ type: 'tool_result', toolUseId: 'toolu_nowhere', content: 'a result' }, { type: 'text', text: '  ' }]);
  });

  it('and an agent turn that is thinking alone, which the prompt strips, doesn\'t join the answer before it either', async () => {
    // The agent's turn 212 is a thinking block alone, which the prompt strips
    // from raw turns, and the user's turn 213 follows it. Without the
    // Context Manager's turn the collapse would join the emptied turn, and its
    // separator, to the recall answer.
    const thinkingOnly = (i: number, text: string) =>
      i === 212 ? [{ type: 'thinking', thinking: 'thought alone', signature: 'sig' }] : [{ type: 'text', text }];
    const { cm, internals, ids, textOf, requests } = await forest('thinking-alone', {}, undefined, thinkingOnly, agentOnEven);
    assert.equal(l1Holding(internals, ids[213]).sourceIds[0], ids[212], 'setup: message 212 opens the L1 holding 213');
    cm.pinRange(ids[213], ids[213], { name: 'after-thinking' });
    const request = await nextL1(cm, requests);
    assert.ok(request, 'the L1 request was sent');
    const { header, id } = pairBefore(request, textOf.get(ids[213])!);
    const before = internals.summaries.find((s) => s.id === id)!;
    assert.deepEqual(request.messages[header + 1].content, internals.summaryAnswerContent(before), 'the recall answer is the memory alone');
    cm.close();
  });

  it('and the zero-recall surgery, taking the recall pairs out, keeps that turn and the Context Manager\'s turn before it', async () => {
    const { cm, ids, textOf, requests } = await agentFirstChunk('agent-first-surgery');
    const request = await nextL1(cm, requests);
    assert.ok(request, 'the L1 request was sent');
    const { messages, removedRecallIds } = transformZeroRecallCompression(request.messages);
    assert.ok(removedRecallIds.length > 0, 'setup: the request recalls memories');
    assert.ok(!messages.some((m) => headerId(m) !== undefined), 'every recall pair is taken out');
    const raw = messages.findIndex((m) => m.content.some((b: any) => b.text === textOf.get(ids[212])));
    assert.ok(raw > 0, 'the agent\'s raw turn stays');
    assert.equal((messages[raw - 1]!.content[0] as { text?: string }).text, RECALL_RESUME_TEXT, 'with the Context Manager\'s turn before it');
    cm.close();
  });

  it('so the summary before it keeps its refusal-fallback variant', async () => {
    const { cm, internals, ids, textOf, requests, script } = await agentFirstChunk('agent-first-variant');
    script.push('refusal');
    const canonical = await nextL1(cm, requests);
    assert.ok(canonical, 'the L1 request was sent');
    const before = internals.summaries.find((s) => s.id === pairBefore(canonical, textOf.get(ids[212])!).id)!;
    assert.ok(before.level >= 2, `setup: the summary before it is an L${before.level}, which a variant can expand`);
    const variant = requests.filter(isL1Request)[1];
    assert.ok(variant, 'a variant followed the refusal');
    const texts = textsOf(variant);
    assert.ok(!texts.includes(`[CM] Recall memory ${before.id}.`), `the first variant expands ${before.id}, the newest summary it can`);
    for (const child of before.sourceIds) assert.ok(texts.includes(`[CM] Recall memory ${child}.`), `its child ${child} is recalled in its place`);
    cm.close();
  });

  it('in a merge prompt, an L2 target that starts on the agent\'s turn stays out of the last ladder answer', async () => {
    const { cm, requests } = await forest('agent-first-merge', {}, undefined, undefined, agentOnEven);
    const merges = requests.filter((request) => !isL1Request(request));
    let separated = 0;
    for (const merge of merges) {
      merge.messages.forEach((m: any, i: number) => {
        const id = headerId(m);
        if (id === undefined) return;
        const answer = merge.messages[i + 1];
        assert.ok(!answer.content.some((b: any) => typeof b.text === 'string' && b.text.startsWith('OLD-')), `no raw turn joins ${id}'s answer`);
        if (merge.messages[i + 2]?.content[0]?.text !== RECALL_RESUME_TEXT) return;
        separated++;
        assert.equal(merge.messages[i + 3]?.participant, 'Claude', 'the agent\'s raw turn follows the Context Manager\'s');
      });
    }
    assert.ok(separated > 0, `setup: an L2 target opened on the agent's turn after a ladder answer (${merges.length} merges)`);
    cm.close();
  });

  it('a recall answer before another speaker\'s turn, or two raw turns of one speaker, get no resume turn (control)', async () => {
    // The agent speaks on odd turns, and on turn 40 too, so each L2 merge
    // target opens on the user's turn and turns 39 to 41 are all the agent's.
    const { cm, ids, textOf, requests } = await forest('user-first', {}, undefined, undefined, (i) => (i % 2 || i === 40 ? 'Claude' : 'User'));
    let userAfterAnswer = 0;
    for (const request of requests) {
      request.messages.forEach((m: any, i: number) => {
        if (headerId(m) !== undefined && request.messages[i + 2]?.participant === 'User') userAfterAnswer++;
      });
      assert.ok(!request.messages.some((m: any) => m.content[0]?.text === RECALL_RESUME_TEXT), 'no request carries a resume turn');
    }
    assert.ok(userAfterAnswer > 0, 'setup: a recall answer comes right before a user turn');
    const sameSpeaker = requests.some((request) => request.messages.some((m: any) =>
      m.content.some((b: any) => b.text === textOf.get(ids[39])) && m.content.some((b: any) => b.text === textOf.get(ids[40]))));
    assert.ok(sameSpeaker, 'setup: the agent\'s turns 39 and 40 reach a prompt, one message as before');
    cm.close();
  });
});

describe('a pin holds whatever the linkage, and empty summaries keep their old coverage', () => {
  it('a pinned message in an L1 its parent does not list opens that L1', async () => {
    const { cm, internals, textOf, requests } = await forest('bad-linkage-pinned');
    const parent = internals.summaries.find((s) => s.level === 2 && s.sourceIds.length >= 2);
    assert.ok(parent, 'setup: an L2 with two children');
    const orphan = internals.summaries.find((s) => s.id === parent!.sourceIds.shift())!;
    cm.pinRange(orphan.sourceIds[0], orphan.sourceIds[0], { name: 'orphan' });
    const texts = textsOf(await nextL1(cm, requests));
    for (const id of orphan.sourceIds) assert.ok(texts.includes(textOf.get(id)!), `the orphan's message ${id} is raw`);
    cm.close();
  });

  it('an empty frontier summary is descended to its children; an empty L1 that holds no pin stays covered', async () => {
    const { cm, internals, textOf, requests } = await forest('empty');
    const root = internals.summaries.find((s) => !s.mergedInto && s.level >= 2);
    const l1 = internals.summaries.find((s) => !s.mergedInto && s.level === 1);
    assert.ok(root && l1, 'setup: an unmerged L2+ and an unmerged L1');
    root!.content = '';
    l1!.content = '';
    const texts = textsOf(await nextL1(cm, requests));
    assert.ok(!texts.includes(`[CM] Recall memory ${root!.id}.`) && !texts.includes(`[CM] Recall memory ${l1!.id}.`), 'neither empty summary is recalled');
    for (const childId of root!.sourceIds) {
      const child = internals.summaries.find((s) => s.id === childId);
      if (child?.content.trim()) assert.ok(texts.includes(`[CM] Recall memory ${childId}.`), `the empty summary's child ${childId} is recalled`);
    }
    for (const id of l1!.sourceIds) assert.ok(!texts.includes(textOf.get(id)!), `the empty L1's message ${id} isn't replayed raw`);
    cm.close();
  });
});

describe('raw pins are priced as the request sends them, serialized media replaced', () => {
  // A tool round whose result carries a serialized data URL, as a tool's JSON
  // output does: message 4 calls the tool, message 5 holds its result. A text
  // block that long would be sharded on ingress; a tool result isn't.
  const withDataUrl = (n: number, prose = '') => (i: number, text: string) =>
    i === 4 ? [{ type: 'text', text }, { type: 'tool_use', id: 'media-5', name: 'fetch', input: {} }]
    : i === 5 ? [{ type: 'tool_result', toolUseId: 'media-5', content: `${text} ${prose}data:image/png;base64,${'A'.repeat(n)}` }]
    : [{ type: 'text', text }];
  const toolRound = (i: number) => (i === 4 ? 'Claude' : i === 5 ? 'User' : i % 2 ? 'Claude' : 'User');
  // History with tool blocks waits for the host's tool definitions.
  const withTools = (cm: ContextManager, ids: string[]) => {
    if (ids.length === 1) cm.setToolDefinitions([{ name: 'fetch', description: 'fetch a url', inputSchema: { type: 'object' as const } }]);
  };
  const markerFor = (n: number) => `[embedded image/png data URL omitted from compression prompt: ${n} serialized payload characters]`;
  /** The store's price of the payload alone, as a tool result's content. */
  const payloadPrice = (cm: ContextManager, n: number): number =>
    (cm as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore
      .estimateTokens({ content: [{ type: 'tool_result', toolUseId: 'x', content: 'A'.repeat(n) }] });

  it('a pinned tool result carrying a data URL is spent from the recall budget as its marker', async () => {
    const { cm, internals, ids, requests } = await forest('media-recall-budget', {}, withTools, withDataUrl(20_000), toolRound);
    // Half the payload's price: room for the pinned chunk as it is sent, and
    // not for its payload.
    internals.config.compressionRecallBudgetTokens = Math.floor(payloadPrice(cm, 20_000) / 2);
    cm.pinRange(ids[5], ids[5], { name: 'media' });
    const { result: request, warnings } = await captureWarnings(() => nextL1(cm, requests));
    assert.ok(request, 'the compression ran');
    assert.ok(!warnings.some((w) => w.includes('recalls the summaries its pins override')), `the pin is honored: ${JSON.stringify(warnings)}`);
    const sent = JSON.stringify(request);
    assert.ok(sent.includes(markerFor(20_000)) && !sent.includes('A'.repeat(4096)), 'the pinned result is raw, its payload replaced');
    cm.close();
  });

  it('the same pin is spent from the recall budget: with no room for it, the summaries it overrides are recalled', async () => {
    const { cm, internals, ids, requests } = await forest('media-recall-none', {}, withTools, withDataUrl(20_000), toolRound);
    internals.config.compressionRecallBudgetTokens = 1;
    cm.pinRange(ids[5], ids[5], { name: 'media' });
    const { warnings } = await captureWarnings(() => nextL1(cm, requests));
    assert.ok(warnings.some((w) => w.includes('recalls the summaries its pins override')), `the pin costs something: ${JSON.stringify(warnings)}`);
    cm.close();
  });

  it('a request whose pinned raw carries a data URL is priced against compressionContextBudgetTokens as sent', async () => {
    const { cm, internals, ids, requests } = await forest('media-context-budget', {}, withTools, withDataUrl(150_000), toolRound);
    // The recall budget has room for the payload itself, and the limit is
    // under any request, so the warning gives the request's price as the gate
    // reckons it.
    internals.config.compressionRecallBudgetTokens = 10_000_000;
    internals.config.compressionContextBudgetTokens = 1;
    cm.pinRange(ids[5], ids[5], { name: 'media' });
    const { warnings } = await captureWarnings(() => nextL1(cm, requests));
    const priced = warnings.map((w) => /would bring the request to ~(\d+) tokens/.exec(w)?.[1]).find((n) => n !== undefined);
    assert.ok(priced !== undefined, `the gate priced the request with its pin: ${JSON.stringify(warnings)}`);
    const payload = payloadPrice(cm, 150_000);
    assert.ok(Number(priced) < payload, `the request is priced without the payload it never sends: ${JSON.stringify({ priced, payload })}`);
    cm.close();
  });

  it('the gate counts the pinned content it sends: more prose beside the payload raises its price by that prose', async () => {
    const pricedWith = async (name: string, prose: string): Promise<number> => {
      const { cm, internals, ids, requests } = await forest(name, {}, withTools, withDataUrl(150_000, prose), toolRound);
      internals.config.compressionRecallBudgetTokens = 10_000_000;
      internals.config.compressionContextBudgetTokens = 1;
      cm.pinRange(ids[5], ids[5], { name: 'media' });
      const { warnings } = await captureWarnings(() => nextL1(cm, requests));
      const priced = warnings.map((w) => /would bring the request to ~(\d+) tokens/.exec(w)?.[1]).find((n) => n !== undefined);
      assert.ok(priced !== undefined, `the gate priced the request with its pin: ${JSON.stringify(warnings)}`);
      cm.close();
      return Number(priced);
    };
    const prose = 'note '.repeat(4000);
    const without = await pricedWith('media-prose-without', '');
    const withProse = await pricedWith('media-prose-with', prose);
    const { cm } = await forest('media-prose-price', {}, withTools, withDataUrl(10), toolRound);
    const prosePrice = (cm as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore
      .estimateTokens({ content: [{ type: 'text', text: prose }] });
    cm.close();
    assert.ok(withProse - without >= prosePrice * 0.9, `the pinned prose is priced: ${JSON.stringify({ without, withProse, prosePrice })}`);
  });
});

describe("the pins gate prices thinking as the request sends it", () => {
  const STORE = (cm: ContextManager) => (cm as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore;
  const signed = (chars: number) => ({ type: 'thinking', thinking: 'weighed it', signature: 'S'.repeat(chars) });

  it("a pinned message's own signed thinking isn't sent, so it isn't spent from the recall budget", async () => {
    // Message 5 carries a signature far past the budget; the request strips
    // raw thinking as it inserts the message.
    const withThinking = (i: number, text: string) => i === 5 ? [signed(80_000), { type: 'text', text }] : [{ type: 'text', text }];
    const { cm, internals, ids, textOf, requests } = await forest('pin-own-thinking', {}, undefined, withThinking);
    const opened = l1Holding(internals, ids[5]);
    const pinnedTokens = opened.sourceIds.reduce((sum, id) => sum + internals.estimateTokens([{ type: 'text', text: textOf.get(id)! }]), 0);
    assert.ok(STORE(cm).estimateTokens({ content: [signed(80_000)] }) > pinnedTokens + 100, 'setup: the signature alone is past the budget');
    internals.config.compressionRecallBudgetTokens = pinnedTokens + 10;
    cm.pinRange(ids[5], ids[5], { name: 'thinking' });
    const { result: request, warnings } = await captureWarnings(() => nextL1(cm, requests));
    assert.ok(request, 'the compression ran');
    assert.ok(!warnings.some((w) => w.includes('recalls the summaries its pins override')), `the pin is honored: ${JSON.stringify(warnings)}`);
    assert.ok(!JSON.stringify(request).includes('S'.repeat(1000)), 'the raw message is sent without its thinking');
    cm.close();
  });

  it("a recall answer's signed reasoning is sent, and the gate prices it in full", async () => {
    // Every summary carries signed reasoning, which a recall answer replays.
    const pricedWith = async (name: string, chars: number) => {
      const respond = (call: number) => [signed(chars), { type: 'text', text: `Summary #${call}: ordinary events.` }];
      const { cm, internals, ids, requests } = await forest(name, {}, undefined, undefined, undefined, respond);
      internals.config.compressionRecallBudgetTokens = 10_000_000;
      internals.config.compressionContextBudgetTokens = 1;
      cm.pinRange(ids[5], ids[5], { name: 'pin' });
      const { warnings } = await captureWarnings(() => nextL1(cm, requests));
      const priced = warnings.map((w) => /would bring the request to ~(\d+) tokens/.exec(w)?.[1]).find((n) => n !== undefined);
      assert.ok(priced !== undefined, `the gate priced the request with its pin: ${JSON.stringify(warnings)}`);
      const delta = STORE(cm).estimateTokens({ content: [signed(chars)] }) - STORE(cm).estimateTokens({ content: [signed(100)] });
      cm.close();
      return { priced: Number(priced), delta };
    };
    const short = await pricedWith('carrier-short', 100);
    const long = await pricedWith('carrier-long', 20_100);
    assert.ok(long.delta > 1000, 'setup: the longer signature costs more');
    assert.ok(long.priced - short.priced >= long.delta, `at least one recall answer's signature is priced: ${JSON.stringify({ short, long })}`);
  });
});

describe('the raw pins add is spent from the recall budget', () => {
  it('pinned raw comes first, and recall pairs get what is left', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('budget-fits');
    const opened = l1Holding(internals, ids[5]);
    const pinnedTokens = opened.sourceIds.reduce((sum, id) => sum + internals.estimateTokens([{ type: 'text', text: textOf.get(id)! }]), 0);
    // Room for the pinned chunk, and less than any recall pair costs.
    internals.config.compressionRecallBudgetTokens = pinnedTokens + 10;
    cm.pinRange(ids[5], ids[5], { name: 'fits' });
    const { result: request, warnings } = await captureWarnings(() => nextL1(cm, requests));
    assert.ok(request, 'the compression ran');
    const texts = textsOf(request);
    for (const id of opened.sourceIds) assert.ok(texts.includes(textOf.get(id)!), `pinned chunk message ${id} is raw`);
    assert.equal(texts.filter((t) => t.startsWith('[CM] Recall memory')).length, 0, 'no recall pair fits in what the pins left');
    assert.ok(warnings.some((w) => w.includes('recall-pair budget capped') && w.includes('pinned raw')), 'the cap names the pinned raw');
    cm.close();
  });

  it('pinned raw exactly at the budget is shown, with no room left for recall pairs', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('budget-equal');
    const opened = l1Holding(internals, ids[5]);
    const pinnedTokens = opened.sourceIds.reduce((sum, id) => sum + internals.estimateTokens([{ type: 'text', text: textOf.get(id)! }]), 0);
    internals.config.compressionRecallBudgetTokens = pinnedTokens;
    cm.pinRange(ids[5], ids[5], { name: 'exact' });
    const texts = textsOf(await nextL1(cm, requests));
    for (const id of opened.sourceIds) assert.ok(texts.includes(textOf.get(id)!), `pinned chunk message ${id} is raw`);
    assert.equal(texts.filter((t) => t.startsWith('[CM] Recall memory')).length, 0, 'no recall pair fits');
    cm.close();
  });

  it('an opened chunk inside the head window is spent from the budget too', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('budget-head');
    const opened = l1Holding(internals, ids[1]);
    const pinnedTokens = opened.sourceIds.reduce((sum, id) => sum + internals.estimateTokens([{ type: 'text', text: textOf.get(id)! }]), 0);
    // A head window over the first chunks, which L1s already own; the
    // opened chunk renders in it.
    internals.config.headWindowTokens = 400;
    internals.config.compressionRecallBudgetTokens = pinnedTokens - 1;
    const view = (cm as unknown as { strategyMessageView(): unknown }).strategyMessageView();
    const headStart = internals.getHeadWindowStartIndex(view);
    const headEnd = internals.getHeadWindowEnd(view);
    for (const id of opened.sourceIds) {
      const at = ids.indexOf(id);
      assert.ok(at >= headStart && at < headEnd, `setup: the opened chunk's message ${at} is in the head window [${headStart}, ${headEnd})`);
    }
    cm.pinRange(ids[1], ids[1], { name: 'in-head' });
    const { result: request, warnings } = await captureWarnings(() => nextL1(cm, requests));
    assert.ok(request, 'the compression ran');
    for (const id of opened.sourceIds) assert.ok(!textsOf(request).includes(textOf.get(id)!), `one token short, the pinned chunk's message ${id} is recalled, not shown raw in the head`);
    assert.ok(warnings.some((w) => w.includes('recalls the summaries its pins override') && w.includes('in-head')), 'the warning names the pin');
    cm.close();
  });

  it('pins that would take the complete request past compressionContextBudgetTokens are recalled; a request without pins still goes', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('context-budget');
    // Far below any canonical request: only a request with pins is gated by it.
    internals.config.compressionContextBudgetTokens = 1;
    assert.ok(await nextL1(cm, requests), 'without pins, the canonical request is attempted as before');
    cm.pinRange(ids[5], ids[5], { name: 'past-context' });
    const root = rootHolding(internals, ids[5]);
    const { result: request, warnings } = await captureWarnings(() => nextL1(cm, requests));
    assert.ok(request, 'the compression ran');
    assert.ok(!textsOf(request).includes(textOf.get(ids[5])!), 'the pinned message is recalled, not raw');
    assert.ok(textsOf(request).includes(`[CM] Recall memory ${root.id}.`), 'the summary the pin overrides is recalled');
    assert.ok(warnings.some((w) => w.includes('compressionContextBudgetTokens') && w.includes('past-context')), 'the warning names the limit and the pin');
    cm.close();
  });

  it('the warning names the pins that keep the history raw, not a level pin beside them', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('names', { foldingStrategy: 'kv-stable' });
    const opened = l1Holding(internals, ids[5]);
    const sibling = opened.sourceIds.find((id) => id !== ids[5]);
    assert.ok(sibling, 'setup: the opened chunk has another message');
    internals.config.compressionRecallBudgetTokens = 1;
    // ids[5] is raw by its level-0 pin, the lowest level there; the level-2
    // pins keep nothing raw, one on the same message, one beside it.
    cm.pinAtLevel(ids[5], ids[5], 0, { name: 'raw-one' });
    cm.pinAtLevel(ids[5], ids[5], 2, { name: 'level-two' });
    cm.pinAtLevel(sibling!, sibling!, 2, { name: 'level-two-beside' });
    const { result: request, warnings } = await captureWarnings(() => nextL1(cm, requests));
    assert.ok(request, 'the compression ran');
    assert.ok(!textsOf(request).includes(textOf.get(ids[5])!), 'setup: the pins are over budget');
    const warning = warnings.find((w) => w.includes('recalls the summaries its pins override'));
    assert.ok(warning && warning.includes('raw-one'), 'the raw pin is named');
    assert.ok(!warning!.includes('level-two'), 'the level pins keep nothing raw, so neither is named');
    cm.close();
  });

  it('a compression deferred for its tool definitions says nothing yet about its pins', async () => {
    // A summarizer family that refuses tools-less requests: without tools the
    // compression defers before any provider call.
    const { cm, internals, ids, requests } = await forest('deferred');
    internals.config.compressionModel = 'claude-fable-5';
    internals.config.compressionRecallBudgetTokens = 1;
    cm.pinRange(ids[5], ids[5], { name: 'over-budget' });
    const { result: request, warnings } = await captureWarnings(() => nextL1(cm, requests));
    assert.equal(request, undefined, 'setup: the compression deferred');
    assert.ok(warnings.some((w) => w.includes('deferring chunk compression')), 'setup: it deferred for its tools');
    assert.ok(!warnings.some((w) => w.includes('recalls the summaries its pins override')), 'no pin warning for a compression that did not run');
    cm.close();
  });

  it('pins are kept up to compressionContextBudgetTokens, priced as the request is sent with the longer retry line', async () => {
    // The pinned chunk carries an image and two turns of one speaker, which
    // the request collapses into one with a separator; a second opened chunk
    // starts on the agent's turn after a recall pair, so the Context Manager
    // takes a turn between them; and the host serves a system prompt and
    // tools. So every term of the price is in play. A retry appends a line to
    // the instruction, so a retry of the admitted request must fit too.
    const image = { type: 'image', source: { type: 'base64', data: 'A'.repeat(64), mediaType: 'image/png' } };
    const tools = [{ name: 'lookup', description: 'Look something up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }];
    const speaker = (i: number) => (i % 2 === 0 || i === 5 ? 'User' : 'Claude');
    const run = async (name: string, budget: number, retried = false) => {
      const { cm, internals, ids, textOf, requests, script } = await forest(name, {}, undefined,
        (i, text) => (i === 5 ? [image, { type: 'text', text }] : [{ type: 'text', text }]), speaker);
      cm.setSystemPrompt('You are the agent whose memory this is.');
      cm.setToolDefinitions(tools as never);
      internals.config.compressionContextBudgetTokens = budget;
      cm.pinRange(ids[5], ids[5], { name: 'at-the-limit' });
      const agentFirst = internals.summaries.find((s) => s.level === 1 && ids.indexOf(s.sourceIds[0]) >= 30 && speaker(ids.indexOf(s.sourceIds[0])) === 'Claude');
      assert.ok(agentFirst, 'setup: an L1 opens on the agent\'s turn');
      cm.pinRange(agentFirst!.sourceIds[0], agentFirst!.sourceIds[0], { name: 'agent-first' });
      const root = rootHolding(internals, ids[5]);
      // A tool call brings the no-tools retry; its memory, wrapped whole in
      // <thinking>, brings the plain-prose retry.
      if (retried) script.push('tool_use', 'thinking-wrapped');
      const { result: request, warnings } = await captureWarnings(() => nextL1(cm, requests));
      assert.ok(request, 'the compression ran');
      assert.ok(request.system && request.tools?.length, 'setup: the request carries the system prompt and tools');
      const view = (cm as unknown as { strategyMessageView(): { estimateTokens(m: unknown): number } }).strategyMessageView();
      const priceOf = (content: unknown[]) => view.estimateTokens({ content });
      const price = (sent: any) => sent.config.maxTokens +
        priceOf([{ type: 'text', text: sent.system }]) +
        priceOf([{ type: 'text', text: JSON.stringify(sent.tools) }]) +
        sent.messages.reduce((sum: number, m: { content: unknown[] }) => sum + priceOf(m.content), 0);
      const instruction = (sent: any): string => sent.messages.at(-1).content.at(-1).text;
      const retries = requests.filter((sent) => sent !== request && isL1Request(sent) &&
        instruction(sent) !== instruction(request) && instruction(sent).startsWith(instruction(request)));
      const texts = textsOf(request);
      const raw = texts.includes(textOf.get(ids[5])!);
      const recalled = texts.includes(`[CM] Recall memory ${root.id}.`);
      const resumeTurns = texts.filter((text) => text === RECALL_RESUME_TEXT).length;
      cm.close();
      return { price: price(request), retryPrices: retries.map(price), raw, recalled, resumeTurns, warnings };
    };
    const roomy = await run('context-roomy', 10_000_000, true);
    assert.ok(roomy.raw, 'setup: with room, the pinned message is raw');
    assert.equal(roomy.resumeTurns, 1, 'setup: the request carries the Context Manager\'s turn before the agent-first chunk');
    assert.equal(roomy.retryPrices.length, 2, 'setup: both retries were sent');
    const longest = Math.max(...roomy.retryPrices);
    assert.ok(longest > roomy.price, `setup: a retry (${longest}) is longer than the request it retries (${roomy.price})`);
    const exact = await run('context-exact', longest);
    assert.ok(exact.raw && exact.price === roomy.price, `a request whose longer retry is exactly the budget (${longest}) keeps the pins`);
    const over = await run('context-over', longest - 1);
    assert.ok(!over.raw && over.recalled, `one token less, the summary the pin overrides is recalled, though the request without a retry line (${roomy.price}) would fit`);
    assert.ok(over.warnings.some((w) => w.includes(`~${longest} tokens, counting the line a retry adds`)), 'the warning gives the price it was held to');
  });

  it('pinned raw is priced as the store prices it, images included, without adaptive selection too', async () => {
    const image = { type: 'image', source: { type: 'base64', data: 'A'.repeat(64), mediaType: 'image/png' } };
    const { cm, internals, ids, textOf, requests } = await forest('image-price', { adaptiveResolution: false },
      undefined, (i, text) => (i === 5 ? [image, { type: 'text', text }] : [{ type: 'text', text }]));
    const opened = l1Holding(internals, ids[5]);
    const textTokens = opened.sourceIds.reduce((sum, id) => sum + internals.estimateTokens([{ type: 'text', text: textOf.get(id)! }]), 0);
    // Room for the chunk's text, and far less than its image costs.
    internals.config.compressionRecallBudgetTokens = textTokens + 100;
    cm.pinRange(ids[5], ids[5], { name: 'with-image' });
    const { result: request, warnings } = await captureWarnings(() => nextL1(cm, requests));
    assert.ok(request, 'the compression ran');
    assert.ok(!textsOf(request).includes(textOf.get(ids[5])!), 'priced with its image, the pinned chunk passes the budget and is recalled');
    assert.ok(warnings.some((w) => w.includes('compressionRecallBudgetTokens') && w.includes('with-image')), 'the warning names the pin');
    cm.close();
  });

  it('a compression whose pinned raw exceeds the budget recalls what the pins override, and says so', async () => {
    const { cm, internals, ids, textOf, requests } = await forest('budget-over');
    const opened = l1Holding(internals, ids[5]);
    const pinnedTokens = opened.sourceIds.reduce((sum, id) => sum + internals.estimateTokens([{ type: 'text', text: textOf.get(id)! }]), 0);
    internals.config.compressionRecallBudgetTokens = pinnedTokens - 1;
    cm.pinRange(ids[5], ids[5], { name: 'too-big' });
    const { result: request, warnings } = await captureWarnings(() => nextL1(cm, requests));
    assert.ok(request, 'the compression ran rather than waiting');
    const texts = textsOf(request);
    for (const id of opened.sourceIds) assert.ok(!texts.includes(textOf.get(id)!), `pinned chunk message ${id} is recalled, not raw`);
    assert.ok(texts.some((t) => t.startsWith('[CM] Recall memory')), 'the summaries the pin overrides are recalled');
    assert.ok(warnings.some((w) => w.includes('recalls the summaries its pins override') && w.includes('too-big')), 'the warning names the pin');
    cm.close();
  });
});

describe('a pin resolves once, for compression and every selector', () => {
  const messages = Array.from({ length: 11 }, (_, i) => ({ id: `m${i}` }));
  const pins: Array<Omit<ProtectedRange, 'firstMessageId' | 'lastMessageId' | 'kind' | 'created' | 'id'> & { at: number }> = [
    { at: 1 },                          // classic raw pin
    { at: 2, level: 0 },
    { at: 3, maxLevel: 0 },
    { at: 4, level: 2 },
    { at: 5, maxLevel: 2 },
    { at: 6, level: 2 }, { at: 6, maxLevel: 0 },   // a fixed level wins over a cap
    { at: 7 }, { at: 7, maxLevel: 3 },              // a bound takes a classic pin's place
    { at: 8, level: 0 }, { at: 8, maxLevel: 3 },
    { at: 9, level: 1 }, { at: 9, level: 2 },      // within a kind, the lowest wins, not the last
    { at: 10, maxLevel: 1 }, { at: 10, maxLevel: 3 },
  ];
  const resolve = (config: Record<string, unknown>) => {
    const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false, ...config });
    (strategy as unknown as { pins: ProtectedRange[] }).pins = pins.map(({ at, ...bound }, n) => ({
      id: `pin-${n}`, firstMessageId: `m${at}`, lastMessageId: `m${at}`, kind: 'pin', created: 0, ...bound,
    }));
    const internals = strategy as unknown as {
      resolvedPinBounds(m: typeof messages): Map<number, unknown>;
      forceRawPinPositions(m: typeof messages): Set<number>;
    };
    return { bounds: internals.resolvedPinBounds(messages), raw: internals.forceRawPinPositions(messages) };
  };

  for (const foldingStrategy of ['kv-stable', 'kv-unified'] as const) {
    it(`${foldingStrategy} reads bounds, as kv-stable always has`, () => {
      const { bounds, raw } = resolve({
        adaptiveResolution: true, foldingStrategy,
        ...(foldingStrategy === 'kv-unified' ? { kvUnified: { treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false } as never } : {}),
      });
      assert.deepEqual([...bounds.entries()].sort(([a], [b]) => a - b), [
        [1, 'raw'], [2, { level: 0 }], [3, { maxLevel: 0 }], [4, { level: 2 }], [5, { maxLevel: 2 }],
        [6, { level: 2 }], [7, { maxLevel: 3 }], [8, { level: 0 }], [9, { level: 1 }], [10, { maxLevel: 1 }],
      ]);
      assert.deepEqual([...raw].sort((a, b) => a - b), [1, 2, 3, 8]);
    });
  }

  for (const [name, config] of [
    ['flat-profile', { adaptiveResolution: true }],
    ['oldest-first', { adaptiveResolution: true, foldingStrategy: 'oldest-first' }],
    ['hierarchical selection', { adaptiveResolution: false, foldingStrategy: 'kv-stable' }],
  ] as const) {
    it(`${name} keeps every pinned message raw`, () => {
      const { bounds, raw } = resolve(config);
      assert.deepEqual([...bounds.values()], Array(10).fill('raw'));
      assert.deepEqual([...raw].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });
  }

  type ChunkPins = { pinned: boolean; pinLevel?: number; pinMaxLevel?: number };
  const BOUNDED_CHUNKS: ChunkPins[] = [
    { pinned: true }, { pinned: true }, { pinned: true }, { pinned: false, pinLevel: 2 }, { pinned: false, pinMaxLevel: 2 },
    { pinned: false, pinLevel: 2 }, { pinned: false, pinMaxLevel: 3 }, { pinned: true },
    { pinned: false, pinLevel: 1 }, { pinned: false, pinMaxLevel: 1 },
  ];
  const pickerCases: Array<[string, Record<string, unknown>, ChunkPins[]]> = [
    ['kv-stable', { foldingStrategy: 'kv-stable' }, BOUNDED_CHUNKS],
    ['kv-unified', { foldingStrategy: 'kv-unified', kvUnified: KV_UNIFIED }, BOUNDED_CHUNKS],
    ['flat-profile', {}, Array(10).fill({ pinned: true })],
  ];
  for (const [name, config, expected] of pickerCases) {
    it(`${name}'s picker chunks carry the resolution: a raw one as pinned, at most one bound`, async () => {
      let captured: Array<ChunkPins & { id: string }> | undefined;
      class Probe extends AutobiographicalStrategy {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        protected buildPicker(...args: [any, ...any[]]): any {
          captured = args[0].chunks;
          return (AutobiographicalStrategy.prototype as any).buildPicker.apply(this, args);
        }
      }
      const strategy = new Probe({ adaptiveResolution: true, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false, ...config });
      const cm = await ContextManager.open({ path: join(dir, `picker-${name}`), strategy });
      const ids = Array.from({ length: 40 }, (_, i) => cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `M-${i}` }]));
      for (const { at, ...bound } of pins) cm.pinRange(ids[at], ids[at], bound);
      try {
        await cm.compile();
      } catch (error) {
        // kv-unified refuses a level no summary supplies yet; the chunks were
        // read before it solved.
        if (!(name === 'kv-unified' && /constraints are infeasible/.test(String(error)))) throw error;
      }
      assert.ok(captured, 'setup: the picker was built');
      for (let at = 1; at <= 10; at++) {
        const chunk: ChunkPins | undefined = captured!.find((c) => c.id === ids[at]);
        assert.ok(chunk, `setup: message ${at} is a picker chunk`);
        const got: ChunkPins = {
          pinned: chunk!.pinned,
          ...(chunk!.pinLevel !== undefined ? { pinLevel: chunk!.pinLevel } : {}),
          ...(chunk!.pinMaxLevel !== undefined ? { pinMaxLevel: chunk!.pinMaxLevel } : {}),
        };
        assert.deepEqual(got, expected[at - 1], `message ${at}`);
      }
      cm.close();
    });
  }

  it('under kv-stable, a message pinned at a level above 0 is still compressed; one kept raw is not', async () => {
    const { cm, internals, ids } = await forest('kv-stable-chunking', { foldingStrategy: 'kv-stable' }, (manager, messageIds) => {
      if (messageIds.length === 4) manager.pinAtLevel(messageIds[3], messageIds[3], 2, { name: 'at-level' });
      if (messageIds.length === 8) manager.pinRange(messageIds[7], messageIds[7], { name: 'raw' });
    });
    const covered = (id: string) => internals.summaries.some((s) => s.level === 1 && s.sourceIds.includes(id));
    assert.ok(covered(ids[3]), 'the level-2 pin\'s message has an L1, so it can render at its level');
    assert.ok(!covered(ids[7]), 'the raw pin\'s message was never chunked');
    cm.close();
  });

  it('under kv-stable, a message the chunker skipped, later pinned at a level, gets an L1 of its own and renders at it', async () => {
    // The store an earlier version leaves for a message pinned at a level
    // before compression: its neighbours compressed and merged around it.
    let skippedPin = '';
    const { cm, internals, ids, textOf, requests } = await forest('skipped-then-level', { foldingStrategy: 'kv-stable' }, (manager, messageIds) => {
      if (messageIds.length === 31) skippedPin = manager.pinRange(messageIds[30], messageIds[30], { name: 'skipped' });
    });
    assert.ok(!internals.summaries.some((s) => s.sourceIds.includes(ids[30])), 'setup: the chunker skipped it');
    assert.ok(internals.summaries.some((s) => s.level >= 2), 'setup: its neighbours merged');
    cm.unpin(skippedPin);
    cm.pinAtLevel(ids[30], ids[30], 2, { name: 'at-level' });
    for (let round = 0; round < 2; round++) await nextL1(cm, requests);
    const own = internals.summaries.find((s) => s.level === 1 && s.sourceIds.includes(ids[30]));
    assert.ok(own && own.sourceIds.length === 1, 'it has an L1 of its own');
    assert.ok(!own!.mergedInto, 'nothing merges it');
    const live = JSON.stringify(await cm.compile());
    assert.ok(!live.includes(textOf.get(ids[30])!), 'it no longer renders raw');
    assert.ok(live.includes(own!.content), 'kv-stable renders it at its L1');
    cm.close();
  });

  for (const [name, overrides] of [
    ['flat-profile', {}],
    ['hierarchical selection', { adaptiveResolution: false }],
  ] as const) {
    it(`the ${name} live view keeps a message pinned at a level raw, as compression does`, async () => {
      const { cm, internals, ids, textOf, requests } = await forest(`live-${name.replace(' ', '-')}`, overrides);
      assert.ok(internals.summaries.some((s) => s.level === 1 && s.sourceIds.includes(ids[100])), 'setup: it has an L1 to fold to');
      // Pinned once compressed, then compiled under a budget that folds its
      // unpinned neighbour.
      cm.pinAtLevel(ids[100], ids[100], 2, { name: 'at-level' });
      const live = JSON.stringify(await cm.compile({ maxTokens: 4000, reserveForResponse: 0 }));
      assert.ok(!live.includes('OLD-101 '), 'setup: an unpinned neighbour folds under this budget');
      assert.ok(live.includes('OLD-100 '), 'pinned at a level, it stays raw where levels are not read');
      const request = await nextL1(cm, requests);
      assert.ok(request && textsOf(request).includes(textOf.get(ids[100])!), 'the L1 prompt shows it raw too');
      cm.close();
    });
  }
});
