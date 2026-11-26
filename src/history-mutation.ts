import { createHash } from 'node:crypto';
import type { ContentBlock } from '@animalabs/membrane';
import { blockAsStored } from './blob-manager.js';
import { bodyBoundsIn } from './body-runs.js';
import { canonicalJson } from './canonical-json.js';
import { carriesItsSource } from './strategies/merge-runs.js';
import { toolPairSplitReason } from './message-store.js';
import { findUnpairedToolBlocks } from './normalize-tool-messages.js';
import { releaseReplacedRawForms } from './raw-forms.js';
import { crossedSummaryIds } from './repair/topology.js';
import { storedJson } from './stored-json.js';
import { planSummaryEdit, summariesFoldingRows, textSha256, withSummariesAbove } from './summary-edit.js';
import { isThinkingBlock } from './thinking-binding.js';
import type { MessageId, MessageMetadata, Sequence, StoredMessage } from './types/message.js';
import type { SummaryEntry, SummaryLevel } from './types/strategy.js';
import { contentForWrite, MalformedContentError, malformedContentPlaces } from './well-formed-content.js';

/** What happens to the summaries that fold a message an edit changes. */
export type FoldedEditPolicy = 'refuse' | 'drop_covering_summaries' | 'leave_summaries';
/** What happens to the summaries that fold a message a removal takes out. */
export type FoldedRemovePolicy = 'refuse' | 'drop_covering_summaries';
/** What happens to the summaries merged over a summary whose text an edit replaces. */
export type ParentPolicy = 'refuse' | 'leave_parents' | 'drop_parents';

const FOLDED_EDIT_POLICIES: readonly FoldedEditPolicy[] = ['refuse', 'drop_covering_summaries', 'leave_summaries'];
const FOLDED_REMOVE_POLICIES: readonly FoldedRemovePolicy[] = ['refuse', 'drop_covering_summaries'];
const PARENT_POLICIES: readonly ParentPolicy[] = ['refuse', 'leave_parents', 'drop_parents'];

/**
 * One change of a history mutation. Each op names what the caller read: the
 * sha256 of its current form (describeMutationTarget gives it), so a change
 * made since refuses the plan.
 */
export type HistoryMutationOp =
  | {
      kind: 'edit_summary';
      summaryId: string;
      /** sha256 of the summary's text as UTF-8. */
      expectedSha256: string;
      newText: string;
      /** sha256 of `newText`, where the caller computed it: a check that it sends the text it means. */
      expectedAfterSha256?: string;
      /** Required where the summary renders verbatim response blocks in place of its text. */
      dropResponseContent?: boolean;
      /** Default 'refuse' where a summary is merged over this one. */
      parentPolicy?: ParentPolicy;
    }
  | {
      kind: 'edit_message';
      messageId: MessageId;
      /** sha256 of the canonical JSON of the message's content as a read gives it (images resolved). */
      expectedSha256: string;
      content: ContentBlock[];
      /**
       * Who changed the message, as the resident will read it, such as
       * `[redacted; surgery 2026-11-25 by Clement]`. It goes first in the
       * content, as a text block of its own, unless a text block of the
       * content already holds it. Required, and not blank.
       */
      label: string;
      /** sha256 of the content as the plan writes it (the plan's `after`). */
      expectedAfterSha256?: string;
      /** Default 'refuse' where a summary folds the message. */
      foldedPolicy?: FoldedEditPolicy;
    }
  | {
      kind: 'remove_messages';
      messageIds: MessageId[];
      /** Per listed id, sha256 of the canonical JSON of its content as a read gives it. */
      expectedSha256ById: Record<MessageId, string>;
      /** Take a listed shard's whole body. Default: a removal of part of a body is refused. */
      expandBodyGroups?: boolean;
      /** Default 'drop_covering_summaries' once a host presents rows (the window's removal does it), 'refuse' in legacy mode. */
      foldedPolicy?: FoldedRemovePolicy;
    };

export interface HistoryMutationManifest {
  ops: HistoryMutationOp[];
}

export type MutationViolationCode =
  | 'EMPTY_MANIFEST'
  | 'DUPLICATE_TARGET'
  | 'TARGET_NOT_FOUND'
  | 'CAS_MISMATCH'
  | 'AFTER_SHA_MISMATCH'
  | 'CARRIED_SUMMARY_TARGET'
  | 'RESPONSE_CONTENT_SHADOW'
  | 'MERGED_PARENT_REQUIRES_POLICY'
  | 'EMPTY_CONTENT'
  | 'MALFORMED_CONTENT'
  | 'MISSING_ATTRIBUTION_LABEL'
  | 'SHARDED_MESSAGE_EDIT'
  | 'PARTIAL_BODY_GROUP_REMOVAL'
  | 'TOOL_PAIR_SPLIT'
  | 'EMPTY_STORE'
  | 'STALE_THINKING_IN_EDITED_MESSAGE'
  | 'FOLDED_ROW_REQUIRES_POLICY'
  | 'EDITED_SUMMARY_DROPPED'
  | 'STRATEGY_UNSUPPORTED'
  | 'MALFORMED_OP'
  | 'STALE_MEMORY'
  // An apply's own, beyond its plan's: the branch or plan it was given isn't
  // the one it finds, its target branch exists, the branch it built reads
  // back other than planned or breaks a rule the source didn't, the source
  // moved while it built, a branch it built is left behind, or the store
  // moved to the branch and the strategy didn't initialize there.
  | 'BRANCH_MISMATCH'
  | 'PLAN_DRIFT'
  | 'TARGET_BRANCH_EXISTS'
  | 'READBACK_MISMATCH'
  | 'INVARIANT_BROKEN'
  | 'SOURCE_MOVED'
  | 'BRANCH_LEFT'
  | 'APPLIED_INIT_FAILED';

export interface MutationViolation {
  /** The op it is about; -1 for the manifest as a whole. */
  opIndex: number;
  code: MutationViolationCode;
  targetId?: string;
  message: string;
  /** What to change: the summary to edit instead, the partner message to take too, the summaries that fold a row. */
  remediation?: Record<string, unknown>;
}

type PlannedSummaryEdit = {
  kind: 'edit_summary';
  opIndex: number;
  summaryId: string;
  level: SummaryLevel;
  beforeSha256: string;
  afterSha256: string;
  newText: string;
  tokens: number;
  droppedResponseBlocks: number;
  dropResponseContent: boolean;
  /** Entries that carry the summary up a level: they read the new text. */
  carriedBy: string[];
  /** Summaries merged over the old text, nearest first. */
  mergedParents: string[];
  parentPolicy: ParentPolicy;
  sourceIds: string[];
};

type PlannedMessageEdit = {
  kind: 'edit_message';
  opIndex: number;
  messageId: MessageId;
  beforeSha256: string;
  afterSha256: string;
  /** The content as the edit writes it: the label first where the content didn't hold it. */
  content: ContentBlock[];
  label: string;
  foldedPolicy: FoldedEditPolicy;
  coveringSummaries: string[];
};

type PlannedRemoval = {
  kind: 'remove_messages';
  opIndex: number;
  /** Every row the removal takes, listed or expanded, in record order. */
  messageIds: MessageId[];
  /** Rows taken because they are shards of a listed row's body. */
  expandedIds: MessageId[];
  beforeSha256ById: Record<MessageId, string>;
  foldedPolicy: FoldedRemovePolicy;
  coveringSummaries: string[];
};

export type PlannedTarget = PlannedSummaryEdit | PlannedMessageEdit | PlannedRemoval;

/**
 * What a mutation does to a reader: another manager on the store, with a
 * strategy namespace of its own, whose window or summaries hold the rows it
 * changes (another resident on the slot, or an agent that merges it).
 */
export interface PlannedReader {
  /** The reader's strategy namespace, which names its window and its summaries in the store. */
  namespace: string;
  /** The rows the mutation edits or removes that the reader's window holds or its summaries fold, in the plan's order. */
  heldIds: MessageId[];
  /** For each op over messages whose rows the reader's summaries fold: those summaries, with every summary above them, and the policy that decides them for this reader. */
  covering: Array<{ opIndex: number; foldedPolicy: FoldedEditPolicy | FoldedRemovePolicy; coveringSummaries: string[] }>;
  /** The reader's summaries the mutation drops, by those policies. */
  droppedSummaries: string[];
  /** As the plan's own, for the reader's thinking-binding record. */
  invalidatesThinkingBinding: boolean;
  /** As the plan's own, for the reader's window. */
  invalidatesKvPrefixFrom?: { messageId: MessageId; sequence: Sequence };
}

/** What a manifest would do, read from the history as it stands, and what refuses it. Planning writes nothing. */
export interface HistoryMutationPlan {
  valid: boolean;
  violations: MutationViolation[];
  /** The branch the plan read: an apply on another refuses. */
  sourceBranch: string;
  /** sha256 of the canonical JSON of what the plan reports (its branch, its targets, each summary it drops as it holds it, where its window and its thinking record change, and each reader's part), so an apply whose plan has drifted refuses (PLAN_DRIFT). */
  planSha256: string;
  targets: PlannedTarget[];
  /** Summaries the mutation drops, by the policies chosen, with every summary above them. */
  droppedSummaries: string[];
  /** A target lies at or before the end of the thinking-binding record, so the next binding compile sends what follows it without thinking. */
  invalidatesThinkingBinding: boolean;
  /** The first stored row whose rendering may change, an estimate that errs early: a provider's prefix cache is rewritten from here once. */
  invalidatesKvPrefixFrom?: { messageId: MessageId; sequence: Sequence };
  /** What the mutation does to each reader the caller named, in the order named. */
  readers: PlannedReader[];
}

export interface HistoryState {
  branch: string;
  rows: readonly StoredMessage[];
  record: readonly StoredMessage[];
  window: readonly StoredMessage[];
  view: readonly StoredMessage[];
  memory: HistoryMemory | null;
  hiddenStrategy?: string;
  windowMode: 'legacy' | 'presented';
  windowOrdinals?: ReadonlyArray<{ id: MessageId; ordinal: number | undefined }>;
  viewKeeps?: (row: StoredMessage) => boolean;
  thinkingBoundThrough?: Sequence;
}

export interface HistoryMemory {
  summaries: readonly SummaryEntry[];
  chunkRecords: ReadonlyArray<{ id: string; sourceIds: string[]; compressed: boolean; summaryId?: string }>;
  stored?: readonly unknown[];
}

/** sha256 of the canonical JSON of a message's content: how an op names the content it read. */
export function messageContentSha256(content: readonly ContentBlock[]): string {
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

/** One target as a mutation names it, with the hash an op compares. */
export type MutationTargetDescription =
  | {
      kind: 'summary';
      summaryId: string;
      level: SummaryLevel;
      sha256: string;
      /** The summary a compile reads in this entry's place, where it carries one up a level: edit that one. */
      authoritativeSummaryId: string;
      carriedBy: string[];
      mergedParents: string[];
      sourceIds: string[];
      responseBlocks: number;
    }
  | {
      kind: 'message';
      messageId: MessageId;
      sequence: Sequence;
      participant: string;
      sha256: string;
      /** The other rows of its body, where it is a shard. */
      bodyGroupIds: MessageId[];
      /** Summaries that fold it, with every summary above them. */
      coveringSummaries: string[];
    };

export function describeTarget(
  state: HistoryState,
  target: { summaryId: string } | { messageId: MessageId },
): MutationTargetDescription | null {
  if ('summaryId' in target) {
    if (!state.memory) return null;
    const plan = planSummaryEdit(state.memory.summaries, target.summaryId, '');
    if (!plan) return null;
    const carried = plan.refusals.find((r) => r.code === 'CARRIED_SUMMARY_TARGET');
    return {
      kind: 'summary',
      summaryId: plan.entry.id,
      level: plan.entry.level,
      sha256: plan.prior.sha256,
      authoritativeSummaryId: carried?.code === 'CARRIED_SUMMARY_TARGET' ? carried.authoritativeSummaryId : plan.entry.id,
      carriedBy: plan.carriedBy.map((s) => s.id),
      mergedParents: plan.parents.map((s) => s.id),
      sourceIds: [...plan.entry.sourceIds],
      responseBlocks: plan.droppedResponseBlocks,
    };
  }
  const index = state.rows.findIndex((row) => row.id === target.messageId);
  if (index < 0) return null;
  const row = state.rows[index]!;
  return {
    kind: 'message',
    messageId: row.id,
    sequence: row.sequence,
    participant: row.participant,
    sha256: messageContentSha256(row.content),
    bodyGroupIds: bodyOf(state.rows, index).map((r) => r.id).filter((id) => id !== row.id),
    coveringSummaries: covering(state.memory, new Set([row.id])),
  };
}

function bodyOf(rows: readonly StoredMessage[], index: number): StoredMessage[] {
  if (!rows[index]?.bodyGroupId) return [rows[index]!];
  const { from, to } = bodyBoundsIn(rows, index);
  return rows.slice(from, to + 1);
}

function covering(memory: HistoryMemory | null, rows: ReadonlySet<MessageId>): string[] {
  if (!memory || rows.size === 0) return [];
  return [...withSummariesAbove(memory.summaries, summariesFoldingRows(memory.summaries, memory.chunkRecords, rows))];
}


const OP_FIELDS: Record<HistoryMutationOp['kind'], readonly string[]> = {
  edit_summary: ['kind', 'summaryId', 'expectedSha256', 'newText', 'expectedAfterSha256', 'dropResponseContent', 'parentPolicy'],
  edit_message: ['kind', 'messageId', 'expectedSha256', 'content', 'label', 'expectedAfterSha256', 'foldedPolicy'],
  remove_messages: ['kind', 'messageIds', 'expectedSha256ById', 'expandBodyGroups', 'foldedPolicy'],
};

function describeGiven(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function malformedOps(manifest: unknown): Array<{ opIndex: number; message: string }> {
  if (typeof manifest !== 'object' || manifest === null) return [{ opIndex: -1, message: `the manifest is ${describeGiven(manifest)}, not an object` }];
  const extra = Object.keys(manifest).filter((key) => key !== 'ops');
  const ops = (manifest as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return [{ opIndex: -1, message: `the manifest's \`ops\` is ${describeGiven(ops)}, not an array` }];
  const out: Array<{ opIndex: number; message: string }> = extra.map((key) => ({ opIndex: -1, message: `the manifest has a field \`${key}\` that no manifest has` }));
  const isString = (value: unknown): value is string => typeof value === 'string';
  const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const op: unknown = ops[opIndex];
    if (typeof op !== 'object' || op === null || Array.isArray(op)) {
      out.push({ opIndex, message: `op ${opIndex} is ${describeGiven(op)}, not an object` });
      continue;
    }
    try {
      JSON.stringify(op);
    } catch (error) {
      out.push({ opIndex, message: `op ${opIndex} isn't plain data (${error instanceof Error ? error.message : String(error)})` });
      continue;
    }
    const fields = op as Record<string, unknown>;
    const want = (field: string, ok: (value: unknown) => boolean, what: string, optional = false) => {
      if ((optional && fields[field] === undefined) || ok(fields[field])) return;
      out.push({ opIndex, message: `op ${opIndex}'s \`${field}\` is ${describeGiven(fields[field])}, not ${what}` });
    };
    const kind = fields.kind;
    if (isString(kind) && Object.hasOwn(OP_FIELDS, kind)) {
      for (const field of Object.keys(fields)) {
        if (!OP_FIELDS[kind as HistoryMutationOp['kind']].includes(field)) out.push({ opIndex, message: `op ${opIndex} (${kind}) has a field \`${field}\` that ${kind} doesn't take` });
      }
    }
    const oneOf = (values: readonly string[]) => (value: unknown) => isString(value) && values.includes(value);
    switch (fields.kind) {
      case 'edit_summary':
        want('summaryId', isString, 'a string');
        want('expectedSha256', isString, 'a string');
        want('newText', isString, 'a string');
        want('expectedAfterSha256', isString, 'a string', true);
        want('dropResponseContent', isBoolean, 'a boolean', true);
        want('parentPolicy', oneOf(PARENT_POLICIES), `one of ${PARENT_POLICIES.join(', ')}`, true);
        break;
      case 'edit_message':
        want('messageId', isString, 'a string');
        want('expectedSha256', isString, 'a string');
        want('content', (value) => Array.isArray(value) && value.every((block) => typeof block === 'object' && block !== null && !Array.isArray(block) && isString((block as { type?: unknown }).type)), 'an array of content blocks, each an object with a string `type`');
        want('label', isString, 'a string');
        want('expectedAfterSha256', isString, 'a string', true);
        want('foldedPolicy', oneOf(FOLDED_EDIT_POLICIES), `one of ${FOLDED_EDIT_POLICIES.join(', ')}`, true);
        break;
      case 'remove_messages':
        want('messageIds', (value) => Array.isArray(value) && value.length > 0 && value.every(isString), 'a non-empty array of strings');
        want('expectedSha256ById', (value) => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isString), 'an object of strings');
        want('expandBodyGroups', isBoolean, 'a boolean', true);
        want('foldedPolicy', oneOf(FOLDED_REMOVE_POLICIES), `one of ${FOLDED_REMOVE_POLICIES.join(', ')}`, true);
        break;
      default:
        out.push({ opIndex, message: `op ${opIndex} has kind ${describeGiven(fields.kind)}, which is none of edit_summary, edit_message and remove_messages` });
    }
  }
  return out;
}

export function planMutation(
  state: HistoryState,
  manifest: HistoryMutationManifest,
  readers: ReadonlyArray<{ namespace: string; state: HistoryState }> = [],
): HistoryMutationPlan {
  const violations: MutationViolation[] = [];
  const refuse = (opIndex: number, code: MutationViolationCode, message: string, targetId?: string, remediation?: Record<string, unknown>) => {
    violations.push({ opIndex, code, message, ...(targetId !== undefined ? { targetId } : {}), ...(remediation ? { remediation } : {}) });
  };
  const malformed = malformedOps(manifest);
  for (const { opIndex, message } of malformed) refuse(opIndex, 'MALFORMED_OP', message);
  const ops: HistoryMutationOp[] = malformed.length > 0 ? [] : JSON.parse(JSON.stringify(manifest.ops));
  if (malformed.length === 0 && ops.length === 0) refuse(-1, 'EMPTY_MANIFEST', 'the manifest has no ops');
  const stale = (memory: HistoryMemory | null) => memory?.stored !== undefined && memory.stored !== memory.summaries && canonicalJson(memory.stored.map(asStored)) !== canonicalJson(memory.summaries.map(asStored));
  const restart = 're-initialize that manager (setStrategy(getStrategy())) and plan again';
  const hidden = (name: string) => `the ${name} strategy has no historyMemory(), so the plan can't see what summaries it keeps over the rows the change reaches; a strategy that keeps none joins with a historyMemory() of empty lists`;
  if (state.hiddenStrategy !== undefined) refuse(-1, 'STRATEGY_UNSUPPORTED', hidden(state.hiddenStrategy));
  for (const { namespace, state: reader } of readers) {
    if (reader.hiddenStrategy !== undefined) refuse(-1, 'STRATEGY_UNSUPPORTED', `reader ${namespace}: ${hidden(reader.hiddenStrategy)}`, undefined, { readerNamespace: namespace });
  }
  if (stale(state.memory)) refuse(-1, 'STALE_MEMORY', `the strategy's summaries in memory aren't the ones the store holds, which another handle wrote since: ${restart}`);
  for (const { namespace, state: reader } of readers) {
    if (stale(reader.memory)) refuse(-1, 'STALE_MEMORY', `reader ${namespace}: its strategy's summaries in memory aren't the ones the store holds, which another handle wrote since: ${restart}`, undefined, { readerNamespace: namespace });
  }

  const position = new Map(state.rows.map((row, i) => [row.id, i] as const));
  const targets: PlannedTarget[] = [];
  const seenSummaries = new Set<string>();
  const seenMessages = new Map<MessageId, number>();
  const claim = (opIndex: number, id: MessageId): boolean => {
    const earlier = seenMessages.get(id);
    if (earlier !== undefined) {
      refuse(opIndex, 'DUPLICATE_TARGET', `message ${id} is a target of op ${earlier} too: compose one change per message`, id);
      return false;
    }
    seenMessages.set(id, opIndex);
    return true;
  };
  const seedsByOp = new Map<number, Set<string>>();
  const dropSeed = (opIndex: number, id: string) => {
    const seeds = seedsByOp.get(opIndex) ?? new Set<string>();
    seeds.add(id);
    seedsByOp.set(opIndex, seeds);
  };
  const removedRows = new Set<MessageId>();
  const editedContent = new Map<MessageId, ContentBlock[]>();
  const touchedBy = new Map<MessageId, number>();
  let rowsNow: StoredMessage[] = [...state.rows];
  const guardSplits: Array<{ opIndex: number; messageId: MessageId; reason: string }> = [];

  ops.forEach((op, opIndex) => {
    switch (op.kind) {
      case 'edit_summary': {
        if (seenSummaries.has(op.summaryId)) {
          refuse(opIndex, 'DUPLICATE_TARGET', `summary ${op.summaryId} is a target of an earlier op too`, op.summaryId);
          return;
        }
        seenSummaries.add(op.summaryId);
        if (!state.memory) {
          if (state.hiddenStrategy === undefined) refuse(opIndex, 'STRATEGY_UNSUPPORTED', 'the strategy keeps no summaries', op.summaryId);
          return;
        }
        const plan = planSummaryEdit(state.memory.summaries, op.summaryId, op.newText, {
          expectedPriorSha256: op.expectedSha256,
          ...(op.dropResponseContent !== undefined ? { dropResponseContent: op.dropResponseContent } : {}),
        });
        if (!plan) {
          refuse(opIndex, 'TARGET_NOT_FOUND', `no summary ${op.summaryId} on ${state.branch}`, op.summaryId);
          return;
        }
        for (const refusal of plan.refusals) {
          switch (refusal.code) {
            case 'CARRIED_SUMMARY_TARGET':
              refuse(opIndex, refusal.code, `summary ${op.summaryId} carries ${refusal.authoritativeSummaryId} up a level, whose text a compile reads in its place`, op.summaryId, { authoritativeSummaryId: refusal.authoritativeSummaryId });
              break;
            case 'CAS_MISMATCH':
              refuse(opIndex, refusal.code, `summary ${op.summaryId}'s text has sha256 ${refusal.actualSha256}, not ${refusal.expectedSha256}`, op.summaryId, { actualSha256: refusal.actualSha256 });
              break;
            case 'RESPONSE_CONTENT_SHADOW':
              refuse(opIndex, refusal.code, `summary ${op.summaryId} renders ${refusal.responseBlocks} verbatim response block(s) in place of its text: set dropResponseContent`, op.summaryId, { responseBlocks: refusal.responseBlocks });
              break;
            case 'EMPTY_CONTENT':
              refuse(opIndex, refusal.code, 'the new text is empty', op.summaryId);
              break;
            default: {
              const _exhaustive: never = refusal;
              void _exhaustive;
            }
          }
        }
        const afterSha256 = textSha256(op.newText);
        if (op.expectedAfterSha256 !== undefined && op.expectedAfterSha256 !== afterSha256) {
          refuse(opIndex, 'AFTER_SHA_MISMATCH', `the new text has sha256 ${afterSha256}, not ${op.expectedAfterSha256}`, op.summaryId, { afterSha256 });
        }
        const mergedParents = plan.parents.map((p) => p.id);
        const parentPolicy = op.parentPolicy ?? 'refuse';
        if (mergedParents.length > 0 && parentPolicy === 'refuse') {
          refuse(opIndex, 'MERGED_PARENT_REQUIRES_POLICY', `summaries merged over ${op.summaryId}'s old text: [${mergedParents.join(', ')}]; choose parentPolicy 'leave_parents' or 'drop_parents'`, op.summaryId, { mergedParents });
        }
        if (parentPolicy === 'drop_parents' && mergedParents.length > 0) dropSeed(opIndex, mergedParents[0]!);
        targets.push({
          kind: 'edit_summary', opIndex, summaryId: op.summaryId, level: plan.entry.level,
          beforeSha256: plan.prior.sha256, afterSha256, newText: op.newText, tokens: plan.tokens,
          droppedResponseBlocks: op.dropResponseContent === true ? plan.droppedResponseBlocks : 0,
          dropResponseContent: op.dropResponseContent === true,
          carriedBy: plan.carriedBy.map((p) => p.id), mergedParents, parentPolicy, sourceIds: [...plan.entry.sourceIds],
        });
        return;
      }

      case 'edit_message': {
        if (!claim(opIndex, op.messageId)) return;
        if (op.label.trim().length === 0) refuse(opIndex, 'MISSING_ATTRIBUTION_LABEL', 'an edit of a message names who made it: give a label', op.messageId);
        const index = position.get(op.messageId);
        if (index === undefined) {
          refuse(opIndex, 'TARGET_NOT_FOUND', `no message ${op.messageId} on ${state.branch}`, op.messageId);
          return;
        }
        const row = state.rows[index]!;
        if (row.bodyGroupId) {
          refuse(opIndex, 'SHARDED_MESSAGE_EDIT', `message ${op.messageId} is a shard of body ${row.bodyGroupId}: remove the whole body instead`, op.messageId, { bodyGroupIds: bodyOf(state.rows, index).map((r) => r.id) });
        }
        const beforeSha256 = messageContentSha256(row.content);
        if (beforeSha256 !== op.expectedSha256) {
          refuse(opIndex, 'CAS_MISMATCH', `message ${op.messageId}'s content has sha256 ${beforeSha256}, not ${op.expectedSha256}`, op.messageId, { actualSha256: beforeSha256 });
        }
        let content: ContentBlock[];
        try {
          const given = contentForWrite(op.content, `Edit of ${op.messageId} refused`);
          const labelled: ContentBlock[] = op.label.trim().length === 0 || given.some((block) => block.type === 'text' && block.text.includes(op.label))
            ? given
            : [{ type: 'text', text: op.label }, ...given];
          content = releaseReplacedRawForms(row.content, contentForWrite(labelled, `Edit of ${op.messageId} refused, with its label first`).map(blockAsStored));
        } catch (error) {
          if (!(error instanceof MalformedContentError)) throw error;
          refuse(opIndex, 'MALFORMED_CONTENT', error.message, op.messageId, { places: [...error.places] });
          return;
        }
        if (content.some(isThinkingBlock) && canonicalJson(content) !== canonicalJson(row.content)) {
          refuse(opIndex, 'STALE_THINKING_IN_EDITED_MESSAGE', `the new content of ${op.messageId} keeps thinking blocks and changes the message: a provider verifies their signatures over the turn they were made in; leave them out`, op.messageId);
        }
        const afterSha256 = storedSha256(content);
        if (op.expectedAfterSha256 !== undefined && op.expectedAfterSha256 !== afterSha256) {
          refuse(opIndex, 'AFTER_SHA_MISMATCH', `the content as written has sha256 ${afterSha256}, not ${op.expectedAfterSha256}`, op.messageId, { afterSha256 });
        }
        const foldedPolicy = op.foldedPolicy ?? 'refuse';
        const coveringSummaries = covering(state.memory, new Set([op.messageId]));
        if (coveringSummaries.length > 0 && foldedPolicy === 'refuse') {
          refuse(opIndex, 'FOLDED_ROW_REQUIRES_POLICY', `summaries fold message ${op.messageId}: [${coveringSummaries.join(', ')}]; choose foldedPolicy 'drop_covering_summaries' or 'leave_summaries'`, op.messageId, { coveringSummaries });
        }
        if (foldedPolicy === 'drop_covering_summaries') for (const id of coveringSummaries) dropSeed(opIndex, id);
        const now = rowsNow.findIndex((r) => r.id === op.messageId);
        if (now >= 0) {
          const reason = toolPairSplitReason((i) => rowsNow[i] ?? null, rowsNow.length, content, now);
          if (reason !== null) guardSplits.push({ opIndex, messageId: op.messageId, reason });
          rowsNow[now] = { ...rowsNow[now]!, content };
        }
        editedContent.set(op.messageId, content);
        touchedBy.set(op.messageId, opIndex);
        targets.push({ kind: 'edit_message', opIndex, messageId: op.messageId, beforeSha256, afterSha256, content, label: op.label, foldedPolicy, coveringSummaries });
        return;
      }

      case 'remove_messages': {
        if (op.messageIds.length === 0) {
          refuse(opIndex, 'EMPTY_MANIFEST', 'the removal lists no messages');
          return;
        }
        const taking = new Set<MessageId>();
        const expandedIds: MessageId[] = [];
        const beforeSha256ById: Record<MessageId, string> = {};
        for (const id of op.messageIds) {
          if (!claim(opIndex, id)) continue;
          const index = position.get(id);
          if (index === undefined) {
            refuse(opIndex, 'TARGET_NOT_FOUND', `no message ${id} on ${state.branch}`, id);
            continue;
          }
          const row = state.rows[index]!;
          const sha256 = messageContentSha256(row.content);
          beforeSha256ById[id] = sha256;
          if (op.expectedSha256ById[id] !== sha256) {
            refuse(opIndex, 'CAS_MISMATCH', `message ${id}'s content has sha256 ${sha256}, not ${op.expectedSha256ById[id] ?? 'none given'}`, id, { actualSha256: sha256 });
          }
          taking.add(id);
          const body = bodyOf(state.rows, index);
          const rest = body.filter((r) => !op.messageIds.includes(r.id));
          if (rest.length === 0) continue;
          if (op.expandBodyGroups === true) {
            for (const r of rest) {
              if (taking.has(r.id)) continue;
              if (!claim(opIndex, r.id)) continue;
              taking.add(r.id);
              expandedIds.push(r.id);
              beforeSha256ById[r.id] = messageContentSha256(r.content);
            }
          } else {
            refuse(opIndex, 'PARTIAL_BODY_GROUP_REMOVAL', `message ${id} is a shard of body ${row.bodyGroupId}, whose other shards aren't listed: list them, or set expandBodyGroups`, id, { bodyGroupIds: body.map((r) => r.id) });
          }
        }
        const messageIds = [...taking].sort((a, b) => position.get(a)! - position.get(b)!);
        const foldedPolicy = op.foldedPolicy ?? (state.windowMode === 'presented' ? 'drop_covering_summaries' : 'refuse');
        const coveringSummaries = covering(state.memory, taking);
        if (coveringSummaries.length > 0 && foldedPolicy === 'refuse') {
          refuse(opIndex, 'FOLDED_ROW_REQUIRES_POLICY', `summaries fold the messages removed: [${coveringSummaries.join(', ')}]; choose foldedPolicy 'drop_covering_summaries'`, messageIds[0], { coveringSummaries });
        }
        if (foldedPolicy === 'drop_covering_summaries') for (const id of coveringSummaries) dropSeed(opIndex, id);
        rowsNow = rowsNow.filter((r) => !taking.has(r.id));
        for (const id of messageIds) {
          removedRows.add(id);
          touchedBy.set(id, opIndex);
        }
        targets.push({ kind: 'remove_messages', opIndex, messageIds, expandedIds, beforeSha256ById, foldedPolicy, coveringSummaries });
        return;
      }
      default: {
        const _exhaustive: never = op;
        void _exhaustive;
      }
    }
  });

  if (state.rows.length > 0 && state.rows.every((row) => removedRows.has(row.id))) refuse(-1, 'EMPTY_STORE', 'the mutation would remove every message');
  const splitOps = new Set<number>();
  const splitsSeen = new Set<string>();
  const applied = (rows: readonly StoredMessage[]) => rows.flatMap((row) => {
    if (removedRows.has(row.id)) return [];
    const content = editedContent.get(row.id);
    return [content ? { ...row, content } : row];
  });
  const changeable = (id: MessageId) => position.has(id);
  for (const split of [...introducedToolSplits(state.record, applied(state.record), changeable), ...introducedToolSplits(state.view, applied(state.view), changeable)]) {
    const key = `${split.messageId}\u0000${split.message}`;
    if (splitsSeen.has(key)) continue;
    splitsSeen.add(key);
    const opIndex = touchedBy.get(split.messageId) ?? touchedBy.get(split.partnerId ?? '') ?? -1;
    splitOps.add(opIndex);
    refuse(opIndex, 'TOOL_PAIR_SPLIT', split.message, split.messageId, split.remediation);
  }
  for (const split of guardSplits) {
    if (!splitOps.has(split.opIndex)) refuse(split.opIndex, 'TOOL_PAIR_SPLIT', `the store refuses the edit of message ${split.messageId}: ${split.reason}`, split.messageId);
  }

  const messageTargets = targets.filter((target) => target.kind !== 'edit_summary');
  const readerPlans = readers.map(({ namespace, state: reader }): PlannedReader => {
    const inWindow = new Set(reader.window.map((row) => row.id));
    const heldIds: MessageId[] = [];
    const byOp: PlannedReader['covering'] = [];
    const seeds = new Set<string>();
    for (const target of messageTargets) {
      const ids = target.kind === 'edit_message' ? [target.messageId] : target.messageIds;
      for (const id of ids) if (inWindow.has(id) || covering(reader.memory, new Set([id])).length > 0) heldIds.push(id);
      const coveringSummaries = covering(reader.memory, new Set(ids));
      if (coveringSummaries.length === 0) continue;
      const op = ops[target.opIndex]!;
      const foldedPolicy = target.kind === 'edit_message'
        ? target.foldedPolicy
        : (op.kind === 'remove_messages' ? op.foldedPolicy : undefined) ?? (reader.windowMode === 'presented' ? 'drop_covering_summaries' : 'refuse');
      byOp.push({ opIndex: target.opIndex, foldedPolicy, coveringSummaries });
      if (foldedPolicy === 'refuse') {
        refuse(target.opIndex, 'FOLDED_ROW_REQUIRES_POLICY',
          `the summaries of reader ${namespace} fold ${target.kind === 'edit_message' ? `message ${target.messageId}` : 'the messages removed'}: [${coveringSummaries.join(', ')}]; choose foldedPolicy 'drop_covering_summaries'${target.kind === 'edit_message' ? " or 'leave_summaries'" : ''}`,
          ids[0], { readerNamespace: namespace, coveringSummaries });
      } else if (foldedPolicy === 'drop_covering_summaries') {
        for (const id of coveringSummaries) seeds.add(id);
      }
    }
    for (const split of [...introducedToolSplits(reader.record, applied(reader.record), changeable), ...introducedToolSplits(reader.view, applied(reader.view), changeable)]) {
      const key = `${split.messageId}\u0000${split.message}`;
      if (splitsSeen.has(key)) continue;
      splitsSeen.add(key);
      refuse(touchedBy.get(split.messageId) ?? touchedBy.get(split.partnerId ?? '') ?? -1, 'TOOL_PAIR_SPLIT', `reader ${namespace}: ${split.message}`, split.messageId, { ...split.remediation, readerNamespace: namespace });
    }
    const droppedSummaries = [...withSummariesAbove(reader.memory?.summaries ?? [], seeds)];
    return { namespace, heldIds, covering: byOp, droppedSummaries, ...windowEffects(reader, messageTargets, droppedSummaries) };
  });

  const summaries = state.memory?.summaries ?? [];
  const dropped = withSummariesAbove(summaries, new Set([...seedsByOp.values()].flatMap((seeds) => [...seeds])));
  for (const target of targets) {
    if (target.kind !== 'edit_summary' || !dropped.has(target.summaryId)) continue;
    const droppingOps = [...seedsByOp].filter(([, seeds]) => withSummariesAbove(summaries, seeds).has(target.summaryId)).map(([opIndex]) => opIndex);
    refuse(target.opIndex, 'EDITED_SUMMARY_DROPPED', `summary ${target.summaryId} is edited here, and the policy of op ${droppingOps.join(', ')} drops it: edit it or drop it`, target.summaryId, { droppingOps });
  }
  const droppedSummaries = [...dropped];
  const effects = windowEffects(state, targets, droppedSummaries);
  const entries = (memory: HistoryMemory | null, ids: readonly string[]) => {
    const byId = new Map<string, unknown>();
    for (const entry of memory?.summaries ?? []) {
      if (typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string') byId.set(entry.id, entry);
    }
    return [...ids].sort().map((id) => asStored(byId.get(id) ?? { id }));
  };
  const planSha256 = createHash('sha256')
    .update(canonicalJson({
      valid: violations.length === 0,
      violations,
      sourceBranch: state.branch,
      targets,
      droppedSummaries: entries(state.memory, droppedSummaries),
      ...effects,
      readers: readerPlans.map((r, i) => ({ ...r, droppedSummaries: entries(readers[i]!.state.memory, r.droppedSummaries) })),
    }), 'utf8')
    .digest('hex');
  return {
    valid: violations.length === 0,
    violations,
    sourceBranch: state.branch,
    planSha256,
    targets,
    droppedSummaries,
    ...effects,
    readers: readerPlans,
  };
}

function windowEffects(
  state: HistoryState,
  targets: readonly PlannedTarget[],
  droppedSummaries: readonly string[],
): Pick<HistoryMutationPlan, 'invalidatesThinkingBinding' | 'invalidatesKvPrefixFrom'> {
  const rows = state.record;
  const sequences = new Map(rows.map((row) => [row.id, row.sequence] as const));
  const viewPosition = new Map(state.view.map((row, i) => [row.id, i] as const));
  const windowAt = new Map(state.window.map((row, i) => [row.id, i] as const));
  const before = new Map(rows.map((row) => [row.id, row.content] as const));
  const rendered = targets.filter((target) => target.kind !== 'edit_message' || asStored(before.get(target.messageId) ?? null) !== asStored(target.content));
  const edited = new Map(rendered.flatMap((target) => (target.kind === 'edit_message' ? [[target.messageId, target.content] as const] : [])));
  const positionOf = (id: MessageId): number | undefined => {
    const held = viewPosition.get(id);
    if (held !== undefined) return held;
    const content = edited.get(id);
    const at = windowAt.get(id);
    if (content === undefined || at === undefined || !(state.viewKeeps?.({ ...state.window[at]!, content }) ?? true)) return undefined;
    const next = state.window.slice(at + 1).find((row) => viewPosition.has(row.id));
    return (next ? viewPosition.get(next.id)! : state.view.length) - 1 + (at + 1) / (state.window.length + 1);
  };
  const sent = (id: MessageId): boolean => positionOf(id) !== undefined;
  const changed = changedRows(state.memory?.summaries ?? [], rendered, droppedSummaries, (id) => sequences.has(id), sent);
  const firstInView = state.view.find((row) => sequences.has(row.id))?.id;
  const rowsChanged = changed.fromStart
    ? [...changed.rows, ...rows.slice(0, 1).map((row) => row.id), ...(firstInView !== undefined ? [firstInView] : [])]
    : changed.rows;
  let kvFrom: MessageId | undefined;
  let earliest: Sequence | undefined;
  for (const id of rowsChanged) {
    const sequence = sequences.get(id);
    if (sequence !== undefined && (earliest === undefined || sequence < earliest)) earliest = sequence;
    const at = positionOf(id);
    if (at !== undefined && sequence !== undefined && (kvFrom === undefined || at < positionOf(kvFrom)!)) kvFrom = id;
  }
  return {
    invalidatesThinkingBinding: earliest !== undefined && state.thinkingBoundThrough !== undefined && earliest <= state.thinkingBoundThrough,
    ...(kvFrom !== undefined ? { invalidatesKvPrefixFrom: { messageId: kvFrom, sequence: sequences.get(kvFrom)! } } : {}),
  };
}

function changedRows(
  summaries: readonly SummaryEntry[],
  targets: readonly PlannedTarget[],
  droppedSummaries: readonly string[],
  held: (id: MessageId) => boolean,
  sent: (id: MessageId) => boolean,
): { rows: MessageId[]; fromStart: boolean } {
  const byId = new Map(summaries.map((s) => [s.id, s] as const));
  const rows: MessageId[] = [];
  let fromStart = false;
  const leavesOf = (id: string) => {
    const leaves: MessageId[] = [];
    const seen = new Set<string>();
    for (const stack = [id]; stack.length > 0;) {
      const summary = byId.get(stack.pop()!);
      if (!summary || seen.has(summary.id)) continue;
      seen.add(summary.id);
      if (summary.level === 1) leaves.push(...summary.sourceIds.filter(held));
      else stack.push(...summary.sourceIds);
    }
    if (leaves.length === 0) fromStart = true;
    rows.push(...leaves);
  };
  for (const target of targets) {
    if (target.kind === 'edit_message') rows.push(...[target.messageId].filter(sent));
    else if (target.kind === 'remove_messages') rows.push(...target.messageIds.filter(sent));
    else leavesOf(target.summaryId);
  }
  for (const id of droppedSummaries) leavesOf(id);
  return { rows, fromStart };
}

interface ToolSplit {
  messageId: MessageId;
  partnerId?: MessageId;
  message: string;
  remediation: Record<string, unknown>;
}

function introducedToolSplits(before: readonly StoredMessage[], after: readonly StoredMessage[], changeable: (id: MessageId) => boolean): ToolSplit[] {
  const splits: ToolSplit[] = [];
  const unpairedKeys = (rows: readonly StoredMessage[]) => {
    const counts = new Map<string, { count: number; messageId: MessageId; kind: string; toolId: string }>();
    for (const u of findUnpairedToolBlocks(rows)) {
      const messageId = rows[u.message]!.id;
      const key = `${messageId}\u0000${u.kind}\u0000${u.toolId}`;
      const seen = counts.get(key);
      if (seen) seen.count++;
      else counts.set(key, { count: 1, messageId, kind: u.kind, toolId: u.toolId });
    }
    return counts;
  };
  const was = unpairedKeys(before);
  const partners = pairedMessages(before);
  for (const [key, now] of unpairedKeys(after)) {
    if (now.count <= (was.get(key)?.count ?? 0)) continue;
    const partnerId = partners.get(`${now.messageId}\u0000${now.kind}\u0000${now.toolId}`);
    splits.push({
      messageId: now.messageId,
      ...(partnerId !== undefined ? { partnerId } : {}),
      message: `the ${now.kind} ${now.toolId} in message ${now.messageId} would be left with no ${now.kind === 'tool_use' ? 'result' : 'call'}` +
        (partnerId === undefined ? ''
          : changeable(partnerId) && changeable(now.messageId) ? ` (its partner was in message ${partnerId}): change both together`
            : ` (its partner was in message ${partnerId}; message ${changeable(partnerId) ? now.messageId : partnerId} is in a slot this manager merges, which its mutation can't change): leave the pair as it is`),
      remediation: { toolId: now.toolId, orphanedMessageId: now.messageId, ...(partnerId !== undefined ? { partnerMessageId: partnerId } : {}) },
    });
  }
  const changeBetween = (rows: readonly StoredMessage[]) => {
    const found = new Map<string, MessageId>();
    for (const pair of pairs(rows)) {
      for (let i = pair.call + 1; i < pair.result; i++) {
        if (rows[i]!.content.some((block) => (block.type as string) === 'system_change')) {
          found.set(`${rows[pair.call]!.id}\u0000${pair.toolId}`, rows[i]!.id);
          break;
        }
      }
    }
    return found;
  };
  const wasBetween = changeBetween(before);
  for (const [key, changeId] of changeBetween(after)) {
    if (wasBetween.has(key)) continue;
    const [callId, toolId] = key.split('\u0000') as [MessageId, string];
    splits.push({
      messageId: callId,
      message: `a system change (message ${changeId}) would stand between the tool call ${toolId} in message ${callId} and its result`,
      remediation: { toolId, callMessageId: callId, systemChangeMessageId: changeId },
    });
  }
  return splits;
}

function pairs(rows: readonly StoredMessage[]): Array<{ call: number; result: number; toolId: string }> {
  const at: number[] = [];
  const blocks: ContentBlock[] = [];
  rows.forEach((row, m) => row.content.forEach((block) => { at.push(m); blocks.push(block); }));
  const out: Array<{ call: number; result: number; toolId: string }> = [];
  const latest = new Map<string, number>();
  blocks.forEach((block, i) => {
    if (block.type === 'tool_use') latest.set(block.id, i);
    else if (block.type === 'tool_result') {
      const call = latest.get(block.toolUseId);
      if (call !== undefined) out.push({ call: at[call]!, result: at[i]!, toolId: block.toolUseId });
    }
  });
  return out;
}

function pairedMessages(rows: readonly StoredMessage[]): Map<string, MessageId> {
  const out = new Map<string, MessageId>();
  for (const pair of pairs(rows)) {
    out.set(`${rows[pair.call]!.id}\u0000tool_use\u0000${pair.toolId}`, rows[pair.result]!.id);
    out.set(`${rows[pair.result]!.id}\u0000tool_result\u0000${pair.toolId}`, rows[pair.call]!.id);
  }
  return out;
}

export type HistoryInvariantCode = 'MALFORMED_CONTENT' | 'EMPTY_CONTENT' | 'INCOMPLETE_BODY' | 'TOOL_PAIR_SPLIT' | 'TOPOLOGY_CROSSED';

/** One way a stored history breaks a rule the strategy and the provider rely on. */
export interface HistoryAnomaly {
  code: HistoryInvariantCode;
  /** A message id (for a tool pair, the call's message where there is a call), or a summary id for TOPOLOGY_CROSSED. */
  targetId: string;
  message: string;
}

export function historyAnomalies(state: HistoryState): HistoryAnomaly[] {
  const out: HistoryAnomaly[] = [];
  const seen = new Set<string>();
  const add = (anomaly: HistoryAnomaly) => {
    const key = anomalyKey(anomaly);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(anomaly);
  };
  state.rows.forEach((row, index) => {
    const places = malformedContentPlaces(row.content);
    if (places.length > 0) add({ code: 'MALFORMED_CONTENT', targetId: row.id, message: `message ${row.id}: ${places.join('; ')}` });
    else if (row.content.length === 0) add({ code: 'EMPTY_CONTENT', targetId: row.id, message: `message ${row.id} has no content blocks` });
    if (row.bodyGroupId && row.shardCount !== undefined && (index === 0 || state.rows[index - 1]!.bodyGroupId !== row.bodyGroupId)) {
      const body = bodyOf(state.rows, index);
      if (body.length !== row.shardCount) {
        add({ code: 'INCOMPLETE_BODY', targetId: row.id, message: `body ${row.bodyGroupId} holds ${body.length} of its ${row.shardCount} shards` });
      }
    }
  });
  for (const rows of [state.record, state.view]) {
    for (const u of findUnpairedToolBlocks(rows)) {
      const id = rows[u.message]!.id;
      add({ code: 'TOOL_PAIR_SPLIT', targetId: id, message: `the ${u.kind} ${u.toolId} in message ${id} has no ${u.kind === 'tool_use' ? 'result' : 'call'}` });
    }
    for (const pair of pairs(rows)) {
      for (let i = pair.call + 1; i < pair.result; i++) {
        if (rows[i]!.content.some((block) => (block.type as string) === 'system_change')) {
          const callId = rows[pair.call]!.id;
          add({ code: 'TOOL_PAIR_SPLIT', targetId: callId, message: `a system change (message ${rows[i]!.id}) stands between the tool call ${pair.toolId} in message ${callId} and its result` });
          break;
        }
      }
    }
  }
  if (state.memory) {
    const crossed = crossedSummaryIds({
      summaries: state.memory.summaries.map((s) => ({ id: s.id, level: s.level, sourceIds: [...s.sourceIds], sourceRange: s.sourceRange })),
      records: state.memory.chunkRecords.map((r) => ({ ...r, sourceIds: [...r.sourceIds] })),
      messages: state.view.map((row) => ({ id: row.id })),
    });
    for (const id of crossed) {
      add({ code: 'TOPOLOGY_CROSSED', targetId: id, message: `summary ${id}'s messages aren't contiguous: another live summary or raw row stands inside its span` });
    }
  }
  return out;
}

function anomalyKey(anomaly: HistoryAnomaly): string {
  return `${anomaly.code}\u0000${anomaly.targetId}\u0000${anomaly.message}`;
}

export function introducedAnomalies(before: readonly HistoryAnomaly[], after: readonly HistoryAnomaly[]): HistoryAnomaly[] {
  const had = new Set(before.map(anomalyKey));
  return after.filter((anomaly) => !had.has(anomalyKey(anomaly)));
}

/** Why an apply was refused or failed: before it wrote anything, before the store moved to the branch it built, or (APPLIED_INIT_FAILED) after. */
export class HistoryMutationError extends Error {
  readonly violations: readonly MutationViolation[];
  /** The plan an apply made at its own head, where one was made. */
  readonly plan?: HistoryMutationPlan;
  /** What the apply did, where the store had moved to the branch it built (APPLIED_INIT_FAILED): the mutation is applied. */
  readonly receipt?: HistoryMutationReceipt;

  constructor(
    message: string,
    violations: readonly MutationViolation[],
    plan?: HistoryMutationPlan,
    options: { cause?: unknown; receipt?: HistoryMutationReceipt } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HistoryMutationError';
    this.violations = violations;
    if (plan) this.plan = plan;
    if (options.receipt) this.receipt = options.receipt;
  }
}

/** What an apply did: the branch it built and moved the store to, from what, and what it dropped. */
export interface HistoryMutationReceipt {
  sourceBranch: string;
  targetBranch: string;
  /** The source branch's sequence when the apply began. */
  fromSequence: Sequence;
  /** The target branch's sequence when the store moved to it. */
  toSequence: Sequence;
  planSha256: string;
  targets: PlannedTarget[];
  /** The summaries the plan drops, which the target doesn't hold. */
  droppedSummaries: string[];
}

export interface HistorySnapshot {
  record: Array<{ id: MessageId; sha256: string; fields: Omit<StoredMessage, 'content'> }>;
  summaries: SummaryEntry[];
  window?: ReadonlyArray<{ id: MessageId; ordinal: number | undefined }>;
}

const asStored = (value: unknown): string => canonicalJson(JSON.parse(storedJson(value ?? null).toString('utf8')));

const storedSha256 = (content: readonly ContentBlock[]): string => createHash('sha256').update(asStored(content), 'utf8').digest('hex');

export function snapshotOf(state: HistoryState): HistorySnapshot {
  return {
    record: state.record.map(({ content, ...fields }) => ({ id: fields.id, sha256: storedSha256(content), fields: { ...fields, ...(fields.metadata ? { metadata: { ...fields.metadata } } : {}) } })),
    summaries: (state.memory?.summaries ?? []).map((summary) => structuredClone(summary)),
    ...(state.windowOrdinals ? { window: state.windowOrdinals.map((at) => ({ ...at })) } : {}),
  };
}

function windowMismatches(plan: HistoryMutationPlan, source: HistorySnapshot, written: HistoryState): string[] {
  if (!source.window) return [];
  if (!written.windowOrdinals) return ['its window is no longer presented'];
  const removed = new Set(plan.targets.flatMap((target) => (target.kind === 'remove_messages' ? target.messageIds : [])));
  const want = source.window.filter((at) => !removed.has(at.id));
  const got = new Map(written.windowOrdinals.map((at) => [at.id, at.ordinal] as const));
  const out: string[] = [];
  for (const { id, ordinal } of want) {
    if (!got.has(id)) out.push(`message ${id} left its window`);
    else if (got.get(id) !== ordinal) out.push(`message ${id} moved in its window from ordinal ${ordinal} to ${got.get(id)}`);
  }
  const kept = new Set(want.map((at) => at.id));
  for (const { id } of written.windowOrdinals) if (!kept.has(id)) out.push(`message ${id} is in its window, and the source's window didn't hold it`);
  return out;
}

function differing(got: object, want: object, omit: readonly string[] = []): string[] {
  const fields = (value: object) => new Map<string, unknown>(Object.entries(value).filter(([key, v]) => v !== undefined && !omit.includes(key)));
  const a = fields(got);
  const b = fields(want);
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => asStored(a.get(key)) !== asStored(b.get(key))).sort();
}

function recordMismatches(plan: HistoryMutationPlan, source: HistorySnapshot, written: readonly StoredMessage[], stamp: Omit<MessageEditStamp, 'label'>): string[] {
  const out: string[] = [];
  const edits = new Map<MessageId, Extract<PlannedTarget, { kind: 'edit_message' }>>();
  const removed = new Set<MessageId>();
  for (const target of plan.targets) {
    if (target.kind === 'edit_message') edits.set(target.messageId, target);
    else if (target.kind === 'remove_messages') for (const id of target.messageIds) removed.add(id);
  }
  const expected = source.record.filter((row) => !removed.has(row.id));
  for (const [i, row] of expected.entries()) {
    const got = written[i];
    if (got?.id !== row.id) {
      out.push(got ? `message ${got.id} stands where ${row.id} should` : `message ${row.id} is missing`);
      break;
    }
    const edit = edits.get(row.id);
    const want = edit ? storedSha256(edit.content) : row.sha256;
    const { content, ...fields } = got;
    const sha256 = storedSha256(content);
    if (sha256 !== want) out.push(`message ${row.id}'s content has sha256 ${sha256}, not ${want}`);
    const wantFields = edit ? { ...row.fields, metadata: { ...row.fields.metadata, historyMutation: { ...stamp, label: edit.label } } } : row.fields;
    const changed = differing(fields, wantFields);
    if (edit && changed.includes('metadata')) out.push(`message ${row.id} doesn't record the edit as made beside its metadata (metadata.historyMutation)`);
    const other = changed.filter((field) => !edit || field !== 'metadata');
    if (other.length > 0) out.push(`message ${row.id}'s ${other.join(', ')} changed`);
  }
  const sourceIds = new Set(source.record.map((row) => row.id));
  for (const row of written.slice(expected.length)) if (sourceIds.has(row.id)) out.push(`message ${row.id} is still there`);
  return out;
}

const removesRows = (plan: HistoryMutationPlan): boolean => plan.targets.some((target) => target.kind === 'remove_messages');

const POINTERS = ['parentId', 'mergedInto'] as const;
const CARRIED_AS = ['id', 'level', 'sourceLevel', 'sourceIds', 'carriedFrom', ...POINTERS];

function summaryMismatches(
  source: HistorySnapshot,
  droppedSummaries: readonly string[],
  written: HistoryState,
  mayCarry: boolean,
  edits: ReadonlyMap<string, PlannedSummaryEdit> = new Map(),
  by?: Omit<MessageEditStamp, 'label'>,
): string[] {
  const out: string[] = [];
  const branch = new Map((written.memory?.summaries ?? []).map((s) => [s.id, s] as const));
  const before = new Set(source.summaries.map((s) => s.id));
  const dropped = new Set(droppedSummaries);
  const carries = new Map<string, string>();
  for (const [id, summary] of branch) {
    if (before.has(id)) continue;
    const carried = summary.carriedFrom !== undefined ? branch.get(summary.carriedFrom) : undefined;
    const isCarry = mayCarry && carried !== undefined && carriesItsSource(summary) && summary.level === carried.level + 1
      && summary.sourceLevel === carried.level && carried.mergedInto === id && differing(summary, carried, CARRIED_AS).length === 0;
    if (isCarry) carries.set(id, carried.id);
    else out.push(`summary ${id} is there, and the source didn't hold it`);
  }
  const pointersMoved = (got: SummaryEntry, was: SummaryEntry | undefined): string[] => POINTERS.filter((field) => {
    const now = got[field];
    const then = was?.[field];
    return !(now === then || (now === undefined && then !== undefined && dropped.has(then)) || (field === 'mergedInto' && now !== undefined && carries.get(now) === got.id));
  });
  for (const was of source.summaries) {
    const got = branch.get(was.id);
    if (dropped.has(was.id)) {
      if (got) out.push(`summary ${was.id} is still there`);
      continue;
    }
    if (!got) {
      out.push(`summary ${was.id} is gone`);
      continue;
    }
    const edit = edits.get(was.id);
    const changed = [...differing(got, edit ? editedEntry(was, edit) : was, [...POINTERS, ...(edit ? ['external'] : [])]), ...pointersMoved(got, was)];
    if (changed.length > 0) out.push(`summary ${was.id}'s ${changed.join(', ')} ${edit ? 'other than the edit writes' : 'changed'}`);
    if (edit && by) {
      const { at, ...named } = got.external ?? { at: undefined };
      if (typeof at !== 'number' || asStored(named) !== asStored({ by: by.by, note: by.note })) out.push(`summary ${was.id} doesn't record the edit as made (external)`);
    }
  }
  for (const id of carries.keys()) {
    const moved = pointersMoved(branch.get(id)!, undefined);
    if (moved.length > 0) out.push(`summary ${id}'s ${moved.join(', ')} changed`);
  }
  return out;
}

function editedEntry(was: SummaryEntry, edit: PlannedSummaryEdit): SummaryEntry {
  const { responseContent: _responseContent, provenance: _provenance, stitched: _stitched, ...kept } = was;
  return { ...kept, content: edit.newText, tokens: edit.tokens };
}

export function readerReadBackMismatches(
  plan: HistoryMutationPlan,
  reader: PlannedReader,
  source: HistorySnapshot,
  written: HistoryState,
  stamp: Omit<MessageEditStamp, 'label'>,
  stillInWindow: readonly MessageId[],
): string[] {
  return [
    ...stillInWindow.map((id) => `message ${id} is still in its window`),
    ...windowMismatches(plan, source, written),
    ...recordMismatches(plan, source, written.record, stamp),
    ...summaryMismatches(source, reader.droppedSummaries, written, reader.droppedSummaries.length > 0 || removesRows(plan)),
  ].map((mismatch) => `reader ${reader.namespace}: ${mismatch}`);
}

/** What an apply records on each message it edits (`metadata.historyMutation`). */
export interface MessageEditStamp {
  by: string;
  at: number;
  label: string;
  note?: string;
  sourceBranch: string;
}

export function readBackMismatches(
  plan: HistoryMutationPlan,
  source: HistorySnapshot,
  written: HistoryState,
  stamp: Omit<MessageEditStamp, 'label'>,
  stillInWindow: readonly MessageId[] = [],
): string[] {
  const edits = new Map<string, PlannedSummaryEdit>();
  for (const target of plan.targets) if (target.kind === 'edit_summary') for (const id of [target.summaryId, ...target.carriedBy]) edits.set(id, target);
  return [
    ...stillInWindow.map((id) => `message ${id} is still in its window`),
    ...windowMismatches(plan, source, written),
    ...recordMismatches(plan, source, written.record, stamp),
    ...summaryMismatches(source, plan.droppedSummaries, written, plan.droppedSummaries.length > 0 || removesRows(plan), edits, stamp),
  ];
}
