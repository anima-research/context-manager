/**
 * The thinking-binding pass through ContextManager.compile and acceptRound
 * (#155). A reply's thinking renders while the prefix it was minted under is
 * the prefix it is sent under; a fold before it removes it; thinking with no
 * stamp (a carrier, a message from before any accepted compile) never renders
 * once the store's host has accepted a round. Stamps, releases and engagement
 * are records, so a reopened store keeps them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy, PassthroughStrategy } from '../src/index.js';
import type { SummaryEntry, CompileResult, ContextInjection } from '../src/index.js';
import { THINKING_BINDING_RECORD, bindThinking, chainSeed, chainStep, mintStamp } from '../src/thinking-binding.js';
import { chunkMessage } from '../src/adaptive/chunker.js';

class SeedableStrategy extends AutobiographicalStrategy {
  seed(entry: Omit<SummaryEntry, 'created'>): void {
    this.pushSummary({ ...entry, created: 0 });
  }
}

/** Passthrough, with ingress chunking as adaptive resolution shards a long body. */
class ChunkedStrategy extends PassthroughStrategy {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    if (content.some((b) => b.type !== 'text')) return null;
    const body = content.map((b) => (b as { text: string }).text).join('');
    const sharded = chunkMessage(body, { chunkThreshold: 20, chunkSize: 10, charsPerToken: 4 });
    if (!sharded.wasSharded) return null;
    return { bodyGroupId: sharded.bodyGroupId, shards: sharded.shards.map((s) => ({ content: text(s.content), shardIndex: s.index })) };
  }
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const reply = (t: string, sig: string): ContentBlock[] => [
  { type: 'thinking', thinking: '', signature: sig } as ContentBlock,
  { type: 'text', text: t },
];
const BUDGET = { maxTokens: 100_000, reserveForResponse: 0 };

async function withStore<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'zz-thinking-binding-'));
  try {
    return await run(join(dir, 'store'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const signaturesIn = (result: CompileResult): string[] =>
  result.messages.flatMap((m) =>
    m.content.filter((b) => b.type === 'thinking').map((b) => (b as { signature: string }).signature),
  );

const bindingRecords = (cm: ContextManager): number => cm.getStore().getRecordIdsByType(THINKING_BINDING_RECORD).length;

/** One turn: compile, accept the compile as a standing round, store the reply. */
async function turn(cm: ContextManager, user: string, answer: string, sig: string, prefixIdentity = 'p0') {
  cm.addMessage('user', text(user));
  const compiled = await cm.compile(BUDGET, undefined, { prefixIdentity });
  cm.acceptRound({ provenance: compiled.provenance! });
  cm.addMessage('assistant', reply(answer, sig));
  return compiled;
}

describe('thinking binding', () => {
  it('keeps each reply’s thinking while nothing before it changes', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      await turn(cm, 'u1', 'a1', 'S1');
      await turn(cm, 'u2', 'a2', 'S2');
      const third = await turn(cm, 'u3', 'a3', 'S3');
      assert.deepEqual(signaturesIn(third), ['S1', 'S2']);
      assert.equal(third.thinkingStripped, 0);
      cm.addMessage('user', text('u4'));
      const fourth = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(fourth), ['S1', 'S2', 'S3']);
      cm.close();
    });
  });

  it('strips every reply when the host’s prefix identity changes, and keeps replies minted after', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      await turn(cm, 'u1', 'a1', 'S1');
      await turn(cm, 'u2', 'a2', 'S2');
      const changed = await turn(cm, 'u3', 'a3', 'S3', 'p1');
      assert.deepEqual(signaturesIn(changed), []);
      assert.equal(changed.thinkingStripped, 2);
      cm.addMessage('user', text('u4'));
      const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
      assert.deepEqual(signaturesIn(next), ['S3']);
      cm.close();
    });
  });

  it('seeds the chain with the system injections a compile returns', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
      const clock = (t: string): ContextInjection[] => [{ namespace: 'clock', position: 'system', content: text(t) }];
      const round = async (user: string, injection: string) => {
        cm.addMessage('user', text(user));
        const compiled = await cm.compile(BUDGET, clock(injection), { prefixIdentity: 'p0' });
        cm.acceptRound({ provenance: compiled.provenance! });
        return compiled;
      };
      await round('u1', 'same');
      cm.addMessage('assistant', reply('a1', 'S1'));
      await round('u2', 'same');
      cm.addMessage('assistant', reply('a2', 'S2'));
      cm.addMessage('user', text('u3'));
      const unchanged = await cm.compile(BUDGET, clock('same'), { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(unchanged), ['S1', 'S2']);
      const changed = await cm.compile(BUDGET, clock('moved'), { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(changed), []);
      assert.equal(changed.thinkingStripped, 2);
      cm.close();
    });
  });

  it('reports every strip the strategy’s view still counted, the releasing compile under a new seed included', async () => {
    await withStore(async (path) => {
      // The adaptive path is the one that arms a calibration sample.
      const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 100_000,
        adaptiveResolution: true, foldingStrategy: 'kv-stable', autoTickOnNewMessage: false });
      const cm = await ContextManager.open({ path, strategy });
      const sig = (n: number) => 'Q'.repeat(3300 * n); // about n thousand tokens each
      cm.addMessage('user', text('u1'));
      const c1 = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: c1.provenance! });
      cm.addMessage('assistant', reply('a1', sig(2)));
      cm.addMessage('user', text('u2'));
      const c2 = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: c2.provenance! });
      cm.addMessage('assistant', reply('a2', sig(3)));
      const estimate = () => (strategy as unknown as { _lastCompileEstimate: number })._lastCompileEstimate;
      // A lasting change: the first compile under p1 strips and releases nothing.
      cm.addMessage('user', text('u3'));
      const first = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
      assert.equal(first.thinkingStripped, 2);
      cm.acceptRound({ provenance: first.provenance! });
      // A dry run's select records its estimate too; it strips the same, and says so.
      const dry = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1', dryRun: true });
      assert.equal(dry.thinkingStripped, 2);
      // The second strips the same blocks again, still counted by the view, and releases them.
      const firstEstimate = estimate();
      const second = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
      assert.equal(second.thinkingStripped, 2);
      const secondEstimate = estimate();
      assert.equal(firstEstimate, secondEstimate, 'both compiles sent the same, and both samples say so');
      // The third never sees them: its estimate is what was sent at the second.
      const third = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
      assert.equal(third.thinkingStripped, 0);
      assert.ok(secondEstimate > 0);
      assert.equal(secondEstimate, estimate(), 'the releasing compile’s sample leaves out what it stripped');
      cm.close();
    });
  });

  it('strips for a one-turn seed change without releasing, so thinking returns with the seed', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      await turn(cm, 'u1', 'a1', 'S1');
      await turn(cm, 'u2', 'a2', 'S2');
      // A heartbeat turn: the host's system differs for this turn only.
      cm.addMessage('user', text('tick'));
      const heartbeat = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0+heartbeat' });
      assert.deepEqual(signaturesIn(heartbeat), []);
      assert.equal(heartbeat.thinkingStripped, 2);
      cm.acceptRound({ provenance: heartbeat.provenance! });
      cm.addMessage('assistant', reply('quiet', 'H1'));
      // The next ordinary turn restores the seed: S1 and S2 are valid again.
      cm.addMessage('user', text('u3'));
      const ordinary = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(ordinary), ['S1', 'S2']);
      assert.equal(ordinary.thinkingStripped, 1, 'only the heartbeat reply, minted under the heartbeat seed');
      cm.close();
    });
  });

  it('renders as today until the store’s host accepts a round', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      cm.addMessage('user', text('u1'));
      cm.addMessage('assistant', reply('a1', 'S1'));
      cm.addMessage('user', text('u2'));
      const before = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(before), ['S1']);
      assert.equal(before.thinkingStripped, 0);
      // The first accepted round engages the pass: S1 has no stamp.
      cm.acceptRound({ provenance: before.provenance! });
      cm.addMessage('assistant', reply('a2', 'S2'));
      cm.addMessage('user', text('u3'));
      const after = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(after), []);
      assert.equal(after.thinkingStripped, 2, 'S1 is unstamped; S2 was minted with S1 in its prefix');
      cm.close();
    });
  });

  it('strips the replies after a fold and keeps replies minted after it', async () => {
    await withStore(async (path) => {
      const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 8 });
      const cm = await ContextManager.open({ path, strategy });
      await turn(cm, 'zz-u1', 'zz-a1', 'S1');
      await turn(cm, 'zz-u2', 'zz-a2', 'S2');
      cm.addMessage('user', text('zz-u3'));
      const before = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(before), ['S1', 'S2']);
      cm.acceptRound({ provenance: before.provenance! });
      cm.addMessage('assistant', reply('zz-a3', 'S3'));
      // Fold the first exchange into a summary.
      const ids = (await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' })).provenance!.messages
        .flatMap((s) => (s.kind === 'raw' ? s.bodies.map((b) => b.messageId) : []));
      strategy.seed({ id: 'L1-0', level: 1, content: 'the first exchange', tokens: 4, sourceLevel: 0,
        sourceIds: [ids[0]!, ids[1]!], sourceRange: { first: ids[0]!, last: ids[1]! } });
      cm.addMessage('user', text('zz-u4'));
      const folded = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.ok(folded.provenance!.messages.some((s) => s.kind === 'summary'), 'the fold rendered');
      assert.deepEqual(signaturesIn(folded), [], 'S2 and S3 were minted before the fold');
      assert.equal(folded.thinkingStripped, 2);
      // The provenance and the layout say those replies went out partial.
      const partialUnits = (r: CompileResult) => r.provenance!.layout!.units.filter((u) => u.k === 'r' && u.p === 1).length;
      assert.equal(partialUnits(before), 0);
      assert.equal(partialUnits(folded), 2);
      const replyBodies = folded.provenance!.messages.flatMap((m) => (m.kind === 'raw' ? m.bodies : []))
        .filter((b) => cm.getAllMessages().find((m) => m.id === b.messageId)?.participant === 'assistant');
      assert.equal(replyBodies.length, 2);
      assert.ok(replyBodies.every((b) => b.complete === false && b.missing?.includes('content')));
      const again = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.equal(again.thinkingStripped, 0, 'released thinking is out of the strategy’s view');
      assert.deepEqual(signaturesIn(again), []);
      cm.acceptRound({ provenance: folded.provenance! });
      cm.addMessage('assistant', reply('zz-a4', 'S4'));
      cm.addMessage('user', text('zz-u5'));
      const after = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(after), ['S4']);
      cm.close();
    });
  });

  it('keeps a tool loop’s thinking across turns, with an image in a tool result', async () => {
    await withStore(async (path) => {
      const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 100_000 });
      const cm = await ContextManager.open({ path, strategy });
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      cm.addMessage('user', text('look at the picture'));
      const first = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: first.provenance! });
      cm.addMessage('assistant', [
        { type: 'thinking', thinking: '', signature: 'T1' } as ContentBlock,
        { type: 'tool_use', id: 'tu1', name: 'view', input: { path: 'a.png' } } as ContentBlock,
      ]);
      cm.addMessage('user', [{ type: 'tool_result', toolUseId: 'tu1', content: [
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: png } },
      ] } as ContentBlock]);
      cm.addMessage('assistant', reply('a red pixel', 'T2'));
      cm.addMessage('user', text('thanks'));
      const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(next), ['T1', 'T2']);
      assert.equal(next.thinkingStripped, 0);
      cm.close();
    });
  });

  it('walks a bundled tool cycle in the parts a compile splits it into', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
      cm.addMessage('user', text('u1'));
      const first = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: first.provenance! });
      // An imported transcript's shape: the tool cycle in one assistant message.
      cm.addMessage('assistant', [
        { type: 'thinking', thinking: '', signature: 'T1' } as ContentBlock,
        { type: 'tool_use', id: 'tu1', name: 'look', input: {} } as ContentBlock,
        { type: 'tool_result', toolUseId: 'tu1', content: text('seen') } as ContentBlock,
        { type: 'thinking', thinking: '', signature: 'T3' } as ContentBlock,
        { type: 'text', text: 'done' },
      ]);
      cm.addMessage('assistant', reply('after', 'T2'));
      cm.addMessage('user', text('u2'));
      const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.ok(next.messages.length > 4, 'the compile split the bundled message');
      assert.deepEqual(signaturesIn(next), ['T1', 'T3', 'T2'], 'each part is judged by its own chain');
      assert.equal(next.thinkingStripped, 0);
      const again = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(again), ['T1', 'T3', 'T2'], 'nothing was released');
      // Its tool result edited: what follows it is stripped and released,
      // from T3's place in the stored message, so T1 stays.
      cm.acceptRound({ provenance: again.provenance! });
      const bundled = cm.getAllMessages().find((m) => m.content.length === 5)!;
      cm.editMessage(bundled.id, bundled.content.map((b) => (b.type === 'tool_result'
        ? ({ type: 'tool_result', toolUseId: 'tu1', content: text('seen, redacted') } as ContentBlock)
        : b)));
      const edited = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(edited), ['T1']);
      const after = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(after), ['T1'], 'T1 was not released with T3');
      assert.equal(after.thinkingStripped, 0);
      cm.close();
    });
  });

  it('keeps thinking only up to the first block that differs from the one minted there', () => {
    const seed = chainSeed('p');
    const minted = [
      { type: 'thinking', thinking: '', signature: 'A' },
      { type: 'tool_use', id: 't1', name: 'x', input: { long: 'original' } },
      { type: 'thinking', thinking: '', signature: 'B' },
      { type: 'text', text: 'done' },
    ] as ContentBlock[];
    const edited = { participant: 'assistant', content: [
      minted[0]!, { type: 'tool_use', id: 't1', name: 'x', input: { long: 'capped' } } as ContentBlock,
      minted[2]!, minted[3]!,
    ] };
    const user = { participant: 'user', content: text('go') };
    const before = chainStep(seed, user);
    const out = bindThinking({
      messages: [user, edited],
      sources: [{ kind: 'other' }, { kind: 'raw', bodies: [{ messageId: 'm1', sequence: 2, complete: true }] }],
      seed, engaged: true,
      stampOf: (id) => (id === 'm1' ? mintStamp(seed, before, { participant: 'assistant', content: minted }) : undefined),
    });
    assert.deepEqual(out.messages[1]!.content.map((b) => b.type), ['thinking', 'tool_use', 'text']);
    assert.equal(out.stripped, 1);
  });

  it('vouches for no thinking in a compiled message that carries several bodies', () => {
    const seed = chainSeed('p');
    const minted: ContentBlock[] = [...text('pre'), { type: 'thinking', thinking: '', signature: 'A' } as ContentBlock, ...text('a')];
    const merged = { participant: 'assistant', content: [...minted, ...text('b')] };
    const out = bindThinking({
      messages: [merged],
      sources: [{ kind: 'raw', bodies: [
        { messageId: 'm1', sequence: 1, complete: true },
        { messageId: 'm2', sequence: 2, complete: true },
      ] }],
      seed, engaged: true,
      stampOf: (id) => (id === 'm1' ? mintStamp(seed, seed, { participant: 'assistant', content: minted }) : undefined),
    });
    assert.equal(out.stripped, 1);
    assert.deepEqual([...out.strippedFrom], [['m1', 0], ['m2', 0]]);
  });

  it('drops a message the strip leaves empty', () => {
    const seed = chainSeed('p');
    const thinkingOnly = { participant: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'A' } as ContentBlock] };
    const user = { participant: 'user', content: text('go') };
    const out = bindThinking({
      messages: [thinkingOnly, user],
      sources: [{ kind: 'raw', bodies: [{ messageId: 'm1', sequence: 1, complete: true }] }, { kind: 'other' }],
      seed, engaged: true,
      stampOf: () => undefined,
    });
    assert.deepEqual(out.kept, [1]);
    assert.equal(out.chainEnd, chainStep(seed, user));
  });

  it('matches a block whatever order its keys were built in', () => {
    const seed = chainSeed('p');
    const minted = [
      { type: 'thinking', thinking: '', signature: 'A' },
      { type: 'tool_use', id: 't1', name: 'x', input: { a: 1, b: 2 } },
      { type: 'thinking', thinking: '', signature: 'B' },
    ] as ContentBlock[];
    const rebuilt = [minted[0]!, { input: { b: 2, a: 1 }, name: 'x', id: 't1', type: 'tool_use' } as ContentBlock, minted[2]!];
    const out = bindThinking({
      messages: [{ participant: 'assistant', content: rebuilt }],
      sources: [{ kind: 'raw', bodies: [{ messageId: 'm1', sequence: 1, complete: true }] }],
      seed, engaged: true,
      stampOf: () => mintStamp(seed, seed, { participant: 'assistant', content: minted }),
    });
    assert.equal(out.stripped, 0);
  });

  it('strips thinking after a block a store edit changed, and keeps the thinking before it', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
      cm.addMessage('user', text('u1'));
      const first = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: first.provenance! });
      const minted: ContentBlock[] = [
        { type: 'thinking', thinking: '', signature: 'A' } as ContentBlock,
        { type: 'text', text: 'first part' },
        { type: 'thinking', thinking: '', signature: 'B' } as ContentBlock,
        { type: 'text', text: 'second part' },
      ];
      const id = cm.addMessage('assistant', minted);
      cm.addMessage('user', text('u2'));
      const intact = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(intact), ['A', 'B']);
      cm.editMessage(id, [minted[0]!, { type: 'text', text: 'first part, edited' }, minted[2]!, minted[3]!]);
      const edited = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(edited), ['A']);
      assert.equal(edited.thinkingStripped, 1);
      // Only B was released: A is still sent, and nothing is stripped again.
      const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(next), ['A']);
      assert.equal(next.thinkingStripped, 0);
      cm.acceptRound({ provenance: next.provenance! });
      // A lasting prefix change then takes A too, and its release reaches back to it.
      const changed = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
      assert.equal(changed.thinkingStripped, 1);
      cm.acceptRound({ provenance: changed.provenance! });
      const releasing = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
      assert.equal(releasing.thinkingStripped, 1);
      const settled = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
      assert.equal(settled.thinkingStripped, 0);
      assert.deepEqual(signaturesIn(settled), []);
      cm.close();
    });
  });

  it('gives no stamp to a reply stored after a sharded body in the same live request', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path, strategy: new ChunkedStrategy() });
      cm.addMessage('user', text('u1'));
      const first = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: first.provenance! });
      // In one live request: a long tool-free body the store shards, then the reply.
      const doc = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} of a long note, long enough to shard. `).join('');
      cm.addMessage('assistant', text(doc));
      assert.ok(cm.getAllMessages().some((m) => m.bodyGroupId), 'the body was sharded');
      cm.addMessage('assistant', reply('after the note', 'S1'));
      cm.addMessage('user', text('u2'));
      const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(next), []);
      assert.equal(next.thinkingStripped, 1);
      // The next accepted compile vouches for what follows it again.
      cm.acceptRound({ provenance: next.provenance! });
      cm.addMessage('assistant', reply('a2', 'S2'));
      cm.addMessage('user', text('u3'));
      const after = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(after), ['S2']);
      cm.close();
    });
  });

  it('stamps only what this manager stored: another writer’s message before a reply strips it', async () => {
    await withStore(async (path) => {
      const main = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
      const side = await ContextManager.open({
        store: main.getStore(),
        namespace: 'zz-side',
        isolate: true,
        strategy: new PassthroughStrategy(),
        auxiliaryMessageViews: [{}],
      });
      side.addMessage('user', text('u1'));
      const first = await side.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      side.acceptRound({ provenance: first.provenance! });
      side.addMessage('assistant', reply('a1', 'S1'));
      side.addMessage('user', text('u2'));
      const second = await side.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      side.acceptRound({ provenance: second.provenance! });
      assert.deepEqual(signaturesIn(second), ['S1']);
      // While the side's request is out, the shared slot gets a message; the
      // side's live request didn't carry it, and its next compile renders it
      // before the reply.
      main.addMessage('alice', text('m-mid'));
      side.addMessage('assistant', reply('a2', 'S2'));
      side.addMessage('user', text('u3'));
      const third = await side.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      const rendered = third.messages.map((m) => m.content.find((b) => b.type === 'text') as { text: string } | undefined)
        .map((b) => b?.text);
      assert.deepEqual(rendered, ['u1', 'a1', 'u2', 'm-mid', 'a2', 'u3']);
      assert.deepEqual(signaturesIn(third), ['S1']);
      assert.equal(third.thinkingStripped, 1);
      side.close();
      main.close();
    });
  });

  it('stamps only what this manager stored, also through a compile run while a request is out', async () => {
    await withStore(async (path) => {
      const main = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
      const side = await ContextManager.open({
        store: main.getStore(),
        namespace: 'zz-side',
        isolate: true,
        strategy: new PassthroughStrategy(),
        auxiliaryMessageViews: [{}],
      });
      side.addMessage('user', text('u1'));
      const first = await side.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      side.acceptRound({ provenance: first.provenance! });
      // While the request is out: another writer's message, and a compile
      // of the side's that renders it (one never sent).
      main.addMessage('alice', text('m-mid'));
      await side.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      side.addMessage('assistant', reply('a1', 'S1'));
      side.addMessage('user', text('u2'));
      const next = await side.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(next), [], 'S1 was minted without m-mid before it');
      side.close();
      main.close();
    });
  });

  it('a dry run binds as a compile would and commits nothing', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      await turn(cm, 'u1', 'a1', 'S1');
      await turn(cm, 'u2', 'a2', 'S2');
      cm.addMessage('user', text('u3'));
      const records = bindingRecords(cm);
      const dry = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1', dryRun: true });
      assert.deepEqual(signaturesIn(dry), []);
      assert.equal(dry.thinkingStripped, 2);
      cm.acceptRound({ provenance: dry.provenance! });
      assert.equal(bindingRecords(cm), records, 'a dry run has no chain to record');
      const real = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(real), ['S1', 'S2'], 'the dry run released nothing');
      cm.close();
    });
  });

  it('accepts a compile once', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      cm.addMessage('user', text('u1'));
      const compiled = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: compiled.provenance! });
      cm.acceptRound({ provenance: compiled.provenance! });
      assert.equal(bindingRecords(cm), 1);
      cm.close();
    });
  });

  it('records a stamp once, even when a late acceptance moves where stamping starts', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      cm.addMessage('user', text('u1'));
      const c1 = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: c1.provenance! });
      cm.addMessage('assistant', reply('a1', 'S1'));
      cm.addMessage('user', text('u2'));
      const c2 = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.addMessage('assistant', reply('a2', 'S2'));
      cm.addMessage('user', text('u3'));
      // This compile stamps S2 from c1, before c2's acceptance arrives.
      await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: c2.provenance! });
      const c4 = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(c4), ['S1', 'S2']);
      cm.acceptRound({ provenance: c4.provenance! });
      const stamped = cm.getStore().getRecordIdsByType(THINKING_BINDING_RECORD).flatMap((rid) => {
        const record = JSON.parse(cm.getStore().getRecord(rid)!.payload.toString('utf8')) as { stamps?: [string][] };
        return (record.stamps ?? []).map(([mid]) => mid);
      });
      assert.equal(stamped.length, 2);
      assert.equal(new Set(stamped).size, 2, 'no message is stamped twice');
      cm.close();
    });
  });

  describe('a reply minted under a compile whose acceptance isn’t in yet', () => {
    /** S1 under p0; then a heartbeat compile under another seed, sent, its
     *  acceptance not yet in, and its reply H1; then an ordinary compile. */
    async function heartbeatUnaccepted(cm: ContextManager) {
      await turn(cm, 'u1', 'a1', 'S1');
      cm.addMessage('user', text('tick'));
      const heartbeat = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0+heartbeat' });
      cm.addMessage('assistant', reply('quiet', 'H1'));
      cm.addMessage('user', text('u2'));
      const ordinary = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(ordinary), ['S1'], 'H1 was minted under the heartbeat seed');
      return { heartbeat, ordinary };
    }

    it('waits for that compile, which stamps it from its own chain', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        const { heartbeat } = await heartbeatUnaccepted(cm);
        cm.acceptRound({ provenance: heartbeat.provenance! });
        cm.addMessage('assistant', reply('a2', 'S2'));
        cm.addMessage('user', text('u3'));
        const ordinary = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(ordinary), ['S1'], 'S2 follows the ordinary compile, which is still unaccepted');
        // H1 was neither released nor stamped from the walk: the next
        // heartbeat sends what H1 was minted after, and H1 with it.
        cm.addMessage('user', text('tick'));
        const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0+heartbeat' });
        assert.deepEqual(signaturesIn(next), ['H1']);
        cm.close();
      });
    });

    it('never sends it when a compile bound after it is accepted first', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        const { heartbeat, ordinary } = await heartbeatUnaccepted(cm);
        cm.acceptRound({ provenance: ordinary.provenance! });
        cm.acceptRound({ provenance: heartbeat.provenance! });
        cm.addMessage('assistant', reply('a2', 'S2'));
        cm.addMessage('user', text('u3'));
        const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(next), ['S1', 'S2']);
        cm.acceptRound({ provenance: next.provenance! });
        cm.addMessage('assistant', reply('a3', 'S3'));
        cm.addMessage('user', text('u4'));
        const after = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(after), ['S1', 'S2', 'S3']);
        cm.close();
      });
    });

    it('keeps the owner bound last when an earlier compile at the same head is accepted after it', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        await turn(cm, 'u1', 'a1', 'S1');
        cm.addMessage('user', text('u2'));
        const heartbeat = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0+heartbeat' });
        const ordinary = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        cm.acceptRound({ provenance: ordinary.provenance! });
        cm.acceptRound({ provenance: heartbeat.provenance! });
        cm.addMessage('assistant', reply('a2', 'S2'));
        cm.addMessage('user', text('u3'));
        const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(next), ['S1', 'S2'], 'S2 follows the ordinary compile');
        const quiet = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0+heartbeat' });
        assert.deepEqual(signaturesIn(quiet), []);
        cm.close();
      });
    });

    it('goes blind past it when more compiles than it remembers follow, until one bound later is accepted', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        await heartbeatUnaccepted(cm);
        let last: CompileResult | undefined;
        for (let i = 0; i < 33; i++) {
          cm.addMessage('user', text(`more ${i}`));
          last = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
          assert.deepEqual(signaturesIn(last), ['S1'], `compile ${i}: H1 is never vouched for`);
        }
        cm.acceptRound({ provenance: last!.provenance! });
        cm.addMessage('assistant', reply('a2', 'S2'));
        cm.addMessage('user', text('u3'));
        const after = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(after), ['S1', 'S2']);
        cm.close();
      });
    });
  });

  it('keeps stamping past the compiles it has passed while no acceptance comes in', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      await turn(cm, 'u1', 'a1', 'S1');
      cm.addMessage('user', text('u2'));
      await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.addMessage('assistant', reply('a2', 'S2'));
      cm.addMessage('user', text('u3'));
      const second = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(second), ['S1', 'S2']);
      cm.addMessage('assistant', reply('a3', 'S3'));
      cm.addMessage('user', text('u4'));
      const third = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(third), ['S1', 'S2', 'S3']);
      cm.close();
    });
  });

  it('vouches through recompiles that send the same, however many, without a dry run or an acceptance', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      await turn(cm, 'u1', 'a1', 'S1');
      cm.addMessage('user', text('u2'));
      for (let i = 0; i < 40; i++) await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.addMessage('assistant', reply('a2', 'S2'));
      cm.addMessage('user', text('u3'));
      const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(next), ['S1', 'S2']);
      cm.close();
    });
  });

  it('releases what a seed that changes every turn strips, at the second compile after each reply', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
      const clock = (t: string): ContextInjection[] => [{ namespace: 'clock', position: 'system', content: text(t) }];
      const stripped: number[] = [];
      for (let i = 1; i <= 5; i++) {
        cm.addMessage('user', text(`u${i}`));
        const compiled = await cm.compile(BUDGET, clock(`t${i}`), { prefixIdentity: 'p0' });
        stripped.push(compiled.thinkingStripped ?? -1);
        cm.acceptRound({ provenance: compiled.provenance! });
        cm.addMessage('assistant', reply(`a${i}`, `S${i}`));
      }
      // Each compile strips the last two replies; the older of them it releases.
      assert.deepEqual(stripped, [0, 1, 2, 2, 2]);
      cm.close();
    });
  });

  it('engages every manager on the store when one of them accepts a round', async () => {
    await withStore(async (path) => {
      const a = await ContextManager.open({ path });
      const b = await ContextManager.open({ store: a.getStore() });
      a.addMessage('user', text('u1'));
      a.addMessage('assistant', reply('a1', 'S1'));
      a.addMessage('user', text('u2'));
      const before = await b.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(before), ['S1'], 'nothing accepted yet');
      const first = await a.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      a.acceptRound({ provenance: first.provenance! });
      const after = await b.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(after), [], 'S1 has no stamp, and the namespace is engaged');
      // B's round stands, and its reply is stored through A.
      b.acceptRound({ provenance: after.provenance! });
      a.addMessage('assistant', reply('a2', 'S2'));
      a.addMessage('user', text('u3'));
      const later = await b.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(later), ['S2'], 'one manager stamps what the other accepted');
      b.close();
      a.close();
    });
  });

  it('tells each manager’s strategy once the store is engaged, whichever manager accepted', async () => {
    await withStore(async (path) => {
      const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 8 });
      const b = await ContextManager.open({ path, strategy });
      const a = await ContextManager.open({ store: b.getStore() });
      b.addMessage('user', text('zz-u1'));
      b.addMessage('assistant', text('zz-a1'));
      b.addMessage('user', text('zz-u2'));
      b.addMessage('assistant', text('zz-a2'));
      b.addMessage('user', text('zz-u3'));
      const ids = (await b.compile(BUDGET, undefined, { prefixIdentity: 'p0', dryRun: true })).provenance!.messages
        .flatMap((s) => (s.kind === 'raw' ? s.bodies.map((x) => x.messageId) : []));
      strategy.seed({ id: 'L1-0', level: 1, content: 'the first exchange', tokens: 4, sourceLevel: 0,
        sourceIds: [ids[0]!, ids[1]!], sourceRange: { first: ids[0]!, last: ids[1]! },
        responseContent: [
          { type: 'thinking', thinking: '', signature: 'C1' } as ContentBlock,
          { type: 'text', text: 'the first exchange' },
        ] });
      const first = await a.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      a.acceptRound({ provenance: first.provenance! });
      const bound = await b.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.ok(bound.provenance!.messages.some((s) => s.kind === 'summary'), 'the summary renders');
      assert.deepEqual(signaturesIn(bound), []);
      assert.equal(bound.thinkingStripped, 0, 'the strategy no longer renders the carrier for the pass to strip');
      a.close();
      b.close();
    });
  });

  it('strips a reply when what came before it is edited after it was stored', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      await turn(cm, 'u1', 'a1', 'S1');
      cm.addMessage('user', text('look it up'));
      const sent = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: sent.provenance! });
      cm.addMessage('assistant', [{ type: 'tool_use', id: 'tu1', name: 'look', input: {} } as ContentBlock]);
      const result = cm.addMessage('user', [{ type: 'tool_result', toolUseId: 'tu1', content: text('original') } as ContentBlock]);
      cm.addMessage('assistant', reply('answer', 'S2'));
      // Between turns, the result the reply was minted after is edited.
      cm.editMessage(result, [{ type: 'tool_result', toolUseId: 'tu1', content: text('redacted') } as ContentBlock]);
      cm.addMessage('user', text('u3'));
      const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(next), ['S1']);
      assert.equal(next.thinkingStripped, 1);
      cm.close();
    });
  });

  it('stamps a reply from what was stored before it when it was stored, an edit just before it included', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      await turn(cm, 'u1', 'a1', 'S1');
      cm.addMessage('user', text('look it up'));
      const sent = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: sent.provenance! });
      cm.addMessage('assistant', [{ type: 'tool_use', id: 'tu1', name: 'look', input: {} } as ContentBlock]);
      // A host that stores a placeholder while the request carries the
      // result, and writes the result before the reply is stored.
      const result = cm.addMessage('user', [{ type: 'tool_result', toolUseId: 'tu1', content: text('[pending]') } as ContentBlock]);
      cm.editMessage(result, [{ type: 'tool_result', toolUseId: 'tu1', content: text('the result') } as ContentBlock]);
      cm.addMessage('assistant', reply('answer', 'S2'));
      cm.addMessage('user', text('u3'));
      const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(next), ['S1', 'S2']);
      cm.close();
    });
  });

  it('keeps the owner it chose across a reopen, when two compiles share a head', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      await turn(cm, 'u1', 'a1', 'S1');
      cm.addMessage('user', text('u2'));
      const heartbeat = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0+heartbeat' });
      const ordinary = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: ordinary.provenance! });
      cm.acceptRound({ provenance: heartbeat.provenance! });
      cm.addMessage('assistant', reply('a2', 'S2'));
      cm.close();
      const reopened = await ContextManager.open({ path });
      reopened.addMessage('user', text('u3'));
      const next = await reopened.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(next), ['S1', 'S2'], 'S2 follows the ordinary compile');
      reopened.close();
    });
  });

  it('records an acceptance once when its write reports a failure after landing', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      const store = cm.getStore() as unknown as { appendJson(type: string, payload: unknown): unknown };
      const append = store.appendJson.bind(store);
      let fail = true;
      store.appendJson = (type: string, payload: unknown) => {
        const written = append(type, payload);
        if (fail && type === THINKING_BINDING_RECORD) {
          fail = false;
          throw new Error('reported failure after landing');
        }
        return written;
      };
      cm.addMessage('user', text('u1'));
      const first = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.throws(() => cm.acceptRound({ provenance: first.provenance! }), /after landing/);
      cm.acceptRound({ provenance: first.provenance! });
      assert.equal(bindingRecords(cm), 1);
      cm.addMessage('assistant', reply('a1', 'S1'));
      cm.addMessage('user', text('u2'));
      const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.deepEqual(signaturesIn(next), ['S1'], 'the record that landed made the compile its branch\'s owner');
      cm.close();
    });
  });

  it('prices the layout as sent, and reads a message the pass emptied as omitted', async () => {
    await withStore(async (path) => {
      const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 100_000 });
      const cm = await ContextManager.open({ path, strategy });
      cm.addMessage('user', text('u1'));
      // A thinking-only reply, stored before any round was accepted.
      cm.addMessage('assistant', [{ type: 'thinking', thinking: '', signature: 'Q'.repeat(33_000) } as ContentBlock]);
      cm.addMessage('user', text('u2'));
      const first = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: first.provenance! });
      const second = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.equal(second.thinkingStripped, 1);
      const kinds = (r: CompileResult) => r.provenance!.layout!.units.map((u) => u.k);
      assert.deepEqual(kinds(first), ['r', 'r', 'r']);
      assert.deepEqual(kinds(second), ['r', 'o', 'r']);
      assert.ok(first.provenance!.layout!.totalTokens > 5_000, 'the thinking was sent, and priced');
      assert.ok(second.provenance!.layout!.totalTokens < 100, 'nothing of it was sent');
      cm.close();
    });
  });

  it('forgets compiles beyond its 32 most recent, and records nothing when one is accepted', async () => {
    await withStore(async (path) => {
      const cm = await ContextManager.open({ path });
      cm.addMessage('user', text('u1'));
      const oldest = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      for (let i = 0; i < 32; i++) await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      cm.acceptRound({ provenance: oldest.provenance! });
      assert.equal(bindingRecords(cm), 0);
      cm.close();
    });
  });

  describe('across a reopen', () => {
    it('keeps the stamps it recorded', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        await turn(cm, 'u1', 'a1', 'S1');
        await turn(cm, 'u2', 'a2', 'S2');
        // This compile stamps S2, and its acceptance records the stamp.
        await turn(cm, 'u3', 'a3', 'S3');
        const stamped = cm.getStore().getRecordIdsByType(THINKING_BINDING_RECORD).flatMap((rid) => {
          const record = JSON.parse(cm.getStore().getRecord(rid)!.payload.toString('utf8')) as { stamps?: [string][] };
          return (record.stamps ?? []).map(([mid]) => mid);
        });
        assert.equal(stamped.length, 2, 'S1 and S2, each in one record');
        assert.equal(new Set(stamped).size, 2);
        cm.close();
        const reopened = await ContextManager.open({ path });
        reopened.addMessage('user', text('u4'));
        const next = await reopened.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(next), ['S1', 'S2', 'S3']);
        assert.equal(next.thinkingStripped, 0);
        reopened.close();
      });
    });

    it('keeps the seed each stamp was minted under, so a one-turn seed releases nothing', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        await turn(cm, 'u1', 'a1', 'S1');
        await turn(cm, 'u2', 'a2', 'S2');
        await turn(cm, 'u3', 'a3', 'S3');
        cm.close();
        const reopened = await ContextManager.open({ path });
        reopened.addMessage('user', text('tick'));
        const heartbeat = await reopened.compile(BUDGET, undefined, { prefixIdentity: 'p0+heartbeat' });
        assert.equal(heartbeat.thinkingStripped, 3);
        reopened.acceptRound({ provenance: heartbeat.provenance! });
        reopened.addMessage('assistant', reply('quiet', 'H1'));
        reopened.addMessage('user', text('u4'));
        const ordinary = await reopened.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(ordinary), ['S1', 'S2', 'S3']);
        reopened.close();
      });
    });

    it('keeps what it released', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        await turn(cm, 'u1', 'a1', 'S1');
        await turn(cm, 'u2', 'a2', 'S2');
        // A lasting change releases at its second compile; the next acceptance records it.
        cm.addMessage('user', text('u3'));
        const first = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
        cm.acceptRound({ provenance: first.provenance! });
        const second = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
        assert.equal(second.thinkingStripped, 2);
        cm.acceptRound({ provenance: second.provenance! });
        const third = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
        cm.acceptRound({ provenance: third.provenance! });
        const releases = cm.getStore().getRecordIdsByType(THINKING_BINDING_RECORD).flatMap((rid) => {
          const record = JSON.parse(cm.getStore().getRecord(rid)!.payload.toString('utf8')) as { released?: [string][] };
          return (record.released ?? []).map(([mid]) => mid);
        });
        assert.equal(releases.length, 2, 'each release is recorded once');
        cm.close();
        const reopened = await ContextManager.open({ path });
        const next = await reopened.compile(BUDGET, undefined, { prefixIdentity: 'p1' });
        assert.equal(next.thinkingStripped, 0, 'released thinking stays out of the strategy’s view');
        assert.deepEqual(signaturesIn(next), []);
        // The copies lack thinking the store holds, so they are partial.
        const replies = next.provenance!.messages.flatMap((m) => (m.kind === 'raw' ? m.bodies : []))
          .filter((b) => reopened.getAllMessages().find((m) => m.id === b.messageId)?.participant === 'assistant');
        assert.equal(replies.length, 2);
        assert.ok(replies.every((b) => b.complete === false), 'judged against the store, not the released view');
        reopened.close();
      });
    });

    it('stays engaged', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        cm.addMessage('user', text('u1'));
        cm.addMessage('assistant', reply('a1', 'S1'));
        cm.addMessage('user', text('u2'));
        const first = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(first), ['S1']);
        cm.acceptRound({ provenance: first.provenance! });
        cm.close();
        const reopened = await ContextManager.open({ path });
        const next = await reopened.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(next), [], 'S1 has no stamp, and the pass is still engaged');
        reopened.close();
      });
    });
  });

  it('takes a summary’s carriers out of the live window and its pricing once thinking is bound', async () => {
    await withStore(async (path) => {
      const strategy = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 8 });
      const cm = await ContextManager.open({ path, strategy });
      cm.addMessage('user', text('zz-u1'));
      cm.addMessage('assistant', text('zz-a1'));
      cm.addMessage('user', text('zz-u2'));
      cm.addMessage('assistant', text('zz-a2'));
      cm.addMessage('user', text('zz-u3'));
      const ids = (await cm.compile(BUDGET)).provenance!.messages
        .flatMap((s) => (s.kind === 'raw' ? s.bodies.map((b) => b.messageId) : []));
      strategy.seed({ id: 'L1-0', level: 1, content: 'the first exchange', tokens: 4, sourceLevel: 0,
        sourceIds: [ids[0]!, ids[1]!], sourceRange: { first: ids[0]!, last: ids[1]! },
        responseContent: [
          { type: 'thinking', thinking: '', signature: 'C1' } as ContentBlock,
          { type: 'text', text: 'the first exchange' },
        ] });
      const unbound = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.ok(unbound.provenance!.messages.some((s) => s.kind === 'summary'), 'the summary rendered');
      assert.deepEqual(signaturesIn(unbound), ['C1'], 'carrierPolicy full: the carrier rides the live window');
      const internals = strategy as unknown as { summaries: SummaryEntry[]; recallPairCost(s: SummaryEntry): number };
      const summary = internals.summaries.find((x) => x.id === 'L1-0')!;
      const pricedWithCarrier = internals.recallPairCost(summary);
      cm.acceptRound({ provenance: unbound.provenance! });
      assert.ok(internals.recallPairCost(summary) < pricedWithCarrier, 'the plan stops pricing the carrier');
      const bound = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.ok(bound.provenance!.messages.some((s) => s.kind === 'summary'), 'the summary still renders');
      assert.deepEqual(signaturesIn(bound), []);
      assert.equal(bound.thinkingStripped, 0, 'the strategy no longer renders the carrier for the pass to strip');
      cm.close();
      // A strategy initialized on an engaged store knows from the start,
      // before its first compile.
      const fresh = new SeedableStrategy({ headWindowTokens: 0, recentWindowTokens: 8 });
      const reopened = await ContextManager.open({ path, strategy: fresh });
      const freshInternals = fresh as unknown as { summaries: SummaryEntry[]; recallPairCost(s: SummaryEntry): number };
      const reloaded = freshInternals.summaries.find((x) => x.id === 'L1-0')!;
      assert.ok(freshInternals.recallPairCost(reloaded) < pricedWithCarrier, 'priced without the carrier from the start');
      const afterReopen = await reopened.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
      assert.ok(afterReopen.provenance!.messages.some((s) => s.kind === 'summary'), 'the summary renders after a reopen');
      assert.equal(afterReopen.thinkingStripped, 0);
      reopened.close();
    });
  });
  describe('a host’s own release', () => {
    const releasesRecorded = (cm: ContextManager): Array<[string, number]> =>
      cm.getStore().getRecordIdsByType(THINKING_BINDING_RECORD).flatMap((rid) => {
        const record = JSON.parse(cm.getStore().getRecord(rid)!.payload.toString('utf8')) as { released?: Array<[string, number]> };
        return record.released ?? [];
      });
    const idOf = (cm: ContextManager, sig: string): string =>
      cm.getAllMessages().find((m) => m.content.some((b) => (b as { signature?: string }).signature === sig))!.id;

    it('stops sending what the host releases, records it with the next acceptance, and keeps it across a reopen', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        await turn(cm, 'u1', 'a1', 'S1');
        await turn(cm, 'u2', 'a2', 'S2');
        cm.addMessage('user', text('u3'));
        // The provider refused S1: the host releases it.
        cm.releaseThinking(idOf(cm, 'S1'));
        const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(next), [], 'S1 is released, and S2 was minted after it');
        assert.equal(next.thinkingStripped, 1, 'the view no longer holds S1; the pass strips S2');
        assert.ok(next.messages.some((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === 'a1')),
          'the reply itself stays');
        assert.deepEqual(releasesRecorded(cm), [], 'nothing recorded before an acceptance');
        cm.acceptRound({ provenance: next.provenance! });
        assert.deepEqual(releasesRecorded(cm).map(([id]) => id).sort(), [idOf(cm, 'S1'), idOf(cm, 'S2')].sort());
        cm.close();
        const reopened = await ContextManager.open({ path });
        const after = await reopened.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(after), []);
        assert.equal(after.thinkingStripped, 0);
        reopened.close();
      });
    });

    it('keeps the thinking before the block it releases from', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        cm.addMessage('user', text('u1'));
        const first = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        cm.acceptRound({ provenance: first.provenance! });
        const id = cm.addMessage('assistant', [
          { type: 'thinking', thinking: '', signature: 'T1' } as ContentBlock,
          { type: 'text', text: 'first' },
          { type: 'thinking', thinking: '', signature: 'T2' } as ContentBlock,
          { type: 'text', text: 'second' },
        ]);
        cm.addMessage('user', text('u2'));
        cm.releaseThinking(id, 2);
        cm.releaseThinking(id, 3);
        const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(next), ['T1'], 'a later call keeps the earlier block');
        cm.close();
      });
    });

    it('releases before the pass is engaged too', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        cm.addMessage('user', text('u1'));
        cm.addMessage('assistant', reply('a1', 'S1'));
        cm.addMessage('user', text('u2'));
        cm.releaseThinking(idOf(cm, 'S1'));
        const next = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(next), []);
        cm.close();
      });
    });

    it('releases on the current branch only', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        await turn(cm, 'u1', 'a1', 'S1');
        cm.addMessage('user', text('u2'));
        const main = cm.currentBranch().name;
        await cm.fork('zz-other');
        cm.releaseThinking(idOf(cm, 'S1'));
        const there = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(there), []);
        await cm.switchBranch(main);
        const here = await cm.compile(BUDGET, undefined, { prefixIdentity: 'p0' });
        assert.deepEqual(signaturesIn(here), ['S1']);
        cm.close();
      });
    });

    it('refuses a message the branch doesn’t hold, and a block that isn’t one of its blocks', async () => {
      await withStore(async (path) => {
        const cm = await ContextManager.open({ path });
        cm.addMessage('user', text('u1'));
        const id = cm.addMessage('assistant', reply('a1', 'S1'));
        assert.throws(() => cm.releaseThinking('zz-no-such-message'), /holds no message/);
        assert.throws(() => cm.releaseThinking(id, -1), /block index/);
        assert.throws(() => cm.releaseThinking(id, 1.5), /block index/);
        assert.throws(() => cm.releaseThinking(id, 2), /has 2 blocks/);
        cm.close();
      });
    });
  });
});
