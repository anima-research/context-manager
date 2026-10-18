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
 * wherever it is still true. The last group sends compiles through membrane's
 * own formatters and asserts what reaches the provider: the edit, once.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { AnthropicXmlFormatter, Membrane, MockAdapter, OpenAIResponsesFormatter } from '@animalabs/membrane';
import type { ContentBlock, PrefillFormatter, ToolDefinition } from '@animalabs/membrane';
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
  releaseTrailingReasoning,
  releaseVanishedRawForms,
  withoutRawForms,
} from '../src/raw-forms.js';
import { wrapRecallAnswerContent } from '../src/recall-envelope.js';
import { stripEmptyTextBlocks } from '../src/strategies/autobiographical.js';
import { hoistToolProse, toolProseStub } from '../src/tool-prose-hoist.js';

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
// membrane's zero-width carrier for an opaque Responses item: its raw item is its whole content.
const opaqueCarrier = (): ContentBlock =>
  ({ type: 'text', text: '', rawItem: { type: 'compaction', id: 'cmp_1', encrypted_content: 'z' } } as ContentBlock);
// A hosted tool's call is opaque too, and follows the reasoning that led to it.
const searchCall = (): ContentBlock =>
  ({ type: 'text', text: '', rawItem: { type: 'web_search_call', id: 'ws_1', status: 'completed' } } as ContentBlock);
const signedThinking = (): ContentBlock => ({ type: 'thinking', thinking: 'mm', signature: 'sig' } as ContentBlock);
// membrane#101's carrier for a <function_calls> block that dispatched nothing: its rawXml is its whole text.
const attempt = (rawXml = CALLS_XML): ContentBlock => ({ type: 'tool_attempt', rawXml } as unknown as ContentBlock);

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
    // The XML formatter replays rawXml only on tool_use and tool_result runs; elsewhere it is content.
    assert.deepEqual(rawFormKeys(attempt()), []);
  });

  it('a block whose rawXml is its content keeps it when a dispatched block with the same text goes', () => {
    // Two byte-identical <function_calls> blocks in one message: the first dispatched, so its tool_use carries
    // the text as rawXml; the second refused whole (say, a per-turn cap), so a tool_attempt carries it.
    const use = xmlUse('a', '/big');
    const refused = attempt();
    for (const release of [releaseEditedRawForms, releaseVanishedRawForms]) {
      const after = release([use, refused], [refused]);
      assert.equal(after[0], refused, `${release.name}: the attempt is untouched, by identity`);
      assert.equal(rawOf(after[0]).rawXml, CALLS_XML);
    }
    assert.equal(withoutRawForms(refused), refused, 'nothing strips it');
    assert.equal(releaseSharedRawFormsOnMove(use, [use, refused]), use, 'nor does a move share it');
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

  it('a moved member of a reasoning pairing gives up its id, as its partner left behind does', () => {
    const rs1 = { type: 'redacted_thinking', data: 'one', rawItem: { type: 'reasoning', id: 'rs_1' } } as ContentBlock;
    const fc1 = { type: 'tool_use', id: 'call_1', name: 'fs:read', input: { path: '/a' }, rawItem: { type: 'function_call', id: 'fc_1' } } as ContentBlock;
    const source = [rs1, fc1];
    assert.equal(rawOf(releaseSharedRawFormsOnMove(fc1, source)).rawItem, undefined, 'the call moved without its reasoning');
    assert.equal(rawOf(releaseEditedRawForms(source, [rs1])[0]).rawItem, undefined, 'and the reasoning left behind');
    assert.equal(rawOf(releaseSharedRawFormsOnMove(rs1, source)).rawItem, undefined, 'the reasoning moved without its call');
    assert.equal(rawOf(releaseEditedRawForms(source, [fc1])[0]).rawItem, undefined, 'and the call left behind');
    // An item that pairs with nothing in its message keeps its id when it moves.
    const result = { type: 'tool_result', toolUseId: 'call_1', content: 'read', rawItem: { type: 'function_call_output', id: 'fco_1' } } as ContentBlock;
    assert.equal(releaseSharedRawFormsOnMove(result, [result, itemText('after')]), result);
    // So does one in a message whose pairing it isn't part of: after the follower, or after it in place of reasoning.
    const fc2 = { type: 'tool_use', id: 'call_2', name: 'fs:read', input: { path: '/b' }, rawItem: { type: 'function_call', id: 'fc_2' } } as ContentBlock;
    assert.equal(releaseSharedRawFormsOnMove(fc2, [rs1, fc1, fc2]), fc2);
    // Reasoning at the end of a message pairs with nothing, and keeps its id.
    const rs9 = { type: 'redacted_thinking', data: 'nine', rawItem: { type: 'reasoning', id: 'rs_9' } } as ContentBlock;
    assert.equal(releaseSharedRawFormsOnMove(rs9, [fc1, rs9]), rs9);
  });

  it('a moved opaque carrier keeps its item even in a pairing, as a carrier always does', () => {
    const think = reasoning();
    const search = searchCall();
    assert.equal(releaseSharedRawFormsOnMove(search, [think, search]), search);
  });
});

describe('raw forms: opaque carriers, drops and appends', () => {
  it('an opaque carrier keeps its raw item, and is the follower of the reasoning before it', () => {
    const think = reasoning();
    const search = searchCall();
    const parts = [itemText('first part'), itemText('second part')];
    const content = [think, search, ...parts];
    assert.equal(withoutRawForms(search), search, 'even asked to release everything, a carrier keeps its raw item');
    // Editing the message after the search releases that message alone: the reasoning and the call it led to stay paired.
    const edited = releaseEditedRawForms(content, [think, search, { ...parts[0], text: 'cut' } as ContentBlock, parts[1]]);
    assert.equal(edited[0], think, 'the reasoning keeps its id, with its follower');
    assert.equal(edited[1], search, 'and so does the call it led to');
    assert.equal(rawOf(edited[3]).rawItem, undefined, 'the edited item gives up its raw form in every part');
    // Stripping the reasoning releases its pairing, and the call can only ship whole, as main sends it.
    const stripped = releaseEditedRawForms(content, [search, ...parts]);
    assert.equal(stripped[0], search, 'the call stays whole');
    assert.equal(stripped[1], parts[0], 'and the message after it keeps its id');
    // Dropping the call (an empty carrier) releases the reasoning that led to it.
    const dropped = releaseVanishedRawForms(content, [think, ...parts]);
    assert.equal(rawOf(dropped[0]).rawItem, undefined);
  });

  it('a compaction carrier after reasoning is its follower, as any item is', () => {
    const think = reasoning();
    const compaction = opaqueCarrier();
    const parts = [itemText('first part'), itemText('second part')];
    const content = [think, compaction, ...parts];
    const edited = releaseEditedRawForms(content, [think, compaction, { ...parts[0], text: 'cut' } as ContentBlock, parts[1]]);
    assert.equal(edited[0], think, 'the reasoning keeps its id, with the item that follows it');
    assert.equal(edited[1], compaction);
    assert.equal(rawOf(edited[3]).rawItem, undefined, 'the edited message alone gives up its raw form');
  });

  it('a drop releases the reasoning of an item none of whose parts survive, and nothing for a part whose sibling survives', () => {
    const think = reasoning();
    const vanished = releaseVanishedRawForms([think, itemText('   ')], [think]);
    assert.equal(rawOf(vanished[0]).rawItem, undefined, 'the reasoning is not replayed without its follower');
    assert.equal((vanished[0] as { data: string }).data, 'opaque', 'its content stays byte for byte');
    const sibling = itemText('second part');
    const after = [think, sibling];
    assert.equal(releaseVanishedRawForms([think, itemText(''), sibling], after), after,
      'the item still ships whole through its surviving part, so nothing changes');
  });

  it('a block appended after a message releases the reasoning at its end, and only that', () => {
    const ledToCall = reasoning();
    const call = { type: 'tool_use', id: 'call_1', name: 'fs:read', input: {}, rawItem: { type: 'function_call', id: 'fc_1', call_id: 'call_1' } } as ContentBlock;
    const trailing = { type: 'redacted_thinking', data: 'opaque-2', rawItem: { type: 'reasoning', id: 'rs_2', encrypted_content: 'opaque-2' } } as ContentBlock;
    const out = releaseTrailingReasoning([ledToCall, call, trailing]);
    assert.equal(out[0], ledToCall, 'reasoning that leads to an item keeps its id');
    assert.equal(out[1], call);
    assert.equal(rawOf(out[2]).rawItem, undefined, 'the reasoning at the end gives up its id');
    const signed = signedThinking();
    assert.equal(releaseTrailingReasoning([signed])[0], signed, 'a block without a raw item is untouched');
    const think = reasoning();
    const search = searchCall();
    const ledToSearch = releaseTrailingReasoning([think, search]);
    assert.equal(ledToSearch[0], think, 'reasoning followed by an opaque call is not at the end: it keeps its id');
    assert.equal(ledToSearch[1], search);
    const compaction = opaqueCarrier();
    const beforeCompaction = releaseTrailingReasoning([think, compaction]);
    assert.equal(beforeCompaction[0], think, 'so is reasoning followed by a compaction item');
    assert.equal(beforeCompaction[1], compaction);
  });

  it('a dropped part with content gives up its item in every part, as an edit does', () => {
    const think = reasoning();
    const parts = [itemText('first part'), itemText('second part')];
    const out = releaseVanishedRawForms([think, ...parts], [think, parts[0]]);
    assert.equal(rawOf(out[1]).rawItem, undefined, 'the surviving part would otherwise replay the dropped one');
    assert.equal(rawOf(out[0]).rawItem, undefined, 'and the reasoning paired with the item goes id-less');
  });

  it('stripEmptyTextBlocks releases what its drops made untrue, and nothing else', () => {
    const think = reasoning();
    const vanished = stripEmptyTextBlocks([think, itemText('  ')]);
    assert.equal(vanished.length, 1);
    assert.equal(rawOf(vanished[0]).rawItem, undefined, 'the item is gone, so its reasoning goes id-less');
    const sibling = itemText('second part');
    const kept = stripEmptyTextBlocks([think, itemText(''), sibling]);
    assert.equal(kept.length, 2);
    assert.equal(kept[0], think, 'the item still ships whole through its surviving part');
    assert.equal(kept[1], sibling);
    const search = searchCall();
    const dropped = stripEmptyTextBlocks([think, search, sibling]);
    assert.deepEqual(dropped.map((b) => b.type), ['redacted_thinking', 'text']);
    assert.equal(rawOf(dropped[0]).rawItem, undefined, 'a dropped carrier was its reasoning\'s follower');
    assert.equal(dropped[1], sibling, 'and the message after it was not');
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

  it('a second compile with no store writes caps and releases again, and the store keeps its messages', async () => {
    // With no message cap cutting it, an entry holds its message's content
    // array from the store's cached view. An edit written into that array
    // would outlive the compile: the next one, before any write, would find
    // the marker already in place and under the cap, neither cap nor release
    // it, and replay the original input from the raw form the marker kept.
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      toolUseInputMaxTokens: 20,
      toolResultMaxLastN: { 'fs:read': 1 },
    });
    const manager = await ContextManager.open({ path: STORE, strategy });
    manager.addMessage('Claude', [
      { type: 'tool_use', id: 'a', name: 'fs:read', input: { path: 'x'.repeat(400) }, rawXml: CALLS_XML } as ContentBlock,
      xmlUse('b', '/small'),
    ]);
    manager.addMessage('user', [xmlResult('a', 'big file'), xmlResult('b', 'small file')]);
    const stored = (): ContentBlock[] => manager.getAllMessages().flatMap((m) => m.content);
    const asStored = structuredClone(stored());
    const budget = { maxTokens: 100_000, reserveForResponse: 0 };
    const first = await manager.compile(budget);
    const second = await manager.compile(budget);
    const [a, b] = second.messages.flatMap((m) => m.content).filter((x) => x.type === 'tool_use');
    assert.equal((a as { input: { _truncated?: boolean } }).input._truncated, true, 'the cap applied again');
    assert.equal(rawOf(a).rawXml, undefined, 'the capped invoke still doesn\'t replay the original');
    assert.equal(rawOf(b).rawXml, undefined, 'nor does its sibling');
    assert.deepEqual(second.messages, first.messages, 'the second compile ships what the first did');
    assert.deepEqual(stored(), asStored, 'compiling left the store\'s messages as they were');
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
    // Both older results say the same: the limit, not a count of what follows.
    assert.equal((byId.get('a') as { content: unknown }).content, "[result of tool 'fs:read' left out: this context shows only the tool's last result]");
    assert.equal((byId.get('b') as { content: unknown }).content, "[result of tool 'fs:read' left out: this context shows only the tool's last result]");
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
    // The first part fits and is kept as it was; the second is cut; the third is dropped, and a marker says so.
    manager.addMessage('Claude', [reasoning(), itemText('first part'), itemText(`second ${long}`), itemText(`third ${long}`)]);
    const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const reply = compiled.messages.find((m) => m.content.some((b) => b.type === 'redacted_thinking'))!;
    const texts = reply.content.filter((b) => b.type === 'text');
    assert.equal(texts.length, 3);
    assert.equal((texts[0] as { text: string }).text, 'first part');
    assert.ok((texts[1] as { text: string }).text.includes('[truncated'), 'the cap applied');
    assert.equal((texts[2] as { text: string }).text, '[content omitted: this message reached its token limit]');
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
    const contents = results.map((r) => String((r as { content: unknown }).content));
    assert.match(contents[0]!, /\[truncated — original was \d+ tokens\]$/, 'the first result is cut at the cap');
    assert.equal(contents[1], '[content omitted: this message reached its token limit before this result]', 'the second is left out');
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

  it('an answer with no prose gets the envelope after its carriers, and the reasoning at its end gives up its id', () => {
    const wrapped = wrapRecallAnswerContent([reasoning()], summary, 'xml');
    assert.equal(wrapped.length, 2);
    assert.equal(rawOf(wrapped[0]).rawItem, undefined, 'the envelope would follow it on the wire, so it goes id-less');
    assert.equal((wrapped[0] as { data: string }).data, 'opaque', 'with its content byte for byte');
    assert.match((wrapped[1] as { text: string }).text, /^<cm-recall[^>]*>\n<\/cm-recall>$/);
    const signed = signedThinking();
    assert.equal(wrapRecallAnswerContent([signed], summary, 'xml')[0], signed, 'signed thinking without a raw item passes by reference');
  });

  it('never wraps an opaque carrier as prose', () => {
    for (const opaque of [opaqueCarrier(), searchCall()]) {
      const wrapped = wrapRecallAnswerContent([opaque, itemText('first part'), itemText('second part')], summary, 'xml');
      assert.equal(wrapped[0], opaque, 'the carrier keeps its identity and its raw item');
      assert.match((wrapped[1] as { text: string }).text, /^<cm-recall/);
      assert.match((wrapped[2] as { text: string }).text, /<\/cm-recall>$/);
    }
  });

  it('the combined recall answer releases each answer\'s trailing reasoning before the separator after it', () => {
    class Exposed extends AutobiographicalStrategy {
      combined(entries: SummaryEntry[]): ContentBlock[] { return this.combinedRecallAnswerContent(entries, 0); }
    }
    const trailing = { type: 'redacted_thinking', data: 'opaque-2', rawItem: { type: 'reasoning', id: 'rs_2', encrypted_content: 'opaque-2' } } as ContentBlock;
    const first = { ...summary, id: 'L1-1', responseContent: [itemText('first answer'), trailing] };
    const second = { ...summary, id: 'L1-2', responseContent: [itemText('second answer', { ...MESSAGE_ITEM, id: 'msg_2' })] };
    for (const recallEnvelope of [undefined, 'xml'] as const) {
      const content = new Exposed({ recallEnvelope }).combined([first, second]);
      const at = content.findIndex((b) => b.type === 'redacted_thinking');
      assert.ok(at >= 0, `the reasoning is kept (${recallEnvelope ?? 'no envelope'})`);
      assert.equal(rawOf(content[at]!).rawItem, undefined, `a separator follows it, so it goes id-less (${recallEnvelope ?? 'no envelope'})`);
      assert.equal((content[at + 1] as { text: string }).text.includes('---'), true, 'the separator is what follows it');
    }
  });

  it('the combined answer\'s layout stays aligned when a cut gives up the item of a blank part the cap kept', () => {
    class Exposed extends AutobiographicalStrategy {
      render(entries: SummaryEntry[], cap: number) { return this.renderCombinedRecallAnswer(entries, cap); }
    }
    const itemA = { ...MESSAGE_ITEM, id: 'msg_a' };
    // A's blank part fits before the cap of 200 characters, and its long part is cut, so the item is
    // given up from both parts: the blank part comes back as a copy. Past the cap, the separator becomes
    // the marker, B's thinking passes through, and B's text is dropped.
    const a = { ...summary, id: 'L1-a', responseContent: [itemText(' ', itemA), itemText('x'.repeat(400), itemA)] };
    const b = { ...summary, id: 'L1-b', responseContent: [
      { type: 'thinking', thinking: 'kept reasoning', signature: 'sig-b' } as ContentBlock,
      itemText('second answer', { ...MESSAGE_ITEM, id: 'msg_b' }),
    ] };
    const { content, refs } = new Exposed({}).render([a, b], 50);
    assert.ok(content[0]?.type === 'text' && (content[0] as { text: string }).text === ' ' && rawOf(content[0]).rawItem === undefined,
      'premise: the blank part is kept, as a copy without its item');
    assert.ok(content.some((x) => x.type === 'thinking'), 'premise: B\'s thinking survived the cap');
    assert.deepEqual(refs.map((r) => r.id + (r.partial ? '~' : '')), ['L1-a~', 'L1-b~'], 'A was cut, and B shows its thinking');
  });

  it('a single recall answer whose cap left out only a blank part is listed whole', () => {
    class Exposed extends AutobiographicalStrategy {
      render(entry: SummaryEntry, cap: number) { return this.renderSummaryAnswer(entry, cap); }
    }
    // The answer's 200 characters spend a cap of 50 exactly, so the blank part is past it and left out.
    const one = { ...summary, id: 'L1-a', responseContent: [itemText('x'.repeat(200)), itemText('  ')] };
    const { content, refs } = new Exposed({}).render(one, 50);
    assert.ok(!content.some((x) => x.type === 'text' && (x as { text: string }).text === '  '), 'premise: the blank part is left out');
    assert.deepEqual(refs, [{ id: 'L1-a', level: 1 }]);
  });

  describe("the combined answer's layout of blank blocks", () => {
    class Exposed extends AutobiographicalStrategy {
      render(entries: SummaryEntry[], cap: number) { return this.renderCombinedRecallAnswer(entries, cap); }
      truncate(content: ContentBlock[], cap: number) { return this.truncateContent(content, cap); }
    }
    const OMITTED = '[content omitted: this message reached its token limit]';
    const plain = (t: string): ContentBlock => ({ type: 'text', text: t });
    const listed = (refs: Array<{ id: string; partial?: true }>) => refs.map((r) => r.id + (r.partial ? '~' : ''));

    it("doesn't name a summary whose only survivor is a blank part that came back as a copy, since it shows none of the summary", () => {
      const itemA = { ...MESSAGE_ITEM, id: 'msg_a' };
      // The blank part spends a cap of 200 characters exactly and is kept. The next part, of the same
      // item, is past the cap: it's dropped for the marker, and the item is given up, so the blank part
      // comes back as a copy without it.
      const a = { ...summary, id: 'L1-a', responseContent: [itemText(' '.repeat(200), itemA), itemText('the rest of the answer', itemA)] };
      const { content, refs } = new Exposed({}).render([a], 50);
      assert.ok(content[0]?.type === 'text' && (content[0] as { text: string }).text === ' '.repeat(200) && rawOf(content[0]).rawItem === undefined,
        'premise: the blank part is kept, as a copy without its item');
      assert.equal((content[1] as { text: string }).text, OMITTED, 'premise: the next part is dropped for the marker');
      assert.deepEqual(listed(refs), [], 'its blank copy shows nothing, and it lost its next part');
    });

    it("doesn't name a summary whose only survivor is a blank part kept as it was, since it shows none of the summary", () => {
      // The blank part spends a cap of 200 characters exactly and is kept as the same block; the next
      // part is past the cap and dropped for the marker.
      const a = { ...summary, id: 'L1-a', responseContent: [plain(' '.repeat(200)), plain('the rest of the answer')] };
      const { content, refs } = new Exposed({}).render([a], 50);
      assert.equal(content[0], a.responseContent[0], 'premise: the blank part is kept as it was');
      assert.equal((content[1] as { text: string }).text, OMITTED, 'premise: the next part is dropped for the marker');
      assert.deepEqual(listed(refs), [], 'its blank part shows nothing, and it lost its next part');
    });

    it("in the xml answer, doesn't admit a summary of which only blank blocks reach the cap, whether kept or across it", () => {
      const strategy = new Exposed({ recallEnvelope: 'xml' });
      // 'first answer' spends 3 tokens of a cap of 25, and the separator 2, so the second summary's
      // prose has 20 tokens, 80 characters: its blank block spends them exactly and is kept, and
      // its text is dropped for the marker.
      const first = { ...summary, id: 'L1-1', responseContent: [plain('first answer')] };
      const kept = { ...summary, id: 'L1-2', responseContent: [plain(' '.repeat(80)), plain('second answer')] };
      const keptCapped = strategy.truncate(kept.responseContent, 20);
      assert.equal(keptCapped[0], kept.responseContent[0], 'premise: the blank block spends the 20 tokens exactly and is kept as it was');
      assert.deepEqual(keptCapped.slice(1).map((b) => (b as { text?: string }).text), [OMITTED], 'premise: and the text after it is dropped for the marker');
      const after = strategy.render([first, kept], 25);
      assert.deepEqual(listed(after.refs), ['L1-1'], 'the second summary, whose blank block alone reached the cap, is not listed');
      assert.ok(!after.content.some((b) => b.type === 'text' && b.text.includes(' '.repeat(80))), 'nor is its blank block in the answer');
      assert.equal((after.content.at(-1) as { text: string }).text, OMITTED, 'and one marker after the first says it was left out');
      // A first summary whose blank block crosses the cap's 100 characters: the cap ends there, and its
      // text is dropped for the marker, so none of it shows.
      const across = { ...summary, id: 'L1-1', responseContent: [plain(' '.repeat(400)), plain('the rest')] };
      assert.deepEqual(strategy.truncate(across.responseContent, 25).map((b) => (b as { text?: string }).text), [OMITTED],
        'premise: the blank block crosses the cap and is left out, and the text after it is dropped for the marker');
      const alone = strategy.render([across], 25);
      assert.deepEqual(alone.content.map((b) => (b as { text?: string }).text), [OMITTED], 'the answer is the marker alone');
      assert.deepEqual(alone.refs, [], 'and lists none');
    });

    it('names a summary whose prose holds nothing, kept before the cap, whole', () => {
      const a = { ...summary, id: 'L1-a', responseContent: [plain('first answer')] };
      const blank = { ...summary, id: 'L1-b', responseContent: [plain('   ')] };
      const c = { ...summary, id: 'L1-c', responseContent: [plain('x'.repeat(800))] };
      const { refs } = new Exposed({}).render([a, blank, c], 50);
      assert.deepEqual(listed(refs), ['L1-a', 'L1-b', 'L1-c~'], 'the blank summary is in the answer as it is, and lost nothing');
    });

    it('in the xml answer, admits a summary whose prose holds nothing, kept before the cap, and names it whole', () => {
      const a = { ...summary, id: 'L1-a', responseContent: [plain('first answer')] };
      const blank = { ...summary, id: 'L1-b', responseContent: [plain('   ')] };
      const c = { ...summary, id: 'L1-c', responseContent: [plain('x'.repeat(800))] };
      const { content, refs } = new Exposed({ recallEnvelope: 'xml' }).render([a, blank, c], 50);
      assert.deepEqual(listed(refs), ['L1-a', 'L1-b', 'L1-c~'], 'the blank summary the cap never reached is in the answer as it is, and lost nothing');
      assert.ok(content.some((b) => b.type === 'text' && b.text.includes('   ')), 'its blank block is sent');
    });

    it('takes a block of a summary whose text equals the marker, come back as a copy, for that block and not the marker', () => {
      const itemA = { ...MESSAGE_ITEM, id: 'msg_a' };
      // A blank part and a part whose text is the marker's spend a cap of 56 characters exactly, so the
      // next part, of the same item, is dropped for the marker, and both kept parts come back as copies.
      const a = { ...summary, id: 'L1-a', responseContent: [itemText(' ', itemA), itemText(OMITTED, itemA), itemText('the rest of the answer', itemA)] };
      const { content, refs } = new Exposed({}).render([a], 14);
      assert.ok(content[1] !== a.responseContent[1] && (content[1] as { text: string }).text === OMITTED && rawOf(content[1]!).rawItem === undefined,
        'premise: the part whose text equals the marker is kept, as a copy without its item');
      assert.equal((content[2] as { text: string }).text, OMITTED, 'premise: the next part is dropped for the marker');
      assert.deepEqual(listed(refs), ['L1-a~'], 'its own text reached the answer, and it lost its next part');
      assert.deepEqual(listed(new Exposed({ recallEnvelope: 'xml' }).render([a], 14).refs), ['L1-a~'],
        'the xml answer admits it too: a block of its own whose text equals the marker is no marker');
      // In the xml answer, the same copy doesn't stand in for the marker that says a later summary was left out.
      const b = { ...summary, id: 'L1-b', responseContent: [itemText(OMITTED, itemA), itemText('x'.repeat(400), itemA)] };
      const second = { ...summary, id: 'L1-c', responseContent: [plain('second answer')] };
      const xml = new Exposed({ recallEnvelope: 'xml' }).render([b, second], 25);
      assert.deepEqual(listed(xml.refs), ['L1-b~'], 'premise: the first summary is cut and ends the answer');
      assert.equal((xml.content.at(-1) as { text: string }).text, OMITTED, 'so one marker after it says the second was left out');
    });

    it('in the xml answer, ends at the summary where the cap ended, though the blank block it left out spent none of it', () => {
      // 'first answer' spends 3 tokens of a cap of 25, and the blank block after it crosses the rest.
      const first = { ...summary, id: 'L1-1', responseContent: [plain('first answer'), plain(' '.repeat(400))] };
      const second = { ...summary, id: 'L1-2', responseContent: [plain('second answer')] };
      const { content, refs } = new Exposed({ recallEnvelope: 'xml' }).render([first, second], 25);
      assert.ok(!content.some((b) => b.type === 'text' && b.text.includes('second answer')), 'the second summary is left out');
      assert.deepEqual(listed(refs), ['L1-1'], 'the first is listed whole, having lost only its blank block');
      assert.equal((content.at(-1) as { text: string }).text, OMITTED, 'and one marker after it says the second was left out');
    });

    it("in the xml answer, doesn't admit a summary whose prose holds nothing where the cap reaches it", () => {
      const first = { ...summary, id: 'L1-1', responseContent: [plain('first answer')] };
      const blank = { ...summary, id: 'L1-2', responseContent: [plain(' '.repeat(400))] };
      const third = { ...summary, id: 'L1-3', responseContent: [plain('third answer')] };
      const strategy = new Exposed({ recallEnvelope: 'xml' });
      const alone = strategy.render([first, blank], 25);
      assert.deepEqual(listed(alone.refs), ['L1-1'], 'the blank summary the cap reached is not listed');
      assert.ok(!alone.content.some((b) => b.type === 'text' && b.text.includes(OMITTED)), 'and nothing that held anything was left out, so no marker');
      const after = strategy.render([first, blank, third], 25);
      assert.deepEqual(listed(after.refs), ['L1-1'], 'nor anything after it');
      assert.equal((after.content.at(-1) as { text: string }).text, OMITTED, 'and the marker says the summary after it was left out');
    });

    it('in the xml answer, a cap that admits no summary gives the marker alone and lists none', () => {
      const strategy = new Exposed({ recallEnvelope: 'xml' });
      // The first summary's 400 characters of whitespace cross the cap's 100, so the cap ends at it.
      const blank = { ...summary, id: 'L1-1', responseContent: [plain(' '.repeat(400))] };
      const alsoBlank = { ...summary, id: 'L1-2', responseContent: [plain('   ')] };
      const holdsText = { ...summary, id: 'L1-3', responseContent: [plain('third answer')] };
      for (const [after, why] of [[alsoBlank, 'every summary holds nothing'], [holdsText, 'a summary after it holds text']] as const) {
        const { content, refs } = strategy.render([blank, after], 25);
        assert.deepEqual(content.map((b) => (b as { text?: string }).text), [OMITTED], `${why}: the marker alone`);
        assert.deepEqual(refs, [], `${why}: no summary listed`);
      }
    });

    it("names a summary partial when the blank part it left out was its message item's only part, so the reasoning paired with that item gives up its id", () => {
      const think = reasoning();
      // The blank part's 400 characters cross the cap's 200, and no other part carries its message item.
      const a = { ...summary, id: 'L1-a', responseContent: [think, itemText(' '.repeat(400))] };
      const { content, refs } = new Exposed({}).render([a], 50);
      assert.ok(!content.some((b) => b.type === 'text' && (b as { text: string }).text.trim() === ''), 'premise: the blank part is left out');
      const kept = content.find((b) => b.type === 'redacted_thinking');
      assert.ok(kept && kept !== think && rawOf(kept).rawItem === undefined, 'the reasoning goes out as a copy without its item');
      assert.deepEqual(listed(refs), ['L1-a~'], 'so the summary is partial, as after a cut');
    });

    it("in the xml answer, names a summary partial when the blank part it left out was its message item's only part, so the reasoning paired with that item gives up its id", () => {
      const think = reasoning();
      // The blank part's 400 characters cross the cap's 200, and no other part carries its message item.
      const a = { ...summary, id: 'L1-a', responseContent: [think, itemText(' '.repeat(400))] };
      const { content, refs } = new Exposed({ recallEnvelope: 'xml' }).render([a], 50);
      assert.ok(!content.some((b) => b.type === 'text' && (b as { text: string }).text.includes(' '.repeat(400))), 'premise: the blank part is left out');
      const kept = content.find((b) => b.type === 'redacted_thinking');
      assert.ok(kept && kept !== think && rawOf(kept).rawItem === undefined, 'the reasoning goes out as a copy without its item');
      assert.deepEqual(listed(refs), ['L1-a~'], 'so the summary is partial, as in the plain answer');
    });

    it('in the plain answer, a summary whose blocks all hold nothing and that the cap cuts gives the marker alone and lists none, as the xml answer does', () => {
      // A blank block that fits the cap's 100 characters, and one after it that crosses them: every
      // survivor would hold nothing, so the content is the marker alone, which carries none of the summary.
      const blank = { ...summary, id: 'L1-a', responseContent: [plain('  '), plain(' '.repeat(400))] };
      const { content, refs } = new Exposed({}).render([blank], 25);
      assert.deepEqual(content.map((b) => (b as { text?: string }).text), [OMITTED]);
      assert.deepEqual(refs, []);
    });
  });

  it("a single recall answer whose prose holds nothing past the cap is the marker alone, listed whole: it answers for its summary, so it can't leave it out or be empty", () => {
    class Exposed extends AutobiographicalStrategy {
      render(entry: SummaryEntry, cap: number) { return this.renderSummaryAnswer(entry, cap); }
    }
    const blank = { ...summary, id: 'L1-b', responseContent: [{ type: 'text', text: ' '.repeat(400) } as ContentBlock] };
    const { content, refs } = new Exposed({}).render(blank, 25);
    assert.deepEqual(content.map((b) => (b as { text?: string }).text), ['[content omitted: this message reached its token limit]']);
    assert.deepEqual(refs, [{ id: 'L1-b', level: 1 }]);
  });

  it('a combined recall answer that leaves summaries out says so once, after its last answer', () => {
    class Exposed extends AutobiographicalStrategy {
      combined(entries: SummaryEntry[], cap: number): ContentBlock[] { return this.combinedRecallAnswerContent(entries, cap); }
    }
    const OMITTED = '[content omitted: this message reached its token limit]';
    const omissions = (content: ContentBlock[]) =>
      content.filter((b) => b.type === 'text' && b.text.includes(OMITTED)).length;
    const trailing = { type: 'redacted_thinking', data: 'opaque-2', rawItem: { type: 'reasoning', id: 'rs_2', encrypted_content: 'opaque-2' } } as ContentBlock;
    // 'first answer' is 12 characters, 3 tokens: a cap of 3 admits it whole and leaves the second out.
    const first = { ...summary, id: 'L1-1', responseContent: [itemText('first answer'), trailing] };
    const second = { ...summary, id: 'L1-2', responseContent: [itemText('second answer', { ...MESSAGE_ITEM, id: 'msg_2' })] };
    const strategy = new Exposed({ recallEnvelope: 'xml' });

    const leftOut = strategy.combined([first, second], 3);
    assert.equal(omissions(leftOut), 1, 'one marker for the summary left out');
    assert.equal((leftOut.at(-1) as { text: string }).text, OMITTED, 'after the last answer');
    assert.ok(!leftOut.some((b) => b.type === 'text' && b.text.includes('second answer')), 'the second answer is left out');
    const at = leftOut.findIndex((b) => b.type === 'redacted_thinking');
    assert.ok(at >= 0, 'the first answer keeps its reasoning');
    assert.equal(rawOf(leftOut[at]!).rawItem, undefined, 'the marker follows it on the wire, so it goes id-less');

    assert.equal(omissions(strategy.combined([first, second], 1_000)), 0, 'nothing left out, no marker');

    // A cap that cuts the first answer's prose drops its later part too: that
    // answer carries the one marker, inside its envelope, and none follows it.
    const twoParts = { ...summary, id: 'L1-3', responseContent: [itemText('x'.repeat(400)), itemText('later part')] };
    const cut = strategy.combined([twoParts, second], 50);
    assert.equal(omissions(cut), 1, 'one marker in all');
    assert.match((cut.at(-1) as { text: string }).text, /\[content omitted: this message reached its token limit\]\n<\/cm-recall>$/);
  });

  it('the live-strip answer releases the item its stripped reasoning led to', () => {
    class Exposed extends AutobiographicalStrategy {
      live(entry: SummaryEntry): ContentBlock[] { return this.liveWindowAnswerProse(entry); }
    }
    const strategy = new Exposed({ carrierPolicy: 'live-strip' });
    const live = strategy.live({ ...summary, responseContent: [reasoning(), itemText('first part'), itemText('second part')] });
    assert.deepEqual(live.map((b) => b.type), ['text', 'text'], 'the reasoning is stripped');
    for (const part of live) assert.equal(rawOf(part).rawItem, undefined, 'and the item it led to goes out without its id');
  });
});

describe('raw forms: on the wire, through membrane\'s formatters', () => {
  // Each test hands a compile to membrane's own formatter and request path,
  // over a mock transport that records the provider messages it is given. Each
  // also sends the same compile with the raw forms put back, as a spread edit
  // kept them, to show that this formatter replays them: what the release
  // changes is then seen on the wire, not assumed.
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  type Sent = Array<{ participant: string; content: ContentBlock[] }>;
  const READ_TOOL: ToolDefinition = {
    name: 'fs:read',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  };

  async function wire(formatter: PrefillFormatter, messages: Sent): Promise<unknown[]> {
    const adapter = new MockAdapter({ defaultResponse: 'ok' });
    const membrane = new Membrane(adapter, { formatter, assistantParticipant: 'Claude' });
    await membrane.complete({
      messages: messages.map(({ participant, content }) => ({ participant, content })),
      config: { model: 'test-model', maxTokens: 16 },
      tools: [READ_TOOL],
    });
    const request = adapter.getLastRequest();
    assert.ok(request, 'the transport was called');
    return request.messages as unknown[];
  }
  /** How often `text` appears in what was sent, escaped as the rendered request holds it. */
  const occurrences = (sent: unknown[], text: string): number =>
    JSON.stringify(sent).split(JSON.stringify(text).slice(1, -1)).length - 1;
  /** The messages with `restore`'s raw form given back to each block it names. */
  const withRawForms = (messages: Sent, restore: (block: ContentBlock) => Raw | undefined): Sent =>
    messages.map((m) => ({ ...m, content: m.content.map((b) => ({ ...b, ...restore(b) } as ContentBlock)) }));
  const xml = (): PrefillFormatter => new AnthropicXmlFormatter({ toolMode: 'xml' });

  it('XML prefill: a capped tool_use input ships capped, and its sibling ships once', async () => {
    const big = 'x'.repeat(400);
    const calls =
      `<function_calls>\n<invoke name="fs:read">\n<parameter name="path">${big}</parameter>\n</invoke>\n` +
      '<invoke name="fs:read">\n<parameter name="path">/small</parameter>\n</invoke>\n</function_calls>';
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      toolUseInputMaxTokens: 20,
    });
    const manager = await ContextManager.open({ path: STORE, strategy });
    manager.addMessage('Claude', [
      { type: 'tool_use', id: 'a', name: 'fs:read', input: { path: big }, rawXml: calls } as ContentBlock,
      { type: 'tool_use', id: 'b', name: 'fs:read', input: { path: '/small' }, rawXml: calls } as ContentBlock,
    ]);
    manager.addMessage('user', [xmlResult('a', 'big file'), xmlResult('b', 'small file')]);
    const compiled = (await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 })).messages;
    await manager.close();

    const sent = await wire(xml(), compiled);
    assert.equal(occurrences(sent, big), 0, 'the original input is not on the wire');
    assert.equal(occurrences(sent, '_truncated'), 1, 'the cap is');
    assert.equal(occurrences(sent, '/small'), 1, 'the sibling ships its own input, once');
    assert.equal(occurrences(sent, RESULTS_XML), 1, 'the untouched results replay verbatim');

    const kept = await wire(xml(), withRawForms(compiled, (b) => (b.type === 'tool_use' ? { rawXml: calls } : undefined)));
    assert.equal(occurrences(kept, big), 1, 'with the raw form kept, the formatter replays the original input');
    assert.equal(occurrences(kept, '_truncated'), 0, 'and the cap never ships');
  });

  it('XML prefill: a result moved next to its use ships once, and so does the one it left behind', async () => {
    const strategy = new AutobiographicalStrategy({});
    const entries: ContextEntry[] = [
      { index: 0, participant: 'Claude', content: [{ type: 'tool_use', id: 'a', name: 'fs:read', input: { path: '/big' } } as ContentBlock] },
      { index: 1, participant: 'user', content: [{ type: 'text', text: 'an interleaved turn' }] },
      { index: 2, participant: 'Claude', content: [{ type: 'tool_use', id: 'b', name: 'fs:read', input: { path: '/small' } } as ContentBlock] },
      // 'a''s result sits here, sharing one <function_results> with 'b''s.
      { index: 3, participant: 'user', content: [xmlResult('a', 'big file'), xmlResult('b', 'small file')] },
    ];
    (strategy as unknown as { enforceToolPairing: (e: ContextEntry[]) => void }).enforceToolPairing(entries);

    const sent = await wire(xml(), entries);
    assert.equal(occurrences(sent, 'big file'), 1);
    assert.equal(occurrences(sent, 'small file'), 1);

    const kept = await wire(xml(), withRawForms(entries, (b) => (b.type === 'tool_result' ? { rawXml: RESULTS_XML } : undefined)));
    assert.equal(occurrences(kept, 'big file'), 2, 'with the shared raw form kept, both results ship from both places');
    assert.equal(occurrences(kept, 'small file'), 2);
  });

  it('Responses: a message cap that cuts an item ships the cut part once, and the reasoning without its id', async () => {
    const long = 'y'.repeat(200);
    const item = {
      type: 'message', id: 'msg_1', role: 'assistant',
      content: [
        { type: 'output_text', text: 'first part' },
        { type: 'output_text', text: `second ${long}` },
        { type: 'output_text', text: `third ${long}` },
      ],
    };
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      maxMessageTokens: 30,
    });
    const manager = await ContextManager.open({ path: STORE, strategy });
    manager.addMessage('user', [{ type: 'text', text: 'go' }]);
    // The first part fits; the second is cut; the third is dropped.
    manager.addMessage('Claude', [
      reasoning(),
      itemText('first part', item),
      itemText(`second ${long}`, item),
      itemText(`third ${long}`, item),
    ]);
    const compiled = (await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 })).messages;
    await manager.close();

    const sent = (await wire(new OpenAIResponsesFormatter(), compiled)) as Array<Record<string, unknown>>;
    assert.equal(occurrences(sent, 'msg_1'), 0, 'the uncut item is not replayed');
    assert.equal(occurrences(sent, 'rs_1'), 0, 'nor is the reasoning that led to it, by its id');
    assert.equal(occurrences(sent, 'third'), 0, 'the dropped part is not on the wire');
    assert.equal(occurrences(sent, 'second y'), 1, 'the cut part ships once');
    assert.equal(occurrences(sent, '[truncated'), 1, 'with its marker');
    const thinking = sent.filter((i) => i.type === 'reasoning');
    assert.deepEqual(
      thinking.map((i) => [i.id, i.encrypted_content]),
      [[undefined, 'opaque']],
      'the reasoning ships id-less, with its encrypted content',
    );

    const kept = await wire(new OpenAIResponsesFormatter(), withRawForms(compiled, (b) =>
      b.type === 'redacted_thinking' ? { rawItem: REASONING_ITEM }
        : b.type === 'text' && b.text !== 'go' ? { rawItem: item }
          : undefined));
    assert.equal(occurrences(kept, 'msg_1'), 1, 'with the raw forms kept, the formatter replays the uncut item');
    assert.equal(occurrences(kept, `third ${long}`), 1, 'dropped part and all');
  });

  it('XML prefill: a hoisted tool_use ships its stub, and its prose ships once', async () => {
    const prose = 'p'.repeat(400);
    const calls = '<function_calls>\n<invoke name="skip_reply">\n<parameter name="reason">' + prose + '</parameter>\n</invoke>\n</function_calls>';
    const results = '<function_results>\n<result>\n<name>skip_reply</name>\n<output>ok</output>\n</result>\n</function_results>';
    const history: Sent = [
      { participant: 'user', content: [{ type: 'text', text: 'go' } as ContentBlock] },
      { participant: 'Claude', content: [{ type: 'tool_use', id: 'call_1', name: 'skip_reply', input: { reason: prose }, rawXml: calls } as ContentBlock] },
      { participant: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'ok', rawXml: results } as ContentBlock] },
    ];
    const { messages: hoisted, hoisted: count } = hoistToolProse(history, {
      intoTool: 'journal', field: 'content', result: '{"recorded":true}', minChars: 100, fromTools: ['skip_reply'],
    });
    assert.equal(count, 1);
    const sent = await wire(xml(), hoisted);
    assert.equal(occurrences(sent, prose), 1, 'the prose ships once, in the journal call');
    assert.equal(occurrences(sent, toolProseStub('journal', prose.length)), 1, 'and the stub where it was');

    const kept = await wire(xml(), withRawForms(hoisted, (b) =>
      b.type === 'tool_use' && (b as { id: string }).id === 'call_1' ? { rawXml: calls } : undefined));
    assert.equal(occurrences(kept, prose), 2, 'with the raw form kept, the original prose ships beside the hoisted copy');
  });

  it('Responses: a hoisted call ships its stub, its prose once, and the reasoning that led to it id-less', async () => {
    const prose = 'q'.repeat(400);
    const callItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'skip_reply', arguments: JSON.stringify({ reason: prose }) };
    const history: Sent = [
      { participant: 'user', content: [{ type: 'text', text: 'go' } as ContentBlock] },
      { participant: 'Claude', content: [
        reasoning(),
        { type: 'tool_use', id: 'call_1', name: 'skip_reply', input: { reason: prose }, rawItem: callItem } as ContentBlock,
      ] },
      { participant: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'ok', rawItem: { type: 'function_call_output', call_id: 'call_1', output: 'ok' } } as ContentBlock] },
    ];
    const { messages: hoisted, hoisted: count } = hoistToolProse(history, {
      intoTool: 'journal', field: 'content', result: '{"recorded":true}', minChars: 100, fromTools: ['skip_reply'],
    });
    assert.equal(count, 1);
    const sent = await wire(new OpenAIResponsesFormatter(), hoisted);
    assert.equal(occurrences(sent, prose), 1, 'the prose ships once, in the journal call');
    assert.equal(occurrences(sent, 'fc_1'), 0, 'the original call is not replayed');
    assert.equal(occurrences(sent, 'rs_1'), 0, 'nor is the reasoning that led to it, by its id');

    const kept = await wire(new OpenAIResponsesFormatter(), withRawForms(hoisted, (b) =>
      b.type === 'tool_use' && (b as { id: string }).id === 'call_1' ? { rawItem: callItem } : undefined));
    assert.equal(occurrences(kept, prose), 2, 'with the raw form kept, the original prose ships beside the hoisted copy');
  });

  it('Responses: an answer with no prose ships its envelope after reasoning that has given up its id', async () => {
    const summary: SummaryEntry = {
      id: 'L1-7', level: 1, content: 'memory', tokens: 4, sourceLevel: 0,
      sourceIds: ['m-1'], sourceRange: { first: 'm-1', last: 'm-4' }, created: 0,
    };
    const wrapped = wrapRecallAnswerContent([reasoning()], summary, 'xml');
    const ask = { participant: 'user', content: [{ type: 'text', text: 'what do you remember?' } as ContentBlock] };
    const sent = (await wire(new OpenAIResponsesFormatter(), [ask, { participant: 'Claude', content: wrapped }])) as Array<Record<string, unknown>>;
    assert.equal(occurrences(sent, '<cm-recall'), 1, 'the envelope is on the wire');
    assert.equal(occurrences(sent, 'rs_1'), 0, 'the reasoning is not replayed by its id');
    assert.deepEqual(sent.filter((i) => i.type === 'reasoning').map((i) => [i.id, i.encrypted_content]), [[undefined, 'opaque']]);
  });

  it('Responses: a wrapped recall answer ships wrapped', async () => {
    const summary: SummaryEntry = {
      id: 'L1-7', level: 1, content: 'memory', tokens: 4, sourceLevel: 0,
      sourceIds: ['m-1'], sourceRange: { first: 'm-1', last: 'm-4' }, created: 0,
    };
    const answer = [itemText('first part'), itemText('second part'), itemText('third part')];
    const wrapped = wrapRecallAnswerContent(answer, summary, 'xml');
    const ask = { participant: 'user', content: [{ type: 'text', text: 'what do you remember?' } as ContentBlock] };

    const sent = await wire(new OpenAIResponsesFormatter(), [ask, { participant: 'Claude', content: wrapped }]);
    assert.equal(occurrences(sent, '<cm-recall'), 1, 'the envelope is on the wire');
    assert.equal(occurrences(sent, 'msg_1'), 0, 'the unwrapped item is not');

    const kept = await wire(new OpenAIResponsesFormatter(), [
      ask,
      { participant: 'Claude', content: wrapped.map((b) => ({ ...b, rawItem: MESSAGE_ITEM } as ContentBlock)) },
    ]);
    assert.equal(occurrences(kept, '<cm-recall'), 0, 'with the raw form kept, the envelope never ships');
    assert.equal(occurrences(kept, 'msg_1'), 1);
  });
});
