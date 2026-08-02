/**
 * Apply a re-authored consolidation to a truncated merge entry (the L4-1197
 * class of repair). READ THE RUNBOOK BEFORE RUNNING:
 *
 *   1. STOP the agent (its cm process must not hold the store).
 *   2. Take a dated backup copy of the store dir (or at minimum note the
 *      current summaries state for rollback — this script prints the old
 *      entry JSON to stdout; capture it).
 *   3. Run:  bun scripts/apply-l4-repair.ts <storePath> <summariesStateId> \
 *              <entryId> <draftPath> [--yes]
 *      Without --yes it is a DRY RUN: prints what would change, writes nothing.
 *   4. Restart the agent; verify a compile.
 *
 * What it does to the entry:
 *   - content  := the draft body (everything after the first '---' line, or
 *                 the whole file if no '---' separator)
 *   - tokens   := ceil(chars/3) (cm's estimation convention for entries
 *                 without exact outputTokens)
 *   - responseContent := REMOVED (the captured carriers belong to the
 *                 refused/truncated generation and must not replay beside
 *                 replacement text)
 *   - provenance := { stopReason: 'end_turn', requestHash: sha256(draft body),
 *                 model: <--model arg, default claude-fable-5> }
 *                 The requestHash keys the draft file, not a membrane request —
 *                 this is an out-of-band, same-weights manual consolidation;
 *                 the receipt below records that explicitly.
 *   - every other field (id, level, sourceIds, sourceRange, created, parent
 *                 linkage) is preserved untouched.
 *
 * A durable receipt is appended to <storeDir>/repair-receipts.jsonl.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import type { SummaryEntry } from '../src/types/index.js';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const [storePath, stateId, entryId, draftPath] = positional;
const confirm = args.includes('--yes');
const modelIdx = args.indexOf('--model');
const model = modelIdx >= 0 ? args[modelIdx + 1]! : 'claude-fable-5';

if (!storePath || !stateId || !entryId || !draftPath) {
  console.error('Usage: apply-l4-repair <storePath> <summariesStateId> <entryId> <draftPath> [--yes] [--model <m>]');
  process.exit(1);
}

const raw = readFileSync(draftPath, 'utf8');
const separatorIdx = raw.indexOf('\n---\n');
const body = (separatorIdx >= 0 ? raw.slice(separatorIdx + 5) : raw).trim();
if (body.length < 500) {
  console.error(`Draft body suspiciously short (${body.length} chars) — refusing.`);
  process.exit(1);
}
const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');

const store = JsStore.open({ path: storePath });
const summaries = store.getStateJson(stateId) as SummaryEntry[];
if (!Array.isArray(summaries)) {
  console.error(`State ${stateId} is not an array`);
  process.exit(1);
}
const index = summaries.findIndex((s) => s?.id === entryId);
if (index < 0) {
  console.error(`Entry ${entryId} not found in ${stateId}`);
  process.exit(1);
}
const entry = summaries[index]!;

console.log('=== OLD ENTRY (capture for rollback) ===');
console.log(JSON.stringify(entry));
console.log('=== CHANGE PLAN ===');
console.log(`content: ${entry.content.length} chars -> ${body.length} chars`);
console.log(`tokens:  ${entry.tokens} -> ${Math.ceil(body.length / 3)}`);
console.log(`responseContent: ${entry.responseContent ? `REMOVED (${entry.responseContent.length} blocks)` : 'absent'}`);
console.log(`provenance: { stopReason: 'end_turn', requestHash: ${bodyHash.slice(0, 16)}…, model: ${model} }`);
console.log(`preserved: id=${entry.id} level=${entry.level} sources=${entry.sourceIds.length} created=${new Date(entry.created).toISOString()}`);
console.log(`new content head: ${body.slice(0, 120)}`);
console.log(`new content tail: ${body.slice(-120)}`);

if (!confirm) {
  console.log('\nDRY RUN — nothing written. Re-run with --yes to apply.');
  process.exit(0);
}

const updated: SummaryEntry = {
  ...entry,
  content: body,
  tokens: Math.ceil(body.length / 3),
  provenance: { stopReason: 'end_turn', requestHash: bodyHash, model },
};
delete (updated as { responseContent?: unknown }).responseContent;
summaries[index] = updated;
store.setStateJson(stateId, summaries);
store.sync();

appendFileSync(`${storePath}/repair-receipts.jsonl`, JSON.stringify({
  kind: 'manual-consolidation-repair',
  at: new Date().toISOString(),
  entryId,
  stateId,
  draftSha256: bodyHash,
  oldChars: entry.content.length,
  newChars: body.length,
  removedResponseContent: !!entry.responseContent,
  model,
  note: 'out-of-band same-weights consolidation; original generation was classifier-cut; children intact and unchanged',
}) + '\n');

console.log('\nAPPLIED. Receipt appended to repair-receipts.jsonl. Restart the agent and verify a compile.');
