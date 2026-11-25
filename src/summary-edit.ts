import { createHash } from 'node:crypto';
import { carriesItsSource } from './strategies/merge-runs.js';
import type { MessageId } from './types/message.js';
import { getSummaryParentId, type SummaryEntry, type SummaryTextEdit, type SummaryTextEditOptions } from './types/strategy.js';

/** sha256 (hex) of a text as UTF-8: how a summary's text is named in an edit's compare-and-swap. */
export function textSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export type SummaryEditRefusal =
  | { code: 'CARRIED_SUMMARY_TARGET'; authoritativeSummaryId: string }
  | { code: 'CAS_MISMATCH'; expectedSha256: string; actualSha256: string }
  | { code: 'RESPONSE_CONTENT_SHADOW'; responseBlocks: number }
  | { code: 'EMPTY_CONTENT' };

export type SummaryEditPlan = Omit<SummaryTextEdit, 'id' | 'level' | 'applied'> & {
  entry: SummaryEntry;
  refusals: SummaryEditRefusal[];
};

export function planSummaryEdit(
  summaries: readonly SummaryEntry[],
  id: string,
  body: string,
  options: Omit<SummaryTextEditOptions, 'apply'> = {},
): SummaryEditPlan | null {
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const entry = byId.get(id);
  if (!entry) return null;
  const carriedBy: SummaryEditPlan['carriedBy'] = [];
  const parents: SummaryEditPlan['parents'] = [];
  const seen = new Set([entry.id]);
  for (let below = entry, parent = byId.get(getSummaryParentId(entry) ?? ''); parent && !seen.has(parent.id); below = parent, parent = byId.get(getSummaryParentId(parent) ?? '')) {
    seen.add(parent.id);
    const carries = parents.length === 0 && carriesItsSource(parent) && parent.sourceIds[0] === below.id;
    (carries ? carriedBy : parents).push({ id: parent.id, level: parent.level });
  }

  const refusals: SummaryEditRefusal[] = [];
  if (carriesItsSource(entry)) {
    let memory = entry;
    const passed = new Set([entry.id]);
    for (let under: SummaryEntry | undefined; carriesItsSource(memory) && (under = byId.get(memory.sourceIds[0]!)) && !passed.has(under.id); ) {
      passed.add(under.id);
      memory = under;
    }
    if (memory !== entry) refusals.push({ code: 'CARRIED_SUMMARY_TARGET', authoritativeSummaryId: memory.id });
  }
  const sha256 = textSha256(entry.content);
  if (options.expectedPriorSha256 !== undefined && options.expectedPriorSha256 !== sha256) {
    refusals.push({ code: 'CAS_MISMATCH', expectedSha256: options.expectedPriorSha256, actualSha256: sha256 });
  }
  const responseBlocks = entry.responseContent?.length ?? 0;
  if (responseBlocks > 0 && options.dropResponseContent !== true) refusals.push({ code: 'RESPONSE_CONTENT_SHADOW', responseBlocks });
  if (body.trim().length === 0) refusals.push({ code: 'EMPTY_CONTENT' });

  return {
    entry,
    prior: { sha256, length: entry.content.length, tokens: entry.tokens },
    tokens: Math.ceil(body.length / 3),
    droppedResponseBlocks: responseBlocks,
    carriedBy,
    parents,
    refusals,
  };
}

export function describeSummaryEditRefusal(id: string, refusal: SummaryEditRefusal): string {
  switch (refusal.code) {
    case 'CARRIED_SUMMARY_TARGET':
      return `summary ${id} carries ${refusal.authoritativeSummaryId} up a level, and a compile reads that summary's text in its place: edit ${refusal.authoritativeSummaryId}`;
    case 'CAS_MISMATCH':
      return `summary ${id}'s text has sha256 ${refusal.actualSha256}, not the ${refusal.expectedSha256} given: read it again`;
    case 'RESPONSE_CONTENT_SHADOW':
      return `summary ${id} renders ${refusal.responseBlocks} verbatim response block(s) in place of its text; drop them with the new text (dropResponseContent)`;
    case 'EMPTY_CONTENT':
      return 'the memory text is empty';
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

/**
 * The L1s that fold one of `rows`: each L1 listing one among its sources,
 * and the L1 of each chunk record holding one. What a let-go of the rows
 * drops starts from these (withSummariesAbove).
 */
export function summariesFoldingRows(
  summaries: ReadonlyArray<Pick<SummaryEntry, 'id' | 'level' | 'sourceIds'>>,
  records: ReadonlyArray<{ sourceIds: readonly string[]; summaryId?: string }>,
  rows: ReadonlySet<MessageId>,
): Set<string> {
  const seeds = new Set<string>();
  for (const summary of summaries) {
    if (summary.level === 1 && summary.sourceIds.some((id) => rows.has(id))) seeds.add(summary.id);
  }
  for (const record of records) {
    if (record.summaryId && record.sourceIds.some((id) => rows.has(id))) seeds.add(record.summaryId);
  }
  return seeds;
}

/** `seeds`, with every summary above one of them: each summary above L1 with a source among them, again and again. */
export function withSummariesAbove(
  summaries: ReadonlyArray<Pick<SummaryEntry, 'id' | 'level' | 'sourceIds'>>,
  seeds: ReadonlySet<string>,
): Set<string> {
  const dropped = new Set(seeds);
  for (let grew = dropped.size > 0; grew;) {
    grew = false;
    for (const summary of summaries) {
      if (!dropped.has(summary.id) && summary.level > 1 && summary.sourceIds.some((id) => dropped.has(id))) {
        dropped.add(summary.id);
        grew = true;
      }
    }
  }
  return dropped;
}
