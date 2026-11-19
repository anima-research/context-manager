import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AutobiographicalStrategy,
  ContextManager,
  MessageStore,
  PassthroughStrategy,
  SWEEPS_APPLIED_STATE_ID,
  sweepsApplied,
} from '../src/index.js';
import type { MessageId, StoredContentBlock, SummaryEntry, SweepBody, SweepEntry } from '../src/index.js';

const BASE = './test-sweep';
let storeSeq = 0;
function freshPath(): string {
  const path = `${BASE}-${storeSeq++}`;
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  return path;
}
after(() => {
  for (let i = 0; i < storeSeq + 1; i++) {
    const p = `${BASE}-${i}`;
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const OLD = 'OLDWORDS';
const NEW = 'NEWWORDS';
const BIG = { maxTokens: 1_000_000, reserveForResponse: 0 };
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const textOfBlocks = (blocks: readonly { type: string; text?: string }[]) => blocks.map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('');

const FILLER = 'filler words for the long note ';
const MORE_FILLER = 'more filler for the note ';

function rewords(seen?: SweepBody[]): SweepEntry {
  return {
    name: 'rewords-test',
    line: "rewrites OLDWORDS in the faulty test writer's notes",
    mend: (body) => {
      seen?.push(body);
      if (body.metadata?.writer !== 'faulty') return null;
      if (!body.content.some((b) => b.type === 'text' && b.text.includes(OLD))) return null;
      return body.content.map((b): StoredContentBlock =>
        b.type === 'text' ? { type: 'text', text: b.text.replaceAll(OLD, NEW).replaceAll(FILLER, '').replaceAll(MORE_FILLER, '') } : b,
      );
    },
  };
}

function note(cm: ContextManager, words: string): MessageId {
  return cm.addMessage('system', [text(words)], { writer: 'faulty' });
}

function longNote(cm: ContextManager, marker: string): MessageId {
  return note(cm, `${marker} ${FILLER.repeat(120)}${OLD} in the middle ${MORE_FILLER.repeat(120)}end of ${marker}`);
}

async function compiledText(cm: ContextManager): Promise<string> {
  const result = await cm.compile(BIG);
  return result.messages.map((m) => textOfBlocks(m.content as { type: string; text?: string }[])).join('\n');
}

function sequenceOf(cm: ContextManager): number {
  return cm.getStore().currentSequence();
}

function mockMembrane(requests: string[] = []) {
  let calls = 0;
  return {
    complete: async (request: { messages: Array<{ content: ContentBlock[] }> }) => {
      calls++;
      const texts = request.messages.map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join('\n'));
      requests.push(texts.join('\n'));
      let marker = -1;
      for (let i = 0; i < texts.length; i++) if (texts[i]!.startsWith('System: You will soon form a new memory')) marker = i;
      const folded = (marker === -1 ? texts : texts.slice(marker + 1, -1)).join('\n');
      const words = [folded.includes(OLD) ? OLD : '', folded.includes(NEW) ? NEW : ''].filter(Boolean).join(' ');
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `[summary ${calls} ${words}] ` + 'mem '.repeat(20) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  } as never;
}

const FOLD = {
  compressionModel: 'mock',
  targetChunkTokens: 50,
  headWindowTokens: 0,
  recentWindowTokens: 0,
  autoTickOnNewMessage: false,
  minChunkCharsForLLM: 0,
  l1HoldbackChunks: 0,
  hierarchical: false,
} as const;

const folding = () => new AutobiographicalStrategy({ ...FOLD });
const adaptive = () => new AutobiographicalStrategy({ ...FOLD, adaptiveResolution: true });

async function drain(cm: ContextManager): Promise<void> {
  await cm.compile(BIG);
  for (let i = 0; i < 300 && !cm.isReady(); i++) await cm.tick();
  assert.ok(cm.isReady(), 'the drain finished');
}

const summariesOf = (strategy: AutobiographicalStrategy) => (strategy as unknown as { summaries: SummaryEntry[] }).summaries;

function covered(strategy: AutobiographicalStrategy): Set<MessageId> {
  return new Set(summariesOf(strategy).filter((s) => s.level === 1).flatMap((s) => s.sourceIds));
}

function bodyRows(cm: ContextManager, id: MessageId): MessageId[] {
  const all = cm.getAllMessages();
  const at = all.findIndex((m) => m.id === id);
  const first = all[at]!;
  if (!first.bodyGroupId) return [id];
  const rows = [id];
  for (let i = at + 1; i < all.length && all[i]!.bodyGroupId === first.bodyGroupId && (all[i]!.shardIndex ?? 0) > (all[i - 1]!.shardIndex ?? 0); i++) rows.push(all[i]!.id);
  return rows;
}

function failOnce(store: JsStore, method: 'editStateItem' | 'redactStateItems', failOn: number, slot = 'messages') {
  const target = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = target[method]!;
  let calls = 0;
  target[method] = function (this: unknown, ...args: unknown[]) {
    if (args[0] === slot && ++calls === failOn) throw new Error(`test: ${method} stopped`);
    return real.apply(this, args);
  };
  return { restore: () => { target[method] = real; } };
}

describe('a show', () => {
  it('S1: writes nothing, also while a take waits to be applied', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    note(cm, `a note with ${OLD}`);
    const before = sequenceOf(cm);
    const shown = cm.showSweep(rewords());
    assert.equal(shown.changes.length, 1, 'premise: the show lists the note');
    assert.equal(sequenceOf(cm), before, 'a show writes nothing');
    cm.takeSweep('rewords-test');
    const taken = sequenceOf(cm);
    cm.showSweep(rewords());
    assert.equal(sequenceOf(cm), taken, 'a show while the take waits writes nothing');
    cm.close();
  });

  it('S16: its changes and a pass report hold no old text', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    note(cm, `a note with ${OLD}`);
    const shown = cm.showSweep(rewords());
    assert.equal(shown.changes.length, 1);
    assert.ok(!JSON.stringify(shown).includes(OLD), 'the show gives no old text');
    assert.equal(shown.changes[0]!.oldLength, `a note with ${OLD}`.length);
    assert.equal(shown.changes[0]!.newLength, `a note with ${NEW}`.length);
    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([rewords()]);
    assert.ok(!JSON.stringify(report).includes(OLD), 'the report gives no old text');
    assert.ok(!JSON.stringify(cm.sweepReceipt('rewords-test')).includes(OLD), 'the receipt gives no old text');
    cm.close();
  });

  it('S10: the entry sees the writer, the time, the metadata, and a sharded body whole', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: adaptive() });
    const id = longNote(cm, 'LONG');
    assert.ok(bodyRows(cm, id).length > 1, 'premise: the note is stored as shards');
    const seen: SweepBody[] = [];
    cm.showSweep(rewords(seen));
    const body = seen.find((b) => b.id === id);
    assert.ok(body, 'the entry is asked of the body by its first row');
    assert.equal(seen.filter((b) => b.id !== id && bodyRows(cm, id).includes(b.id)).length, 0, 'no later shard is asked as a body');
    assert.equal(body.participant, 'system');
    assert.deepEqual(body.metadata, { writer: 'faulty' });
    assert.equal(body.timestamp.getTime(), cm.getMessage(id)!.timestamp.getTime());
    const whole = textOfBlocks(body.content);
    assert.ok(whole.startsWith('LONG ') && whole.includes(OLD) && whole.endsWith('end of LONG'), 'the body is given whole');
    cm.close();
  });
});

describe('a take and its pass', () => {
  it('S2: the next compile holds the new text and none of the old, for one row and for shards', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: adaptive() });
    cm.addMessage('User', [text('BEFORE the notes')]);
    const short = note(cm, `a short note with ${OLD}`);
    const long = longNote(cm, 'LONG');
    cm.addMessage('User', [text('AFTER the notes')]);
    const shards = bodyRows(cm, long);
    assert.ok(shards.length > 1, 'premise: the long note is stored as shards');
    assert.ok((await compiledText(cm)).includes(OLD), 'premise: the compile holds the old text');

    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([rewords()]);
    assert.deepEqual(report.sweeps.map((s) => s.outcome), ['finished']);
    assert.deepEqual(new Set(report.sweeps[0]!.rewritten), new Set([short, long]));
    assert.deepEqual(new Set(report.sweeps[0]!.removed), new Set(shards.slice(1)));

    const compiled = await compiledText(cm);
    assert.ok(!compiled.includes(OLD), 'none of the old text');
    assert.ok(compiled.includes(NEW), 'the new text');
    const ids = cm.getAllMessages().map((m) => m.id);
    assert.equal(ids.indexOf(long), ids.indexOf(short) + 1, 'the long note is one row at its first shard\'s place');
    assert.ok(!cm.getMessage(long)!.bodyGroupId, 'the row is in no body group');
    for (const shard of shards.slice(1)) assert.equal(cm.getMessage(shard), null, 'its later shards are gone');
    assert.ok(compiled.indexOf('BEFORE') < compiled.indexOf('end of LONG') && compiled.indexOf('end of LONG') < compiled.indexOf('AFTER'), 'it keeps its place among its neighbours');
    cm.close();
  });

  it('S3: a second show lists nothing and the receipt names the bodies; a second pass rewrites and appends nothing', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const a = note(cm, `first ${OLD}`);
    const b = note(cm, `second ${OLD}`);
    const take = cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    assert.deepEqual(cm.showSweep(rewords()).changes, [], 'nothing left to change');
    const receipt = cm.sweepReceipt('rewords-test');
    assert.equal(receipt.take?.take, take.take);
    assert.equal(receipt.finished, true);
    assert.deepEqual(receipt.passes.flatMap((p) => p.bodies.map((body) => body.id)), [a, b]);
    const before = sequenceOf(cm);
    const again = cm.applySweeps([rewords()]);
    assert.deepEqual(again.sweeps, [], 'nothing is owed');
    assert.equal(sequenceOf(cm), before, 'a second pass writes nothing');
    cm.close();
  });

  it('S4: an entry that throws on one body: the report names it, the others are mended, and the sweep stays owed', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const good = note(cm, `good ${OLD}`);
    const bad = note(cm, `bad ${OLD}`);
    const entry = rewords();
    const throwing: SweepEntry = { ...entry, mend: (body) => { if (body.id === bad) throw new TypeError(`entry broke on ${OLD}`); return entry.mend(body); } };
    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([throwing]);
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    assert.deepEqual(report.sweeps[0]!.failed.map((f) => f.id), [bad]);
    assert.match(report.sweeps[0]!.failed[0]!.error, /TypeError/, 'the report names the error\'s type');
    assert.ok(!JSON.stringify(report).includes(OLD), 'and never its text, which can hold the old text');
    assert.ok(!JSON.stringify(cm.showSweep(throwing)).includes(OLD), 'nor does the show');
    assert.ok(textOfBlocks(cm.getMessage(good)!.content).includes(NEW), 'the other body is mended');
    assert.equal(cm.sweepReceipt('rewords-test').finished, false);
    const next = cm.applySweeps([rewords()]);
    assert.equal(next.sweeps[0]!.outcome, 'finished', 'a later pass is asked again');
    cm.close();
  });

  it('S25: an entry that gives no content can\'t empty a body: the report names it, and the body stays', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const id = note(cm, `a note ${OLD}`);
    const emptying: SweepEntry = { ...rewords(), mend: (body) => (body.id === id ? [] : null) };
    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([emptying]);
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    assert.deepEqual(report.sweeps[0]!.failed.map((f) => f.id), [id]);
    assert.match(report.sweeps[0]!.failed[0]!.error, /null/, 'the failure says what an entry gives instead');
    assert.ok(textOfBlocks(cm.getMessage(id)!.content).includes(OLD), 'the body is as it was');
    assert.deepEqual(cm.showSweep(emptying).failures.map((f) => f.id), [id], 'the show names it too');
    cm.close();
  });

  it('S12: in a store that never took the sweep a pass rewrites nothing', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const id = note(cm, `a note ${OLD}`);
    const before = sequenceOf(cm);
    assert.deepEqual(cm.applySweeps([rewords()]).sweeps, []);
    assert.equal(sequenceOf(cm), before);
    assert.ok(textOfBlocks(cm.getMessage(id)!.content).includes(OLD));
    assert.equal(cm.sweepReceipt('rewords-test').take, null);
    cm.close();
  });

  it('S15: a load rewrites nothing: an open with a take owed leaves the slot as it was', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
    const id = note(cm, `a note ${OLD}`);
    cm.takeSweep('rewords-test');
    const slot = () => JSON.stringify(cm.getStore().getStateJson('messages'));
    const before = slot();
    cm.close();
    const reopened = await ContextManager.open({ path, strategy: folding(), membrane: mockMembrane() });
    assert.equal(JSON.stringify(reopened.getStore().getStateJson('messages')), before, 'the open wrote nothing to the slot');
    assert.equal(sweepsApplied(reopened.getStore()).length, 0, 'nor to the applied list');
    assert.ok(textOfBlocks(reopened.getMessage(id)!.content).includes(OLD));
    assert.equal(reopened.sweepReceipt('rewords-test').finished, false);
    reopened.close();
  });

  it('S17: a taken sweep whose entry is not given is reported and left', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const id = note(cm, `a note ${OLD}`);
    const take = cm.takeSweep('rewords-test');
    const report = cm.applySweeps([]);
    assert.deepEqual(report.sweeps.map((s) => [s.name, s.take, s.outcome]), [['rewords-test', take.take, 'unknown']]);
    assert.ok(textOfBlocks(cm.getMessage(id)!.content).includes(OLD), 'nothing was rewritten');
    assert.throws(() => cm.takeSweep(''), /a sweep needs a name/, 'a take names its sweep');
    cm.close();
  });

  it('S26: a pass asked while a sharded addMessage stores its shards is refused, and the body stays whole', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: adaptive() });
    cm.takeSweep('rewords-test');
    let refused: unknown;
    let asked = false;
    cm.onMessage((event) => {
      if (event.type !== 'add' || asked) return;
      asked = true;
      try {
        cm.applySweeps([rewords()]);
      } catch (error) {
        refused = error;
      }
    });
    const long = longNote(cm, 'LONG');
    assert.ok(asked, 'premise: the listener heard a shard stored');
    assert.match(String(refused), /applySweeps refused/);
    assert.ok(bodyRows(cm, long).length > 1, 'the body is whole');
    assert.equal(sweepsApplied(cm.getStore()).length, 0, 'nothing was listed');
    cm.close();
  });

  it('S18: a rewrite that the store refuses is a failure, and the sweep stays owed', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    cm.addMessage('Claude', [{ type: 'tool_use', id: 'tu-1', name: 'search', input: {} }]);
    const id = note(cm, `a note ${OLD}`);
    cm.addMessage('User', [{ type: 'tool_result', toolUseId: 'tu-1', content: 'found' }]);
    const splitting: SweepEntry = { ...rewords(), mend: (body) => (body.id === id ? [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as StoredContentBlock] : null) };
    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([splitting]);
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    assert.deepEqual(report.sweeps[0]!.failed.map((f) => f.id), [id]);
    assert.ok(textOfBlocks(cm.getMessage(id)!.content).includes(OLD), 'the body is as it was');
    assert.equal(sweepsApplied(cm.getStore()).length, 0, 'the refused body is not listed');
    cm.applySweeps([splitting]);
    assert.equal(sweepsApplied(cm.getStore()).length, 0, 'nor by a second pass');
    cm.close();
  });

  it('S22: a sharded body\'s rewrite that would put a tool call before a system change is refused', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: adaptive() });
    const long = longNote(cm, 'LONG');
    assert.ok(bodyRows(cm, long).length > 1, 'premise: sharded');
    cm.addMessage('system', [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock]);
    const calling: SweepEntry = {
      ...rewords(),
      mend: (body) => (body.id === long ? [{ type: 'text', text: 'mended' }, { type: 'tool_use', id: 'tu-9', name: 'search', input: {} }] : null),
    };
    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([calling]);
    assert.deepEqual(report.sweeps[0]!.failed.map((f) => f.id), [long]);
    assert.ok(report.sweeps[0]!.failed[0]!.error.includes('system change'), report.sweeps[0]!.failed[0]!.error);
    assert.ok(cm.getMessage(long)!.bodyGroupId, 'the body is as it was');
    cm.close();
  });

  it('S23: MessageStore.rewriteBody refuses a row that is not its body\'s first', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: adaptive() });
    const long = longNote(cm, 'LONG');
    const shards = bodyRows(cm, long);
    const slot = new MessageStore(cm.getStore());
    assert.throws(() => slot.rewriteBody(shards[1]!, [{ type: 'text', text: 'x' }]), new RegExp(`not the first row of its body.*${long}`));
    assert.deepEqual(bodyRows(cm, long), shards, 'the body is as it was');
    cm.close();
  });

  it('S24: a body\'s media reaches the entry as its blob reference, and a rewrite that keeps it keeps the media', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const image: ContentBlock = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PNG } };
    const id = cm.addMessage('system', [text(`a note ${OLD}`), image], { writer: 'faulty' });
    const seen: SweepBody[] = [];
    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([rewords(seen)]);
    assert.equal(report.sweeps[0]!.outcome, 'finished', JSON.stringify(report));
    assert.ok(seen.find((b) => b.id === id)!.content.some((b) => b.type === 'blob_ref'), 'the entry sees the blob reference');
    const stored = cm.getMessage(id)!.content;
    assert.ok(textOfBlocks(stored as never).includes(NEW));
    assert.equal(stored[1]!.type, 'image', 'the image is kept');
    assert.equal((stored[1] as { source: { data: string } }).source.data, PNG);
    cm.close();
  });

  it('S9: a branch that finished, then a new body the entry changes: the show lists it, and a new take mends it', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    note(cm, `first ${OLD}`);
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    const late = note(cm, `late ${OLD}`);
    assert.deepEqual(cm.showSweep(rewords()).changes.map((c) => c.id), [late]);
    assert.equal(cm.sweepReceipt('rewords-test').finished, true, 'the branch finished the take it had');
    assert.deepEqual(cm.applySweeps([rewords()]).sweeps, [], 'the finished take is not applied again');
    cm.takeSweep('rewords-test');
    assert.equal(cm.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.ok(textOfBlocks(cm.getMessage(late)!.content).includes(NEW));
    cm.close();
  });

  it('S14: a body that the manager\'s view hides is mended', async () => {
    const cm = await ContextManager.open({
      path: freshPath(),
      strategy: new PassthroughStrategy(),
      viewFilter: (m) => m.metadata?.hidden !== true,
    });
    const id = cm.addMessage('system', [text(`held ${OLD}`)], { writer: 'faulty', hidden: true });
    assert.deepEqual(cm.showSweep(rewords()).changes.map((c) => c.id), [id]);
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    assert.ok(textOfBlocks(cm.getMessage(id)!.content).includes(NEW));
    cm.close();
  });
});

describe('a pass that stops partway', () => {
  it('S5: after its first rewrite, then a restart: both bodies are mended, and a summary over the first in a namespace that loads later is gone', async () => {
    const path = freshPath();
    let store = JsStore.openOrCreate({ path });
    const a = await ContextManager.open({ store, namespace: 'a', strategy: new PassthroughStrategy() });
    const first = note(a, `first ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 3; i++) a.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const second = note(a, `second ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 3; i++) a.addMessage('User', [text(`later ${i} ${'words '.repeat(60)}`)]);
    const laterStrategy = folding();
    const b = await ContextManager.open({ store, namespace: 'b', strategy: laterStrategy, membrane: mockMembrane() });
    await drain(b);
    assert.ok(covered(laterStrategy).has(first), 'premise: b folds the first note');
    b.close();

    a.takeSweep('rewords-test');
    const stop = failOnce(store, 'editStateItem', 2);
    a.applySweeps([rewords()]);
    stop.restore();
    assert.ok(textOfBlocks(a.getMessage(first)!.content).includes(NEW), 'premise: the first rewrite landed');
    assert.ok(textOfBlocks(a.getMessage(second)!.content).includes(OLD), 'premise: the second did not');
    assert.deepEqual(sweepsApplied(store).items.map((item) => item.kind), ['listed'], 'the list holds what a stop there leaves: the listed bodies and no finish');
    a.close();
    store.close();

    store = JsStore.openOrCreate({ path });
    const restarted = await ContextManager.open({ store, namespace: 'a', strategy: new PassthroughStrategy() });
    assert.equal(restarted.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.ok(textOfBlocks(restarted.getMessage(second)!.content).includes(NEW));
    assert.deepEqual(new Set(restarted.sweepReceipt('rewords-test').passes.flatMap((p) => p.bodies.map((body) => body.id))), new Set([first, second]));
    const loadsLater = folding();
    const late = await ContextManager.open({ store, namespace: 'b', strategy: loadsLater, membrane: mockMembrane() });
    assert.ok(!covered(loadsLater).has(first), 'no summary covers the first note');
    assert.ok(!(await compiledText(late)).includes(OLD), 'its compile holds none of the old text');
    late.close();
    restarted.close();
    store.close();
  });

  it('S6: between a long note\'s rewrite and its shards\' removal, then a restart: managers load, and the pass removes the shards before it asks any entry', async () => {
    const path = freshPath();
    let store = JsStore.openOrCreate({ path });
    const cm = await ContextManager.open({ store, strategy: adaptive() });
    const long = longNote(cm, 'LONG');
    cm.addMessage('User', [text('AFTER')]);
    const shards = bodyRows(cm, long);
    assert.ok(shards.length > 1, 'premise: sharded');
    cm.takeSweep('rewords-test');
    const stop = failOnce(store, 'redactStateItems', 1);
    cm.applySweeps([rewords()]);
    stop.restore();
    assert.ok(!cm.getMessage(long)!.bodyGroupId, 'premise: the first shard was rewritten');
    assert.ok(cm.getMessage(shards[1]!), 'premise: its later shards stayed');
    assert.deepEqual(sweepsApplied(store).items.map((item) => item.kind), ['listed'], 'the list holds what a stop there leaves');
    cm.close();
    store.close();

    store = JsStore.openOrCreate({ path });
    const restarted = await ContextManager.open({ store, strategy: adaptive() });
    const seen: SweepBody[] = [];
    const report = restarted.applySweeps([rewords(seen)]);
    assert.ok(seen.every((body) => !shards.slice(1).includes(body.id)), 'no entry is asked of a leftover shard');
    assert.deepEqual(new Set(report.sweeps[0]!.removed), new Set(shards.slice(1)));
    assert.equal(report.sweeps[0]!.outcome, 'finished');
    for (const shard of shards.slice(1)) assert.equal(restarted.getMessage(shard), null);
    const compiled = await compiledText(restarted);
    assert.ok(!compiled.includes(OLD) && compiled.includes('end of LONG'), 'the note is one row, mended');
    restarted.close();
    store.close();
  });

  it('S7: after its list and before a long note\'s rewrite: the note is whole, and the next pass mends it', async () => {
    const path = freshPath();
    let store = JsStore.openOrCreate({ path });
    const cm = await ContextManager.open({ store, strategy: adaptive() });
    const long = longNote(cm, 'LONG');
    const shards = bodyRows(cm, long);
    assert.ok(shards.length > 1, 'premise: the note is stored as shards');
    cm.takeSweep('rewords-test');
    const stop = failOnce(store, 'editStateItem', 1);
    const report = cm.applySweeps([rewords()]);
    stop.restore();
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    assert.deepEqual(bodyRows(cm, long), shards, 'the note is whole');
    assert.deepEqual(sweepsApplied(store).items.map((item) => item.kind), ['listed'], 'the list holds what a stop there leaves');
    cm.close();
    store.close();

    store = JsStore.openOrCreate({ path });
    const restarted = await ContextManager.open({ store, strategy: adaptive() });
    assert.equal(restarted.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.ok(!(await compiledText(restarted)).includes(OLD));
    assert.deepEqual(bodyRows(restarted, long), [long]);
    restarted.close();
    store.close();
  });
});

describe('summaries made from a mended row', () => {
  it('S8: a summary over a later shard of a mended long note is gone after the pass', async () => {
    const strategy = adaptive();
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    const long = longNote(cm, 'LONG');
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const shards = bodyRows(cm, long);
    await drain(cm);
    assert.ok(shards.slice(1).some((id) => covered(strategy).has(id)), 'premise: a later shard is folded');
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    const compiled = await compiledText(cm);
    for (const id of shards) assert.ok(!covered(strategy).has(id), `no summary covers ${id}`);
    assert.ok(!compiled.includes(OLD), 'the compile holds none of the old text');
    cm.close();
  });

  for (const mode of ['legacy', 'presented'] as const) {
    it(`S13 (${mode}): gone in the applying namespace, another namespace on the slot, and one that loads later`, async () => {
      const path = freshPath();
      const store = JsStore.openOrCreate({ path });
      const present = (cm: ContextManager, ids: MessageId[]) => { if (mode === 'presented') cm.presentRows(ids); };
      const mine = folding();
      const other = folding();
      const a = await ContextManager.open({ store, namespace: 'a', strategy: mine, membrane: mockMembrane() });
      const b = await ContextManager.open({ store, namespace: 'b', strategy: other, membrane: mockMembrane() });
      present(a, []);
      present(b, []);
      const ids: MessageId[] = [];
      for (let i = 0; i < 8; i++) {
        const id = i === 2 ? note(a, `note ${OLD} ${'words '.repeat(60)}`) : a.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
        present(a, [id]);
        present(b, [id]);
        ids.push(id);
      }
      const mended = ids[2]!;
      await drain(a);
      await drain(b);
      const third = folding();
      const c = await ContextManager.open({ store, namespace: 'c', strategy: third, membrane: mockMembrane() });
      present(c, []);
      await drain(c);
      for (const s of [mine, other, third]) assert.ok(covered(s).has(mended), 'premise: each namespace folds the note');
      c.close();

      a.takeSweep('rewords-test');
      a.applySweeps([rewords()]);
      for (const [cm, s, name] of [[a, mine, 'a'], [b, other, 'b']] as const) {
        const compiled = await compiledText(cm);
        assert.ok(!covered(s).has(mended), `${name}: no summary covers the mended row`);
        assert.ok(!compiled.includes(OLD), `${name}: the compile holds none of the old text`);
        await drain(cm);
        assert.ok(!(await compiledText(cm)).includes(OLD), `${name}: made again from the new text`);
        assert.ok(covered(s).has(mended), `${name}: the mended row is folded again`);
        await compiledText(cm);
        assert.ok(covered(s).has(mended), `${name}: a later compile keeps the summary made from the new text`);
      }
      const later = folding();
      const reopened = await ContextManager.open({ store, namespace: 'c', strategy: later, membrane: mockMembrane() });
      assert.ok(!covered(later).has(mended), 'c: no summary covers the mended row');
      assert.ok(!(await compiledText(reopened)).includes(OLD), 'c: the compile holds none of the old text');
      reopened.close();
      a.close();
      b.close();
      store.close();
    });
  }

  it('S21: after the pass, a tick asks the summarizer nothing that holds the old text', async () => {
    const requests: string[] = [];
    const strategy = folding();
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane(requests) });
    const id = note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    assert.ok(covered(strategy).has(id), 'premise: the note is folded');
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`after ${i} ${'words '.repeat(60)}`)]);
    requests.length = 0;
    for (let i = 0; i < 50 && !cm.isReady(); i++) await cm.tick();
    assert.ok(requests.length > 0, 'premise: the ticks compressed');
    assert.ok(requests.every((r) => !r.includes(OLD)), 'no request holds the old text');
    assert.ok(requests.some((r) => r.includes(NEW)), 'the mended row is folded again from its new text');
    cm.close();
  });

  it('S20: once a host presents, the removed shards leave the applying manager\'s window', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: adaptive() });
    cm.presentRows([]);
    const long = longNote(cm, 'LONG');
    const shards = bodyRows(cm, long);
    assert.ok(shards.length > 1, 'premise: the note is stored as shards');
    cm.presentRows(shards);
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    const presented = cm.getPresentedMessages().map((m) => m.id);
    for (const shard of shards.slice(1)) assert.ok(!presented.includes(shard), `the window no longer holds ${shard}`);
    assert.ok(presented.includes(long), 'the mended row stays in the window');
    assert.ok(!(await compiledText(cm)).includes(OLD));
    cm.close();
  });
});

describe('branches', () => {
  it('S11: a branch cut from before the take, then selected, owes the sweep, and its pass mends it', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: folding(), membrane: mockMembrane() });
    const id = note(cm, `a note ${OLD}`);
    const old = cm.branchAt(id, 'before-take');
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    await cm.switchBranch(old);
    assert.equal(cm.sweepReceipt('rewords-test').finished, false, 'the old branch owes the sweep');
    assert.ok((await compiledText(cm)).includes(OLD), 'premise: the old branch holds the old text');
    assert.equal(cm.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.ok(!(await compiledText(cm)).includes(OLD));
    cm.close();
  });

  it('S19: a derived context inherits the applied list, so a pass on its branch reaches its summaries', async () => {
    const strategy = folding();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'agent', strategy, membrane: mockMembrane() });
    note(cm, `first ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 3; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    const second = note(cm, `second ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 3; i++) cm.addMessage('User', [text(`later ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    assert.ok(covered(strategy).has(second), 'premise: the second note is folded');
    const childStrategy = folding();
    const child = await cm.derive({ branch: 'child', strategy: childStrategy, membrane: mockMembrane() });
    assert.equal(sweepsApplied(child.getStore()).length, sweepsApplied(cm.getStore()).length, 'the child holds the parent\'s list');
    assert.ok(covered(childStrategy).has(second), 'premise: the child folds the second note');
    child.takeSweep('rewords-test');
    child.applySweeps([rewords()]);
    assert.ok(!(await compiledText(child)).includes(OLD), 'the child\'s compile holds none of the old text');
    assert.ok(!covered(childStrategy).has(second));
    child.close();
    cm.close();
  });

  it('the applied list is a state of the branch', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    note(cm, `a note ${OLD}`);
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    const { items } = sweepsApplied(cm.getStore());
    assert.deepEqual(items.map((item) => item.kind), ['listed', 'finished']);
    assert.ok(cm.getStore().listStates().some((s) => s.id === SWEEPS_APPLIED_STATE_ID));
    cm.close();
  });
});

function landsThenThrows(store: JsStore, method: 'editStateItem', on: number, slot = 'messages') {
  const target = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = target[method]!;
  let calls = 0;
  target[method] = function (this: unknown, ...args: unknown[]) {
    const result = real.apply(this, args);
    if (args[0] === slot && ++calls === on) throw new Error(`test: ${method} landed, then threw`);
    return result;
  };
  return { restore: () => { target[method] = real; } };
}

function gatedMembrane() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const inner = mockMembrane() as unknown as { complete: (request: unknown) => Promise<unknown> };
  let waiting = 0;
  return {
    membrane: { complete: async (request: unknown) => { waiting++; const answer = inner.complete(request); await gate; return answer; } } as never,
    open: () => open(),
    waiting: () => waiting,
  };
}

async function until(holds: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !holds(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(holds(), what);
}

function leavesOf(all: readonly SummaryEntry[], summary: SummaryEntry): Set<MessageId> {
  if (summary.level === 1) return new Set(summary.sourceIds);
  const leaves = new Set<MessageId>();
  for (const id of summary.sourceIds) {
    const child = all.find((each) => each.id === id);
    if (child) for (const leaf of leavesOf(all, child)) leaves.add(leaf);
  }
  return leaves;
}

function spreading(): SweepEntry {
  return {
    ...rewords(),
    mend: (body) => {
      if (body.metadata?.writer !== 'faulty') return null;
      if (!body.content.some((b) => b.type === 'text' && b.text.includes(OLD))) return null;
      return body.content.map((b) => (b.type === 'text' && b.text.includes(OLD) ? { ...b, text: b.text.replaceAll(OLD, NEW) } : b));
    },
  };
}

describe('what a pass reads and refuses', () => {
  it('S27: an entry that spreads a block keeps no raw form of it, in what a show gives and what the store keeps', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: `a note ${OLD}` }, { type: 'output_text', text: 'a second part' }] };
    const own = { type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'output_text', text: 'another item' }] };
    const id = cm.addMessage('system', [
      { type: 'text', text: `a note ${OLD}`, rawItem: item },
      { type: 'text', text: 'a second part', rawItem: item },
      { type: 'text', text: 'another item', rawItem: own },
    ] as ContentBlock[], { writer: 'faulty' });
    assert.ok(JSON.stringify(cm.getMessage(id)!.content).includes('msg_1'), 'premise: the store keeps the raw item');
    const shown = cm.showSweep(spreading());
    assert.equal(shown.changes.length, 1, 'premise: the show lists the note');
    assert.ok(!JSON.stringify(shown).includes(OLD), 'the show gives no raw form that holds the old text');
    cm.takeSweep('rewords-test');
    assert.equal(cm.applySweeps([spreading()]).sweeps[0]!.outcome, 'finished');
    const stored = cm.getMessage(id)!.content as Array<{ rawItem?: unknown }>;
    assert.ok(!JSON.stringify(stored).includes(OLD), 'the store keeps no old text');
    assert.equal(stored[0]!.rawItem, undefined, 'the edited block gives up its raw item');
    assert.equal(stored[1]!.rawItem, undefined, 'and so does the block that shared it');
    assert.deepEqual(stored[2]!.rawItem, own, 'a block whose raw item no edited block carried keeps it');
    cm.close();
  });

  it('S30: later shards a pass listed are asked of no entry, in the same pass or a later one, and the next pass removes them', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: adaptive() });
    const long = longNote(cm, 'LONG');
    cm.addMessage('User', [text('AFTER')]);
    const shards = bodyRows(cm, long);
    assert.ok(shards.length > 1, 'premise: the note is stored as shards');
    const seen: SweepBody[] = [];
    const other: SweepEntry = { ...rewords(seen), name: 'rewords-other' };
    cm.takeSweep('rewords-test');
    cm.takeSweep('rewords-other');
    const stop = failOnce(cm.getStore(), 'redactStateItems', 1);
    const report = cm.applySweeps([rewords(), other]);
    stop.restore();
    assert.ok(cm.getMessage(shards[1]!), 'premise: the later shards stayed');
    assert.ok(seen.every((body) => !shards.slice(1).includes(body.id)), 'the other sweep is asked of no later shard');
    assert.deepEqual(report.sweeps.find((s) => s.name === 'rewords-other')?.rewritten ?? [], [], 'nor rewrites one');
    assert.deepEqual(report.sweeps.find((s) => s.name === 'rewords-other')?.failed ?? [], [], 'nor names one as a failure: they are no body');
    const next = cm.applySweeps([rewords(), other]);
    assert.equal(next.sweeps.find((s) => s.name === 'rewords-test')?.outcome, 'finished');
    for (const shard of shards.slice(1)) assert.equal(cm.getMessage(shard), null, `${shard} is removed`);
    const compiled = await compiledText(cm);
    assert.ok(!compiled.includes(OLD) && compiled.includes('end of LONG'), 'the note is one row, mended');
    cm.close();
  });

  it('S31: a body stored short is asked of no entry: the report and the show name it, and the sweep stays owed', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const slot = new MessageStore(cm.getStore());
    const head = slot.append('system', [text(`part one ${OLD} `)], { writer: 'faulty' }, undefined, { bodyGroupId: 'g-short', shardIndex: 0, shardCount: 3 });
    slot.append('system', [text(`part two ${OLD}`)], { writer: 'faulty' }, undefined, { bodyGroupId: 'g-short', shardIndex: 1, shardCount: 3 });
    const seen: SweepBody[] = [];
    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([rewords(seen)]);
    assert.ok(!seen.some((body) => body.id === head.id), 'the entry is not asked of it');
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    assert.deepEqual(report.sweeps[0]!.failed.map((f) => f.id), [head.id]);
    assert.match(report.sweeps[0]!.failed[0]!.error, /short/);
    assert.equal(cm.getMessage(head.id)!.bodyGroupId, 'g-short', 'its rows are as they were');
    assert.deepEqual(cm.showSweep(rewords()).failures.map((f) => f.id), [head.id], 'the show names it too');
    cm.close();
  });

  it('S46: a rewrite never makes one row of content that the strategy would shard, but a row long before and after is edited', async () => {
    const path = freshPath();
    const before = await ContextManager.open({ path, strategy: folding(), membrane: mockMembrane() });
    const longRow = longNote(before, 'ROW');
    before.close();
    const cm = await ContextManager.open({ path, strategy: adaptive() });
    assert.deepEqual(bodyRows(cm, longRow), [longRow], 'premise: one row, stored while ingress did not shard');
    const sharded = longNote(cm, 'SHARDS');
    const shards = bodyRows(cm, sharded);
    assert.ok(shards.length > 1, 'premise: the note is stored as shards');
    const short = note(cm, `a short note ${OLD}`);
    assert.deepEqual(bodyRows(cm, short), [short]);
    const lengthens: SweepEntry = {
      ...rewords(),
      mend: (body) => {
        const whole = textOfBlocks(body.content);
        if (body.metadata?.writer !== 'faulty' || !whole.includes(OLD)) return null;
        const mended = whole.replaceAll(OLD, NEW);
        return [{ type: 'text', text: body.id === short ? `${mended} ${'added words '.repeat(400)}` : mended }];
      },
    };
    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([lengthens]);
    const sweep = report.sweeps[0]!;
    assert.equal(sweep.outcome, 'owed');
    assert.deepEqual(new Set(sweep.failed.map((f) => f.id)), new Set([sharded, short]), 'the report names both refused bodies');
    assert.deepEqual(sweep.rewritten, [longRow], 'the row long before and after is edited');
    assert.deepEqual(bodyRows(cm, sharded), shards, 'the sharded note is as it was');
    assert.ok(textOfBlocks(cm.getMessage(short)!.content).includes(OLD), 'the short note is as it was');
    const listed = sweepsApplied(cm.getStore()).items.flatMap((item) => (item.kind === 'listed' ? item.bodies.map((body) => body.id) : []));
    assert.deepEqual(listed, [longRow], 'neither refused body is listed');
    const length = sweepsApplied(cm.getStore()).length;
    assert.equal(cm.applySweeps([lengthens]).sweeps[0]!.outcome, 'owed', 'the sweep stays owed');
    assert.equal(sweepsApplied(cm.getStore()).length, length, 'a second pass lists nothing');
    cm.close();
  });

  it('S37: a list item or a take record that does not parse is named in the pass report, and a strategy reading the list warns of it', async (t) => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    note(cm, `a note ${OLD}`);
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    const store = cm.getStore();
    store.appendToStateJson(SWEEPS_APPLIED_STATE_ID, { v: 1, kind: 'listed' });
    const bad = store.appendJson('context-manager/sweep-take', { v: 1 });
    const report = cm.applySweeps([rewords()]);
    assert.deepEqual(report.unreadable, { items: [2], takes: [bad.id] });
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    const reader = await ContextManager.open({ store, namespace: 'reader', strategy: folding(), membrane: mockMembrane() });
    assert.ok(warnings.some((w) => w.includes('[2]') && w.includes("don't parse")), warnings.join('\n'));
    reader.close();
    cm.close();
  });
});

describe('what runs beside a pass', () => {
  it('S28: a listener that moves the branch stops the pass: nothing is written on the other branch, and the first owes the sweep', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const first = note(cm, `first ${OLD}`);
    const second = note(cm, `second ${OLD}`);
    const last = cm.addMessage('User', [text('after the notes')]);
    const other = cm.branchAt(last, 'other');
    const main = cm.getStore().currentBranch().name;
    cm.takeSweep('rewords-test');
    let moving: Promise<void> | undefined;
    cm.onMessage((event) => { if (event.type === 'edit' && !moving) moving = cm.switchBranch(other); });
    const report = cm.applySweeps([rewords()]);
    assert.ok(moving, 'premise: the listener moved the branch');
    await moving;
    assert.ok(report.stopped, 'the report says the pass stopped');
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    assert.equal(cm.getStore().currentBranch().name, other);
    assert.ok(textOfBlocks(cm.getMessage(first)!.content).includes(OLD), 'the other branch: the first note as it was');
    assert.ok(textOfBlocks(cm.getMessage(second)!.content).includes(OLD), 'the other branch: the second note as it was');
    assert.equal(sweepsApplied(cm.getStore()).length, 0, 'nothing is listed on the other branch');
    await cm.switchBranch(main);
    assert.ok(textOfBlocks(cm.getMessage(first)!.content).includes(NEW), 'premise: the first rewrite landed on its branch');
    assert.equal(cm.sweepReceipt('rewords-test').finished, false, 'the first branch owes the sweep');
    assert.equal(cm.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.ok(textOfBlocks(cm.getMessage(second)!.content).includes(NEW));
    cm.close();
  });

  it('S29: a listener that closes the manager stops the pass, which still reports; after a reopen the next pass finishes', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
    note(cm, `first ${OLD}`);
    const second = note(cm, `second ${OLD}`);
    cm.takeSweep('rewords-test');
    let closed = false;
    cm.onMessage((event) => { if (event.type === 'edit' && !closed) { closed = true; cm.close(); } });
    const report = cm.applySweeps([rewords()]);
    assert.ok(closed, 'premise: the listener closed the manager');
    assert.ok(report.stopped, 'the report says the pass stopped');
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    const reopened = await ContextManager.open({ path, strategy: new PassthroughStrategy() });
    assert.ok(textOfBlocks(reopened.getMessage(second)!.content).includes(OLD), 'nothing was written after the close');
    assert.equal(reopened.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.ok(textOfBlocks(reopened.getMessage(second)!.content).includes(NEW));
    reopened.close();
  });

  it('S32: a tick that a listener starts during a pass lets go of nothing until the pass ends, and no compile after it holds the old text', async () => {
    const strategy = folding();
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    cm.addMessage('User', [text(`chat ${'words '.repeat(60)}`)]);
    const a = note(cm, `first ${OLD}`);
    const b = note(cm, `second ${OLD}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    const l1 = summariesOf(strategy).find((s) => s.level === 1 && s.sourceIds.includes(a));
    assert.ok(l1?.sourceIds.includes(b), 'premise: one summary folds both notes');
    cm.takeSweep('rewords-test');
    let ticking: Promise<void> | undefined;
    cm.onMessage((event) => { if (event.type === 'edit' && !ticking) ticking = cm.tick(); });
    cm.applySweeps([rewords()]);
    assert.ok(ticking, 'premise: the listener started a tick');
    await ticking;
    await drain(cm);
    assert.ok(!(await compiledText(cm)).includes(OLD), 'the compile holds none of the old text');
    assert.ok(covered(strategy).has(a) && covered(strategy).has(b), 'both notes are folded again');
    cm.close();
  });

  it('S33: a pass asked during a pass is refused, and the first pass finishes', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    note(cm, `first ${OLD}`);
    note(cm, `second ${OLD}`);
    cm.takeSweep('rewords-test');
    let refused: unknown;
    let asked = false;
    cm.onMessage((event) => {
      if (event.type !== 'edit' || asked) return;
      asked = true;
      try {
        cm.applySweeps([rewords()]);
      } catch (error) {
        refused = error;
      }
    });
    const report = cm.applySweeps([rewords()]);
    assert.ok(asked, 'premise: the listener asked for a pass');
    assert.match(String(refused), /applySweeps refused: a pass is running/);
    assert.equal(report.sweeps[0]!.outcome, 'finished');
    assert.deepEqual(sweepsApplied(cm.getStore()).items.map((item) => item.kind), ['listed', 'finished']);
    cm.close();
  });

  it('S39: a show asked while a sharded addMessage stores its shards is refused', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: adaptive() });
    let refused: unknown;
    let asked = false;
    cm.onMessage((event) => {
      if (event.type !== 'add' || asked) return;
      asked = true;
      try {
        cm.showSweep(rewords());
      } catch (error) {
        refused = error;
      }
    });
    longNote(cm, 'LONG');
    assert.ok(asked, 'premise: the listener heard a shard stored');
    assert.match(String(refused), /showSweep refused/);
    cm.close();
  });

  it('S40: a rewrite that threw after its write says it may have landed, and the next pass finishes', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: adaptive() });
    const id = note(cm, `a note ${OLD}`);
    const long = longNote(cm, 'LONG');
    const shards = bodyRows(cm, long);
    assert.ok(shards.length > 1, 'premise: the note is stored as shards');
    cm.takeSweep('rewords-test');
    const broken = landsThenThrows(cm.getStore(), 'editStateItem', 1);
    const report = cm.applySweeps([rewords()]);
    broken.restore();
    assert.deepEqual(report.sweeps[0]!.failed.map((f) => f.id), [id]);
    assert.match(report.sweeps[0]!.failed[0]!.error, /may have landed/);
    assert.ok(textOfBlocks(cm.getMessage(id)!.content).includes(NEW), 'premise: the write landed');
    assert.equal(cm.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.ok(!(await compiledText(cm)).includes(OLD));
    cm.close();
  });

  for (const when of ['before', 'after'] as const) {
    it(`S44 (${when}): a compression in flight across a pass leaves no summary of the old text, landing ${when} the next select`, async () => {
      const gated = gatedMembrane();
      const strategy = folding();
      const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: gated.membrane });
      const id = note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
      for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
      await cm.compile(BIG);
      const ticking = cm.tick();
      await until(() => gated.waiting() > 0, 'premise: a compression is in flight');
      cm.takeSweep('rewords-test');
      cm.applySweeps([rewords()]);
      if (when === 'after') await cm.compile(BIG);
      gated.open();
      await ticking;
      await drain(cm);
      assert.ok(!(await compiledText(cm)).includes(OLD), 'the compile holds none of the old text');
      assert.ok(covered(strategy).has(id), 'the note is folded again');
      cm.close();
    });
  }
});

describe('readers that keep summaries', () => {
  it('S34: two instances of one namespace each let go of what a pass listed', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const one = folding();
    const first = await ContextManager.open({ store, namespace: 'a', strategy: one, membrane: mockMembrane() });
    const id = note(first, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) first.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(first);
    const two = folding();
    const second = await ContextManager.open({ store, namespace: 'a', strategy: two, membrane: mockMembrane() });
    assert.ok(covered(one).has(id) && covered(two).has(id), 'premise: both instances fold the note');
    first.takeSweep('rewords-test');
    first.applySweeps([rewords()]);
    assert.ok(!(await compiledText(first)).includes(OLD), 'the first to compile holds none of the old text');
    assert.ok(!(await compiledText(second)).includes(OLD), 'nor does the second');
    assert.ok(!covered(two).has(id), 'the second lets go of its summary');
    second.close();
    first.close();
    store.close();
  });

  it('S35: a sweep cursor past the list\'s end is warned of, and the list is read from its start', async (t) => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const strategy = folding();
    const b = await ContextManager.open({ store, namespace: 'b', strategy, membrane: mockMembrane() });
    const id = note(b, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) b.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(b);
    assert.ok(covered(strategy).has(id), 'premise: b folds the note');
    b.close();
    const a = await ContextManager.open({ store, namespace: 'a', strategy: new PassthroughStrategy() });
    a.takeSweep('rewords-test');
    a.applySweeps([rewords()]);
    store.setStateJson('b/autobio:sweep-cursor', 100);
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    const later = folding();
    const reopened = await ContextManager.open({ store, namespace: 'b', strategy: later, membrane: mockMembrane() });
    assert.ok(!covered(later).has(id), 'no summary covers the note');
    assert.ok(!(await compiledText(reopened)).includes(OLD), 'the compile holds none of the old text');
    assert.ok(warnings.some((w) => w.includes('sweep') && w.includes('100')), warnings.join('\n'));
    reopened.close();
    a.close();
    store.close();
  });

  it('S38: with hierarchy on, no summary of any level over a listed row stays', async () => {
    const strategy = new AutobiographicalStrategy({ ...FOLD, hierarchical: true, mergeThreshold: 2 });
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    const id = note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 7; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    const over = () => summariesOf(strategy).filter((s) => leavesOf(summariesOf(strategy), s).has(id));
    assert.ok(over().some((s) => s.level > 1), 'premise: a summary above the note\'s own folds it');
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    assert.ok(!(await compiledText(cm)).includes(OLD), 'the compile holds none of the old text');
    assert.deepEqual(over().map((s) => s.id), [], 'no summary over the note stays, of any level');
    cm.close();
  });

  it('S43: a chunk record whose rows a pass listed keeps them, and is compressed again over them, under a later chunk size too', async () => {
    const path = freshPath();
    const strategy = folding();
    const cm = await ContextManager.open({ path, strategy, membrane: mockMembrane() });
    const notes: MessageId[] = [];
    for (let i = 0; i < 8; i++) notes.push(note(cm, `note ${i} ${OLD} ${'words '.repeat(60)}`));
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    cm.addMessage('User', [text('a short tail')]);
    await drain(cm);
    const foldsOf = (s: AutobiographicalStrategy) =>
      summariesOf(s).filter((summary) => summary.level === 1 && summary.sourceIds.some((id) => notes.includes(id))).map((summary) => summary.sourceIds.join(',')).sort();
    const folds = foldsOf(strategy);
    assert.ok(notes.every((id) => covered(strategy).has(id)), 'premise: every note is folded');
    assert.ok(folds.every((fold) => fold.split(',').every((id) => notes.includes(id))), `premise: each summary over a note folds notes alone: ${JSON.stringify(folds)} of notes ${notes.join(',')}`);
    cm.close();
    const larger = new AutobiographicalStrategy({ ...FOLD, targetChunkTokens: 500 });
    const reopened = await ContextManager.open({ path, strategy: larger, membrane: mockMembrane() });
    reopened.takeSweep('rewords-test');
    reopened.applySweeps([rewords()]);
    await drain(reopened);
    assert.deepEqual(foldsOf(larger), folds, 'the notes are folded again over the rows their records held');
    assert.ok(!(await compiledText(reopened)).includes(OLD));
    reopened.close();
  });

  it('S45: a context derived before a take owes the take made through its parent, and its pass mends it', async () => {
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'agent', strategy: folding(), membrane: mockMembrane() });
    note(cm, `a note ${OLD}`);
    const child = await cm.derive({ branch: 'child', strategy: folding(), membrane: mockMembrane() });
    cm.takeSweep('rewords-test');
    assert.equal(child.sweepReceipt('rewords-test').finished, false, 'the child owes the take');
    assert.equal(child.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.ok(!(await compiledText(child)).includes(OLD), 'the child\'s compile holds none of the old text');
    child.close();
    cm.close();
  });
});
