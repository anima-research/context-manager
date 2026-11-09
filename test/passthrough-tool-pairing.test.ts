import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, OverBudgetError, PassthroughStrategy, WindowedPassthroughStrategy } from '../src/index.js';
import { answeredCallIndexes } from '../src/normalize-tool-messages.js';
import type { ContextStrategy, MessageStoreView } from '../src/types/index.js';

const dirs: string[] = [];
function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cm-passthrough-pairing-'));
  dirs.push(dir);
  return join(dir, 'store');
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const call = (id: string, rawXml?: string): ContentBlock => ({ type: 'tool_use', id, name: 'read', input: { path: id }, ...(rawXml ? { rawXml } : {}) } as ContentBlock);
const result = (id: string, content: unknown, rawXml?: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content, ...(rawXml ? { rawXml } : {}) } as ContentBlock);
const image = (data: string): ContentBlock => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data }, tokenEstimate: 100 } as unknown as ContentBlock);
const change = (): ContentBlock => ({ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock);
const OPEN = { maxTokens: 1_000_000, reserveForResponse: 0 };
const budget = (maxTokens: number) => ({ maxTokens, reserveForResponse: 0 });

/** The ids of the tool_results a window sends with no earlier block in it holding the call they answer. */
function orphans(messages: ReadonlyArray<{ content: ContentBlock[] }>): string[] {
  const blocks = messages.flatMap((m) => m.content);
  const answers = answeredCallIndexes(blocks);
  return blocks.flatMap((b, i) => (b.type === 'tool_result' && answers[i] === undefined ? [(b as { toolUseId: string }).toolUseId] : []));
}
const shape = (messages: ReadonlyArray<{ participant: string; content: ContentBlock[] }>): string[] =>
  messages.map((m) => `${m.participant}: ${m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text.slice(0, 12) : b.type)).join(', ')}`);
/** The content as a provider receives it: cache markers aside. */
const sent = (content: readonly unknown[]): unknown => JSON.parse(JSON.stringify(content, (key, value) => (key === 'cache_control' ? undefined : value)));

/** Keeps the store view its last select read, to price stored messages as it does. */
function priced<S extends ContextStrategy>(strategy: S): S & { view?: MessageStoreView } {
  const s = strategy as S & { view?: MessageStoreView };
  const select = s.select.bind(s) as (...args: unknown[]) => ReturnType<S['select']>;
  (s as unknown as { select: (...args: unknown[]) => unknown }).select = (...args: unknown[]) => {
    s.view = args[0] as MessageStoreView;
    return select(...args);
  };
  return s;
}
function cost(strategy: { view?: MessageStoreView }, ...ids: string[]): number {
  const all = strategy.view!.getAll();
  return ids.reduce((n, id) => n + strategy.view!.estimateTokens(all.find((m) => m.id === id)!), 0);
}

async function open<S extends ContextStrategy>(strategy: S, path = freshPath(), extra: Record<string, unknown> = {}) {
  const cm = await ContextManager.open({ path, strategy, ...extra });
  return cm;
}

/** issue #370's store: a long call, its result, then two short turns. */
function store370(cm: ContextManager): string[] {
  return [
    cm.addMessage('User', [text('Please read the file.')]),
    cm.addMessage('Claude', [text(`THINKING-OUT-LOUD ${'word '.repeat(2000)}`), call('t1')]),
    cm.addMessage('User', [result('t1', `FILE ${'line '.repeat(150)}`)]),
    cm.addMessage('Claude', [text('Read it.')]),
    cm.addMessage('User', [text('Thanks.')]),
  ];
}

describe('passthrough strategies send no tool result without its call', () => {
  it('1. #370\'s store: at 1,200 the window starts after the result, and stays there at 1,000,000', async () => {
    const cm = await open(new WindowedPassthroughStrategy());
    store370(cm);
    try {
      const first = await cm.compile(OPEN);
      assert.equal(first.messages.length, 5);
      const cut = await cm.compile(budget(1200));
      assert.deepEqual(shape(cut.messages), ['Claude: Read it.', 'User: Thanks.']);
      assert.deepEqual(orphans(cut.messages), []);
      const again = await cm.compile(OPEN);
      assert.deepEqual(shape(again.messages), ['Claude: Read it.', 'User: Thanks.']);
    } finally {
      cm.close();
    }
  });

  it('2. windowed: the newest unit, a call and its result, is sent whole where it fits and refused where it doesn\'t', async () => {
    const build = (cm: ContextManager) => [
      cm.addMessage('User', [text(`CONTEXT ${'x '.repeat(2400)}`)]),
      cm.addMessage('Claude', [text(`CALLING ${'word '.repeat(400)}`), call('t1')]),
      cm.addMessage('User', [result('t1', `FILE ${'line '.repeat(100)}`)]),
    ];
    const strategy = priced(new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 }));
    const cm = await open(strategy);
    const [, callId, resultId] = build(cm);
    try {
      await cm.compile(OPEN);
      const pair = cost(strategy, callId!, resultId!);
      assert.ok(cost(strategy, resultId!) <= (pair + 20) / 2, 'setup: the result alone fits the target');
      const fits = await cm.compile(budget(pair + 20));
      assert.deepEqual(shape(fits.messages), ['Claude: CALLING word, tool_use', 'User: tool_result']);
      assert.deepEqual(orphans(fits.messages), []);
    } finally {
      cm.close();
    }
    const strategy2 = priced(new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 }));
    const cm2 = await open(strategy2);
    const [, callId2, resultId2] = build(cm2);
    try {
      await cm2.compile(OPEN);
      const tight = cost(strategy2, resultId2!) + 20;
      await assert.rejects(cm2.compile(budget(tight)), (err: unknown) => {
        assert.ok(err instanceof OverBudgetError, String(err));
        assert.equal(err.actual, cost(strategy2, callId2!, resultId2!), 'the unit: the call and its result');
        return true;
      });
    } finally {
      cm2.close();
    }
  });

  it('3. a host\'s anchor on a result starts the window at its call, and getAnchor() still names the result', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    cm.addMessage('User', [text('hi')]);
    cm.addMessage('Claude', [text('CALLING'), call('t1')]);
    const resultId = cm.addMessage('User', [result('t1', 'FILE')]);
    cm.addMessage('Claude', [text('Read it.')]);
    try {
      const at = cm.getMessage(resultId)!.sequence;
      strategy.setAnchor(at);
      const r = await cm.compile(OPEN);
      assert.deepEqual(shape(r.messages), ['Claude: CALLING, tool_use', 'User: tool_result', 'Claude: Read it.']);
      assert.equal(strategy.getAnchor(), at);
    } finally {
      cm.close();
    }
  });

  it('4. presented rows: an anchor ordinal on a result starts the window at its call, and getAnchorOrdinal() still names the result', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    const ids = [
      cm.addMessage('User', [text('hi')]),
      cm.addMessage('Claude', [text('CALLING'), call('t1')]),
      cm.addMessage('User', [result('t1', 'FILE')]),
      cm.addMessage('Claude', [text('Read it.')]),
    ];
    try {
      cm.presentRows(ids);
      const at = cm.ordinalOf(ids[2]!)!;
      strategy.setAnchorOrdinal(at);
      const r = await cm.compile(OPEN);
      assert.deepEqual(shape(r.messages), ['Claude: CALLING, tool_use', 'User: tool_result', 'Claude: Read it.']);
      assert.equal(strategy.getAnchorOrdinal(), at);
    } finally {
      cm.close();
    }
  });

  it('5. a result stored after the anchor, answering a call before it, starts the window back at the call', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    cm.addMessage('User', [text('hi')]);
    cm.addMessage('Claude', [text('CALLING'), call('t1')]);
    const note = cm.addMessage('User', [text('a note')]);
    try {
      strategy.setAnchor(cm.getMessage(note)!.sequence);
      cm.addMessage('User', [result('t1', 'FILE')]);
      const r = await cm.compile(OPEN);
      assert.deepEqual(shape(r.messages), ['Claude: CALLING, tool_use', 'User: a note', 'User: tool_result']);
    } finally {
      cm.close();
    }
  });

  it('6. a store an earlier release anchored at the result: the window starts at the call, the slot stays, and a reopen sends the same bytes', async () => {
    const ANCHOR = 'zz/windowed:anchor';
    const path = freshPath();
    const make = () => new WindowedPassthroughStrategy({ anchorStateId: ANCHOR });
    let cm = await open(make(), path, { namespace: 'zz' });
    const ids = store370(cm);
    const slot = { anchor: cm.getMessage(ids[2]!)!.sequence };
    cm.getStore().setStateJson(ANCHOR, slot);
    cm.close();
    cm = await open(make(), path, { namespace: 'zz' });
    let first: unknown;
    try {
      const r = await cm.compile(OPEN);
      assert.deepEqual(shape(r.messages), ['Claude: THINKING-OUT, tool_use', 'User: tool_result', 'Claude: Read it.', 'User: Thanks.']);
      assert.deepEqual(cm.getStore().getStateJson(ANCHOR), slot, 'the slot isn\'t rewritten');
      first = sent(r.messages);
    } finally {
      cm.close();
    }
    cm = await open(make(), path, { namespace: 'zz' });
    try {
      assert.deepEqual(sent((await cm.compile(OPEN)).messages), first);
    } finally {
      cm.close();
    }
  });

  it('7. repeated ids: a start between a result and the next call with its id stands, and one between that call and its result moves back to the call', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    const ids = [
      cm.addMessage('User', [text('hi')]),
      cm.addMessage('Claude', [text('FIRST'), call('t1')]),
      cm.addMessage('User', [result('t1', 'one')]),
      cm.addMessage('Claude', [text('SECOND'), call('t1')]),
      cm.addMessage('User', [result('t1', 'two')]),
      cm.addMessage('Claude', [text('done')]),
    ];
    try {
      strategy.setAnchor(cm.getMessage(ids[3]!)!.sequence);
      assert.deepEqual(shape((await cm.compile(OPEN)).messages), ['Claude: SECOND, tool_use', 'User: tool_result', 'Claude: done']);
      strategy.setAnchor(cm.getMessage(ids[4]!)!.sequence);
      const r = await cm.compile(OPEN);
      assert.deepEqual(shape(r.messages), ['Claude: SECOND, tool_use', 'User: tool_result', 'Claude: done']);
      assert.deepEqual(orphans(r.messages), []);
    } finally {
      cm.close();
    }
  });

  it('8. a system change a host presents between a call and its result: no window starts between them, and the change is sent', async () => {
    // The store refuses a change written between a call and its result, so
    // here rows taken out and presented again, as an undo and its redo do,
    // put the change there in the window's order.
    for (const strategy of [new PassthroughStrategy(), new WindowedPassthroughStrategy()]) {
      const cm = await open(strategy);
      const ids = [
        cm.addMessage('User', [text('Please read the file.')]),
        cm.addMessage('Harness', [change()]),
        cm.addMessage('Claude', [text(`THINKING-OUT-LOUD ${'word '.repeat(2000)}`), call('t1')]),
        cm.addMessage('User', [result('t1', `FILE ${'line '.repeat(150)}`)]),
        cm.addMessage('Claude', [text('Read it.')]),
        cm.addMessage('User', [text('Thanks.')]),
      ];
      try {
        cm.presentRows([]);
        cm.retractRows(ids.slice(1));
        cm.presentRows([ids[2]!]);
        cm.presentRows([ids[1]!]);
        cm.presentRows([ids[3]!, ids[4]!, ids[5]!]);
        assert.deepEqual(shape((await cm.compile(OPEN)).messages).slice(1, 4), ['Claude: THINKING-OUT, tool_use', 'Harness: system_change', 'User: tool_result'], `setup: ${strategy.name} presents the change between the pair`);
        const r = await cm.compile(budget(1200));
        assert.deepEqual(shape(r.messages), ['Harness: system_change', 'Claude: Read it.', 'User: Thanks.'], strategy.name);
        assert.deepEqual(orphans(r.messages), []);
      } finally {
        cm.close();
      }
    }
  });

  describe('9. a call removed in legacy mode, its result kept', () => {
    it('the result isn\'t sent, a message that held only it sends [tool call omitted], and a pending call at the end is still sent', async () => {
      for (const strategy of [new PassthroughStrategy(), new WindowedPassthroughStrategy()]) {
        const cm = await open(strategy);
        cm.addMessage('User', [text('hi')]);
        const callId = cm.addMessage('Claude', [text('CALLING'), call('t1')]);
        cm.addMessage('User', [result('t1', 'FILE')]);
        cm.addMessage('Claude', [text('AGAIN'), call('t2')]);
        try {
          cm.removeMessage(callId);
          const r = await cm.compile(OPEN);
          assert.deepEqual(shape(r.messages), ['User: hi', 'User: [tool call o', 'Claude: AGAIN, tool_use'], strategy.name);
          assert.deepEqual(r.messages[1]!.content, [{ type: 'text', text: '[tool call omitted]' }]);
          assert.deepEqual(orphans(r.messages), []);
        } finally {
          cm.close();
        }
      }
    });

    it('windowed: an image the dropped result held takes no live-image slot, so an older one within the limit stays live', async () => {
      const cm = await open(new WindowedPassthroughStrategy({ maxLiveImages: 1, imageStripDepthTokens: 0 }));
      cm.addMessage('User', [image('AAAA'), text('first')]);
      const callId = cm.addMessage('Claude', [call('t1')]);
      cm.addMessage('User', [result('t1', [image('BBBB')])]);
      try {
        cm.removeMessage(callId);
        const r = await cm.compile(OPEN);
        assert.deepEqual(shape(r.messages), ['User: image, first', 'User: [tool call o']);
      } finally {
        cm.close();
      }
    });

    it('the window is priced without the dropped result', async () => {
      for (const strategy of [new PassthroughStrategy(), new WindowedPassthroughStrategy()]) {
        const cm = await open(strategy);
        cm.addMessage('User', [text('hi')]);
        const callId = cm.addMessage('Claude', [call('t1')]);
        cm.addMessage('User', [result('t1', `STALE ${'line '.repeat(3000)}`)]);
        cm.addMessage('User', [text('a note')]);
        try {
          cm.removeMessage(callId);
          const r = await cm.compile(budget(1000));
          assert.deepEqual(shape(r.messages), ['User: hi', 'User: [tool call o', 'User: a note'], strategy.name);
        } finally {
          cm.close();
        }
      }
    });

    it('a result that shared its raw form with the dropped one gives it up', async () => {
      for (const strategy of [new PassthroughStrategy(), new WindowedPassthroughStrategy()]) {
        const cm = await open(strategy);
        const raw = '<function_results><result>one</result><result>two</result></function_results>';
        cm.addMessage('User', [text('hi')]);
        const callId = cm.addMessage('Claude', [call('t1')]);
        cm.addMessage('Claude', [call('t2')]);
        cm.addMessage('User', [result('t1', 'one', raw), result('t2', 'two', raw)]);
        try {
          cm.removeMessage(callId);
          const r = await cm.compile(OPEN);
          const last = r.messages.at(-1)!.content;
          assert.deepEqual(last.map((b) => [b.type, (b as { toolUseId?: string }).toolUseId, (b as { rawXml?: string }).rawXml]), [['tool_result', 't2', undefined]], strategy.name);
        } finally {
          cm.close();
        }
      }
    });
  });

  it('9a. a message stored with no blocks goes out as it did, with no text written into it', async () => {
    for (const strategy of [new PassthroughStrategy(), new WindowedPassthroughStrategy()]) {
      const cm = await open(strategy);
      cm.addMessage('User', [text('hi')]);
      cm.addMessage('User', []);
      cm.addMessage('Claude', [text('ok')]);
      try {
        const r = await cm.compile(OPEN);
        assert.deepEqual(r.messages.map((m) => sent(m.content)), [[{ type: 'text', text: 'hi' }], [], [{ type: 'text', text: 'ok' }]], strategy.name);
      } finally {
        cm.close();
      }
    }
  });

  describe('10. passthrough over budget', () => {
    it('a cut across a call and its result leaves the pair out whole', async () => {
      const strategy = priced(new PassthroughStrategy());
      const cm = await open(strategy);
      const ids = [
        cm.addMessage('User', [text(`CONTEXT ${'x '.repeat(2400)}`)]),
        cm.addMessage('Claude', [text(`CALLING ${'word '.repeat(400)}`), call('t1')]),
        cm.addMessage('User', [result('t1', `FILE ${'line '.repeat(100)}`)]),
        cm.addMessage('Claude', [text('Read it.')]),
        cm.addMessage('User', [text('Thanks.')]),
      ];
      try {
        await cm.compile(OPEN);
        const r = await cm.compile(budget(cost(strategy, ids[2]!, ids[3]!, ids[4]!) + 20));
        assert.deepEqual(shape(r.messages), ['Claude: Read it.', 'User: Thanks.']);
      } finally {
        cm.close();
      }
    });

    it('beside a system change, a newest call and result over the budget refuse, counting the changes and the pair', async () => {
      const strategy = priced(new PassthroughStrategy());
      const cm = await open(strategy);
      const ids = [
        cm.addMessage('Harness', [change()]),
        cm.addMessage('User', [text('hi')]),
        cm.addMessage('Claude', [text(`CALLING ${'word '.repeat(400)}`), call('t1')]),
        cm.addMessage('User', [result('t1', `FILE ${'line '.repeat(100)}`)]),
      ];
      try {
        await cm.compile(OPEN);
        await assert.rejects(cm.compile(budget(cost(strategy, ids[0]!, ids[3]!) + 20)), (err: unknown) => {
          assert.ok(err instanceof OverBudgetError, String(err));
          assert.equal(err.actual, cost(strategy, ids[0]!, ids[2]!, ids[3]!));
          return true;
        });
      } finally {
        cm.close();
      }
    });
  });

  it('11. windowed: renderAsNewest renders what select sends, the call a moved-back start holds and a stripped result included', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    cm.addMessage('User', [text('hi')]);
    const callId = cm.addMessage('Claude', [text('CALLING'), call('t1')]);
    const resultId = cm.addMessage('User', [result('t1', 'FILE')]);
    const gone = cm.addMessage('Claude', [call('t2')]);
    const stripped = cm.addMessage('User', [result('t2', 'GONE')]);
    try {
      cm.removeMessage(gone);
      strategy.setAnchor(cm.getMessage(resultId)!.sequence);
      const r = await cm.compile(OPEN);
      assert.deepEqual(shape(r.messages), ['Claude: CALLING, tool_use', 'User: tool_result', 'User: [tool call o']);
      const rendered = cm.renderAsNewest([callId, resultId, stripped])!;
      assert.deepEqual(rendered.map((c) => (c ? sent(c) : c)), r.messages.map((m) => sent(m.content)));
    } finally {
      cm.close();
    }
  });

  it('12. where every start is clean and the view holds every call, both send the stored messages from the same start as before', async () => {
    for (const make of [() => new PassthroughStrategy(), () => new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 })]) {
      const cm = await open(make());
      const ids = [
        cm.addMessage('User', [text(`CONTEXT ${'x '.repeat(2400)}`)]),
        cm.addMessage('Claude', [text('CALLING'), call('t1')]),
        cm.addMessage('User', [result('t1', `FILE ${'line '.repeat(100)}`)]),
        cm.addMessage('Claude', [text('Read it.')]),
        cm.addMessage('Claude', [text('CALLING'), call('t2')]),
        cm.addMessage('User', [result('t2', 'short')]),
        cm.addMessage('Claude', [text('done')]),
      ];
      try {
        for (const [at, from] of [[OPEN, 0], [budget(1000), 1]] as const) {
          const r = await cm.compile(at);
          assert.deepEqual(r.messages.map((m) => sent(m.content)), ids.slice(from).map((id) => sent(cm.getMessage(id)!.content)), `${make().name} at ${at.maxTokens}`);
        }
      } finally {
        cm.close();
      }
    }
  });
});
