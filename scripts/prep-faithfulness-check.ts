/**
 * Prepare data for subagent-driven faithfulness checks of the migrated chronicle.
 *
 * For each L1 summary, extract:
 *   - the summary content (what opus produced)
 *   - the source-shard message IDs
 *   - the actual raw text of those shards (concatenated, as the LLM would have seen)
 *
 * For each L2, extract the L1s it merged from.
 * For each L3, extract the L2s.
 *
 * Output: a structured directory the subagent can read piece by piece.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

function makeMockMembrane() {
  return {
    complete: async () => ({ content: [{ type: 'text', text: '[mock]' }] }),
  };
}

interface SummaryEntry {
  id: string;
  level: number;
  content: string;
  tokens: number;
  sourceLevel: number;
  sourceIds: string[];
  sourceRange: { first: string; last: string };
  parentId?: string;
  mergedInto?: string;
}

async function main() {
  const [storePath, outputDir = './faith-check'] = process.argv.slice(2);
  if (!storePath) {
    console.error('Usage: prep-faithfulness-check <store-path> [output-dir]');
    process.exit(1);
  }
  if (!existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    process.exit(1);
  }
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(`${outputDir}/l1`, { recursive: true });
  mkdirSync(`${outputDir}/l2`, { recursive: true });
  mkdirSync(`${outputDir}/l3`, { recursive: true });

  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    targetChunkTokens: 3000,
  });
  const manager = await ContextManager.open({
    path: storePath,
    strategy,
    membrane: makeMockMembrane() as any,
  });

  const allMessages = manager.getAllMessages();
  const messageById = new Map(allMessages.map((m) => [m.id, m]));
  const summaries = (strategy as any).summaries as SummaryEntry[];
  const summaryById = new Map(summaries.map((s) => [s.id, s]));

  const messageText = (id: string): string => {
    const m = messageById.get(id);
    if (!m) return `[MESSAGE NOT FOUND: ${id}]`;
    return m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  };

  // L1 summaries: source = raw message ids
  let l1Index = 0;
  let l2Index = 0;
  let l3Index = 0;
  const l1Manifest: Array<{ file: string; summaryId: string; sourceMessages: number; sourceChars: number }> = [];
  const l2Manifest: Array<{ file: string; summaryId: string; sourceL1Ids: string[] }> = [];
  const l3Manifest: Array<{ file: string; summaryId: string; sourceL2Ids: string[] }> = [];

  for (const s of summaries.sort((a, b) => a.id.localeCompare(b.id))) {
    if (s.level === 1) {
      const sourceTexts = s.sourceIds.map((mid) => messageText(mid));
      const sourceConcat = sourceTexts.join('');
      const file = `l1/${s.id}.md`;
      const content = [
        `# ${s.id} (L1, ${s.tokens} tokens, ${s.sourceIds.length} source messages)\n`,
        `Source range: ${s.sourceRange.first} … ${s.sourceRange.last}\n`,
        `Parent: ${s.parentId ?? s.mergedInto ?? '(none)'}\n`,
        `\n## SUMMARY (what opus produced)\n\n${s.content}\n`,
        `\n## SOURCE CONTENT (${sourceConcat.length} chars, what opus was given to summarize)\n\n${sourceConcat}\n`,
      ].join('');
      writeFileSync(`${outputDir}/${file}`, content);
      l1Manifest.push({ file, summaryId: s.id, sourceMessages: s.sourceIds.length, sourceChars: sourceConcat.length });
      l1Index++;
    } else if (s.level === 2) {
      const sourceL1s = s.sourceIds
        .map((sid) => summaryById.get(sid))
        .filter((x): x is SummaryEntry => x != null);
      const file = `l2/${s.id}.md`;
      const content = [
        `# ${s.id} (L2, ${s.tokens} tokens, merging ${s.sourceIds.length} L1s)\n`,
        `Source range: ${s.sourceRange.first} … ${s.sourceRange.last}\n`,
        `Parent: ${s.parentId ?? s.mergedInto ?? '(none)'}\n`,
        `\n## SUMMARY (what opus produced)\n\n${s.content}\n`,
        `\n## SOURCE L1 SUMMARIES (what opus was given to consolidate)\n\n`,
        ...sourceL1s.map((s1) => `### ${s1.id}\n\n${s1.content}\n\n---\n`),
      ].join('');
      writeFileSync(`${outputDir}/${file}`, content);
      l2Manifest.push({ file, summaryId: s.id, sourceL1Ids: s.sourceIds });
      l2Index++;
    } else if (s.level === 3) {
      const sourceL2s = s.sourceIds
        .map((sid) => summaryById.get(sid))
        .filter((x): x is SummaryEntry => x != null);
      const file = `l3/${s.id}.md`;
      const content = [
        `# ${s.id} (L3, ${s.tokens} tokens, merging ${s.sourceIds.length} L2s)\n`,
        `Source range: ${s.sourceRange.first} … ${s.sourceRange.last}\n`,
        `\n## SUMMARY (what opus produced)\n\n${s.content}\n`,
        `\n## SOURCE L2 SUMMARIES (what opus was given to consolidate)\n\n`,
        ...sourceL2s.map((s2) => `### ${s2.id}\n\n${s2.content}\n\n---\n`),
      ].join('');
      writeFileSync(`${outputDir}/${file}`, content);
      l3Manifest.push({ file, summaryId: s.id, sourceL2Ids: s.sourceIds });
      l3Index++;
    }
  }

  // Index file
  const indexLines: string[] = [];
  indexLines.push('# Faithfulness check data\n');
  indexLines.push('Each file under l1/, l2/, l3/ pairs an opus-produced summary with the input that opus saw when producing it.\n');
  indexLines.push('Compare the SUMMARY section against the SOURCE CONTENT (for L1) or SOURCE L_{n-1} SUMMARIES (for L2/L3) to check faithfulness.\n');
  indexLines.push('\n## L1 summaries\n');
  for (const m of l1Manifest) {
    indexLines.push(`- ${m.file} — ${m.summaryId} — ${m.sourceMessages} source messages, ${m.sourceChars} source chars`);
  }
  indexLines.push('\n## L2 summaries\n');
  for (const m of l2Manifest) {
    indexLines.push(`- ${m.file} — ${m.summaryId} — sources: ${m.sourceL1Ids.join(', ')}`);
  }
  indexLines.push('\n## L3 summaries\n');
  for (const m of l3Manifest) {
    indexLines.push(`- ${m.file} — ${m.summaryId} — sources: ${m.sourceL2Ids.join(', ')}`);
  }
  writeFileSync(`${outputDir}/INDEX.md`, indexLines.join('\n'));

  console.log(`Wrote ${l1Index} L1 + ${l2Index} L2 + ${l3Index} L3 summary/source pairs to ${outputDir}/`);
  console.log(`Index at ${outputDir}/INDEX.md`);
  manager.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
