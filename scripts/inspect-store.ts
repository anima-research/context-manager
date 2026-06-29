/**
 * Inspect a migrated chronicle: dump messages, summaries, and the picker's
 * resolution state in a human-readable form.
 *
 * Usage:
 *   node dist/scripts/inspect-store.js <store-path> [--summaries|--messages|--all]
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

function makeMockMembrane() {
  return {
    complete: async () => ({
      content: [{ type: 'text', text: '[mock]' }],
    }),
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
  created: number;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: inspect-store <store-path> [--output <dir>]');
    process.exit(1);
  }
  const storePath = args[0];
  const outputDir = (() => {
    const i = args.indexOf('--output');
    return i >= 0 ? args[i + 1] : './inspection-output';
  })();

  if (!existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    process.exit(1);
  }
  mkdirSync(outputDir, { recursive: true });

  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    targetChunkTokens: 3000,
    recentWindowTokens: 30000,
    mergeThreshold: 6,
  });
  const nsIdx = args.indexOf('--ns');
  const ns = nsIdx >= 0 ? args[nsIdx + 1] : undefined;
  const manager = await ContextManager.open({
    path: storePath,
    strategy,
    membrane: makeMockMembrane() as any,
    ...(ns ? { namespace: ns } : {}),
  });

  const messages = manager.getAllMessages();
  const summaries = (strategy as any).summaries as SummaryEntry[];
  const resolutions = (strategy as any).resolutions as Map<string, number>;

  // === Overview ===
  const byLevel: Record<number, number> = {};
  for (const s of summaries) byLevel[s.level] = (byLevel[s.level] ?? 0) + 1;

  const bodyGroups = new Map<string, number>();
  for (const m of messages) {
    if (m.bodyGroupId) {
      bodyGroups.set(m.bodyGroupId, (bodyGroups.get(m.bodyGroupId) ?? 0) + 1);
    }
  }

  console.log('=== Overview ===');
  console.log(`Messages: ${messages.length}`);
  console.log(`Summaries: ${summaries.length} (${JSON.stringify(byLevel)})`);
  console.log(`BodyGroups: ${bodyGroups.size}`);
  for (const [gid, count] of Array.from(bodyGroups.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  ${gid}: ${count} shards`);
  }
  console.log(`Resolutions recorded: ${resolutions.size}`);
  const resDist: Record<number, number> = {};
  for (const lvl of resolutions.values()) resDist[lvl] = (resDist[lvl] ?? 0) + 1;
  console.log(`Resolution distribution: ${JSON.stringify(resDist)}`);

  // === Summary tree dump ===
  const byId = new Map<string, SummaryEntry>();
  for (const s of summaries) byId.set(s.id, s);
  const getParent = (s: SummaryEntry) => s.parentId ?? s.mergedInto;

  const summaryTreeLines: string[] = [];
  summaryTreeLines.push('# Summary tree\n');
  summaryTreeLines.push('Sorted by level (highest first), then by source order.\n');

  const sortedByLevel = [...summaries].sort((a, b) => {
    if (a.level !== b.level) return b.level - a.level;
    // Within a level, sort by first source message id (rough source order)
    return a.sourceRange.first.localeCompare(b.sourceRange.first);
  });

  for (const s of sortedByLevel) {
    const parent = getParent(s);
    const parentInfo = parent ? ` parent=${parent}` : '';
    summaryTreeLines.push(`\n## ${s.id} (L${s.level}, ${s.tokens} tokens)${parentInfo}`);
    summaryTreeLines.push(`sourceLevel=${s.sourceLevel} sources=${s.sourceIds.length} range=${s.sourceRange.first}…${s.sourceRange.last}`);
    summaryTreeLines.push('');
    summaryTreeLines.push(s.content);
    summaryTreeLines.push('');
    summaryTreeLines.push('---');
  }

  const treePath = `${outputDir}/summary-tree.md`;
  writeFileSync(treePath, summaryTreeLines.join('\n'));
  console.log(`\nWrote summary tree → ${treePath}`);

  // === Per-summary lineage with leaf chunk ids ===
  const lineageLines: string[] = [];
  lineageLines.push('# Summary lineage\n');
  lineageLines.push('For each summary: leaf message IDs it ultimately covers, and (for L1s) the chunk size.\n');

  const collectLeafMessageIds = (s: SummaryEntry, visited = new Set<string>()): string[] => {
    if (visited.has(s.id)) return [];
    visited.add(s.id);
    if (s.sourceLevel === 0) return [...s.sourceIds];
    const out: string[] = [];
    for (const sid of s.sourceIds) {
      const child = byId.get(sid);
      if (child) out.push(...collectLeafMessageIds(child, visited));
    }
    return out;
  };

  for (const s of sortedByLevel) {
    const leaves = collectLeafMessageIds(s);
    lineageLines.push(`\n## ${s.id} (L${s.level})`);
    lineageLines.push(`Source range: ${s.sourceRange.first} … ${s.sourceRange.last}`);
    lineageLines.push(`Leaf message ids (${leaves.length}): ${leaves.slice(0, 5).join(', ')}${leaves.length > 5 ? `, … ${leaves[leaves.length - 1]}` : ''}`);
  }
  writeFileSync(`${outputDir}/summary-lineage.md`, lineageLines.join('\n'));
  console.log(`Wrote summary lineage → ${outputDir}/summary-lineage.md`);

  // === Message listing (compact) ===
  const messageLines: string[] = [];
  messageLines.push('# Messages\n');
  messageLines.push(`Total stored: ${messages.length}\n`);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const text = m.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    const preview = text.slice(0, 100).replace(/\n/g, '\\n');
    const tokenEst = Math.ceil(text.length / 4);
    const shard = m.bodyGroupId ? ` [shard ${m.shardIndex}/${bodyGroups.get(m.bodyGroupId)} of ${m.bodyGroupId.slice(0, 12)}…]` : '';
    const res = resolutions.get(m.id) !== undefined ? ` res=L${resolutions.get(m.id)}` : '';
    messageLines.push(`[${i.toString().padStart(3, '0')}] ${m.participant} ${tokenEst}t${shard}${res}: ${preview}`);
  }
  writeFileSync(`${outputDir}/messages.md`, messageLines.join('\n'));
  console.log(`Wrote messages → ${outputDir}/messages.md`);

  // === Sample compile output (50K budget for spot-check) ===
  const compiled = await manager.compile({ maxTokens: 50000, reserveForResponse: 4000 });
  const compileLines: string[] = [];
  compileLines.push('# Sample compile output (50K budget)\n');
  compileLines.push(`Entries: ${compiled.messages.length}\n`);
  for (let i = 0; i < compiled.messages.length; i++) {
    const m = compiled.messages[i];
    const text = m.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    compileLines.push(`\n## [${i}] ${m.participant} (${Math.ceil(text.length / 4)} tokens)`);
    compileLines.push('');
    compileLines.push(text);
    compileLines.push('');
    compileLines.push('---');
  }
  writeFileSync(`${outputDir}/sample-compile-50k.md`, compileLines.join('\n'));
  console.log(`Wrote sample compile → ${outputDir}/sample-compile-50k.md`);

  manager.close();
  console.log(`\nAll outputs in ${outputDir}/`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
