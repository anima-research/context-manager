import { createHash } from 'node:crypto';
import { carriesItsSource } from './strategies/merge-runs.js';
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
  if (refusals.length === 0 && options.expectedPriorSha256 !== undefined && options.expectedPriorSha256 !== sha256) {
    refusals.push({ code: 'CAS_MISMATCH', expectedSha256: options.expectedPriorSha256, actualSha256: sha256 });
  }
  const responseBlocks = Math.max(...[entry, ...carriedBy.flatMap((carrier) => byId.get(carrier.id) ?? [])].map((s) => s.responseContent?.length ?? 0));
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
      return `summary ${id}, or an entry that carries it, holds ${refusal.responseBlocks} verbatim response block(s) of the old text; dropResponseContent (or the CLI's --drop-response-content) deletes them from the summary and each carrier`;
    case 'EMPTY_CONTENT':
      return 'the memory text is empty: give a text that isn\'t blank';
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}
