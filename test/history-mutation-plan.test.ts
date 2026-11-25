import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';

import {
  describeTarget, historyAnomalies, messageContentSha256, planMutation, readBackMismatches, snapshotOf,
  type HistoryMemory, type HistoryMutationOp, type HistoryState,
} from '../src/history-mutation.js';
import { textSha256 } from '../src/summary-edit.js';
import type { StoredMessage } from '../src/types/message.js';
import type { SummaryEntry } from '../src/types/strategy.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

function row(id: string, sequence: number, participant: string, content: ContentBlock[], extra: Partial<StoredMessage> = {}): StoredMessage {
  return { id, sequence, participant, content, timestamp: new Date(0), ...extra };
}

const ROWS: StoredMessage[] = [
  row('m0', 1, 'User', text('hello')),
  row('m1', 2, 'Ada', [
    { type: 'thinking', thinking: 'which tool', signature: 'sig-1' },
    { type: 'text', text: 'let me look' },
    { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
  ]),
  row('m2', 3, 'User', [{ type: 'tool_result', toolUseId: 't1', content: 'file a' }]),
  row('m3', 4, 'Ada', text('it says a')),
  row('m4', 5, 'User', text('first half of a long paste'), { bodyGroupId: 'g1', shardIndex: 0, shardCount: 2 }),
  row('m5', 6, 'User', text('second half of a long paste'), { bodyGroupId: 'g1', shardIndex: 1, shardCount: 2 }),
  row('m6', 7, 'Ada', text('noted')),
];

function summary(id: string, level: number, sourceIds: string[], first: string, last: string, extra: Partial<SummaryEntry> = {}): SummaryEntry {
  return { id, level, sourceLevel: level - 1, sourceIds, sourceRange: { first, last }, content: `memory ${id}`, tokens: 30, created: 1, ...extra } as SummaryEntry;
}

const MEMORY: HistoryMemory = {
  summaries: [
    summary('L1-a', 1, ['m0', 'm1', 'm2', 'm3'], 'm0', 'm3', { mergedInto: 'L2-p', responseContent: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'memory L1-a' }] }),
    summary('L1-b', 1, ['m4', 'm5', 'm6'], 'm4', 'm6', { mergedInto: 'L2-p' }),
    summary('L2-p', 2, ['L1-a', 'L1-b'], 'm0', 'm6', { mergedInto: 'L3-c' }),
    summary('L3-c', 3, ['L2-p'], 'm0', 'm6', { carriedFrom: 'L2-p' }),
  ],
  chunkRecords: [
    { id: 'c-1', sourceIds: ['m0', 'm1', 'm2', 'm3'], compressed: true, summaryId: 'L1-a' },
    { id: 'c-2', sourceIds: ['m4', 'm5', 'm6'], compressed: true, summaryId: 'L1-b' },
  ],
};

function state(over: Partial<HistoryState> = {}): HistoryState {
  const rows = over.rows ?? ROWS;
  return { branch: 'main', rows, record: rows, view: rows, memory: null, windowMode: 'legacy', ...over };
}

const inOrder = (ids: string[], rows: readonly StoredMessage[] = ROWS) => ids.map((id) => rows.find((r) => r.id === id)!);
const sha = (id: string, rows: readonly StoredMessage[] = ROWS) => messageContentSha256(rows.find((r) => r.id === id)!.content);
const codes = (ops: HistoryMutationOp[], s: HistoryState = state()) => planMutation(s, { ops }).violations.map((v) => v.code);
type MessageEdit = Extract<HistoryMutationOp, { kind: 'edit_message' }>;
type Removal = Extract<HistoryMutationOp, { kind: 'remove_messages' }>;
const editMessage = (messageId: string, content: ContentBlock[], extra: Partial<MessageEdit> = {}): MessageEdit =>
  ({ kind: 'edit_message', messageId, expectedSha256: sha(messageId), content, label: '[edited by Clement]', ...extra });
const remove = (...ids: string[]): Removal =>
  ({ kind: 'remove_messages', messageIds: ids, expectedSha256ById: Object.fromEntries(ids.map((id) => [id, sha(id)])) });

describe('history mutation plan', () => {
  it('refuses an empty manifest, a target named twice, one not there, and content other than the caller read', () => {
    assert.deepEqual(codes([]), ['EMPTY_MANIFEST']);
    assert.deepEqual(codes([editMessage('m3', text('x')), remove('m3')]), ['DUPLICATE_TARGET']);
    assert.deepEqual(codes([{ kind: 'edit_message', messageId: 'm9', expectedSha256: 'x', content: text('x'), label: '[edited]' }]), ['TARGET_NOT_FOUND']);
    assert.deepEqual(codes([editMessage('m3', text('x'), { expectedSha256: sha('m0') })]), ['CAS_MISMATCH']);
    assert.deepEqual(codes([{ ...remove('m3'), expectedSha256ById: { m3: sha('m0') } }]), ['CAS_MISMATCH']);
    assert.deepEqual(codes([editMessage('m3', text('x'), { expectedAfterSha256: sha('m0') })]), ['AFTER_SHA_MISMATCH']);
  });

  it('puts the label first in an edited message, once, and refuses a blank one', () => {
    const plan = planMutation(state(), { ops: [editMessage('m3', text('it says b'))] });
    assert.equal(plan.valid, true);
    const target = plan.targets[0]!;
    assert.equal(target.kind, 'edit_message');
    assert.deepEqual(target.kind === 'edit_message' && target.content, [...text('[edited by Clement]'), ...text('it says b')]);
    assert.equal(target.kind === 'edit_message' && target.afterSha256, messageContentSha256([...text('[edited by Clement]'), ...text('it says b')]));

    const spliced = planMutation(state(), { ops: [editMessage('m3', text('it says [edited by Clement] b'))] }).targets[0]!;
    assert.deepEqual(spliced.kind === 'edit_message' && spliced.content, text('it says [edited by Clement] b'), 'a label the text holds is not added again');
    assert.deepEqual(codes([editMessage('m3', text('it says b'), { label: '  ' })]), ['MISSING_ATTRIBUTION_LABEL']);
  });

  it('refuses malformed content, an edit of a shard, and a removal of part of a body unless it takes the whole', () => {
    assert.deepEqual(codes([editMessage('m3', [{ type: 'text' } as unknown as ContentBlock])]), ['MALFORMED_CONTENT']);
    const change = [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock];
    assert.deepEqual(codes([editMessage('m3', change)]), ['MALFORMED_CONTENT'], 'a system change, which the label would stand beside');
    assert.deepEqual(codes([editMessage('m4', text('x'))]), ['SHARDED_MESSAGE_EDIT']);
    assert.deepEqual(codes([remove('m4')]), ['PARTIAL_BODY_GROUP_REMOVAL']);
    assert.deepEqual(codes([remove('m4', 'm5')]), []);
    const expanded = planMutation(state(), { ops: [{ ...remove('m4'), expandBodyGroups: true }] });
    assert.equal(expanded.valid, true);
    const target = expanded.targets[0]!;
    assert.deepEqual(target.kind === 'remove_messages' && [target.messageIds, target.expandedIds], [['m4', 'm5'], ['m5']]);
  });

  it('refuses a batch that splits a tool call from its result, and takes one that removes both', () => {
    const split = planMutation(state(), { ops: [remove('m1')] });
    assert.deepEqual(split.violations.map((v) => [v.code, v.targetId, v.remediation?.partnerMessageId]), [['TOOL_PAIR_SPLIT', 'm2', 'm1']]);
    assert.deepEqual(codes([remove('m2')]), ['TOOL_PAIR_SPLIT']);
    assert.deepEqual(codes([editMessage('m1', text('let me look'))]), ['TOOL_PAIR_SPLIT'], 'an edit that takes out the call');
    assert.deepEqual(codes([remove('m1', 'm2')]), []);
    const rows = [...ROWS.slice(0, 2), row('mc', 2.5, 'system', [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock]), ...ROWS.slice(2)];
    const withChange = state({ rows });
    assert.deepEqual(historyAnomalies(withChange).map((a) => a.code), ['TOOL_PAIR_SPLIT'], 'setup: the change stands between them already');
    assert.deepEqual(planMutation(withChange, { ops: [{ ...remove('m3'), expectedSha256ById: { m3: sha('m3', rows) } }] }).violations, [], 'a split that was there before is not the batch\'s');
  });

  it('refuses an edit the store refuses for a tool pair, even where the split was there before', () => {
    const rows = [
      row('m0', 1, 'User', text('hello')),
      row('ma', 2, 'Ada', [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't9', name: 'read', input: {} }]),
      row('mc', 3, 'system', [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock]),
    ];
    const s = state({ rows });
    const op: MessageEdit = { kind: 'edit_message', messageId: 'ma', expectedSha256: sha('ma', rows), content: [{ type: 'text', text: 'looked' }, { type: 'tool_use', id: 't9', name: 'read', input: {} }], label: '[edited]' };
    const plan = planMutation(s, { ops: [op] });
    assert.deepEqual(plan.violations.map((v) => [v.code, v.targetId]), [['TOOL_PAIR_SPLIT', 'ma']]);
    assert.match(plan.violations[0]!.message, /the store refuses the edit of message ma: a tool_use \(t9\) can't go before a system change \(message mc\)/);
  });

  it('reads each edit as the store will, against the rows the batch\'s earlier ops leave', () => {
    const rows = [
      row('m0', 1, 'User', text('hello')),
      row('ma', 2, 'Ada', [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't9', name: 'read', input: {} }]),
      row('mc', 3, 'system', [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock]),
      row('m4', 4, 'User', text('and then')),
    ];
    const s = state({ rows });
    const editCall: MessageEdit = { kind: 'edit_message', messageId: 'ma', expectedSha256: sha('ma', rows), content: [{ type: 'text', text: 'looked' }, { type: 'tool_use', id: 't9', name: 'read', input: {} }], label: '[edited]' };
    const removeChange: Removal = { kind: 'remove_messages', messageIds: ['mc'], expectedSha256ById: { mc: sha('mc', rows) } };
    const editChange: MessageEdit = { kind: 'edit_message', messageId: 'mc', expectedSha256: sha('mc', rows), content: text('units noted'), label: '[edited]' };
    assert.deepEqual(codes([removeChange, editCall], s), [], 'the change is gone when the call is edited');
    assert.deepEqual(codes([editChange, editCall], s), [], 'the change is text when the call is edited');
    assert.deepEqual(codes([editCall, removeChange], s), ['TOOL_PAIR_SPLIT'], 'the change still stands when the call is edited');
  });

  it('refuses a split that only the window\'s order shows', () => {
    const rows = [...ROWS.slice(0, 3), row('m3', 4, 'User', [{ type: 'tool_result', toolUseId: 't1', content: 'file a, again' }])];
    const presented = state({ rows, view: inOrder(['m0', 'm1', 'm2'], rows), windowMode: 'presented' });
    const plan = planMutation(presented, { ops: [{ ...remove('m2'), expectedSha256ById: { m2: sha('m2', rows) } }] });
    assert.deepEqual(plan.violations.map((v) => [v.code, v.targetId]), [['TOOL_PAIR_SPLIT', 'm1']]);
  });

  it('refuses an edit of a summary that another op of the batch drops', () => {
    const memory = state({ memory: MEMORY });
    const plan = planMutation(memory, { ops: [
      { kind: 'edit_summary', summaryId: 'L2-p', expectedSha256: textSha256('memory L2-p'), newText: 'by hand' },
      editMessage('m3', text('x'), { foldedPolicy: 'drop_covering_summaries' }),
    ] });
    assert.deepEqual(plan.violations.map((v) => [v.code, v.opIndex, v.remediation?.droppingOps]), [['EDITED_SUMMARY_DROPPED', 0, [1]]]);
  });

  it('plans an image as the store keeps it', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const plan = planMutation(state(), { ops: [editMessage('m3', [{ type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: png } }])] });
    const target = plan.targets[0]!;
    assert.ok(target.kind === 'edit_message');
    assert.deepEqual(target.content[1], { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: png } });
    assert.equal(target.afterSha256, messageContentSha256(target.content));
  });

  it('refuses changed text beside kept thinking, and says when a target lies inside the thinking record', () => {
    const m1 = ROWS[1]!.content;
    assert.deepEqual(codes([editMessage('m1', [m1[0]!, ...text('let me check'), m1[2]!])]), ['STALE_THINKING_IN_EDITED_MESSAGE']);
    assert.deepEqual(
      codes([editMessage('m1', [{ type: 'thinking', thinking: 'another thought', signature: 'sig-1' }, m1[1]!, m1[2]!], { label: 'let me look' })]),
      ['STALE_THINKING_IN_EDITED_MESSAGE'],
      'a thinking block changed, the text as it was',
    );
    const without = planMutation(state({ thinkingBoundThrough: 3 }), { ops: [editMessage('m1', [...text('let me check'), m1[2]!])] });
    assert.equal(without.valid, true);
    assert.equal(without.invalidatesThinkingBinding, true);
    assert.deepEqual(without.invalidatesKvPrefixFrom, { messageId: 'm1', sequence: 2 });
    assert.equal(planMutation(state({ thinkingBoundThrough: 7 }), { ops: [editMessage('m6', text('ok'))] }).invalidatesThinkingBinding, true);
    assert.equal(planMutation(state({ thinkingBoundThrough: 6 }), { ops: [editMessage('m6', text('ok'))] }).invalidatesThinkingBinding, false);
  });

  it('places an edited summary by the rows it folds, and from the start where it folds none that the history holds', () => {
    const summaries = [summary('L1-b', 1, ['gone', 'm5', 'm6'], 'gone', 'm6'), summary('L1-z', 1, ['x', 'y'], 'x', 'y')];
    const s = state({ memory: { summaries, chunkRecords: [] }, view: inOrder(['m0', 'm1', 'm2', 'm3', 'm4', 'm6', 'm5']), windowMode: 'presented', thinkingBoundThrough: 6 });
    const edit = (summaryId: string): HistoryMutationOp => ({ kind: 'edit_summary', summaryId, expectedSha256: textSha256(`memory ${summaryId}`), newText: 'by hand' });
    const folded = planMutation(s, { ops: [edit('L1-b')] });
    assert.deepEqual(folded.invalidatesKvPrefixFrom, { messageId: 'm6', sequence: 7 });
    assert.equal(folded.invalidatesThinkingBinding, true);
    const nowhere = planMutation(s, { ops: [edit('L1-z')] });
    assert.deepEqual(nowhere.invalidatesKvPrefixFrom, { messageId: 'm0', sequence: 1 });
    assert.equal(nowhere.invalidatesThinkingBinding, true);
  });

  it('says where the window first changes in its own order, and that the thinking record is reached by any changed row', () => {
    const presented = state({ view: inOrder(['m0', 'm1', 'm2', 'm6', 'm3', 'm4', 'm5']), windowMode: 'presented', thinkingBoundThrough: 4 });
    const plan = planMutation(presented, { ops: [editMessage('m6', text('ok')), editMessage('m3', text('it says b'))] });
    assert.deepEqual(plan.invalidatesKvPrefixFrom, { messageId: 'm6', sequence: 7 });
    assert.equal(plan.invalidatesThinkingBinding, true);
  });

  it('refuses a change of a folded message unless the plan says what happens to what folds it, and refuses taking every message', () => {
    const memory = state({ memory: MEMORY });
    const folded = planMutation(memory, { ops: [editMessage('m3', text('x'))] });
    assert.deepEqual(folded.violations.map((v) => [v.code, v.remediation?.coveringSummaries]), [['FOLDED_ROW_REQUIRES_POLICY', ['L1-a', 'L2-p', 'L3-c']]]);
    const dropping = planMutation(memory, { ops: [editMessage('m3', text('x'), { foldedPolicy: 'drop_covering_summaries' })] });
    assert.equal(dropping.valid, true);
    assert.deepEqual(dropping.droppedSummaries.sort(), ['L1-a', 'L2-p', 'L3-c']);
    assert.deepEqual(planMutation(memory, { ops: [editMessage('m3', text('x'), { foldedPolicy: 'leave_summaries' })] }).droppedSummaries, []);

    assert.deepEqual(codes([remove('m3')], memory), ['FOLDED_ROW_REQUIRES_POLICY'], 'legacy mode: a removal drops nothing by itself');
    assert.deepEqual(codes([remove('m3')], state({ memory: MEMORY, windowMode: 'presented' })), [], 'once a host presents, a removal lets go of what folds it');
    assert.deepEqual(codes([remove(...ROWS.map((r) => r.id))]), ['EMPTY_STORE']);
  });

  it('refuses a summary edit that a compile wouldn\'t show, or whose merged parents it leaves unexamined', () => {
    const memory = state({ memory: MEMORY });
    const edit = (summaryId: string, extra: Partial<Extract<HistoryMutationOp, { kind: 'edit_summary' }>> = {}): HistoryMutationOp => ({
      kind: 'edit_summary', summaryId, expectedSha256: textSha256(`memory ${summaryId}`), newText: 'by hand', ...extra,
    });
    const carried = planMutation(memory, { ops: [edit('L3-c')] });
    assert.deepEqual(carried.violations.map((v) => [v.code, v.remediation?.authoritativeSummaryId]), [['CARRIED_SUMMARY_TARGET', 'L2-p']]);
    assert.deepEqual(codes([edit('L1-a', { parentPolicy: 'leave_parents' })], memory), ['RESPONSE_CONTENT_SHADOW']);
    assert.deepEqual(codes([edit('L1-a', { dropResponseContent: true })], memory), ['MERGED_PARENT_REQUIRES_POLICY']);
    assert.deepEqual(codes([edit('L1-a', { dropResponseContent: true, parentPolicy: 'leave_parents', newText: ' ' })], memory), ['EMPTY_CONTENT']);
    assert.deepEqual(codes([edit('L2-p')], memory), [], 'a carrier is not a merged parent');
    const dropParents = planMutation(memory, { ops: [edit('L1-b', { parentPolicy: 'drop_parents' })] });
    assert.deepEqual(dropParents.droppedSummaries.sort(), ['L2-p', 'L3-c']);
    assert.deepEqual(codes([edit('L1-b')], state()), ['STRATEGY_UNSUPPORTED']);

    assert.deepEqual(describeTarget(memory, { summaryId: 'L2-p' }), {
      kind: 'summary', summaryId: 'L2-p', level: 2, sha256: textSha256('memory L2-p'), authoritativeSummaryId: 'L2-p',
      carriedBy: ['L3-c'], mergedParents: [], sourceIds: ['L1-a', 'L1-b'], responseBlocks: 0,
    });
    const carrier = describeTarget(memory, { summaryId: 'L3-c' });
    assert.equal(carrier?.kind === 'summary' && carrier.authoritativeSummaryId, 'L2-p');
  });

  it('binds the plan to its branch and to what it would do', () => {
    const ops = [editMessage('m3', text('it says b'))];
    const plan = planMutation(state(), { ops });
    assert.equal(plan.sourceBranch, 'main');
    assert.equal(planMutation(state(), { ops }).planSha256, plan.planSha256, 'the same history and manifest give the same hash');
    assert.notEqual(planMutation(state({ branch: 'other' }), { ops }).planSha256, plan.planSha256);
    assert.notEqual(planMutation(state(), { ops: [editMessage('m3', text('it says c'))] }).planSha256, plan.planSha256);
    const both = text('it says b [edited by Clement] [edited by Ada]');
    assert.notEqual(
      planMutation(state(), { ops: [editMessage('m3', both)] }).planSha256,
      planMutation(state(), { ops: [editMessage('m3', both, { label: '[edited by Ada]' })] }).planSha256,
      'the label is recorded, so it is bound even where the text holds both',
    );
  });

  it('names each anomaly of a history at rest', () => {
    const rows = [...ROWS.slice(0, 2), ROWS[3]!, ROWS[4]!, ROWS[6]!];
    const anomalies = historyAnomalies(state({ rows, memory: {
      summaries: [summary('L1-x', 1, ['m0', 'm6'], 'm0', 'm6')],
      chunkRecords: [{ id: 'c-x', sourceIds: ['m0', 'm6'], compressed: true, summaryId: 'L1-x' }, { id: 'c-y', sourceIds: ['m1', 'm3'], compressed: false }],
    } }));
    assert.deepEqual(anomalies.map((a) => [a.code, a.targetId]), [
      ['INCOMPLETE_BODY', 'm4'],
      ['TOOL_PAIR_SPLIT', 'm1'],
      ['TOPOLOGY_CROSSED', 'L1-x'],
    ]);
    assert.deepEqual(historyAnomalies(state({ memory: MEMORY })), [], 'the fixture itself has none');
  });

  it('reads back a removal of the last row as not made while the row is still there', () => {
    const s = state();
    const plan = planMutation(s, { ops: [remove('m6')] });
    assert.equal(plan.valid, true);
    assert.deepEqual(readBackMismatches(plan, snapshotOf(s), s, { by: 'operator', at: 0, sourceBranch: 'main' }), ['message m6 is still there']);
  });

  it('names a system change inside a tool pair once per call, by the call\'s message', () => {
    const change = row('mc', 2.5, 'system', [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock]);
    const again = row('m2b', 3.5, 'User', [{ type: 'tool_result', toolUseId: 't1', content: 'file a, again' }]);
    const anomalies = historyAnomalies(state({ rows: [...ROWS.slice(0, 2), change, ROWS[2]!, again, ...ROWS.slice(3)] }));
    assert.deepEqual(anomalies.filter((a) => /system change/.test(a.message)).map((a) => [a.targetId, a.message]), [
      ['m1', 'a system change (message mc) stands between the tool call t1 in message m1 and its result'],
    ]);
  });
});
