/**
 * Thinking binding (#155): on a model that binds each signed thinking block
 * to the request it was minted in, a compile leaves out the thinking whose
 * request has changed since, against a per-branch record of what the branch
 * last sent (src/thinking-binding.ts, SelectOptions.thinkingBinding).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '../src/index.js';
import type {
  CompileResult,
  CompiledMessageSources,
  ContextEntry,
  ContextInjection,
  ContextLogView,
  ContextStrategy,
  MessageId,
  MessageStoreView,
  RawBodySource,
  ReadinessState,
  RequestIdentity,
  ThinkingBinding,
  ThinkingStrip,
  TokenBudget,
} from '../src/index.js';
import type { RequestIdentity as RequestIdentityFromTypes, SelectOptions, ThinkingStrip as ThinkingStripFromTypes } from '../src/types/index.js';
import { UNVOUCHED, bindThinking, markThinkingLeftOut, messageDigest, type BindingRecord } from '../src/thinking-binding.js';
import { renderAdaptiveFixture } from './fixtures/recall-envelope-fixture.js';

const STORE = './test-thinking-binding';
const STORE_B = './test-thinking-binding-b';

function cleanup() {
  for (const path of [STORE, STORE_B]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const thought = (n: number): ContentBlock =>
  ({ type: 'thinking', thinking: `zz-reasoning-${n} `.repeat(20), signature: `zz-sig-${n}-0123456789abcdef` }) as ContentBlock;
const redacted = (n: number): ContentBlock => ({ type: 'redacted_thinking', data: `zz-enc-${n}-payload==` }) as unknown as ContentBlock;
const isThinking = (b: ContentBlock) => b.type === 'thinking' || (b.type as string) === 'redacted_thinking';
const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'zz_search', input: { q: id } }) as ContentBlock;
const toolResult = (id: string, content: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content }) as ContentBlock;

const identity = (over: Partial<RequestIdentity> = {}): RequestIdentity =>
  ({ system: 'zz-system-1', tools: 'zz-tools-1', model: 'zz-model-1', request: 'zz-request-1', ...over });
/** The options a binding compile takes, as agent-framework passes them. */
const bind = (over: { dropBlock?: boolean; identity?: Partial<RequestIdentity>; dryRun?: boolean } = {}): SelectOptions => {
  const binding: ThinkingBinding = { binds: true, dropBlock: over.dropBlock === true, participant: 'Claude' };
  return { thinkingBinding: binding, identity: identity(over.identity), ...(over.dryRun ? { dryRun: true } : {}) };
};
const BIND = bind();
const BIND_DROP = bind({ dropBlock: true });
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };

/** Which compiled messages carry thinking, by their text. */
function thinkingByText(result: CompileResult): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of result.messages) {
    const label = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('|');
    out[label || m.content.map((b) => b.type).join('+')] = m.content.some(isThinking);
  }
  return out;
}

async function open(path = STORE, strategy: ContextStrategy = new PassthroughStrategy(), namespace?: string) {
  return ContextManager.open({ path, strategy, ...(namespace ? { namespace } : {}) });
}

/** U1, A1 (thinking), U2, A2 (thinking). */
function seed(manager: ContextManager): { a1: MessageId; a2: MessageId } {
  manager.addMessage('User', [text('U1')]);
  const a1 = manager.addMessage('Claude', [thought(1), text('A1')]);
  manager.addMessage('User', [text('U2')]);
  const a2 = manager.addMessage('Claude', [thought(2), text('A2')]);
  return { a1, a2 };
}

function recordOf(manager: ContextManager, namespace = 'default'): unknown {
  return manager.getStore().getStateJson(`${namespace}/thinking-binding`);
}

/** The compile id the branch's record holds, in the manager's namespace, if any. */
function recordCompileId(manager: ContextManager): string {
  const namespace = (manager as unknown as { strategyNamespace: string }).strategyNamespace;
  const id = (recordOf(manager, namespace) as { compileId?: unknown } | null)?.compileId;
  return typeof id === 'string' ? id : 'zz-no-record';
}

/** Note rows for the stream of the compile that wrote the branch's record,
 *  as a host does with that compile's provenance.compileId. */
function note(
  manager: ContextManager,
  rows: ReadonlyArray<MessageId | { unstored: true }>,
  identity: RequestIdentity,
  compileId = recordCompileId(manager),
): boolean {
  return manager.noteRequestSent(rows, identity, compileId);
}

/** The budget the newest `n` messages take, as the passthrough strategy prices them. */
function tokensOfNewest(manager: ContextManager, n: number): number {
  const store = (manager as unknown as { messageStore: { estimateTokens(m: unknown): number } }).messageStore;
  return manager.getAllMessages().slice(-n).reduce((sum, m) => sum + store.estimateTokens(m), 0);
}

/** Passthrough that counts its selects, and can render a header ahead of
 *  each tool result message (`header`). */
class Watching extends PassthroughStrategy {
  selects = 0;
  header = false;
  select(store: MessageStoreView, log: ContextLogView, budget: TokenBudget): ContextEntry[] {
    this.selects++;
    return super.select(store, log, budget).map((entry) => {
      const headed = this.header && entry.content.some((b) => b.type === 'tool_result');
      return headed ? { ...entry, content: [text('zz-header'), ...entry.content] } : entry;
    });
  }
}

/** U1, a committing compile, then a stream's first round: A1 calling a
 *  tool, and its result. */
async function streamTurn(manager: ContextManager): Promise<{ a1: MessageId; r1: MessageId }> {
  manager.addMessage('User', [text('U1')]);
  await manager.compile(BIG, undefined, BIND_DROP);
  const a1 = manager.addMessage('Claude', [thought(1), text('A1'), toolUse('t1')]);
  const r1 = manager.addMessage('User', [toolResult('t1', 'zz-result')]);
  return { a1, r1 };
}

describe('thinking binding: compile', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('without binds, a compile is unchanged and records nothing', async () => {
    cleanup();
    const manager = await open();
    seed(manager);
    const plain = await manager.compile(BIG);
    const off = await manager.compile(BIG, undefined, { thinkingBinding: { binds: false } });
    assert.deepEqual(off.messages, plain.messages);
    assert.equal(off.thinkingStrip, undefined);
    assert.equal(off.thinkingRecordedAfter, undefined);
    assert.ok(plain.messages.filter((m) => m.content.some(isThinking)).length === 2, 'setup: both replies carry thinking');
    assert.equal(recordOf(manager), null);
    await manager.close();
  });

  it('with no record and no drop control, leaves out every reply\u2019s thinking once; a reply the host notes keeps its own', async () => {
    cleanup();
    const manager = await open();
    const { a1, a2 } = seed(manager);
    const u3 = manager.addMessage('User', [text('U3')]);
    const first = await manager.compile(BIG, undefined, BIND);
    assert.deepEqual(thinkingByText(first), { U1: false, A1: false, U2: false, A2: false, U3: false });
    assert.deepEqual(first.thinkingStrip, { newly: [a1, a2], cause: 'first' });
    assert.ok(first.thinkingRecordedAfter! >= manager.getMessage(u3)!.sequence, 'at or above every message stored before');

    const a3 = manager.addMessage('Claude', [thought(3), text('A3')]);
    note(manager, [a3], identity());
    manager.addMessage('User', [text('U4')]);
    const next = await manager.compile(BIG, undefined, BIND);
    assert.deepEqual(thinkingByText(next), { U1: false, A1: false, U2: false, A2: false, U3: false, A3: true, U4: false });
    assert.equal(next.thinkingStrip, undefined, 'nothing newly left out');
    assert.equal(next.thinkingRecordedAfter, first.thinkingRecordedAfter, 'where the record began stays put');
    await manager.close();
  });

  it('with no record and the drop control, leaves the replies\u2019 thinking and starts the record', async () => {
    cleanup();
    const manager = await open();
    const { a2 } = seed(manager);
    const first = await manager.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(thinkingByText(first), { U1: false, A1: true, U2: false, A2: true });
    assert.equal(first.thinkingStrip, undefined);
    assert.ok(first.thinkingRecordedAfter! >= manager.getMessage(a2)!.sequence);
    assert.notEqual(recordOf(manager), null);
    await manager.close();
  });

  it('a record begun under the drop control hands its earlier replies to no compile without it', async () => {
    cleanup();
    const manager = await open();
    const { a1, a2 } = seed(manager);
    await manager.compile(BIG, undefined, BIND_DROP);
    manager.addMessage('User', [text('U3')]);
    const a3 = manager.addMessage('Claude', [thought(3), text('A3')]);
    const without = await manager.compile(BIG, undefined, BIND);
    // A3 was minted after A1 and A2 with their thinking, so it goes too.
    assert.deepEqual(thinkingByText(without), { U1: false, A1: false, U2: false, A2: false, U3: false, A3: false });
    assert.deepEqual(without.thinkingStrip, { newly: [a1, a2, a3], cause: 'first' });
    const next = await manager.compile(BIG, undefined, BIND);
    assert.equal(next.thinkingStrip, undefined, 'control: nothing newly left out after');
    await manager.close();
  });

  it('a moved injection: replies after its old place lose their thinking, earlier ones keep it, and a lost one stays lost', async () => {
    cleanup();
    const manager = await open();
    const { a2 } = seed(manager);
    const lesson: ContextInjection = { namespace: 'zz-lessons', position: 'afterUser', content: [text('zz-lesson')] };
    const first = await manager.compile(BIG, [lesson], BIND_DROP);
    assert.deepEqual(first.messages.map((m) => m.participant), ['User', 'Claude', 'User', 'system_context:zz-lessons', 'Claude']);

    manager.addMessage('User', [text('U3')]);
    const moved = await manager.compile(BIG, [lesson], BIND_DROP);
    assert.deepEqual(thinkingByText(moved), { U1: false, A1: true, U2: false, A2: false, U3: false, 'zz-lesson': false });
    assert.deepEqual(moved.thinkingStrip, { newly: [a2], cause: 'messages' });

    const again = await manager.compile(BIG, [lesson], BIND_DROP);
    assert.deepEqual(thinkingByText(again), thinkingByText(moved), 'A2 goes without again, and A1 keeps');
    assert.equal(again.thinkingStrip, undefined, 'A2 was left out before, so not newly');
    await manager.close();
  });

  it('oldest messages leaving the window change the first message, so later replies lose their thinking, without the drop control too', async () => {
    cleanup();
    const manager = await open();
    seed(manager);
    manager.addMessage('User', [text('U3')]);
    await manager.compile(BIG, undefined, BIND);
    const a3 = manager.addMessage('Claude', [thought(3), text('A3')]);
    note(manager, [a3], identity());
    const kept = await manager.compile(BIG, undefined, BIND);
    assert.equal(thinkingByText(kept).A3, true, 'setup: A3 keeps its thinking');
    // A budget that fits only the newest two messages: the rest fall out.
    const tight = await manager.compile({ maxTokens: tokensOfNewest(manager, 2), reserveForResponse: 0 }, undefined, BIND);
    assert.deepEqual(thinkingByText(tight), { U3: false, A3: false });
    assert.deepEqual(tight.thinkingStrip, { newly: [a3], cause: 'messages' });
    await manager.close();
  });

  it('a stream\u2019s replies keep their thinking when the host notes each round and the last reply, and lose it, never refused, when it doesn\u2019t', async () => {
    for (const noted of ['every note', 'rounds only', 'none'] as const) {
      cleanup();
      const manager = await open();
      const run = await streamTurn(manager);
      if (noted !== 'none') assert.equal(note(manager, [run.a1, run.r1], identity()), true);
      const a2 = manager.addMessage('Claude', [thought(2), text('A2')]);
      // The stream's end: the last reply is stored, then noted.
      if (noted === 'every note') note(manager, [run.a1, run.r1, a2], identity());
      manager.addMessage('User', [text('U2')]);
      const next = await manager.compile(BIG, undefined, BIND_DROP);
      const expected = { 'every note': [true, true], 'rounds only': [true, false], none: [false, false] }[noted];
      assert.deepEqual(thinkingByText(next), { U1: false, A1: expected[0], tool_result: false, A2: expected[1], U2: false }, noted);
      const newly = [...(expected[0] ? [] : [run.a1]), ...(expected[1] ? [] : [a2])];
      assert.deepEqual(next.thinkingStrip, newly.length > 0 ? { newly, cause: 'messages' } : undefined, noted);
      await manager.close();
    }
  });

  it('a write between a stream\u2019s rounds that the stream didn\u2019t send leaves out the reply after it', async () => {
    cleanup();
    const manager = await open();
    manager.addMessage('User', [text('U1')]);
    await manager.compile(BIG, undefined, BIND_DROP);
    const a1 = manager.addMessage('Claude', [thought(1), text('A1'), toolUse('t1')]);
    manager.addMessage('Other', [text('zz-interleaved')]);
    const r1 = manager.addMessage('User', [toolResult('t1', 'zz-result')]);
    note(manager, [a1, r1], identity());
    const a2 = manager.addMessage('Claude', [thought(2), text('A2')]);
    note(manager, [a1, r1, a2], identity());
    const next = await manager.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(thinkingByText(next), { U1: false, A1: true, 'zz-interleaved': false, tool_result: false, A2: false });
    assert.deepEqual(next.thinkingStrip, { newly: [a2], cause: 'messages' });
    await manager.close();
  });

  it('a write in an auxiliary slot between a stream\u2019s rounds leaves out the reply after it', async () => {
    cleanup();
    const main = await open();
    const side = await ContextManager.open({
      store: main.getStore(), namespace: 'zz-side', isolate: true, strategy: new PassthroughStrategy(), auxiliaryMessageViews: [{}],
    });
    side.addMessage('User', [text('U1')]);
    await side.compile(BIG, undefined, BIND_DROP);
    const a1 = side.addMessage('Claude', [thought(1), text('A1'), toolUse('t1')]);
    main.addMessage('Other', [text('zz-auxiliary')]);
    const r1 = side.addMessage('User', [toolResult('t1', 'zz-result')]);
    note(side, [a1, r1], identity());
    const a2 = side.addMessage('Claude', [thought(2), text('A2')]);
    note(side, [a1, r1, a2], identity());
    const next = await side.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(thinkingByText(next), { U1: false, A1: true, 'zz-auxiliary': false, tool_result: false, A2: false });
    assert.deepEqual(next.thinkingStrip, { newly: [a2], cause: 'messages' });
    await side.close();
    await main.close();
  });

  it('an edit to a noted row, which keeps its sequence, leaves out the reply after it', async () => {
    cleanup();
    const manager = await open();
    const run = await streamTurn(manager);
    note(manager, [run.a1, run.r1], identity());
    const a2 = manager.addMessage('Claude', [thought(2), text('A2')]);
    note(manager, [run.a1, run.r1, a2], identity());
    const sequence = manager.getMessage(run.r1)!.sequence;
    manager.editMessage(run.r1, [toolResult('t1', 'zz-edited')]);
    assert.equal(manager.getMessage(run.r1)!.sequence, sequence, 'setup: the edit keeps the sequence');
    const next = await manager.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(thinkingByText(next), { U1: false, A1: true, tool_result: false, A2: false });
    assert.deepEqual(next.thinkingStrip, { newly: [a2], cause: 'messages' });
    await manager.close();
  });

  it('a noted row removed, or one the view filter leaves out, leaves out the reply after it', async () => {
    for (const how of ['removed', 'filtered'] as const) {
      cleanup();
      const manager = await ContextManager.open({
        path: STORE, strategy: new PassthroughStrategy(),
        viewFilter: (message) => !(message.metadata as { hidden?: unknown } | undefined)?.hidden,
      });
      const run = await streamTurn(manager);
      const injected = manager.addMessage('User', [text('zz-injected')], how === 'filtered' ? { hidden: true } : undefined);
      note(manager, [run.a1, run.r1, injected], identity());
      const a2 = manager.addMessage('Claude', [thought(2), text('A2')]);
      note(manager, [run.a1, run.r1, injected, a2], identity());
      if (how === 'removed') manager.removeMessage(injected);
      const next = await manager.compile(BIG, undefined, BIND_DROP);
      assert.deepEqual(thinkingByText(next), { U1: false, A1: true, tool_result: false, A2: false }, how);
      assert.deepEqual(next.thinkingStrip, { newly: [a2], cause: 'messages' }, how);
      await manager.close();
    }
  });

  it('a row the compile renders with an addition leaves out the reply after it', async () => {
    cleanup();
    const strategy = new Watching();
    const manager = await open(STORE, strategy);
    const run = await streamTurn(manager);
    note(manager, [run.a1, run.r1], identity());
    const a2 = manager.addMessage('Claude', [thought(2), text('A2')]);
    note(manager, [run.a1, run.r1, a2], identity());
    const control = await manager.compile(BIG, undefined, { ...BIND_DROP, dryRun: true });
    assert.equal(thinkingByText(control).A2, true, 'control: rendered as stored, A2 keeps its thinking');
    strategy.header = true;
    const decorated = await manager.compile(BIG, undefined, BIND_DROP);
    assert.equal(thinkingByText(decorated).A2, false);
    await manager.close();
  });

  it('past a row noted as unstored, nothing keeps its thinking', async () => {
    cleanup();
    const manager = await open();
    const run = await streamTurn(manager);
    note(manager, [run.a1, { unstored: true }], identity());
    const a2 = manager.addMessage('Claude', [thought(2), text('A2')]);
    note(manager, [run.a1, { unstored: true }, a2], identity());
    const next = await manager.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(thinkingByText(next), { U1: false, A1: true, tool_result: false, A2: false });
    assert.deepEqual(next.thinkingStrip, { newly: [a2], cause: 'messages' });
    await manager.close();
  });

  it('a noted row is digested as renderAsNewest renders it, and one it renders as null matches nothing', async () => {
    for (const render of ['as-stored', 'null', 'otherwise'] as const) {
      cleanup();
      class Rendering extends PassthroughStrategy {
        renderAsNewest(store: MessageStoreView, ids: readonly MessageId[]): Array<ContentBlock[] | null> {
          return ids.map((id) => {
            const content = store.get(id)!.content;
            const result = content.some((b) => b.type === 'tool_result');
            if (!result || render === 'as-stored') return content;
            return render === 'null' ? null : [text('zz-other'), ...content];
          });
        }
      }
      const manager = await open(STORE, new Rendering());
      const run = await streamTurn(manager);
      note(manager, [run.a1, run.r1], identity());
      const a2 = manager.addMessage('Claude', [thought(2), text('A2')]);
      note(manager, [run.a1, run.r1, a2], identity());
      const next = await manager.compile(BIG, undefined, BIND_DROP);
      assert.equal(thinkingByText(next).A2, render === 'as-stored', render);
      await manager.close();
    }
  });

  it('with no renderAsNewest, a noted body stored as shards matches nothing', async () => {
    cleanup();
    class Sharding extends PassthroughStrategy {
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        const body = content.length === 1 && content[0]!.type === 'text' ? (content[0] as { text: string }).text : '';
        if (!body.startsWith('zz-shard')) return null;
        const half = Math.floor(body.length / 2);
        return {
          bodyGroupId: 'zz-group',
          shards: [
            { content: [text(body.slice(0, half))], shardIndex: 0 },
            { content: [text(body.slice(half))], shardIndex: 1 },
          ],
        };
      }
    }
    const manager = await open(STORE, new Sharding());
    manager.addMessage('User', [text('U1')]);
    await manager.compile(BIG, undefined, BIND_DROP);
    const before = manager.getAllMessages().length;
    const shard = manager.addMessage('User', [text('zz-shard ' + 'y'.repeat(100))]);
    assert.equal(manager.getAllMessages().length, before + 2, 'setup: stored as two shards');
    const plain = manager.addMessage('User', [text('zz-plain')]);
    note(manager, [shard, plain], identity());
    const noted = recordOf(manager) as BindingRecord;
    assert.equal(noted.continued[0], UNVOUCHED);
    assert.notEqual(noted.continued[1], UNVOUCHED, 'control: an unsharded row is digested');
    await manager.close();
  });

  it('noteRequestSent writes nothing on a branch with no record, and refuses what it can\u2019t record before writing', async () => {
    cleanup();
    const manager = await open();
    manager.addMessage('User', [text('U1')]);
    const a1 = manager.addMessage('Claude', [thought(1), text('A1')]);
    assert.equal(note(manager, [a1], identity()), false, 'no record yet');
    assert.equal(note(manager, ['zz-missing'], identity()), false, 'an unknown id, with no record');
    assert.equal(recordOf(manager), null);
    await manager.compile(BIG, undefined, BIND);
    const before = recordOf(manager) as BindingRecord;
    assert.deepEqual(before.without, [a1], 'setup: the compile left A1 out');
    const recorded = JSON.stringify(recordOf(manager));
    const refused: Array<[string, () => unknown, RegExp]> = [
      ['rows not a list', () => note(manager, 'zz' as unknown as MessageId[], identity()), /`rows` must be an array/],
      ['a row of neither kind', () => note(manager, [a1, { unstored: false } as unknown as { unstored: true }], identity()), /row 1 must be a message id or \{ unstored: true \}/],
      ['no identity', () => note(manager, [a1], undefined as unknown as RequestIdentity), /`identity` must be an object/],
      ['a digest not a string', () => note(manager, [a1], { ...identity(), model: 3 as unknown as string }), /`identity.model` must be a string, got number/],
      ['a compileId not a string', () => manager.noteRequestSent([a1], identity(), undefined as unknown as string), /`compileId` must be a string, the provenance.compileId of the compile the stream was built from; got undefined/],
    ];
    for (const [label, call, message] of refused) {
      assert.throws(call, (error: unknown) => error instanceof Error && message.test(error.message), label);
    }
    assert.equal(JSON.stringify(recordOf(manager)), recorded, 'the record is as it was');
    // An id the store doesn't hold, as after a removal, vouches for nothing, as the marker does.
    assert.equal(note(manager, [a1, 'zz-missing', { unstored: true }], identity()), true);
    const noted = recordOf(manager) as BindingRecord;
    assert.equal(noted.continued.length, 3);
    assert.notEqual(noted.continued[0], UNVOUCHED, 'control: a stored row is digested');
    assert.equal(noted.continued[1], UNVOUCHED);
    assert.equal(noted.continued[2], UNVOUCHED);
    assert.deepEqual(noted.sent, before.sent, 'the compiled part stays');
    assert.deepEqual(noted.without, before.without, 'and what it left out');
    assert.equal(noted.recordedAfter, before.recordedAfter, 'and where the record began');
    // A compile starts the request over.
    await manager.compile(BIG, undefined, BIND);
    assert.deepEqual((recordOf(manager) as BindingRecord).continued, []);
    await manager.close();
  });

  it('a note is for the stream of the compile that wrote the record: after another committing compile with binds it writes nothing, and a dry compile or one without binds changes nothing', async () => {
    // previewContext calls the strategy alone and never reaches the record.
    for (const between of ['a committing compile', 'a committing compile without binds', 'a dry compile', 'nothing'] as const) {
      cleanup();
      const manager = await open();
      manager.addMessage('User', [text('U1')]);
      const c1 = await manager.compile(BIG, undefined, BIND);
      // Stored while C1's stream is open, so C1's reply was minted without it.
      manager.addMessage('User', [text('zz-X')]);
      if (between === 'a committing compile') await manager.compile(BIG, undefined, BIND);
      if (between === 'a committing compile without binds') await manager.compile(BIG);
      if (between === 'a dry compile') await manager.compile(BIG, undefined, bind({ dryRun: true }));
      const a1 = manager.addMessage('Claude', [thought(1), text('A1')]);
      const accepted = manager.noteRequestSent([a1], identity(), c1.provenance!.compileId);
      assert.equal(accepted, between !== 'a committing compile', between);
      const next = await manager.compile(BIG, undefined, BIND);
      // Where C1's record still stands, X sits where its note put A1, so A1
      // goes without its thinking as well; only the committing compile's
      // record would have lined A1 up with the note, and it refused the note.
      assert.equal(thinkingByText(next).A1, false, between);
      await manager.close();
    }
    // The control: C1's own stream, noted under C1's id, keeps its reply's thinking.
    cleanup();
    const manager = await open();
    manager.addMessage('User', [text('U1')]);
    const c1 = await manager.compile(BIG, undefined, BIND);
    await manager.compile(BIG, undefined, bind({ dryRun: true }));
    // A compile without binds leaves the record, so C1's stream still notes.
    await manager.compile(BIG);
    const a1 = manager.addMessage('Claude', [thought(1), text('A1')]);
    assert.equal(manager.noteRequestSent([a1], identity(), c1.provenance!.compileId), true);
    assert.equal(manager.noteRequestSent([a1], identity(), 'zz-another-compile'), false, 'another compile\u2019s id writes nothing');
    assert.equal(manager.noteRequestSent([a1], identity(), c1.provenance!.compileId), true, 'a later note of the same stream, under the same id');
    const next = await manager.compile(BIG, undefined, BIND);
    assert.equal(thinkingByText(next).A1, true, 'control');
    await manager.close();
  });

  it('each note carries every round so far; a note of the latest round alone leaves out the rounds before', async () => {
    for (const cumulative of [true, false]) {
      cleanup();
      const manager = await open();
      const run = await streamTurn(manager);
      note(manager, [run.a1, run.r1], identity());
      const a2 = manager.addMessage('Claude', [thought(2), text('A2'), toolUse('t2')]);
      const r2 = manager.addMessage('User', [toolResult('t2', 'zz-result-2')]);
      note(manager, cumulative ? [run.a1, run.r1, a2, r2] : [a2, r2], identity());
      const a3 = manager.addMessage('Claude', [thought(3), text('A3')]);
      note(manager, cumulative ? [run.a1, run.r1, a2, r2, a3] : [a3], identity());
      const next = await manager.compile(BIG, undefined, BIND_DROP);
      assert.deepEqual(thinkingByText(next), { U1: false, A1: cumulative, tool_result: false, A2: cumulative, A3: cumulative }, `cumulative: ${cumulative}`);
      if (!cumulative) assert.deepEqual(next.thinkingStrip, { newly: [run.a1, a2, a3], cause: 'messages' });
      await manager.close();
    }
  });

  it('a note sent with another head leaves a record that vouches for no thinking, until the next committing compile', async () => {
    for (const later of [false, true]) {
      for (const next of ['new head', 'old head'] as const) {
        const label = `${next}${later ? ', after a later note under the record\u2019s head' : ''}`;
        cleanup();
        const manager = await open();
        seed(manager);
        manager.addMessage('User', [text('U3')]);
        await manager.compile(BIG, undefined, BIND_DROP);
        const a3 = manager.addMessage('Claude', [thought(3), text('A3')]);
        note(manager, [a3], identity({ tools: 'zz-tools-2' }));
        // A later note under the record's own head doesn't take the mark away.
        if (later) note(manager, [a3], identity());
        const head = next === 'new head' ? { tools: 'zz-tools-2' } : {};
        const after = await manager.compile(BIG, undefined, bind({ dropBlock: true, identity: head }));
        assert.deepEqual(thinkingByText(after), { U1: false, A1: false, U2: false, A2: false, U3: false, A3: false }, label);
        // The record kept its own head, so only a compile under the new one reports a head change.
        assert.equal(after.thinkingStrip?.cause, next === 'new head' ? 'head' : 'messages', label);
        if (next === 'new head') assert.deepEqual(after.thinkingStrip?.changed, ['tools'], label);
        // The compile starts a record again, which vouches as usual.
        const again = await manager.compile(BIG, undefined, bind({ dropBlock: true, identity: head }));
        assert.equal(again.thinkingStrip, undefined, `${label}: nothing newly left out once the compile records again`);
        await manager.close();
      }
    }
    // A later note's rows can't line up with a compile's first messages either:
    // here the window keeps only the noted reply and what follows it.
    cleanup();
    const manager = await open();
    seed(manager);
    manager.addMessage('User', [text('U3')]);
    await manager.compile(BIG, undefined, BIND_DROP);
    const a3 = manager.addMessage('Claude', [thought(3), text('A3')]);
    note(manager, [a3], identity({ tools: 'zz-tools-2' }));
    note(manager, [a3], identity());
    manager.addMessage('User', [text('U4')]);
    const windowed = await manager.compile({ maxTokens: tokensOfNewest(manager, 2), reserveForResponse: 0 }, undefined, { ...BIND_DROP, dryRun: true });
    assert.deepEqual(thinkingByText(windowed), { A3: false, U4: false }, 'the window starts at the noted reply, which goes without its thinking');
    await manager.close();
  });

  it('a noted row removed, by this manager or another on the shared slot, mid-stream or after, leaves out the replies after it', async () => {
    for (const how of ['this manager', 'another manager', 'mid-stream'] as const) {
      cleanup();
      const main = await open();
      const side = await ContextManager.open({ store: main.getStore(), namespace: 'zz-side', strategy: new PassthroughStrategy() });
      side.addMessage('User', [text('U1')]);
      await side.compile(BIG, undefined, BIND_DROP);
      const a1 = side.addMessage('Claude', [thought(1), text('A1'), toolUse('t1')]);
      const r1 = side.addMessage('User', [toolResult('t1', 'zz-result')]);
      const extra = side.addMessage('User', [text('zz-extra')]);
      note(side, [a1, r1, extra], identity());
      if (how === 'mid-stream') side.removeMessage(extra);
      const a2 = side.addMessage('Claude', [thought(2), text('A2')]);
      // The end note names the removed row by its id, which now vouches for nothing.
      assert.equal(note(side, [a1, r1, extra, a2], identity()), true, how);
      if (how === 'this manager') side.removeMessage(extra);
      if (how === 'another manager') main.removeMessage(extra);
      const next = await side.compile(BIG, undefined, BIND_DROP);
      assert.deepEqual(thinkingByText(next), { U1: false, A1: true, tool_result: false, A2: false }, how);
      await side.close();
      await main.close();
    }
  });

  it('an edit to the noted last reply, ahead of its thinking or after it, leaves out its thinking', async () => {
    for (const where of ['ahead', 'after'] as const) {
      cleanup();
      const manager = await open();
      manager.addMessage('User', [text('U1')]);
      await manager.compile(BIG, undefined, BIND_DROP);
      const a1 = manager.addMessage('Claude', [thought(1), text('A1')]);
      note(manager, [a1], identity());
      const control = await manager.compile(BIG, undefined, { ...BIND_DROP, dryRun: true });
      assert.equal(thinkingByText(control).A1, true, `control, ${where}`);
      manager.editMessage(a1, where === 'ahead' ? [text('zz-edit'), thought(1), text('A1')] : [thought(1), text('A1 edited')]);
      const next = await manager.compile(BIG, undefined, BIND_DROP);
      assert.deepEqual(next.thinkingStrip, { newly: [a1], cause: 'messages' }, where);
      await manager.close();
    }
  });

  it('a single-round turn keeps its reply\u2019s thinking when the host notes it, and loses only that reply\u2019s when it doesn\u2019t, as when the host stops before its note', async () => {
    for (const noted of [true, false]) {
      cleanup();
      const manager = await open();
      manager.addMessage('User', [text('U1')]);
      await manager.compile(BIG, undefined, BIND_DROP);
      const a1 = manager.addMessage('Claude', [thought(1), text('A1')]);
      note(manager, [a1], identity());
      manager.addMessage('User', [text('U2')]);
      await manager.compile(BIG, undefined, BIND_DROP);
      const a2 = manager.addMessage('Claude', [thought(2), text('A2')]);
      if (noted) note(manager, [a2], identity());
      manager.addMessage('User', [text('U3')]);
      const next = await manager.compile(BIG, undefined, BIND_DROP);
      assert.deepEqual(thinkingByText(next), { U1: false, A1: true, U2: false, A2: noted, U3: false }, `noted: ${noted}`);
      assert.deepEqual(next.thinkingStrip, noted ? undefined : { newly: [a2], cause: 'messages' }, `noted: ${noted}`);
      await manager.close();
    }
  });

  it('a noted row is digested as the compile sends it: a result under another participant as the user\u2019s, a bundled tool cycle as each part', async () => {
    cleanup();
    const manager = await open();
    manager.addMessage('User', [text('U1')]);
    const c1 = await manager.compile(BIG, undefined, BIND_DROP);
    const a1 = manager.addMessage('Claude', [thought(1), toolUse('t1')]);
    const r1 = manager.addMessage('Tool', [toolResult('t1', 'zz-result')]);
    const b1 = manager.addMessage('Claude', [thought(2), toolUse('t2'), toolResult('t2', 'zz-bundled'), thought(3), text('B1')]);
    assert.equal(manager.noteRequestSent([a1, r1, b1], identity(), c1.provenance!.compileId), true);
    manager.addMessage('User', [text('U2')]);
    const next = await manager.compile(BIG, undefined, BIND_DROP);
    assert.ok(next.messages.some((m) => m.participant === 'user' && m.content.some((b) => b.type === 'tool_result')), 'setup: the compile sends results as the user\u2019s');
    assert.equal(next.messages.length, 7, 'setup: the bundled cycle goes as three messages');
    assert.equal(next.thinkingStrip, undefined);
    assert.equal(next.messages.reduce((n, m) => n + m.content.filter(isThinking).length, 0), 3, 'every noted reply keeps its thinking');
    await manager.close();
  });

  it('the layout prices a split body\u2019s thinking as each part sent it', async () => {
    cleanup();
    const manager = await open();
    manager.addMessage('User', [text('U1')]);
    const c1 = await manager.compile(BIG, undefined, BIND_DROP);
    // The first part's thinking includes a redacted block; the second part's
    // costs more than the first's, so the price says which part kept its own.
    const redacted = { type: 'redacted_thinking', data: 'zz-redacted-payload==' } as ContentBlock;
    const long = { type: 'thinking', thinking: 'zz-long '.repeat(80), signature: 'zz-sig-long-0123456789' } as ContentBlock;
    const b1 = manager.addMessage('Claude', [thought(1), redacted, toolUse('t1'), toolResult('t1', 'zz-bundled'), long, text('B1')]);
    manager.noteRequestSent([b1], identity(), c1.provenance!.compileId);
    // Placed after the cycle's result, the injection changes what precedes
    // the second part, so its thinking goes and the first part's stays.
    const late: ContextInjection = { namespace: 'zz-late', position: 'afterUser', content: [text('zz-late')] };
    const plain = await manager.compile(BIG, [late], { dryRun: true });
    const bound = await manager.compile(BIG, [late], { ...BIND_DROP, dryRun: true });
    const kept = bound.messages.flatMap((m) => m.content.filter(isThinking));
    assert.deepEqual(kept, [thought(1), redacted], 'setup: the first part keeps its thinking, the second goes without');
    const price = (blocks: ContentBlock[]) => (manager as unknown as { messageStore: { estimateBaseTokens(c: ContentBlock[]): number } }).messageStore.estimateBaseTokens(blocks);
    assert.ok(price([long]) > price([thought(1), redacted]), 'setup: the parts\u2019 thinking prices differ');
    assert.equal(bound.provenance!.layout!.totalTokens, plain.provenance!.layout!.totalTokens - price([long]));
    await manager.close();
  });

  it('a strategy that throws taking note of the thinking left out is logged, and the compile stands', async () => {
    cleanup();
    class Throwing extends PassthroughStrategy {
      noteThinkingLeftOut(): void { throw new Error('zz-note-failed'); }
    }
    const manager = await open(STORE, new Throwing());
    seed(manager);
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let result: CompileResult;
    try {
      result = await manager.compile(BIG, undefined, BIND);
    } finally {
      console.error = error;
    }
    assert.equal(result.thinkingStrip?.cause, 'first');
    assert.notEqual(recordOf(manager), null, 'the record is written');
    assert.ok(logged.some((line) => /failed to take note of thinking left out/.test(line) && /zz-note-failed/.test(line)), logged.join('\n'));
    await manager.close();
  });

  it('a compile without binds on a branch with no record writes none', async () => {
    cleanup();
    const manager = await open();
    seed(manager);
    const store = manager.getStore() as unknown as { setStateJson(id: string, value: unknown): void };
    const set = store.setStateJson.bind(store);
    let writes = 0;
    store.setStateJson = (id: string, value: unknown) => {
      if (id === 'default/thinking-binding') writes++;
      set(id, value);
    };
    await manager.compile(BIG);
    store.setStateJson = set;
    assert.equal(writes, 0);
    await manager.close();
  });

  it('a reply long enough to shard and not noted goes without its thinking, every shard read as partial', async () => {
    cleanup();
    const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, targetChunkTokens: 50, autoTickOnNewMessage: false, headWindowTokens: 0 });
    const manager = await ContextManager.open({ path: STORE, strategy });
    manager.addMessage('User', [text('U1')]);
    await manager.compile(BIG, undefined, BIND_DROP);
    const before = manager.getAllMessages().length;
    const a1 = manager.addMessage('Claude', [thought(1), text('zz-long ' + 'w '.repeat(1_500))]);
    const shards = manager.getAllMessages().length - before;
    assert.ok(shards > 1, 'setup: the reply was stored as shards');
    manager.addMessage('User', [text('U2')]);
    const next = await manager.compile(BIG, undefined, BIND_DROP);
    const reply = next.messages.find((m) => m.participant === 'Claude')!;
    assert.ok(!reply.content.some(isThinking), 'the sharded reply goes without its thinking');
    assert.deepEqual(next.thinkingStrip, { newly: [a1], cause: 'messages' });
    const partial = next.provenance!.layout!.units.filter((unit) => (unit as { p?: number }).p === 1).length;
    assert.equal(partial, shards, `every shard's unit is partial (${partial} of ${shards})`);
    await manager.close();
  });

  it('a shorter or empty record doesn\u2019t make older messages look stored since', async () => {
    cleanup();
    const manager = await open();
    const { a1, a2 } = seed(manager);
    await manager.compile(BIG, undefined, BIND_DROP);
    const empty = await manager.compile({ maxTokens: 1, reserveForResponse: 0 }, undefined, BIND_DROP);
    assert.equal(empty.messages.length, 0, 'setup: nothing fits');
    const back = await manager.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(thinkingByText(back), { U1: false, A1: false, U2: false, A2: false });
    assert.deepEqual(back.thinkingStrip, { newly: [a1, a2], cause: 'messages' });
    await manager.close();
  });

  for (const key of ['system', 'tools', 'model', 'request'] as const) {
    it(`a changed ${key} digest leaves out every reply\u2019s thinking`, async () => {
      cleanup();
      const manager = await open();
      const { a1, a2 } = seed(manager);
      await manager.compile(BIG, undefined, BIND_DROP);
      const same = await manager.compile(BIG, undefined, BIND_DROP);
      assert.equal(same.thinkingStrip, undefined, 'control: the same digests change nothing');
      const changed = await manager.compile(BIG, undefined, bind({ dropBlock: true, identity: { [key]: 'zz-changed' } }));
      assert.deepEqual(changed.thinkingStrip, { newly: [a1, a2], cause: 'head', changed: [key] });
      assert.deepEqual(thinkingByText(changed), { U1: false, A1: false, U2: false, A2: false });
      await manager.close();
    });
  }

  it('refuses a binding compile without participant or identity, or with a digest that isn\u2019t a string, before anything is selected or recorded', async () => {
    cleanup();
    const strategy = new Watching();
    const manager = await open(STORE, strategy);
    seed(manager);
    await manager.compile(BIG, undefined, BIND);
    const recorded = JSON.stringify(recordOf(manager));
    const selects = strategy.selects;
    const refused: Array<[string, SelectOptions, RegExp]> = [
      ['no participant', { thinkingBinding: { binds: true }, identity: identity() }, /needs `thinkingBinding.participant`/],
      ['an empty participant', { thinkingBinding: { binds: true, participant: '' }, identity: identity() }, /needs `thinkingBinding.participant`/],
      ['no identity', { thinkingBinding: { binds: true, participant: 'Claude' } }, /needs `identity`: the digests of what the request carries before its messages/],
      ...(['system', 'tools', 'model', 'request'] as const).map((key): [string, SelectOptions, RegExp] => [
        `a ${key} digest that isn't a string`,
        { ...BIND, identity: { ...identity(), [key]: 7 as unknown as string } },
        new RegExp(`identity\\.${key}\` must be a string, got number`),
      ]),
    ];
    for (const [label, opts, message] of refused) {
      await assert.rejects(manager.compile(BIG, undefined, opts), (error: unknown) => error instanceof TypeError && message.test(error.message), label);
    }
    assert.equal(strategy.selects, selects, 'no select ran');
    assert.equal(JSON.stringify(recordOf(manager)), recorded, 'the record is as it was');
    await manager.close();
  });

  it('a compile without binds neither reads nor writes the record; one an earlier binding compile left is compared like any other', async () => {
    cleanup();
    const manager = await open();
    const { a1, a2 } = seed(manager);
    await manager.compile(BIG, undefined, BIND_DROP);
    const recorded = JSON.stringify(recordOf(manager));
    // A store that can't give or take the record state doesn't touch a
    // compile without the option, committing or dry.
    const store = manager.getStore() as unknown as { getStateJson(id: string): unknown; setStateJson(id: string, value: unknown): void };
    const get = store.getStateJson.bind(store);
    const set = store.setStateJson.bind(store);
    let touched = 0;
    store.getStateJson = (id: string) => { if (id === 'default/thinking-binding') { touched++; throw new Error('zz-store-unreadable'); } return get(id); };
    store.setStateJson = (id: string, value: unknown) => { if (id === 'default/thinking-binding') { touched++; throw new Error('zz-store-unwritable'); } set(id, value); };
    await manager.compile(BIG);
    await manager.compile(BIG, undefined, { dryRun: true });
    manager.addMessage('User', [text('U3')]);
    const a3 = manager.addMessage('Claude', [thought(3), text('A3')]);
    await manager.compile(BIG);
    store.getStateJson = get;
    store.setStateJson = set;
    assert.equal(touched, 0, 'no read or write of the record');
    assert.equal(JSON.stringify(recordOf(manager)), recorded, 'the record is as the binding compile left it');
    // Back on a binding model, the record is compared as it stands: the
    // prefix that matches keeps its thinking, and what came after goes without.
    const back = await manager.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(thinkingByText(back), { U1: false, A1: true, U2: false, A2: true, U3: false, A3: false });
    assert.deepEqual(back.thinkingStrip, { newly: [a3], cause: 'messages' });
    void a1; void a2;
    await manager.close();
  });

  it('a reply a compile didn\u2019t send is reported again when it renders again', async () => {
    cleanup();
    const manager = await open();
    const { a1, a2 } = seed(manager);
    const first = await manager.compile(BIG, undefined, BIND);
    assert.deepEqual(first.thinkingStrip, { newly: [a1, a2], cause: 'first' });
    const tight = await manager.compile({ maxTokens: tokensOfNewest(manager, 1), reserveForResponse: 0 }, undefined, BIND);
    assert.deepEqual(thinkingByText(tight), { A2: false }, 'setup: only A2 is sent');
    assert.equal(tight.thinkingStrip, undefined, 'A2 was left out by the last compile');
    const back = await manager.compile(BIG, undefined, BIND);
    assert.deepEqual(back.thinkingStrip, { newly: [a1], cause: 'first' }, 'A1 again, since the last compile didn\u2019t send it');
    await manager.close();
  });

  it('another participant\u2019s reply never keeps its thinking', async () => {
    cleanup();
    const manager = await open();
    manager.addMessage('User', [text('U1')]);
    manager.addMessage('Other', [thought(8), text('O1')]);
    manager.addMessage('Claude', [thought(1), text('A1')]);
    const first = await manager.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(thinkingByText(first), { U1: false, O1: false, A1: true });
    assert.equal(first.thinkingStrip, undefined, 'another participant\u2019s thinking is never newly left out');
    await manager.close();
  });

  it('the record survives a restart', async () => {
    cleanup();
    let manager = await open();
    seed(manager);
    manager.addMessage('User', [text('U3')]);
    await manager.compile(BIG, undefined, BIND);
    const a3 = manager.addMessage('Claude', [thought(3), text('A3')]);
    note(manager, [a3], identity());
    const before = await manager.compile(BIG, undefined, BIND);
    assert.equal(thinkingByText(before).A3, true, 'setup: A3 keeps its thinking');
    await manager.close();

    manager = await open();
    const after = await manager.compile(BIG, undefined, BIND);
    assert.deepEqual(thinkingByText(after), thinkingByText(before), 'with no record this would leave out A3 too');
    assert.equal(after.thinkingStrip, undefined);
    assert.equal(after.thinkingRecordedAfter, before.thinkingRecordedAfter);
    await manager.close();
  });

  it('a branch starts from the record as of its branch point, and its writes stay its own', async () => {
    cleanup();
    const manager = await open();
    seed(manager);
    const first = await manager.compile(BIG, undefined, BIND_DROP);
    const u3 = manager.addMessage('User', [text('U3')]);
    manager.addMessage('Claude', [thought(3), text('A3')]);
    // On main, U1 falls out of the window: A1, A2 and A3 lose their thinking.
    const tight = await manager.compile({ maxTokens: tokensOfNewest(manager, 4), reserveForResponse: 0 }, undefined, BIND_DROP);
    assert.equal(thinkingByText(tight).A2, false, 'setup: main\u2019s latest record leaves A2 out');
    const mainRecord = JSON.stringify(recordOf(manager));

    // A branch at U3 sees the record the first compile wrote, before U3 was
    // stored, and not main's latest.
    const atU3 = manager.branchAt(u3, 'zz-at-u3');
    await manager.switchBranch(atU3);
    const there = await manager.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(thinkingByText(there), { U1: false, A1: true, U2: false, A2: true, U3: false });
    assert.equal(there.thinkingStrip, undefined);
    assert.equal(there.thinkingRecordedAfter, first.thinkingRecordedAfter);
    assert.ok(there.thinkingRecordedAfter! <= manager.currentBranch().branchPoint!, 'at most the branch point');
    await manager.compile({ maxTokens: tokensOfNewest(manager, 2), reserveForResponse: 0 }, undefined, BIND_DROP);

    await manager.switchBranch('main');
    assert.equal(JSON.stringify(recordOf(manager)), mainRecord, 'the branch\u2019s writes left main\u2019s record');

    const forked = await manager.fork('zz-fork');
    assert.equal(forked, 'zz-fork');
    assert.equal(JSON.stringify(recordOf(manager)), mainRecord, 'the fork holds main\u2019s record');
    const onFork = await manager.compile({ maxTokens: tokensOfNewest(manager, 4), reserveForResponse: 0 }, undefined, BIND_DROP);
    assert.equal(onFork.thinkingStrip, undefined, 'the fork starts from main\u2019s record');
    await manager.close();
  });

  it('a dry compile reports what it would leave out and records nothing', async () => {
    cleanup();
    const manager = await open();
    const { a1, a2 } = seed(manager);
    const dry = await manager.compile(BIG, undefined, bind({ dryRun: true }));
    assert.deepEqual(dry.thinkingStrip, { newly: [a1, a2], cause: 'first' });
    assert.deepEqual(thinkingByText(dry), { U1: false, A1: false, U2: false, A2: false });
    assert.equal(recordOf(manager), null);
    const real = await manager.compile(BIG, undefined, BIND);
    assert.deepEqual(real.thinkingStrip, { newly: [a1, a2], cause: 'first' }, 'the dry compile left no record behind');
    const recorded = JSON.stringify(recordOf(manager));
    await manager.compile({ maxTokens: tokensOfNewest(manager, 2), reserveForResponse: 0 }, undefined, bind({ dryRun: true }));
    assert.equal(JSON.stringify(recordOf(manager)), recorded, 'a dry compile leaves a record as it was');
    await manager.close();
  });

  it('a record it cannot read is warned of and read as none', async () => {
    const good = { sent: [], continued: [], without: [], recordedAfter: 1, identity: identity(), compileId: 'zz-compile' };
    const malformed: Array<[string, unknown]> = [
      ['sent not a list', { ...good, sent: 'zz-not-a-list' }],
      ['sent holding a number', { ...good, sent: [7] }],
      ['without missing', { sent: [], continued: [], recordedAfter: 1, identity: identity(), compileId: 'zz-compile' }],
      ['continued missing', { sent: [], without: [], recordedAfter: 1, identity: identity(), compileId: 'zz-compile' }],
      ['compileId missing', { sent: [], continued: [], without: [], recordedAfter: 1, identity: identity() }],
      ['compileId not a string', { ...good, compileId: 7 }],
      ['continued holding a number', { ...good, continued: [7] }],
      ['without holding a number', { ...good, without: [7] }],
      ['recordedAfter not a number', { ...good, recordedAfter: '1' }],
      ['identity missing', { sent: [], continued: [], without: [], recordedAfter: 1, compileId: 'zz-compile' }],
      ['identity null', { ...good, identity: null }],
      ['an identity digest not a string', { ...good, identity: { ...identity(), model: 5 } }],
      ['not an object', ['zz']],
    ];
    for (const [label, value] of malformed) {
      cleanup();
      const manager = await open();
      const { a1, a2 } = seed(manager);
      manager.getStore().setStateJson('default/thinking-binding', value);
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (message: string) => { warned.push(message); };
      let result: CompileResult;
      try {
        assert.equal(note(manager, [a2], identity()), false, `${label}: a note writes nothing`);
        assert.deepEqual(recordOf(manager), value, `${label}: the value is as it was`);
        assert.equal(warned.length, 1, label);
        assert.match(warned[0]!, /thinking-binding record of branch main isn't one this version reads; this note writes nothing/, label);
        warned.length = 0;
        result = await manager.compile(BIG, undefined, BIND);
      } finally {
        console.warn = warn;
      }
      assert.deepEqual(result.thinkingStrip, { newly: [a1, a2], cause: 'first' }, label);
      assert.equal(warned.length, 1, label);
      assert.match(warned[0]!, /thinking-binding record of branch main isn't one this version reads; this compile goes on as if the branch had no record/, label);
      assert.ok(Array.isArray((recordOf(manager) as { sent: unknown }).sent), `${label}: the compile wrote a record it can read`);
      await manager.close();
    }
    cleanup();
    const control = await open();
    seed(control);
    control.getStore().setStateJson('default/thinking-binding', good);
    const read = await control.compile(BIG, undefined, BIND_DROP);
    assert.equal(read.thinkingRecordedAfter, 1, 'control: a record of the right shape is read');
    await control.close();
  });

  it('a stripped body reads as incomplete, and the rendered layout prices what was sent', async () => {
    cleanup();
    const manager = await open();
    const { a1, a2 } = seed(manager);
    const plain = await manager.compile(BIG, undefined, { dryRun: true });
    const bound = await manager.compile(BIG, undefined, BIND);
    const bodies = (result: CompileResult) => {
      const out = new Map<MessageId, RawBodySource>();
      for (const source of result.provenance!.messages) if (source.kind === 'raw') for (const body of source.bodies) out.set(body.messageId, body);
      return out;
    };
    assert.equal(bodies(plain).get(a1)!.complete, true, 'setup: carried whole without binding');
    assert.equal(bodies(bound).get(a1)!.complete, false);
    assert.deepEqual(bodies(bound).get(a2)!.missing, ['content']);
    assert.equal([...bodies(bound).values()].filter((body) => body.complete).length, 2, 'the user messages are still whole');
    const thoughts = (manager as unknown as { messageStore: { estimateBaseTokens(c: ContentBlock[]): number } }).messageStore.estimateBaseTokens([thought(1), thought(2)]);
    assert.ok(thoughts > 0, 'setup: the thinking has a price');
    assert.equal(bound.provenance!.layout!.totalTokens, plain.provenance!.layout!.totalTokens - thoughts);
    const partial = (result: CompileResult) => result.provenance!.layout!.units.filter((unit) => (unit as { p?: number }).p === 1).length;
    assert.equal(partial(plain), 0, 'setup: every raw unit whole without binding');
    assert.equal(partial(bound), 2, 'the two replies\u2019 units are partial');
    await manager.close();
  });

  it('the rendered layout prices a summary\u2019s and an injection\u2019s thinking as never sent', async () => {
    cleanup();
    class Summarizing extends PassthroughStrategy {
      select(store: MessageStoreView, log: ContextLogView, budget: TokenBudget): ContextEntry[] {
        const entries = super.select(store, log, budget);
        return [...entries, { index: entries.length, sourceRelation: 'derived', participant: 'Claude', content: [thought(7), text('zz-summary')], summaries: [{ id: 'zz-s1', level: 1 }] }];
      }
      describeRenderedSummaries(ids: readonly string[]) {
        return new Map(ids.map((id) => [id, { level: 1, leaves: [] as MessageId[], method: 'authored' }]));
      }
    }
    const manager = await open(STORE, new Summarizing());
    seed(manager);
    const odd: ContextInjection = { namespace: 'zz-odd', position: 'afterUser', content: [thought(9), text('zz-odd')] };
    const plain = await manager.compile(BIG, [odd], { dryRun: true });
    const bound = await manager.compile(BIG, [odd], BIND_DROP);
    assert.deepEqual(thinkingByText(bound), { U1: false, A1: true, U2: false, 'zz-odd': false, A2: true, 'zz-summary': false }, 'setup: the replies keep their thinking');
    const price = (blocks: ContentBlock[]) => (manager as unknown as { messageStore: { estimateBaseTokens(c: ContentBlock[]): number } }).messageStore.estimateBaseTokens(blocks);
    assert.ok(plain.provenance!.layout, 'setup: the strategy reports a layout');
    assert.equal(bound.provenance!.layout!.totalTokens, plain.provenance!.layout!.totalTokens - price([thought(7), thought(9)]),
      'the kept replies are priced as sent, the summary and the injection without theirs');
    await manager.close();
  });

  it('a record the store can\u2019t read or write is logged, and never fails a compile or a note', async () => {
    for (const fails of ['write', 'read'] as const) {
      cleanup();
      const told: ContentBlock[][] = [];
      class Listening extends PassthroughStrategy {
        noteThinkingLeftOut(blocks: readonly ContentBlock[]): void { told.push([...blocks]); }
      }
      const manager = await open(STORE, new Listening());
      const { a1, a2 } = seed(manager);
      const store = manager.getStore() as unknown as { getStateJson(id: string): unknown; setStateJson(id: string, value: unknown): void };
      const get = store.getStateJson.bind(store);
      const set = store.setStateJson.bind(store);
      const failing = () => {
        if (fails === 'read') store.getStateJson = (id: string) => { if (id === 'default/thinking-binding') throw new Error('zz-store-unreadable'); return get(id); };
        else store.setStateJson = (id: string, value: unknown) => { if (id === 'default/thinking-binding') throw new Error('zz-store-unwritable'); set(id, value); };
      };
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (message: string) => { warned.push(message); };
      try {
        failing();
        // Read as no record, the compile strips as a branch's first does.
        const result = await manager.compile(BIG, undefined, BIND);
        assert.deepEqual(result.thinkingStrip, { newly: [a1, a2], cause: 'first' }, fails);
        assert.equal(told.length, 1, `${fails}: the strategy is told what was left out of what was sent`);
        assert.equal(warned.length, 1, fails);
        assert.match(warned[0]!, fails === 'read' ? /thinking-binding record of branch main couldn't be read \(.*zz-store-unreadable/ : /thinking-binding record of branch main couldn't be written \(.*zz-store-unwritable/, fails);
        store.getStateJson = get;
        store.setStateJson = set;
        // A note can't read or write it either: it writes nothing and says so.
        const compiled = await manager.compile(BIG, undefined, BIND);
        const a3 = manager.addMessage('Claude', [thought(3), text('A3')]);
        const before = JSON.stringify(recordOf(manager));
        failing();
        warned.length = 0;
        assert.equal(manager.noteRequestSent([a3], identity(), compiled.provenance!.compileId), false, fails);
        assert.equal(warned.length, 1, `${fails}: the note is logged`);
        store.getStateJson = get;
        store.setStateJson = set;
        assert.equal(JSON.stringify(recordOf(manager)), before, `${fails}: the record is as it was`);
      } finally {
        console.warn = warn;
        store.getStateJson = get;
        store.setStateJson = set;
      }
      await manager.close();
    }
  });

  it('a compile whose record the store can\u2019t write leaves the record before it, which that compile\u2019s stream can\u2019t note onto', async () => {
    cleanup();
    const manager = await open();
    seed(manager);
    await manager.compile(BIG, undefined, BIND_DROP);
    const recorded = JSON.stringify(recordOf(manager));
    manager.addMessage('User', [text('U3')]);
    const store = manager.getStore() as unknown as { setStateJson(id: string, value: unknown): void };
    const set = store.setStateJson.bind(store);
    store.setStateJson = (id: string, value: unknown) => { if (id === 'default/thinking-binding') throw new Error('zz-store-unwritable'); set(id, value); };
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (message: string) => { warned.push(message); };
    let c2: CompileResult;
    try {
      c2 = await manager.compile(BIG, undefined, BIND_DROP);
    } finally {
      console.warn = warn;
      store.setStateJson = set;
    }
    assert.equal(warned.length, 1, 'the failed write is logged');
    assert.equal(JSON.stringify(recordOf(manager)), recorded, 'the record before it stands');
    const a3 = manager.addMessage('Claude', [thought(3), text('A3')]);
    assert.equal(manager.noteRequestSent([a3], identity(), c2.provenance!.compileId), false, 'the failed compile\u2019s stream can\u2019t note onto it');
    // Compared against the first compile's record: U3 and A3 are past its end.
    const next = await manager.compile(BIG, undefined, BIND_DROP);
    assert.deepEqual(thinkingByText(next), { U1: false, A1: true, U2: false, A2: true, U3: false, A3: false });
    assert.deepEqual(next.thinkingStrip, { newly: [a3], cause: 'messages' });
    await manager.close();
  });

  it('a compile that fails after selecting writes no record and tells the strategy nothing', async () => {
    cleanup();
    const told: ContentBlock[][] = [];
    class Failing implements ContextStrategy {
      readonly name = 'zz-failing';
      readonly renderedForms = ['raw', 'summary', 'omitted'] as const;
      checkReadiness(): ReadinessState { return { ready: true }; }
      select(store: MessageStoreView): ContextEntry[] {
        const entries: ContextEntry[] = store.getAll().map((m, index) => ({ index, sourceMessageId: m.id, sourceRelation: 'copy', participant: m.participant, content: m.content }));
        return [...entries, { index: entries.length, sourceRelation: 'derived', participant: 'Claude', content: [text('zz-summary')], summaries: [{ id: 'zz-s1', level: 1 }] }];
      }
      describeRenderedSummaries(): ReadonlyMap<string, never> { throw new Error('zz-layout-failed'); }
      noteThinkingLeftOut(blocks: readonly ContentBlock[]): void { told.push([...blocks]); }
    }
    const manager = await open(STORE, new Failing());
    seed(manager);
    await assert.rejects(manager.compile(BIG, undefined, BIND), /zz-layout-failed/);
    assert.equal(recordOf(manager), null);
    assert.deepEqual(told, []);
    // Nor does one without binds clear a record when it fails.
    const planted = { sent: [], continued: [], without: [], recordedAfter: 1, identity: identity(), compileId: 'zz-compile' };
    manager.getStore().setStateJson('default/thinking-binding', planted);
    await assert.rejects(manager.compile(BIG), /zz-layout-failed/);
    assert.deepEqual(recordOf(manager), planted);
    await manager.close();
  });

  it('the strategy is told the stored thinking left out, at each committing compile and only then', async () => {
    cleanup();
    const told: ContentBlock[][] = [];
    class Listening extends PassthroughStrategy {
      noteThinkingLeftOut(blocks: readonly ContentBlock[]): void {
        told.push([...blocks]);
      }
    }
    const manager = await open(STORE, new Listening());
    seed(manager);
    manager.addMessage('User', [text('U3')]);
    const r3 = manager.addMessage('Claude', [redacted(3)]);
    const odd: ContextInjection = { namespace: 'zz-odd', position: 'afterUser', content: [thought(9), text('zz-odd')] };
    const dry = await manager.compile(BIG, [odd], bind({ dryRun: true }));
    assert.equal(told.length, 0, 'a dry compile tells nothing');
    assert.equal(thinkingByText(dry)['zz-odd'], false, 'an injection never keeps thinking');

    const first = await manager.compile(BIG, [odd], BIND);
    assert.ok(first.thinkingStrip!.newly.includes(r3), 'a reply of redacted thinking alone is left out too');
    assert.deepEqual(told, [[thought(1), thought(2), redacted(3)]], 'the replies\u2019 thinking, not the injection\u2019s');
    await manager.compile(BIG, [odd], BIND);
    assert.deepEqual(told[1], [thought(1), thought(2), redacted(3)], 'told again: each compile\u2019s estimate prices them again');
    await manager.close();
  });

  it('calibration: the strategy\u2019s estimate leaves out the price of the thinking left out', async () => {
    const estimateAfter = async (path: string, opts?: SelectOptions) => {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false, headWindowTokens: 0, adaptiveResolution: true });
      const manager = await ContextManager.open({ path, strategy });
      seed(manager);
      await manager.compile(BIG, undefined, opts);
      const reach = strategy as unknown as { _lastCompileEstimate: number; estimateTokens(c: ContentBlock[]): number };
      const result = { estimate: reach._lastCompileEstimate, thoughts: reach.estimateTokens([thought(1), thought(2)]) };
      await manager.close();
      return result;
    };
    const plain = await estimateAfter(STORE);
    const bound = await estimateAfter(STORE_B, BIND);
    assert.ok(plain.thoughts > 0, 'setup: the thinking has a price');
    assert.ok(plain.estimate > plain.thoughts, 'setup: the estimate covers the replies');
    assert.equal(bound.estimate, plain.estimate - plain.thoughts);
    cleanup();
  });

  it('thinkingRecordedAfter is the branch\u2019s sequence where its record began, at or above every message stored before, one the view filter hides included', async () => {
    cleanup();
    const manager = await ContextManager.open({
      path: STORE,
      strategy: new PassthroughStrategy(),
      viewFilter: (message) => !(message.metadata as { hidden?: unknown } | undefined)?.hidden,
    });
    seed(manager);
    const hidden = manager.addMessage('User', [text('zz-hidden')], { hidden: true });
    // A state write after the newest message moves the branch's sequence past it.
    manager.getStore().setStateJson('default/thinking-binding', null);
    const sequence = manager.getStore().currentSequence();
    assert.ok(sequence > manager.getMessage(hidden)!.sequence, 'setup: the branch is past its newest message');
    const first = await manager.compile(BIG, undefined, BIND_DROP);
    assert.equal(first.messages.length, 4, 'setup: the hidden message isn\u2019t sent');
    assert.ok(first.thinkingRecordedAfter! >= sequence);
    assert.ok(first.thinkingRecordedAfter! <= manager.getStore().currentSequence());
    await manager.close();
  });

  it('each namespace on a store keeps its own record', async () => {
    cleanup();
    const a = await open(STORE, new PassthroughStrategy(), 'zz-a');
    seed(a);
    await a.compile(BIG, undefined, BIND_DROP);
    const recorded = JSON.stringify(recordOf(a, 'zz-a'));
    const b = await ContextManager.open({ store: a.getStore(), strategy: new PassthroughStrategy(), namespace: 'zz-b' });
    assert.equal(recordOf(b, 'zz-b'), null, 'zz-b starts with none');
    await b.compile({ maxTokens: tokensOfNewest(a, 2), reserveForResponse: 0 }, undefined, BIND);
    assert.notEqual(recordOf(b, 'zz-b'), null);
    assert.equal(JSON.stringify(recordOf(a, 'zz-a')), recorded, 'zz-b\u2019s write left zz-a\u2019s record');
    await b.close();
    await a.close();
  });
});

describe('thinking binding: a summary\u2019s carriers', () => {
  it('a binding select renders and prices the live window as under live-strip', async () => {
    // Carriers big enough that pricing them changes what fits in 900 tokens.
    const carriers = (call: number): ContentBlock[] => [
      { type: 'thinking', thinking: `zz-archivist-${call} `.repeat(50), signature: `zz-asig-${call}-fedcba9876543210` } as ContentBlock,
      { type: 'redacted_thinking', data: `zz-aenc-${call}-payload==` } as ContentBlock,
      { type: 'text', text: `zz-adaptive-memory-${call} recollection` },
    ];
    await assert.rejects(
      renderAdaptiveFixture({ carrierPolicy: 'full' }, carriers, 900),
      /Adaptive picker exhausted/,
      'setup: rendered and priced with their carriers, these summaries don\u2019t fit',
    );
    const stripped = await renderAdaptiveFixture({ carrierPolicy: 'live-strip' }, carriers, 900);
    const bound = await renderAdaptiveFixture({ carrierPolicy: 'full' }, carriers, 900, BIND_DROP);
    assert.ok(stripped.messages.length > 0, 'setup: the live-strip render fits');
    assert.equal(typeof stripped.estimate, 'number', 'setup: the fixture reads the estimate');
    assert.equal(typeof bound.estimate, 'number');
    assert.deepEqual(bound.messages, stripped.messages);
    assert.equal(bound.estimate, stripped.estimate, 'priced as rendered');
    // A dry select prices by its own option, whatever compiled before it.
    const preview = await renderAdaptiveFixture({ carrierPolicy: 'full' }, carriers, 900, { ...BIND_DROP, dryRun: true });
    assert.deepEqual(preview.messages, stripped.messages, 'a binding dry compile, with no committing compile before it');
    await assert.rejects(
      renderAdaptiveFixture({ carrierPolicy: 'full' }, carriers, 900, { dryRun: true }, BIND_DROP),
      /Emission overran the plan/,
      'a dry compile without the option, after a binding compile, prices as configured: it reports an infeasible plan rather than refusing it, so it fails where its render overruns',
    );
    // previewContext takes the option too.
    const previewed: Record<string, boolean> = {};
    await renderAdaptiveFixture({ carrierPolicy: 'full' }, carriers, 900, BIND_DROP, undefined, (manager) => {
      const budget = { maxTokens: 900, reserveForResponse: 0 };
      previewed.bound = manager.previewContext(budget, undefined, { thinkingBinding: { binds: true } })!.fits;
      previewed.unbound = manager.previewContext(budget)!.fits;
    });
    assert.deepEqual(previewed, { bound: true, unbound: false }, 'priced in full, they don\u2019t fit');
  });

  it('a recall pair is priced as its own select\u2019s binding says', async () => {
    cleanup();
    const entry = {
      id: 'zz-sum-bound', level: 1, content: 'zz-memory prose.', tokens: 4_000,
      sourceIds: ['zz-m1'], sourceRange: { first: 'zz-m1', last: 'zz-m2' }, sourceLevel: 0, timestamp: 0,
      responseContent: [
        { type: 'thinking', thinking: 'zz-archivist '.repeat(300), signature: 'zz-sig-bound-0123' },
        { type: 'text', text: 'zz-memory prose.' },
      ],
    };
    const strategy = new AutobiographicalStrategy({ carrierPolicy: 'full', autoTickOnNewMessage: false });
    const stripStrategy = new AutobiographicalStrategy({ carrierPolicy: 'live-strip', autoTickOnNewMessage: false });
    const price = (s: AutobiographicalStrategy) => (s as unknown as { recallPairCost(e: unknown): number }).recallPairCost(entry);
    const manager = await ContextManager.open({ path: STORE, strategy });
    manager.addMessage('User', [text('U1')]);
    await manager.compile(BIG);
    // The reference: the same pricing, on a store, under live-strip.
    const reference = await ContextManager.open({ path: STORE_B, strategy: stripStrategy });
    reference.addMessage('User', [text('U1')]);
    await reference.compile(BIG);
    const full = price(strategy);
    const live = price(stripStrategy);
    assert.ok(full > live + 1_000, 'setup: the measured tokens, carriers included, set the full price');

    // The price as each select sees it, from inside its select path.
    // The price as each select sees it, from inside its select path, and as
    // it stands once the select has returned.
    const seen: number[] = [];
    const after: number[] = [];
    const hooked = strategy as unknown as { selectPath: (...args: unknown[]) => unknown };
    const selectPath = hooked.selectPath.bind(strategy);
    hooked.selectPath = (...args: unknown[]) => {
      seen.push(price(strategy));
      return selectPath(...args);
    };
    for (const opts of [BIND, { dryRun: true }, { ...BIND, dryRun: true }, { thinkingBinding: { binds: false }, dryRun: true }, undefined]) {
      await manager.compile(BIG, undefined, opts);
      after.push(price(strategy));
    }
    assert.deepEqual(seen, [live, full, live, full, full], 'each select prices by its own option');
    assert.deepEqual(after, [full, full, full, full, full], 'outside a select, as configured, after a binding one too');
    // And after a binding select that throws, committing or dry.
    const refusing = { maxTokens: 1, reserveForResponse: 0 };
    manager.addMessage('User', [text('zz-over ' + 'w '.repeat(400))]);
    await assert.rejects(manager.compile(refusing, undefined, BIND), 'setup: the binding compile is refused');
    assert.equal(price(strategy), full, 'after a refused binding compile');
    await assert.rejects(manager.compile(refusing, undefined, { ...BIND, dryRun: true }), 'setup: the binding dry compile is refused');
    assert.equal(price(strategy), full, 'after a refused binding dry compile');
    await manager.close();
    await reference.close();
    cleanup();
  });
});

describe('thinking binding: bindThinking', () => {
  const user = (t: string, participant = 'User'): NormalizedMessage => ({ participant, content: [text(t)] });
  const reply = (n: number, t: string): NormalizedMessage => ({ participant: 'Claude', content: [thought(n), text(t)] });
  const body = (id: string, sequence: number): RawBodySource => ({ messageId: id, sequence, complete: true });
  const raw = (...bodies: RawBodySource[]): CompiledMessageSources => ({ kind: 'raw', bodies });
  const recordFor = (messages: NormalizedMessage[], over: Partial<BindingRecord> = {}): BindingRecord => ({
    sent: messages.map((m) => messageDigest(m)),
    continued: [],
    without: [],
    identity: identity(),
    recordedAfter: 0,
    compileId: 'zz-compile',
    ...over,
  });
  const input = (messages: NormalizedMessage[], sources: CompiledMessageSources[], record: BindingRecord | null) => ({
    messages, sources, record, dropBlock: true, identity: identity(), participant: 'Claude', sequence: 9, compileId: 'zz-compile-2',
  });

  it('compares content as the provider reads it: key order and cache breakpoints aside', () => {
    const sent = [user('U1'), reply(1, 'A1')];
    const record = recordFor(sent);
    const reordered: NormalizedMessage[] = [
      { participant: 'User', content: [{ text: 'U1', type: 'text' } as ContentBlock], cacheBreakpoint: true },
      reply(1, 'A1'),
    ];
    const outcome = bindThinking(input(reordered, [raw(body('u1', 1)), raw(body('a1', 2))], record));
    assert.equal(outcome.strip, undefined);
    assert.ok(outcome.messages[1]!.content.some(isThinking));
    assert.equal(outcome.record.recordedAfter, 0, 'kept from the record');
    assert.deepEqual(outcome.record.continued, [], 'a compile starts the request over');
  });

  it('a message whose participant alone changed is a difference', () => {
    const sent = [user('U1'), reply(1, 'A1')];
    const now = [user('U1', 'Someone'), reply(1, 'A1')];
    const outcome = bindThinking(input(now, [raw(body('u1', 1)), raw(body('a1', 2))], recordFor(sent)));
    assert.deepEqual(outcome.strip, { newly: ['a1'], cause: 'messages' });
  });

  it('after the first difference, a reply left out before is not newly left out', () => {
    const sent = [user('U1'), reply(1, 'A1'), user('U2'), { participant: 'Claude', content: [text('A2')] }];
    const record = recordFor(sent, { without: ['a2'] });
    const now = [user('U1-edited'), reply(1, 'A1'), user('U2'), reply(2, 'A2')];
    const outcome = bindThinking(input(now, [raw(body('u1', 1)), raw(body('a1', 2)), raw(body('u2', 3)), raw(body('a2', 4))], record));
    assert.deepEqual(outcome.strip, { newly: ['a1'], cause: 'messages' });
    assert.deepEqual(outcome.record.without, ['a1', 'a2']);
    assert.ok(outcome.messages.every((m) => !m.content.some(isThinking)));
  });

  it('a message of several bodies goes without when any of them did, and records them all', () => {
    const merged: NormalizedMessage = { participant: 'Claude', content: [thought(1), text('A1'), text('A1b')] };
    const sent = [user('U1'), { participant: 'Claude', content: [text('A1'), text('A1b')] }];
    const record = recordFor(sent, { without: ['a1b'] });
    const outcome = bindThinking(input([user('U1'), merged], [raw(body('u1', 1)), raw(body('a1', 2), body('a1b', 3))], record));
    assert.equal(outcome.strip, undefined, 'left out before, so not newly');
    assert.ok(!outcome.messages[1]!.content.some(isThinking));
    assert.deepEqual(outcome.record.without, ['a1', 'a1b']);
  });

  it('the participant\u2019s message with no stored body never keeps its thinking', () => {
    const sources: CompiledMessageSources[] = [
      raw(body('u1', 1)),
      { kind: 'summary', summaries: [{ id: 'zz-s1', level: 1 }] },
      { kind: 'other' },
      raw(body('a1', 2)),
    ];
    const now = [user('U1'), reply(8, 'S1'), reply(9, 'O1'), reply(1, 'A1')];
    const outcome = bindThinking(input(now, sources, null));
    assert.deepEqual(outcome.messages.map((m) => m.content.some(isThinking)), [false, false, false, true]);
    assert.equal(outcome.strip, undefined, 'no stored body, so nothing is newly left out');
    assert.deepEqual(outcome.record.without, [], 'and nothing recorded as left out');
    assert.deepEqual(outcome.leftOut, [], 'nor handed to the strategy: only stored bodies\u2019 thinking is');
  });

  it('past the record\u2019s end nothing keeps its thinking; a noted row extends the record, and an unvouched one matches nothing', () => {
    const sent = [user('U1')];
    const now = [user('U1'), reply(1, 'A1'), reply(2, 'A2')];
    const keeps = (record: Partial<BindingRecord>) =>
      bindThinking(input(now, [raw(body('u1', 1)), raw(body('a1', 5)), raw(body('a2', 6))], recordFor(sent, record))).messages.map((m) => m.content.some(isThinking));
    assert.deepEqual(keeps({}), [false, false, false]);
    assert.deepEqual(keeps({ continued: [messageDigest(reply(1, 'A1'))] }), [false, true, false]);
    assert.deepEqual(keeps({ continued: [messageDigest(reply(1, 'A1')), messageDigest(reply(2, 'A2'))] }), [false, true, true]);
    assert.deepEqual(keeps({ continued: [UNVOUCHED, messageDigest(reply(2, 'A2'))] }), [false, false, false]);
    assert.deepEqual(keeps({ sent: [UNVOUCHED], continued: [messageDigest(reply(1, 'A1'))] }), [false, false, false], 'a record that vouches for nothing');
  });

  it('a head change is the cause given, when replies from before the record go too', () => {
    const sent = [user('U1')];
    const now = [user('U1'), reply(1, 'A1')];
    const outcome = bindThinking({
      ...input(now, [raw(body('u1', 1)), raw(body('a1', 2))], recordFor(sent, { recordedAfter: 5, identity: identity({ tools: 'zz-old' }) })),
      dropBlock: false,
    });
    assert.deepEqual(outcome.strip, { newly: ['a1'], cause: 'head', changed: ['tools'] });
  });

  it('a body marked as left out gains \u2018content\u2019 once, and keeps what it was missing', () => {
    const sources: CompiledMessageSources[] = [
      raw({ messageId: 'a1', sequence: 1, complete: false, missing: ['shards'] }),
      raw(body('a2', 2)),
      raw(body('u1', 3)),
    ];
    markThinkingLeftOut(sources, new Set(['a1', 'a2']));
    markThinkingLeftOut(sources, new Set(['a2']));
    const bodiesOf = (i: number) => (sources[i] as { bodies: RawBodySource[] }).bodies[0]!;
    assert.deepEqual(bodiesOf(0).missing, ['shards', 'content']);
    assert.deepEqual(bodiesOf(1).missing, ['content']);
    assert.equal(bodiesOf(1).complete, false);
    assert.equal(bodiesOf(2).complete, true, 'a body not named is left as it was');
  });

  it('a digest is 11 base64url characters, tells an array from an object, and keeps array order', () => {
    const digest = messageDigest(user('U1'));
    assert.match(digest, /^[A-Za-z0-9_-]{11}$/);
    const withInput = (input: unknown): NormalizedMessage => ({ participant: 'Claude', content: [{ type: 'tool_use', id: 't', name: 'n', input } as ContentBlock] });
    assert.notEqual(messageDigest(withInput({ value: ['x'] })), messageDigest(withInput({ value: { 0: 'x' } })));
    assert.notEqual(messageDigest(withInput({ value: ['x', 'y'] })), messageDigest(withInput({ value: ['y', 'x'] })));
    assert.equal(messageDigest(withInput({ a: 1, b: 2 })), messageDigest(withInput({ b: 2, a: 1 })), 'control: key order aside');
    const marked = (key: string): NormalizedMessage => ({ participant: 'User', content: [{ type: 'text', text: 'U1', [key]: { type: 'ephemeral' } } as unknown as ContentBlock] });
    assert.equal(messageDigest(marked('cache_control')), digest, 'a block\u2019s cache marker aside');
    assert.equal(messageDigest(marked('cacheControl')), digest);
  });
});

// The public types, through both barrels: a removed export fails the build.
const exported: { binding: ThinkingBinding; identity: RequestIdentity | RequestIdentityFromTypes; strip: ThinkingStrip | ThinkingStripFromTypes } = {
  binding: { binds: true, participant: 'Claude' },
  identity: identity(),
  strip: { newly: [], cause: 'messages' },
};
void exported;
