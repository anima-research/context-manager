/**
 * Dump per-entry evidence packages for corrupted-summary loss assessment.
 *
 * For each flagged summary id: write <outDir>/<id>.md containing the
 * truncated entry's full content plus the full content of its sources —
 * child summaries for L2+ merges, raw chunk messages for L1s. A reviewer
 * (human or agent) can then judge exactly what information the cut dropped.
 *
 * Usage:
 *   bun scripts/dump-corruption-context.ts <storePath> <summariesStateId> <outDir> <id1,id2,...>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import type { SummaryEntry } from '../src/types/index.js';

const [storePath, stateId, outDir, idsCsv] = process.argv.slice(2);
if (!storePath || !stateId || !outDir || !idsCsv) {
  console.error('Usage: dump-corruption-context <storePath> <summariesStateId> <outDir> <ids,csv>');
  process.exit(1);
}
const targetIds = idsCsv.split(',').map((s) => s.trim()).filter(Boolean);
const targetSet = new Set(targetIds);

const store = JsStore.open({ path: storePath });
const summaries = store.getStateJson(stateId) as SummaryEntry[];
if (!Array.isArray(summaries)) {
  console.error(`State ${stateId} is not an array`);
  process.exit(1);
}
const byId = new Map(summaries.map((s) => [s.id, s]));

// Raw messages (loaded lazily on first L1 target).
let messageById: Map<string, { participant: string; text: string }> | null = null;
function loadMessages(): Map<string, { participant: string; text: string }> {
  if (messageById) return messageById;
  const raw = store.getStateJson('messages') as Array<{
    id: string; participant: string; content: Array<{ type: string; text?: string }>;
  }>;
  messageById = new Map();
  for (const m of raw ?? []) {
    if (!m || typeof m.id !== 'string') continue;
    const text = (Array.isArray(m.content) ? m.content : [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n');
    messageById.set(m.id, { participant: m.participant, text });
  }
  return messageById;
}

// Per-level medians for context.
const lengthsByLevel = new Map<number, number[]>();
for (const s of summaries) {
  if (s.content?.trim()) {
    if (!lengthsByLevel.has(s.level)) lengthsByLevel.set(s.level, []);
    lengthsByLevel.get(s.level)!.push(s.content.length);
  }
}
const medianOf = (level: number): number => {
  const sorted = [...(lengthsByLevel.get(level) ?? [])].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

mkdirSync(outDir, { recursive: true });
const manifest: string[] = [];

for (const id of targetIds) {
  const entry = byId.get(id);
  if (!entry) {
    console.error(`MISSING: ${id}`);
    continue;
  }
  const median = medianOf(entry.level);
  const pct = median ? Math.round((entry.content.length / median) * 100) : 0;
  const lines: string[] = [];
  lines.push(`# ${id} — truncated ${entry.level >= 2 ? 'merge' : 'L1'} entry`);
  lines.push('');
  lines.push(`- level: L${entry.level}, tokens: ${entry.tokens}, chars: ${entry.content.length} (${pct}% of L${entry.level} median ${Math.round(median)})`);
  lines.push(`- created: ${entry.created ? new Date(entry.created).toISOString() : '?'}`);
  lines.push(`- parent: ${entry.parentId ?? entry.mergedInto ?? 'NONE (live at top of pyramid)'}`);
  lines.push(`- sources: ${entry.sourceIds.length} at level ${entry.sourceLevel}`);
  lines.push('');
  lines.push('## TRUNCATED CONTENT (what survived — the generation is a prefix, so everything missing is AFTER this)');
  lines.push('');
  lines.push('```');
  lines.push(entry.content);
  lines.push('```');
  lines.push('');
  if (entry.sourceLevel >= 1) {
    lines.push('## SOURCES (intact children — what the full merge SHOULD have covered)');
    for (const childId of entry.sourceIds) {
      const child = byId.get(childId);
      lines.push('');
      if (!child) {
        lines.push(`### ${childId} — MISSING from store`);
        continue;
      }
      const alsoCut = targetSet.has(childId) ? ' ⚠️ ALSO IN CORRUPTED SET (itself truncated)' : '';
      lines.push(`### ${childId} (L${child.level}, ${child.content.length} chars)${alsoCut}`);
      lines.push('```');
      lines.push(child.content);
      lines.push('```');
    }
  } else {
    lines.push('## SOURCES (raw chunk messages — what the full L1 SHOULD have covered)');
    const messages = loadMessages();
    for (const mid of entry.sourceIds) {
      const m = messages.get(mid);
      lines.push('');
      if (!m) {
        lines.push(`### message ${mid} — MISSING from store`);
        continue;
      }
      lines.push(`### [${m.participant}] ${mid}`);
      lines.push('```');
      lines.push(m.text.length > 6000 ? m.text.slice(0, 6000) + `\n…[truncated for package, ${m.text.length} chars total]` : m.text);
      lines.push('```');
    }
  }
  const outPath = `${outDir}/${id}.md`;
  writeFileSync(outPath, lines.join('\n'));
  manifest.push(`${id}\tL${entry.level}\t${entry.content.length}ch (${pct}% of median)\tparent=${entry.parentId ?? entry.mergedInto ?? 'TOP'}\t${outPath}`);
  console.log(`wrote ${outPath}`);
}
writeFileSync(`${outDir}/MANIFEST.tsv`, manifest.join('\n') + '\n');
console.log(`\nManifest: ${outDir}/MANIFEST.tsv (${manifest.length} packages)`);
