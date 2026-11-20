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

async function dryCompiledText(cm: ContextManager): Promise<string> {
  const result = await cm.compile(BIG, undefined, { dryRun: true });
  return result.messages.map((m) => textOfBlocks(m.content as { type: string; text?: string }[])).join('\n');
}

const total = (levels: readonly { level: number; count: number }[]): number => levels.reduce((sum, each) => sum + each.count, 0);

function byLevel(summaries: readonly SummaryEntry[]): Array<{ level: number; count: number }> {
  const counts = new Map<number, number>();
  for (const summary of summaries) counts.set(summary.level, (counts.get(summary.level) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a - b).map(([level, count]) => ({ level, count }));
}

/** The summaries whose leaves hold `id`: an L1 over it, and every summary above that L1. */
function summariesOver(strategy: AutobiographicalStrategy, id: MessageId): SummaryEntry[] {
  const all = summariesOf(strategy);
  return all.filter((summary) => leavesOf(all, summary).has(id));
}

/** Waits until the clock reads past `iso`, so that what is written next is written after it. */
async function clockPast(iso: string): Promise<void> {
  const at = Date.parse(iso);
  while (Date.now() <= at) await new Promise((resolve) => setTimeout(resolve, 1));
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
    const named = note(cm, `named ${OLD}`);
    const posing = note(cm, `posing ${OLD}`);
    const trapped = note(cm, `trapped ${OLD}`);
    const proxied = note(cm, `proxied ${OLD}`);
    const entry = rewords();
    const throwing: SweepEntry = {
      ...entry,
      mend: (body) => {
        if (body.id === bad) throw new TypeError(`entry broke on ${OLD}`);
        if (body.id === named) {
          const error = new RangeError('no message');
          error.name = textOfBlocks(body.content);
          throw error;
        }
        if (body.id === posing) {
          const error = new SyntaxError('no message');
          Object.defineProperty(error, 'constructor', { value: { name: textOfBlocks(body.content) } });
          throw error;
        }
        if (body.id === trapped) {
          const error = new Error('no message');
          Object.defineProperty(error, 'constructor', { get: () => { throw new Error(textOfBlocks(body.content)); } });
          throw error;
        }
        if (body.id === proxied) throw new Proxy({}, { getPrototypeOf: () => { throw new Error(textOfBlocks(body.content)); } });
        return entry.mend(body);
      },
    };
    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([throwing]);
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    assert.deepEqual(report.sweeps[0]!.failed.map((f) => f.id), [bad, named, posing, trapped, proxied]);
    assert.match(report.sweeps[0]!.failed[0]!.error, /TypeError/, 'the report names the error\'s type');
    assert.match(report.sweeps[0]!.failed[1]!.error, /RangeError/, 'by its class, whatever its name says');
    assert.match(report.sweeps[0]!.failed[2]!.error, /SyntaxError/, 'or its constructor says');
    assert.ok(!JSON.stringify(report).includes(OLD), 'and never its text, which can hold the old text');
    assert.ok(!JSON.stringify(cm.showSweep(throwing)).includes(OLD), 'nor does the show');
    assert.ok(textOfBlocks(cm.getMessage(good)!.content).includes(NEW), 'the other body is mended');
    assert.equal(cm.sweepReceipt('rewords-test').finished, false);
    const next = cm.applySweeps([rewords()]);
    assert.equal(next.sweeps[0]!.outcome, 'finished', 'a later pass is asked again');
    cm.close();
  });

  it('S25: an entry that gives no content, or only empty text, can\'t empty a body: the report names it, and the body stays', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const id = note(cm, `a note ${OLD}`);
    const blank = note(cm, `a blank note ${OLD}`);
    const emptying: SweepEntry = {
      ...rewords(),
      mend: (body) => (body.id === id ? [] : body.id === blank ? [{ type: 'text', text: '' }, { type: 'text', text: '' }] : null),
    };
    cm.takeSweep('rewords-test');
    const report = cm.applySweeps([emptying]);
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    assert.deepEqual(report.sweeps[0]!.failed.map((f) => f.id), [id, blank]);
    for (const failure of report.sweeps[0]!.failed) assert.match(failure.error, /null/, 'the failure says what an entry gives instead');
    assert.ok(textOfBlocks(cm.getMessage(id)!.content).includes(OLD), 'the body is as it was');
    assert.ok(textOfBlocks(cm.getMessage(blank)!.content).includes(OLD), 'and so is the one given empty text');
    assert.deepEqual(cm.showSweep(emptying).failures.map((f) => f.id), [id, blank], 'the show names them too');
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
  it('S5: after its first rewrite, then a restart: both bodies are mended, and a namespace that loads later keeps its summary over the first and counts it old', async () => {
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
    assert.ok(summariesOver(loadsLater, first).length > 0, 'its summary over the first note stays');
    const old = new Set([...summariesOver(loadsLater, first), ...summariesOver(loadsLater, second)]);
    assert.deepEqual(late.sweepReceipt('rewords-test').oldSummaries, byLevel([...old]), 'and its receipt counts it old, with the one over the second');
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
  for (const mode of ['legacy', 'presented'] as const) {
    it(`S8 (${mode}): the summaries over a long note's removed shards go with the pass, and a dry compile right after it shows none of them`, async () => {
      const strategy = adaptive();
      const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
      if (mode === 'presented') cm.presentRows([]);
      const long = longNote(cm, 'LONG');
      for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
      if (mode === 'presented') cm.presentRows(cm.getAllMessages().map((m) => m.id));
      const shards = bodyRows(cm, long);
      await drain(cm);
      const removed = shards.slice(1);
      const going = summariesOf(strategy).filter((summary) => removed.some((id) => leavesOf(summariesOf(strategy), summary).has(id)));
      assert.ok(going.length > 0, 'premise: a later shard is folded');
      cm.takeSweep('rewords-test');
      cm.applySweeps([rewords()]);
      const dry = await dryCompiledText(cm);
      for (const summary of going) {
        assert.ok(!summariesOf(strategy).some((s) => s.id === summary.id), `${summary.id} is dropped`);
        assert.ok(!dry.includes(summary.content), `the dry compile doesn't show ${summary.id}`);
      }
      for (const id of removed) assert.ok(!covered(strategy).has(id), `no summary covers ${id}`);
      cm.close();
    });
  }

  for (const mode of ['legacy', 'presented'] as const) {
    it(`S13 (${mode}): an old summary stays in the applying namespace, another namespace on the slot and one that loads later, and a dry compile and a live one show the same`, async () => {
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

      const before = new Map([mine, other, third].map((s) => [s, summariesOver(s, mended).map((summary) => summary.id)]));
      a.takeSweep('rewords-test');
      a.applySweeps([rewords()]);
      for (const [cm, s, name] of [[a, mine, 'a'], [b, other, 'b']] as const) {
        const dry = await dryCompiledText(cm);
        const live = await compiledText(cm);
        assert.equal(dry, live, `${name}: a dry compile and a live one hold the same`);
        assert.deepEqual(summariesOver(s, mended).map((summary) => summary.id), before.get(s), `${name}: the old summary over the mended row stays`);
        assert.ok(live.includes(OLD), `${name}: it keeps its text`);
        await drain(cm);
        assert.deepEqual(summariesOver(s, mended).map((summary) => summary.id), before.get(s), `${name}: a tick drops nothing`);
      }
      const later = folding();
      const reopened = await ContextManager.open({ store, namespace: 'c', strategy: later, membrane: mockMembrane() });
      assert.deepEqual(summariesOver(later, mended).map((summary) => summary.id), before.get(third), 'c: the old summary stays');
      assert.equal(await dryCompiledText(reopened), await compiledText(reopened), 'c: a dry compile and a live one hold the same');
      reopened.close();
      a.close();
      b.close();
      store.close();
    });
  }

  it('S21: after the second act, a tick asks the summarizer nothing that holds the old text', async () => {
    const requests: string[] = [];
    const strategy = folding();
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane(requests) });
    const id = note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    assert.ok(covered(strategy).has(id), 'premise: the note is folded');
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    cm.dropOldSummaries('rewords-test');
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`after ${i} ${'words '.repeat(60)}`)]);
    requests.length = 0;
    for (let i = 0; i < 50 && !cm.isReady(); i++) await cm.tick();
    assert.ok(requests.length > 0, 'premise: the ticks compressed');
    assert.ok(requests.every((r) => !r.includes(OLD)), 'no request holds the old text');
    assert.ok(requests.some((r) => r.includes(NEW)), 'the mended row is folded again from its new text');
    cm.close();
  });

  it('S69: after a pass, the first tick of another manager asks the summarizer nothing that holds the old text', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const writer = await ContextManager.open({ store, namespace: 'w', strategy: new PassthroughStrategy() });
    note(writer, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) writer.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const requests: string[] = [];
    const reader = await ContextManager.open({ store, namespace: 'r', strategy: folding(), membrane: mockMembrane(requests) });
    await reader.compile(BIG);
    writer.takeSweep('rewords-test');
    writer.applySweeps([rewords()]);
    await reader.tick();
    assert.ok(requests.length > 0, 'premise: the tick compressed');
    assert.ok(requests.every((r) => !r.includes(OLD)), 'no request holds the old text');
    reader.close();
    writer.close();
    store.close();
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

  it('S50: leftover shards that a tick folds after a stop leave no summary once the next pass removes them', async () => {
    const strategy = adaptive();
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    const long = longNote(cm, 'LONG');
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const shards = bodyRows(cm, long);
    assert.ok(shards.length > 1, 'premise: the note is stored as shards');
    cm.takeSweep('rewords-test');
    const stop = failOnce(cm.getStore(), 'redactStateItems', 1);
    cm.applySweeps([rewords()]);
    stop.restore();
    assert.ok(cm.getMessage(shards[1]!), 'premise: the later shards stayed');
    await drain(cm);
    assert.ok(summariesOf(strategy).some((s) => s.content.includes(OLD)), 'premise: a tick summarized a leftover shard\'s old text');
    assert.equal(cm.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    await drain(cm);
    assert.ok(!summariesOf(strategy).some((s) => s.content.includes(OLD)), 'no summary of the old text stays');
    assert.ok(!(await compiledText(cm)).includes(OLD), 'the compile holds none of the old text');
    cm.close();
  });

  it('S57: after a long note\'s pass, no chunk record names a shard the pass removed', async () => {
    const strategy = adaptive();
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    const long = longNote(cm, 'LONG');
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const shards = bodyRows(cm, long);
    await drain(cm);
    const recordsOf = () => (strategy as unknown as { chunkRecords: Array<{ id: string; sourceIds: MessageId[] }> }).chunkRecords;
    assert.ok(recordsOf().some((r) => r.sourceIds.includes(shards[shards.length - 1]!)), 'premise: a record holds a later shard');
    cm.takeSweep('rewords-test');
    assert.equal(cm.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    await drain(cm);
    const named = recordsOf().flatMap((r) => r.sourceIds.filter((id) => cm.getMessage(id) === null).map((id) => `${r.id}:${id}`));
    assert.deepEqual(named, [], 'every row a record names is stored');
    cm.close();
  });
});

describe('old summaries and the second act', () => {
  it('S61: the count holds each old summary and each summary above it, the same in the show before the take and the receipt after, and leaves out an L1 written after the pass', async () => {
    const strategy = new AutobiographicalStrategy({ ...FOLD, hierarchical: true, mergeThreshold: 2 });
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    const folded = note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 7; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    const old = summariesOver(strategy, folded);
    assert.ok(old.some((s) => s.level > 1), 'premise: a summary above the note\'s L1 folds it');
    const unfolded = note(cm, `a later note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`after ${i} ${'words '.repeat(60)}`)]);
    assert.ok(!covered(strategy).has(unfolded), 'premise: the later note is not folded yet');
    const shown = cm.showSweep(rewords());
    assert.deepEqual(shown.changes.map((c) => c.id).sort(), [folded, unfolded].sort(), 'premise: the show lists both notes');
    assert.deepEqual(shown.oldSummaries, byLevel(old), 'the show counts the L1 over the folded note and each summary above it');
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    assert.deepEqual(cm.sweepReceipt('rewords-test').oldSummaries, shown.oldSummaries, 'the receipt after the take counts the same');
    await clockPast(sweepsApplied(cm.getStore()).items[0]!.at);
    await drain(cm);
    assert.ok(covered(strategy).has(unfolded), 'premise: an L1 over the later note is written after the pass');
    const level1 = (levels: readonly { level: number; count: number }[]) => levels.find((each) => each.level === 1)?.count;
    assert.equal(level1(cm.sweepReceipt('rewords-test').oldSummaries), level1(shown.oldSummaries), 'the L1 written after the pass is not counted');
    cm.close();
  });

  it('S62: the cost report writes nothing, and names what the second act drops: the summaries at each level, the records folded again and the tokens of the rows made raw', async () => {
    const strategy = folding();
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    const id = note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    assert.equal(summariesOver(strategy, id).length, 1, 'premise: one L1 folds the note');
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    const sequence = sequenceOf(cm);
    const cost = cm.oldSummaryCost('rewords-test');
    assert.equal(sequenceOf(cm), sequence, 'the cost report writes nothing');
    assert.deepEqual(cost.summaries, [{ level: 1, count: 1 }]);
    assert.equal(cost.records, 1, 'one chunk record is folded again');
    assert.ok(cost.rawTokens > 0, 'its rows have tokens');
    assert.deepEqual(cm.dropOldSummaries('rewords-test'), cost, 'the second act drops what the report named');
    cm.close();
  });

  it('S63: after the second act no compile holds a counted summary, a dry one made first included; the record is folded again from the new text, and a second act drops nothing', async () => {
    const strategy = folding();
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    const id = note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    const counted = summariesOver(strategy, id).map((s) => s.id);
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    assert.ok((await dryCompiledText(cm)).includes(OLD), 'premise: the old summary renders');
    assert.equal(total(cm.dropOldSummaries('rewords-test').summaries), counted.length);
    assert.ok(!(await dryCompiledText(cm)).includes(OLD), 'a dry compile made before any live one holds none of them');
    for (const sid of counted) assert.ok(!summariesOf(strategy).some((s) => s.id === sid), `${sid} is dropped`);
    await clockPast(sweepsApplied(cm.getStore()).items[0]!.at);
    await drain(cm);
    const made = summariesOver(strategy, id);
    assert.ok(made.length > 0 && made.every((s) => s.content.includes(NEW) && !s.content.includes(OLD)), 'the record is folded again from the new text');
    assert.deepEqual(cm.dropOldSummaries('rewords-test'), { summaries: [], records: 0, rawTokens: 0 }, 'a second act drops nothing');
    assert.deepEqual(summariesOver(strategy, id).map((s) => s.id), made.map((s) => s.id));
    cm.close();
  });

  it('S64: the second act drops one resident\'s old summaries only', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const mine = folding();
    const other = folding();
    const a = await ContextManager.open({ store, namespace: 'a', strategy: mine, membrane: mockMembrane() });
    const b = await ContextManager.open({ store, namespace: 'b', strategy: other, membrane: mockMembrane() });
    const id = note(a, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) a.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(a);
    await drain(b);
    assert.ok(covered(mine).has(id) && covered(other).has(id), 'premise: both namespaces fold the note');
    a.takeSweep('rewords-test');
    a.applySweeps([rewords()]);
    const kept = summariesOf(other).map((s) => s.id);
    const counted = b.sweepReceipt('rewords-test').oldSummaries;
    assert.ok(total(counted) > 0, 'premise: b counts an old summary');
    a.dropOldSummaries('rewords-test');
    assert.deepEqual(a.sweepReceipt('rewords-test').oldSummaries, [], 'a counts none');
    assert.ok((await compiledText(b)).includes(OLD), 'b still renders its old summary');
    assert.deepEqual(summariesOf(other).map((s) => s.id), kept, 'b keeps its summaries');
    assert.deepEqual(b.sweepReceipt('rewords-test').oldSummaries, counted, 'and its count');
    a.close();
    b.close();
    store.close();
  });

  it('S67: a second act made through an instance that another instance wrote behind takes up the store first, and keeps the other\'s summaries', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const one = folding();
    const first = await ContextManager.open({ store, namespace: 'a', strategy: one, membrane: mockMembrane() });
    const id = note(first, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) first.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(first);
    const two = folding();
    const second = await ContextManager.open({ store, namespace: 'a', strategy: two, membrane: mockMembrane() });
    first.takeSweep('rewords-test');
    first.applySweeps([rewords()]);
    for (let i = 0; i < 4; i++) first.addMessage('User', [text(`later ${i} ${'words '.repeat(60)}`)]);
    await drain(first);
    const added = summariesOf(one).filter((s) => !summariesOf(two).some((t) => t.id === s.id)).map((s) => s.id);
    assert.ok(added.length > 0, 'premise: the first wrote summaries that the second doesn\'t hold');
    assert.ok(total(second.dropOldSummaries('rewords-test').summaries) > 0, 'premise: the second dropped the note\'s summary');
    const stored = (store.getStateJson('a/autobio:summaries') as SummaryEntry[]).map((s) => s.id);
    for (const sid of added) assert.ok(stored.includes(sid), `the store keeps ${sid}`);
    assert.deepEqual(summariesOver(two, id), [], 'no summary over the note stays in the second');
    second.close();
    first.close();
    store.close();
  });

  it('S68: the show leaves out of its count a summary over a long note\'s later shard, which the pass drops, so the receipt after the take counts the same', async () => {
    const strategy = new AutobiographicalStrategy({ ...FOLD, adaptiveResolution: true, hierarchical: true, mergeThreshold: 2 });
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    const short = note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const long = longNote(cm, 'LONG');
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`after ${i} ${'words '.repeat(60)}`)]);
    const later = bodyRows(cm, long).slice(1);
    await drain(cm);
    const overLater = (summary: SummaryEntry) => later.some((id) => leavesOf(summariesOf(strategy), summary).has(id));
    const over = [...new Set([...summariesOver(strategy, short), ...summariesOver(strategy, long)])];
    assert.ok(over.some(overLater), 'premise: a summary over a mended body is over a later shard too');
    const stays = over.filter((summary) => !overLater(summary));
    assert.ok(stays.length > 0, 'premise: a summary over a mended body is over no later shard');
    const shown = cm.showSweep(rewords()).oldSummaries;
    assert.deepEqual(shown, byLevel(stays), 'the show counts what the pass leaves');
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    assert.deepEqual(cm.sweepReceipt('rewords-test').oldSummaries, shown, 'the receipt after the take counts the same');
    cm.close();
  });

  it('S70: an audit-only strategy refuses the second act, and the store stays as it was', async () => {
    const path = freshPath();
    const cm = await ContextManager.open({ path, strategy: folding(), membrane: mockMembrane() });
    note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    cm.close();
    const audit = await ContextManager.open({ path, strategy: new AutobiographicalStrategy({ ...FOLD, auditOnly: true }), membrane: mockMembrane() });
    assert.ok(total(audit.oldSummaryCost('rewords-test').summaries) > 0, 'premise: it counts an old summary');
    const sequence = sequenceOf(audit);
    assert.throws(() => audit.dropOldSummaries('rewords-test'), /audit-only/);
    assert.equal(sequenceOf(audit), sequence, 'the store stays as it was');
    audit.close();
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

  it('S19: a derived context inherits the applied list: a pass on its branch counts its old summaries, and its second act drops them', async () => {
    const strategy = folding();
    const cm = await ContextManager.open({ path: freshPath(), namespace: 'agent', strategy, membrane: mockMembrane() });
    note(cm, `first ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 3; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    await clockPast(sweepsApplied(cm.getStore()).items[0]!.at);
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
    assert.deepEqual(child.sweepReceipt('rewords-test').oldSummaries, byLevel(summariesOver(childStrategy, second)), 'the child counts its summary over the second note, and none over the first');
    child.dropOldSummaries('rewords-test');
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
    const otherOutcome = report.sweeps.find((s) => s.name === 'rewords-other');
    assert.ok(otherOutcome && seen.length > 0, 'premise: the other sweep ran, and its entry was asked');
    assert.ok(seen.every((body) => !shards.slice(1).includes(body.id)), 'the other sweep is asked of no later shard');
    assert.deepEqual(otherOutcome.rewritten, [], 'nor rewrites one');
    assert.deepEqual(otherOutcome.failed, [], 'nor names one as a failure: they are no body');
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

  it('S53: a sharded body is given with its other blocks first, as a compile of its recent window gives it, and a rewrite that keeps them keeps that order', async () => {
    const strategy = new AutobiographicalStrategy({ ...FOLD, adaptiveResolution: true, recentWindowTokens: 1_000_000 });
    const cm = await ContextManager.open({ path: freshPath(), strategy });
    const image: ContentBlock = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PNG } };
    const id = cm.addMessage('system', [text(`LONG ${FILLER.repeat(120)}${OLD} in the middle ${MORE_FILLER.repeat(120)}end of LONG`), image], { writer: 'faulty' });
    assert.ok(bodyRows(cm, id).length > 1, 'premise: the note is stored as shards');
    const compiledTypes = async (): Promise<string[]> => {
      const result = await cm.compile(BIG);
      const message = result.messages.find((m) => textOfBlocks(m.content as { type: string; text?: string }[]).includes('end of LONG'));
      assert.ok(message, 'premise: the compile gives the note');
      return (message.content as { type: string }[]).map((block) => block.type);
    };
    const before = await compiledTypes();
    assert.deepEqual(before, ['image', 'text'], 'premise: a compile gives the image, then the text');
    const seen: SweepBody[] = [];
    cm.showSweep(rewords(seen));
    assert.deepEqual(seen.find((body) => body.id === id)!.content.map((block) => block.type), ['blob_ref', 'text'], 'the entry is given the body in that order');
    cm.takeSweep('rewords-test');
    assert.equal(cm.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.deepEqual(bodyRows(cm, id), [id], 'premise: the note is one row');
    assert.deepEqual(await compiledTypes(), before, 'a compile gives its blocks in the order it gave them before');
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

  it('S32: a tick that a listener starts during a pass reads the list once the pass ends, so no summary of the old text is written after it', async () => {
    const strategy = folding();
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    cm.addMessage('User', [text(`chat ${'words '.repeat(60)}`)]);
    const a = note(cm, `first ${OLD}`);
    const b = note(cm, `second ${OLD}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await cm.compile(BIG);
    assert.ok(!covered(strategy).has(a) && !covered(strategy).has(b), 'premise: neither note is folded yet');
    cm.takeSweep('rewords-test');
    let ticking: Promise<void> | undefined;
    cm.onMessage((event) => { if (event.type === 'edit' && !ticking) ticking = cm.tick(); });
    cm.applySweeps([rewords()]);
    assert.ok(ticking, 'premise: the listener started a tick');
    await ticking;
    await drain(cm);
    assert.ok(covered(strategy).has(a) && covered(strategy).has(b), 'premise: both notes are folded');
    assert.ok(!summariesOf(strategy).some((s) => s.content.includes(OLD)), 'no summary holds the old text');
    assert.ok(!(await compiledText(cm)).includes(OLD), 'the compile holds none of the old text');
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

  it('S51: a listener\'s edit of a body that the pass rewrites later stands: the pass names that body and leaves it, and the next pass reads it again', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const first = note(cm, `first ${OLD}`);
    const second = note(cm, `second ${OLD}`);
    cm.takeSweep('rewords-test');
    let edited = false;
    cm.onMessage((event) => {
      if (event.type !== 'edit' || event.messageId !== first || edited) return;
      edited = true;
      cm.editMessage(second, [text(`second ${OLD} as a listener wrote it`)]);
    });
    const report = cm.applySweeps([rewords()]);
    assert.ok(edited, 'premise: the listener edited the second note');
    assert.equal(textOfBlocks(cm.getMessage(second)!.content), `second ${OLD} as a listener wrote it`, 'the listener\'s edit stands');
    assert.deepEqual(report.sweeps[0]!.failed.map((f) => f.id), [second], 'the report names the body');
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    assert.equal(cm.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.equal(textOfBlocks(cm.getMessage(second)!.content), `second ${NEW} as a listener wrote it`, 'the next pass mends the body as the listener left it');
    cm.close();
  });

  it('S52: a manager on another handle of the branch, ticked by a listener during a pass, reads the list once the pass ends, so it writes no summary of the old text after it', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const cm = await ContextManager.open({ store, namespace: 'w', strategy: new PassthroughStrategy() });
    cm.addMessage('User', [text(`chat ${'words '.repeat(60)}`)]);
    const a = note(cm, `first ${OLD}`);
    const b = note(cm, `second ${OLD}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const strategy = folding();
    const reader = await ContextManager.open({ store: store.view(store.currentBranch().name), namespace: 'r', strategy, membrane: mockMembrane() });
    await reader.compile(BIG);
    assert.ok(!covered(strategy).has(a) && !covered(strategy).has(b), 'premise: neither note is folded yet');
    cm.takeSweep('rewords-test');
    let ticking: Promise<void> | undefined;
    cm.onMessage((event) => { if (event.type === 'edit' && !ticking) ticking = reader.tick(); });
    cm.applySweeps([rewords()]);
    assert.ok(ticking, 'premise: the listener started the reader\'s tick');
    await ticking;
    await drain(reader);
    assert.ok(covered(strategy).has(a) && covered(strategy).has(b), 'premise: both notes are folded');
    assert.ok(!summariesOf(strategy).some((s) => s.content.includes(OLD)), 'no summary holds the old text');
    assert.ok(!(await compiledText(reader)).includes(OLD), 'the reader\'s compile holds none of the old text');
    reader.close();
    cm.close();
    store.close();
  });

  it('S58: a listener that edits a body back after its rewrite leaves the take owed, and the next pass mends the body', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const id = note(cm, `a note ${OLD}`);
    cm.takeSweep('rewords-test');
    let reverted = false;
    cm.onMessage((event) => {
      if (event.type !== 'edit' || event.messageId !== id || reverted) return;
      reverted = true;
      cm.editMessage(id, [text(`a note ${OLD} again`)]);
    });
    const report = cm.applySweeps([rewords()]);
    assert.ok(reverted, 'premise: the listener edited the note back');
    assert.equal(report.sweeps[0]!.outcome, 'owed');
    assert.deepEqual(report.sweeps[0]!.failed.map((f) => f.id), [id], 'the report names the body');
    assert.equal(cm.sweepReceipt('rewords-test').finished, false, 'the take is not finished');
    assert.equal(cm.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.equal(textOfBlocks(cm.getMessage(id)!.content), `a note ${NEW} again`, 'the next pass mends the body as the listener left it');
    cm.close();
  });

  it('S55: a write to the applied list that throws stops the pass, which reports what it did, and a later pass finishes', async () => {
    const cm = await ContextManager.open({ path: freshPath(), strategy: new PassthroughStrategy() });
    const id = note(cm, `a note ${OLD}`);
    cm.takeSweep('rewords-test');
    const target = cm.getStore() as unknown as Record<string, (...args: unknown[]) => unknown>;
    const real = target.appendToStateJson!;
    const failListOn = (on: number) => {
      let calls = 0;
      target.appendToStateJson = function (this: unknown, ...args: unknown[]) {
        if (args[0] === SWEEPS_APPLIED_STATE_ID && ++calls === on) throw new Error('test: the list write failed');
        return real.apply(this, args);
      };
    };
    failListOn(1);
    const beforeList = cm.applySweeps([rewords()]);
    assert.match(beforeList.stopped ?? '', /applied list/, 'a failed list write stops the pass');
    assert.deepEqual(beforeList.sweeps[0]!.rewritten, [], 'and nothing is rewritten');
    assert.ok(textOfBlocks(cm.getMessage(id)!.content).includes(OLD));
    failListOn(2);
    const afterRewrite = cm.applySweeps([rewords()]);
    assert.match(afterRewrite.stopped ?? '', /applied list/, 'a failed finish stops the pass too');
    assert.deepEqual(afterRewrite.sweeps[0]!.rewritten, [id], 'and the report names what it rewrote');
    assert.equal(afterRewrite.sweeps[0]!.outcome, 'owed');
    target.appendToStateJson = real;
    assert.equal(cm.applySweeps([rewords()]).sweeps[0]!.outcome, 'finished');
    assert.ok(textOfBlocks(cm.getMessage(id)!.content).includes(NEW));
    cm.close();
  });
});

describe('readers that keep summaries', () => {
  it('S34: two instances of one namespace each let go of the summaries over a long note\'s removed shards', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const one = adaptive();
    const first = await ContextManager.open({ store, namespace: 'a', strategy: one, membrane: mockMembrane() });
    const long = longNote(first, 'LONG');
    for (let i = 0; i < 4; i++) first.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const removed = bodyRows(first, long).slice(1);
    await drain(first);
    const two = adaptive();
    const second = await ContextManager.open({ store, namespace: 'a', strategy: two, membrane: mockMembrane() });
    assert.ok(removed.some((id) => covered(one).has(id) && covered(two).has(id)), 'premise: both instances fold a later shard');
    first.takeSweep('rewords-test');
    first.applySweeps([rewords()]);
    await compiledText(second);
    for (const [s, name] of [[one, 'the first'], [two, 'the second']] as const) {
      for (const id of removed) assert.ok(!covered(s).has(id), `${name} keeps no summary over ${id}`);
    }
    second.close();
    first.close();
    store.close();
  });

  it('S66: another instance of the namespace takes up the second act: it compiles none of the dropped summaries, and writes none back', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const one = folding();
    const first = await ContextManager.open({ store, namespace: 'a', strategy: one, membrane: mockMembrane() });
    const id = note(first, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) first.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(first);
    const two = folding();
    const second = await ContextManager.open({ store, namespace: 'a', strategy: two, membrane: mockMembrane() });
    assert.ok(covered(two).has(id), 'premise: the second instance folds the note');
    first.takeSweep('rewords-test');
    first.applySweeps([rewords()]);
    const counted = summariesOver(one, id).map((s) => s.id);
    assert.ok(counted.length > 0, 'premise: the note has an old summary');
    first.dropOldSummaries('rewords-test');
    assert.ok(!(await compiledText(second)).includes(OLD), 'the second compiles none of the dropped summaries');
    await drain(second);
    const stored = (store.getStateJson('a/autobio:summaries') as SummaryEntry[]).map((s) => s.id);
    for (const sid of counted) assert.ok(!stored.includes(sid), `the store holds no ${sid}`);
    assert.ok(covered(two).has(id), 'the second folds the note again');
    second.close();
    first.close();
    store.close();
  });

  it('S38: with hierarchy on, the second act drops every summary of any level over the note, as the count named them', async () => {
    const strategy = new AutobiographicalStrategy({ ...FOLD, hierarchical: true, mergeThreshold: 2 });
    const cm = await ContextManager.open({ path: freshPath(), strategy, membrane: mockMembrane() });
    const id = note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 7; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    assert.ok(summariesOver(strategy, id).some((s) => s.level > 1), 'premise: a summary above the note\'s own folds it');
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    const counted = byLevel(summariesOver(strategy, id));
    assert.deepEqual(cm.dropOldSummaries('rewords-test').summaries, counted, 'it drops what the count named');
    assert.deepEqual(summariesOver(strategy, id).map((s) => s.id), [], 'no summary over the note stays, of any level');
    assert.ok(!(await compiledText(cm)).includes(OLD), 'the compile holds none of the old text');
    cm.close();
  });

  it('S43: a chunk record whose L1 the second act dropped keeps its rows, and is compressed again over them, under a later chunk size too', async () => {
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
    reopened.dropOldSummaries('rewords-test');
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

  it('S47: a summary in flight in one instance is not written once another instance\'s pass listed a row it folds, and an instance that opens later compiles none of the old text', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const first = await ContextManager.open({ store, namespace: 'a', strategy: folding(), membrane: mockMembrane() });
    note(first, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) first.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const gated = gatedMembrane();
    const two = folding();
    const second = await ContextManager.open({ store, namespace: 'a', strategy: two, membrane: gated.membrane });
    await second.compile(BIG);
    const ticking = second.tick();
    await until(() => gated.waiting() > 0, 'premise: the second instance is compressing');
    first.takeSweep('rewords-test');
    first.applySweeps([rewords()]);
    await first.compile(BIG);
    gated.open();
    await ticking;
    assert.ok(!summariesOf(two).some((s) => s.content.includes(OLD)), 'the second writes no summary of the old text');
    second.close();
    first.close();
    const later = await ContextManager.open({ store, namespace: 'a', strategy: folding(), membrane: mockMembrane() });
    assert.ok(!(await compiledText(later)).includes(OLD), 'an instance that opens later compiles none of the old text');
    later.close();
    store.close();
  });

  it('S48: an instance that opens while another makes the second act takes up the drop', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const one = folding();
    const first = await ContextManager.open({ store, namespace: 'a', strategy: one, membrane: mockMembrane() });
    const id = note(first, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) first.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(first);
    assert.ok(covered(one).has(id), 'premise: the note is folded');
    first.takeSweep('rewords-test');
    first.applySweeps([rewords()]);
    const target = store as unknown as Record<string, (...args: unknown[]) => unknown>;
    const real = target.getStateJson!;
    let dropping: Promise<unknown> | undefined;
    target.getStateJson = function (this: unknown, ...args: unknown[]) {
      const value = real.apply(this, args);
      if (args[0] === 'a/autobio:summaries' && !dropping) dropping = Promise.resolve().then(() => first.dropOldSummaries('rewords-test'));
      return value;
    };
    const two = folding();
    const second = await ContextManager.open({ store, namespace: 'a', strategy: two, membrane: mockMembrane() });
    target.getStateJson = real;
    assert.ok(dropping, 'premise: the first instance made the second act while the second opened');
    assert.ok(total(((await dropping) as { summaries: { level: number; count: number }[] }).summaries) > 0, 'premise: it dropped a summary');
    assert.ok(!(await compiledText(second)).includes(OLD), 'the second compiles none of the old text');
    assert.ok(!summariesOf(two).some((s) => s.content.includes(OLD)), 'and keeps no summary of it');
    second.close();
    first.close();
    store.close();
  });

  it('S59: a list item that is not JSON is named, and neither a show, a pass nor a reader\'s let-go stops at it', async (t) => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const writer = await ContextManager.open({ store, namespace: 'w', strategy: new PassthroughStrategy() });
    const id = note(writer, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) writer.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const reader = await ContextManager.open({ store, namespace: 'r', strategy: folding(), membrane: mockMembrane() });
    await drain(reader);
    writer.takeSweep('rewords-test');
    writer.applySweeps([{ ...rewords(), mend: () => null }]);
    store.appendToState(SWEEPS_APPLIED_STATE_ID, Buffer.from('not json{'));
    const at = (store.getStateLen(SWEEPS_APPLIED_STATE_ID) ?? 0) - 1;
    writer.takeSweep('rewords-test');
    assert.deepEqual(writer.showSweep(rewords()).changes.map((c) => c.id), [id], 'a show reads past it');
    const report = writer.applySweeps([rewords()]);
    assert.ok(report.unreadable.items.includes(at), `the pass names it: ${JSON.stringify(report.unreadable.items)}`);
    assert.equal(report.sweeps[0]!.outcome, 'finished');
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    await reader.compile(BIG);
    assert.ok(warnings.some((w) => w.includes(String(at)) && w.includes("don't parse")), warnings.join('\n'));
    assert.ok(!warnings.some((w) => w.includes('failed')), 'the let-go read the list and did not fail');
    reader.close();
    writer.close();
    store.close();
  });

  it('S56: an instance that opens after its namespace made the second act keeps the summaries made since', async () => {
    const path = freshPath();
    const strategy = folding();
    const cm = await ContextManager.open({ path, strategy, membrane: mockMembrane() });
    const id = note(cm, `a note ${OLD} ${'words '.repeat(60)}`);
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    await drain(cm);
    cm.takeSweep('rewords-test');
    cm.applySweeps([rewords()]);
    assert.ok(total(cm.dropOldSummaries('rewords-test').summaries) > 0, 'premise: the second act dropped the note\'s summary');
    await drain(cm);
    const made = summariesOf(strategy).map((s) => s.id);
    assert.ok(covered(strategy).has(id), 'premise: the note is folded again');
    cm.close();
    const later = folding();
    const reopened = await ContextManager.open({ path, strategy: later, membrane: mockMembrane() });
    await reopened.compile(BIG);
    assert.deepEqual(summariesOf(later).map((s) => s.id), made, 'the summaries made since stand');
    reopened.close();
  });

  it('S54: a chunk record whose L1 the second act dropped keeps a row that the view hides', async () => {
    const path = freshPath();
    const store = JsStore.openOrCreate({ path });
    const writer = await ContextManager.open({ store, namespace: 'w', strategy: new PassthroughStrategy() });
    writer.addMessage('User', [text(`chat ${'words '.repeat(60)}`)]);
    const hidden = writer.addMessage('User', [text('a row the view will hide')], { hidden: true });
    const listed = note(writer, `a note ${OLD}`);
    for (let i = 0; i < 4; i++) writer.addMessage('User', [text(`chat ${i} ${'words '.repeat(60)}`)]);
    const all = await ContextManager.open({ store, namespace: 'r', strategy: folding(), membrane: mockMembrane() });
    await drain(all);
    all.close();
    const recordsOf = (strategy: AutobiographicalStrategy) => (strategy as unknown as { chunkRecords: Array<{ sourceIds: MessageId[] }> }).chunkRecords;
    const strategy = folding();
    const filtered = await ContextManager.open({ store, namespace: 'r', strategy, membrane: mockMembrane(), viewFilter: (m) => m.metadata?.hidden !== true });
    assert.ok(recordsOf(strategy).some((r) => r.sourceIds.includes(hidden) && r.sourceIds.includes(listed)), 'premise: one record holds the hidden row and the note');
    writer.takeSweep('rewords-test');
    writer.applySweeps([rewords()]);
    assert.ok(total(filtered.dropOldSummaries('rewords-test').summaries) > 0, 'premise: the second act dropped the note\'s summary');
    await filtered.compile(BIG);
    const record = recordsOf(strategy).find((r) => r.sourceIds.includes(listed));
    assert.ok(record?.sourceIds.includes(hidden), 'the record keeps the hidden row');
    filtered.close();
    writer.close();
    store.close();
  });
});
