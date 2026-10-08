/**
 * Raw replay forms across the context manager's edits.
 *
 * membrane's XML (prefill) formatter replays a tool block's `rawXml`, and its
 * OpenAI Responses formatter emits a block's `rawItem`, instead of rendering
 * the block's fields. A raw form is shared by every block parsed from it: the
 * invokes of one `<function_calls>`, the results of one `<function_results>`,
 * the text parts of one Responses message item. An edit made by spreading a
 * block kept its raw form, so the edit never reached the wire, and a dropped
 * or moved block still shipped inside a sibling's shared raw form.
 *
 * These tests pin that every edit, drop and move the context manager makes
 * releases exactly the raw forms it made untrue: the edited block's own, from
 * it and from every block sharing it, and a Responses reasoning item paired
 * with it. A raw form no edit touched stays, so verbatim replay survives
 * wherever it is still true.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AutobiographicalStrategy,
  ContextManager,
  WindowedPassthroughStrategy,
  stripUnpairedToolBlocks,
} from '../src/index.js';
import type { ContextEntry, SummaryEntry } from '../src/types/index.js';
import {
  rawFormKeys,
  releaseEditedRawForms,
  releaseSharedRawFormsOnMove,
  withoutRawForms,
} from '../src/raw-forms.js';
import { wrapRecallAnswerContent } from '../src/recall-envelope.js';

type Raw = { rawXml?: string; rawItem?: unknown };
const rawOf = (block: ContentBlock): Raw => block as ContentBlock & Raw;

// One <function_calls> holding two invokes, and the <function_results> answering them.
const CALLS_XML =
  '<function_calls>\n<invoke name="fs:read">\n<parameter name="path">/big</parameter>\n</invoke>\n' +
  '<invoke name="fs:read">\n<parameter name="path">/small</parameter>\n</invoke>\n</function_calls>';
const RESULTS_XML =
  '<function_results>\n<result>\n<name>fs:read</name>\n<output>big file</output>\n</result>\n' +
  '<result>\n<name>fs:read</name>\n<output>small file</output>\n</result>\n</function_results>';
// One Responses message item with three output_text parts, and a reasoning item.
const MESSAGE_ITEM = {
  type: 'message', id: 'msg_1', role: 'assistant',
  content: [
    { type: 'output_text', text: 'first part' },
    { type: 'output_text', text: 'second part' },
    { type: 'output_text', text: 'third part' },
  ],
};
const REASONING_ITEM = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' };

function xmlUse(id: string, path: string, rawXml = CALLS_XML): ContentBlock {
  return { type: 'tool_use', id, name: 'fs:read', input: { path }, rawXml } as ContentBlock;
}
function xmlResult(id: string, content: string, rawXml = RESULTS_XML): ContentBlock {
  return { type: 'tool_result', toolUseId: id, content, rawXml } as ContentBlock;
}
function itemText(text: string, rawItem: unknown = MESSAGE_ITEM): ContentBlock {
  return { type: 'text', text, rawItem } as ContentBlock;
}
const reasoning = (): ContentBlock =>
  ({ type: 'redacted_thinking', data: 'opaque', rawItem: REASONING_ITEM } as ContentBlock);

describe('raw forms: keys and release', () => {
  it('keys a raw form as the formatters tell them apart', () => {
    assert.deepEqual(rawFormKeys(xmlUse('a', '/x')), [`xml:${CALLS_XML}`]);
    assert.deepEqual(rawFormKeys(itemText('t')), ['item:message:msg_1']);
    const anonymous = { type: 'message', content: [] };
    assert.deepEqual(rawFormKeys(itemText('t', anonymous)), [`item:${JSON.stringify(anonymous)}`]);
    // What the formatters don't replay isn't a raw form.
    assert.deepEqual(rawFormKeys({ type: 'tool_use', id: 'a', name: 'n', input: {}, rawXml: '' } as ContentBlock), []);
    assert.deepEqual(rawFormKeys(itemText('t', 'not-an-object')), []);
    assert.deepEqual(rawFormKeys({ type: 'text', text: 'plain' }), []);
  });

  it('an edited block and every block sharing its raw form give it up; an unrelated one keeps its own', () => {
    const big = xmlUse('a', '/big');
    const small = xmlUse('b', '/small');
    const other = xmlUse('c', '/other', '<function_calls>other</function_calls>');
    const before = [big, small, other];
    const edited = { ...big, input: { _truncated: true } } as ContentBlock;
    const after = releaseEditedRawForms(before, [edited, small, other]);
    assert.equal(rawOf(after[0]).rawXml, undefined, 'the edited copy');
    assert.deepEqual((after[0] as { input: unknown }).input, { _truncated: true });
    assert.equal(rawOf(after[1]).rawXml, undefined, 'its sibling in the same <function_calls>');
    assert.equal(after[2], other, 'a block with another raw form is untouched, by identity');
  });

  it('a dropped block releases the raw form its siblings share', () => {
    const before = [itemText('first part'), itemText('second part'), itemText('third part'), reasoning()];
    const after = releaseEditedRawForms(before, [before[0], before[1], before[3]]);
    assert.equal(rawOf(after[0]).rawItem, undefined);
    assert.equal(rawOf(after[1]).rawItem, undefined);
    assert.equal(after[2], before[3], 'the reasoning item is its own raw form and stays');
  });

  it('changes nothing, not even identity, when no raw form was touched', () => {
    const before = [xmlUse('a', '/big'), { type: 'text', text: 'note' } as ContentBlock];
    const after = [before[0], { type: 'text', text: 'note, edited' } as ContentBlock];
    assert.equal(releaseEditedRawForms(before, after), after);
    const block = xmlUse('a', '/x');
    assert.equal(withoutRawForms(block, new Set(['xml:other'])), block);
  });

  it('releasing an item releases the reasoning paired with it, and only that pairing', () => {
    const rs1 = { type: 'redacted_thinking', data: 'one', rawItem: { type: 'reasoning', id: 'rs_1' } } as ContentBlock;
    const fc1 = { type: 'tool_use', id: 'call_1', name: 'fs:read', input: { path: '/a' }, rawItem: { type: 'function_call', id: 'fc_1' } } as ContentBlock;
    const rs2 = { type: 'redacted_thinking', data: 'two', rawItem: { type: 'reasoning', id: 'rs_2' } } as ContentBlock;
    const part1 = itemText('first part');
    const part2 = itemText('second part');
    const before = [rs1, fc1, rs2, part1, part2];
    const edited = { ...part2, text: 'second, cut' } as ContentBlock;
    const after = releaseEditedRawForms(before, [rs1, fc1, rs2, part1, edited]);
    assert.equal(after[0], rs1, 'the other pairing is untouched');
    assert.equal(after[1], fc1);
    assert.equal(rawOf(after[2]).rawItem, undefined, 'the reasoning that led to the edited item');
    assert.equal((after[2] as { data: string }).data, 'two', 'keeps its encrypted content');
    assert.equal(rawOf(after[3]).rawItem, undefined);
    assert.equal(rawOf(after[4]).rawItem, undefined);
  });

  it('dropping a reasoning item releases the item it led to', () => {
    const rs1 = { type: 'redacted_thinking', data: 'one', rawItem: { type: 'reasoning', id: 'rs_1' } } as ContentBlock;
    const fc1 = { type: 'tool_use', id: 'call_1', name: 'fs:read', input: { path: '/a' }, rawItem: { type: 'function_call', id: 'fc_1' } } as ContentBlock;
    const after = releaseEditedRawForms([rs1, fc1], [fc1]);
    assert.equal(rawOf(after[0]).rawItem, undefined, 'its id would name a reasoning item no longer sent');
    // Reasoning at the end of a message has no follower here, and pairs with nothing.
    const tail = { type: 'redacted_thinking', data: 'x', rawItem: { type: 'reasoning', id: 'rs_9' } } as ContentBlock;
    const text = itemText('first part');
    const kept = releaseEditedRawForms([text, tail], [{ ...text, text: 'cut' } as ContentBlock, tail]);
    assert.equal(kept[1], tail);
  });

  it('a moved block keeps a raw form it carries alone and gives up one it shares', () => {
    const alone = xmlResult('a', 'only', '<function_results>only</function_results>');
    assert.equal(releaseSharedRawFormsOnMove(alone, [alone, { type: 'text', text: 'x' }]), alone);
    const shared = xmlResult('a', 'big file');
    const moved = releaseSharedRawFormsOnMove(shared, [shared, xmlResult('b', 'small file')]);
    assert.equal(rawOf(moved).rawXml, undefined);
  });
});

const STORE = './test-raw-forms-store';
function cleanup(): void {
  if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true });
}

describe('raw forms: the strategies\' edits', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('tool_use input truncation releases the <function_calls> it shares', async () => {
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      toolUseInputMaxTokens: 20,
    });
    const manager = await ContextManager.open({ path: STORE, strategy });
    const bigInput = 'x'.repeat(400);
    manager.addMessage('Claude', [
      { type: 'tool_use', id: 'a', name: 'fs:read', input: { path: bigInput }, rawXml: CALLS_XML } as ContentBlock,
      xmlUse('b', '/small'),
    ]);
    manager.addMessage('user', [xmlResult('a', 'big file'), xmlResult('b', 'small file')]);
    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const blocks = compiled.messages.flatMap((m) => m.content);
    const [a, b] = blocks.filter((x) => x.type === 'tool_use');
    assert.equal((a as { input: { _truncated?: boolean } }).input._truncated, true, 'the cap applied');
    assert.equal(rawOf(a).rawXml, undefined, 'the truncated invoke no longer replays the original');
    assert.equal(rawOf(b).rawXml, undefined, 'nor does its sibling, which would carry the original');
    assert.deepEqual((b as unknown as { input: unknown }).input, { path: '/small' }, 'the sibling\'s own input is untouched');
    for (const result of blocks.filter((x) => x.type === 'tool_result')) {
      assert.equal(rawOf(result).rawXml, RESULTS_XML, 'the untouched <function_results> still replays verbatim');
    }
    await manager.close();
  });

  it('the last-N tool_result marker releases the <function_results> it shares', async () => {
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      toolResultMaxLastN: { 'fs:read': 1 },
    });
    const manager = await ContextManager.open({ path: STORE, strategy });
    manager.addMessage('Claude', [xmlUse('a', '/big'), xmlUse('b', '/small')]);
    manager.addMessage('user', [xmlResult('a', 'big file'), xmlResult('b', 'small file')]);
    const lateCalls = '<function_calls>late</function_calls>';
    const lateResults = '<function_results>late</function_results>';
    manager.addMessage('Claude', [xmlUse('c', '/late', lateCalls)]);
    manager.addMessage('user', [xmlResult('c', 'late file', lateResults)]);
    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const results = compiled.messages.flatMap((m) => m.content).filter((x) => x.type === 'tool_result');
    const byId = new Map(results.map((r) => [(r as { toolUseId: string }).toolUseId, r]));
    assert.match(String((byId.get('a') as { content: unknown }).content), /Result truncated/);
    assert.match(String((byId.get('b') as { content: unknown }).content), /Result truncated/);
    assert.equal(rawOf(byId.get('a')!).rawXml, undefined);
    assert.equal(rawOf(byId.get('b')!).rawXml, undefined);
    assert.equal(rawOf(byId.get('c')!).rawXml, lateResults, 'the kept result replays verbatim');
    await manager.close();
  });

  it('a message cap that cuts a Responses message item releases it from every part', async () => {
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      maxMessageTokens: 30,
    });
    const manager = await ContextManager.open({ path: STORE, strategy });
    manager.addMessage('user', [{ type: 'text', text: 'go' }]);
    const long = 'y'.repeat(200);
    // The first part fits and is kept as it was; the second is cut; the third is dropped.
    manager.addMessage('Claude', [reasoning(), itemText('first part'), itemText(`second ${long}`), itemText(`third ${long}`)]);
    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const reply = compiled.messages.find((m) => m.content.some((b) => b.type === 'redacted_thinking'))!;
    const texts = reply.content.filter((b) => b.type === 'text');
    assert.equal(texts.length, 2);
    assert.equal((texts[0] as { text: string }).text, 'first part');
    assert.ok((texts[1] as { text: string }).text.includes('[truncated'), 'the cap applied');
    for (const t of texts) assert.equal(rawOf(t).rawItem, undefined, 'no part replays the uncut item');
    const paired = reply.content.find((b) => b.type === 'redacted_thinking')!;
    assert.equal(rawOf(paired).rawItem, undefined, 'the reasoning paired with the cut item is released with it');
    assert.equal((paired as { data: string }).data, 'opaque', 'and keeps its encrypted content');
    await manager.close();
  });

  it('the windowed strategy\'s message cap does the same', async () => {
    const strategy = new WindowedPassthroughStrategy({ maxMessageTokens: 20 });
    const manager = await ContextManager.open({ path: STORE, strategy });
    manager.addMessage('Claude', [xmlUse('a', '/big'), xmlUse('b', '/small')]);
    manager.addMessage('user', [xmlResult('a', 'z'.repeat(400)), xmlResult('b', 'small file')]);
    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const results = compiled.messages.flatMap((m) => m.content).filter((x) => x.type === 'tool_result');
    assert.ok(results.some((r) => /truncated|omitted/.test(String((r as { content: unknown }).content))), 'the cap applied');
    for (const r of results) assert.equal(rawOf(r).rawXml, undefined);
    const uses = compiled.messages.flatMap((m) => m.content).filter((x) => x.type === 'tool_use');
    for (const u of uses) assert.equal(rawOf(u).rawXml, CALLS_XML, 'the untouched calls replay verbatim');
    await manager.close();
  });
});

describe('raw forms: structural repair', () => {
  const pair = (strategy: AutobiographicalStrategy, entries: ContextEntry[]): void =>
    (strategy as unknown as { enforceToolPairing: (e: ContextEntry[]) => void }).enforceToolPairing(entries);
  const entry = (index: number, participant: string, content: ContentBlock[]): ContextEntry =>
    ({ index, participant, content } as ContextEntry);

  it('dropping an orphan result releases the <function_results> its kept sibling shares', () => {
    const strategy = new AutobiographicalStrategy({});
    const entries = [
      entry(0, 'Claude', [{ type: 'tool_use', id: 'a', name: 'fs:read', input: {} } as ContentBlock]),
      // 'b' answers no use in the entry before it: an orphan to drop.
      entry(1, 'user', [xmlResult('a', 'big file'), xmlResult('b', 'small file')]),
    ];
    pair(strategy, entries);
    const kept = entries[1].content;
    assert.equal(kept.length, 1);
    assert.equal(rawOf(kept[0]).rawXml, undefined, 'the survivor would otherwise replay the dropped orphan');
  });

  it('a result moved next to its use releases the <function_results> it shared with what stayed', () => {
    const strategy = new AutobiographicalStrategy({});
    const entries = [
      entry(0, 'Claude', [{ type: 'tool_use', id: 'a', name: 'fs:read', input: {} } as ContentBlock]),
      entry(1, 'user', [{ type: 'text', text: 'an interleaved turn' } as ContentBlock]),
      entry(2, 'Claude', [{ type: 'tool_use', id: 'b', name: 'fs:read', input: {} } as ContentBlock]),
      // 'a''s result sits here, sharing one <function_results> with 'b''s.
      entry(3, 'user', [xmlResult('a', 'big file'), xmlResult('b', 'small file')]),
    ];
    pair(strategy, entries);
    const all = entries.flatMap((e) => e.content).filter((b) => b.type === 'tool_result');
    const a = all.find((b) => (b as { toolUseId: string }).toolUseId === 'a' && (b as { content: unknown }).content === 'big file');
    const b = all.find((x) => (x as { toolUseId: string }).toolUseId === 'b');
    assert.ok(a, 'the real result was moved up, not stubbed');
    assert.equal(rawOf(a!).rawXml, undefined, 'moved, it would replay its old neighbour too');
    assert.equal(rawOf(b!).rawXml, undefined, 'left behind, it would replay the moved result again');
  });

  it('stripping an unpaired tool_use releases the <function_calls> its paired sibling shares', () => {
    const messages = stripUnpairedToolBlocks([
      { participant: 'Claude', content: [xmlUse('a', '/big'), xmlUse('b', '/small')] },
      { participant: 'user', content: [xmlResult('a', 'big file', '<function_results>a</function_results>')] },
    ]);
    const uses = messages[0].content;
    assert.equal(uses.length, 1);
    assert.equal(rawOf(uses[0]).rawXml, undefined, 'the survivor would otherwise replay the unpaired call');
    assert.equal(rawOf(messages[1].content[0]).rawXml, '<function_results>a</function_results>');
  });

  it('the compression image cap releases a tool_result it edits, and leaves an unedited one whole', () => {
    class Exposed extends AutobiographicalStrategy {
      cap(messages: Array<{ content: ContentBlock[] }>, bytes: number): number {
        return this.capCompressionImageBytes(messages, bytes);
      }
    }
    const strategy = new Exposed({});
    const image = (n: number): ContentBlock =>
      ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'A'.repeat(n) } } as ContentBlock);
    const withImage = { type: 'tool_result', toolUseId: 'a', content: [image(4000)], rawXml: RESULTS_XML } as ContentBlock;
    const sibling = xmlResult('b', 'small file');
    const untouched = { type: 'tool_result', toolUseId: 'c', content: [{ type: 'text', text: 'no image' }], rawXml: '<function_results>c</function_results>' } as ContentBlock;
    const messages = [
      { content: [withImage, sibling] },
      { content: [untouched] },
    ];
    const dropped = strategy.cap(messages, 100);
    assert.equal(dropped, 1);
    assert.equal(rawOf(messages[0].content[0]).rawXml, undefined, 'the edited result');
    assert.equal(rawOf(messages[0].content[1]).rawXml, undefined, 'its sibling in the same <function_results>');
    assert.equal(messages[1].content[0], untouched, 'a result with no image replaced keeps its identity and raw form');
  });
});

describe('raw forms: the compression input', () => {
  before(cleanup);
  after(cleanup);

  it('stripping a reasoning item from the summarizer input releases the item it led to', async () => {
    const calls: Array<{ messages: Array<{ participant: string; content: ContentBlock[] }> }> = [];
    const membrane = {
      complete: async (request: { messages: Array<{ participant: string; content: ContentBlock[] }> }) => {
        calls.push({ messages: request.messages });
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'a summary of the turns ' + 'x '.repeat(20) }],
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    };
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'test-compression-model',
      targetChunkTokens: 80,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as never });
    for (let i = 0; i < 12; i++) {
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(8) }]);
      const item = { type: 'message', id: `msg_${i}`, role: 'assistant', content: [{ type: 'output_text', text: `reply ${i}` }] };
      manager.addMessage('agent', [
        { type: 'redacted_thinking', data: `opaque-${i}`, rawItem: { type: 'reasoning', id: `rs_${i}` } } as ContentBlock,
        { type: 'text', text: `reply ${i} ` + 'word '.repeat(10), rawItem: item } as ContentBlock,
      ]);
    }
    for (let i = 0; i < 500 && !manager.isReady(); i++) await manager.tick();
    assert.ok(calls.length > 0, 'expected at least one compression call');
    let replies = 0;
    for (const call of calls) {
      for (const m of call.messages) {
        for (const b of m.content) {
          assert.ok(b.type !== 'redacted_thinking', 'reasoning never reaches the summarizer');
          if (b.type === 'text' && /^reply \d/.test((b as { text: string }).text)) {
            replies++;
            assert.equal(rawOf(b).rawItem, undefined, 'a reply whose reasoning was stripped is sent without its id');
          }
        }
      }
    }
    assert.ok(replies > 0, 'the agent replies reached the summarizer');
    await manager.close();
  });
});

describe('raw forms: the recall envelope', () => {
  const summary: SummaryEntry = {
    id: 'L1-7', level: 1, content: 'memory', tokens: 4, sourceLevel: 0,
    sourceIds: ['m-1'], sourceRange: { first: 'm-1', last: 'm-4' }, created: 0,
  };

  it('wrapped parts release their message item, and the reasoning paired with it', () => {
    const think = reasoning();
    const content = [think, itemText('first part'), itemText('second part'), itemText('third part')];
    const wrapped = wrapRecallAnswerContent(content, summary, 'xml');
    assert.equal(rawOf(wrapped[0]).rawItem, undefined, 'the paired reasoning item is released');
    assert.equal((wrapped[0] as { data: string }).data, 'opaque', 'with its content byte for byte');
    assert.match((wrapped[1] as { text: string }).text, /^<cm-recall/);
    assert.match((wrapped[3] as { text: string }).text, /<\/cm-recall>$/);
    for (const part of wrapped.slice(1)) {
      assert.equal(rawOf(part).rawItem, undefined, 'no part replays the unwrapped item');
    }
  });

  it('leaves content untouched when it is not wrapped', () => {
    const content = [itemText('first part')];
    assert.equal(wrapRecallAnswerContent(content, summary, undefined), content);
  });
});
