/**
 * Reconstruct the exact LLM prompt that would have been sent for a given
 * L1 summary's production. Uses the chronicle's stored state (messages,
 * summaries, source IDs) and the strategy's current prompt-building logic
 * to rebuild the prompt deterministically.
 *
 * Usage:
 *   node dist/scripts/dump-compression-prompt.js <store-path> <L1-id> [output.md]
 *
 * Example: dump-compression-prompt llr-migrated L1-5
 *
 * The reconstruction assumes:
 *   - L1s are produced in numerical order (L1-0, L1-1, ...)
 *   - At the time L1-N was produced, only L1-0..L1-{N-1} existed
 *   - The strategy's current prompt builder is what produced L1-N
 */

import { existsSync, writeFileSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

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

// ---------------------------------------------------------------------------
// These constants must match src/strategies/autobiographical.ts.
// If those change, update here too.
// ---------------------------------------------------------------------------
const COMPRESSION_MARKER =
  'System: You will soon form a new memory, get ready. ' +
  'The messages that follow are the slice of recent experience you are ' +
  'about to compress. After them, write the memory in your own voice.';

function formatInstruction(targetTokens: number): string {
  return (
    'Write the memory of events since the most recent memory system ' +
    'notification. Speak in the first person from your own perspective. ' +
    'Preserve concrete details — file paths, exact values, decisions, ' +
    `unresolved questions, the user's active asks. Target ~${targetTokens} ` +
    'tokens. Output only the memory body — no preamble, no section headers ' +
    'unless they help preservation, no meta-commentary about summarizing.'
  );
}

function formatDocChunkInstruction(
  doc: { title: string; style: string; originalTokens: number },
  targetTokens: number,
): string {
  return (
    `You just read a slice of document "${doc.title}" (${doc.style}, approximately ` +
    `${doc.originalTokens} tokens total in the full document). Earlier slices ` +
    'of this same document are in your memory above as L1s — they are in ' +
    'chronological order within the document. What comes after this slice ' +
    'you have NOT yet read; treat yourself as reading the document in ' +
    'order, not yet knowing what lies ahead.\n\n' +
    'Write the memory of what this slice contained. Preserve concrete ' +
    'detail aggressively:\n' +
    '- Timestamps, dates, IDs, numeric values, quoted phrases\n' +
    '- Key events, decisions, contradictions with earlier slices\n' +
    '- Structural markers (section titles, entry boundaries) that help ' +
    'you locate this slice within the whole later\n\n' +
    `Speak in the first person. Target ~${targetTokens} tokens. Output ` +
    'only the memory body — no preamble, no meta-commentary about ' +
    'summarizing.'
  );
}

interface PromptMessage {
  role: 'user' | 'assistant';
  text: string;
  participant: string;
  description: string;
}

async function main() {
  const [storePath, targetSummaryId, outputPath] = process.argv.slice(2);
  if (!storePath || !targetSummaryId) {
    console.error(
      'Usage: dump-compression-prompt <store-path> <L1-id> [output.md]\n' +
        '  e.g. dump-compression-prompt llr-migrated L1-5'
    );
    process.exit(1);
  }
  if (!existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    process.exit(1);
  }

  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    targetChunkTokens: 3000,
    recentWindowTokens: 30000,
    mergeThreshold: 6,
  });
  const manager = await ContextManager.open({
    path: storePath,
    strategy,
    membrane: makeMockMembrane() as any,
  });

  const allMessages = manager.getAllMessages();
  const messageById = new Map(allMessages.map((m) => [m.id, m]));
  const summaries = (strategy as any).summaries as SummaryEntry[];
  const target = summaries.find((s) => s.id === targetSummaryId);
  if (!target) {
    console.error(`Summary not found: ${targetSummaryId}`);
    process.exit(1);
  }
  if (target.level !== 1) {
    console.error(
      `${targetSummaryId} is L${target.level}; this script reconstructs L1 prompts only.\n` +
        '(Merge prompts have different structure — separate dumper TODO.)'
    );
    process.exit(1);
  }

  // Determine which prior L1s existed when this one was produced.
  // Assumption: L1s are produced in numerical order. So for L1-N, priors
  // are L1-0 through L1-{N-1}.
  const targetIdx = parseInt(target.id.slice(3), 10);
  const priorL1s = summaries
    .filter((s) => s.level === 1)
    .filter((s) => {
      const idx = parseInt(s.id.slice(3), 10);
      return idx < targetIdx;
    })
    .sort((a, b) => parseInt(a.id.slice(3), 10) - parseInt(b.id.slice(3), 10));

  // Source messages for this chunk
  const chunkMessages = target.sourceIds
    .map((mid) => messageById.get(mid))
    .filter((m): m is NonNullable<typeof m> => m != null);

  if (chunkMessages.length === 0) {
    console.error('Chunk messages not found in store');
    process.exit(1);
  }

  // Head: messages before chunk start, not covered by any prior L1
  const priorL1MessageIds = new Set<string>();
  for (const s of priorL1s) {
    for (const id of s.sourceIds) priorL1MessageIds.add(id);
  }
  const chunkFirstId = chunkMessages[0].id;
  const chunkStartIdx = allMessages.findIndex((m) => m.id === chunkFirstId);
  const headMessages =
    chunkStartIdx > 0
      ? allMessages.slice(0, chunkStartIdx).filter((m) => !priorL1MessageIds.has(m.id))
      : [];

  // Build the prompt
  const targetTokens = 2000;
  const agentParticipant = 'Claude';
  const prompt: PromptMessage[] = [];

  // 1. Prior L1 recall pairs
  for (const s of priorL1s) {
    prompt.push({
      role: 'user',
      participant: 'Context Manager',
      text: `[CM] Recall memory ${s.id}.`,
      description: `RECALL-Q for ${s.id}`,
    });
    prompt.push({
      role: 'assistant',
      participant: agentParticipant,
      text: s.content,
      description: `RECALL-A body of ${s.id}`,
    });
  }

  // 2. Head messages
  for (const m of headMessages) {
    const text = m.content
      .filter((b: ContentBlock) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    prompt.push({
      role: m.participant === agentParticipant ? 'assistant' : 'user',
      participant: m.participant,
      text,
      description: `HEAD message ${m.id}`,
    });
  }

  // 3. Marker
  prompt.push({
    role: 'user',
    participant: 'Context Manager',
    text: COMPRESSION_MARKER,
    description: 'COMPRESSION MARKER',
  });

  // 4. Chunk messages
  for (const m of chunkMessages) {
    const text = m.content
      .filter((b: ContentBlock) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    prompt.push({
      role: m.participant === agentParticipant ? 'assistant' : 'user',
      participant: m.participant,
      text,
      description: `CHUNK shard ${m.id} (shardIndex=${m.shardIndex ?? '-'} bodyGroup=${(m.bodyGroupId ?? '').slice(0, 12)})`,
    });
  }

  // 5. Instruction (doc-aware if all chunk messages share a bodyGroupId)
  const firstGroupId = chunkMessages[0].bodyGroupId;
  const allSameGroup =
    firstGroupId && chunkMessages.every((m) => m.bodyGroupId === firstGroupId);
  let instructionText: string;
  if (allSameGroup) {
    // Compute doc context like the strategy does
    let originalTokens = 0;
    for (const m of allMessages) {
      if (m.bodyGroupId === firstGroupId) {
        const t = m.content
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
        originalTokens += Math.ceil(t.length / 4);
      }
    }
    const title =
      (chunkMessages[0].metadata?.sourceId as string | undefined) ??
      `doc-${firstGroupId!.slice(0, 16)}`;
    instructionText = formatDocChunkInstruction(
      { title, style: 'chronological', originalTokens },
      targetTokens
    );
  } else {
    instructionText = formatInstruction(targetTokens);
  }
  prompt.push({
    role: 'user',
    participant: 'Context Manager',
    text: instructionText,
    description: 'INSTRUCTION',
  });

  // System prompt
  const systemPrompt =
    'You are forming autobiographical memories of an ongoing conversation. ' +
    'Speak in the first person from your own perspective; the messages above ' +
    'are your actual experience and prior recollections.';

  // Output
  const out: string[] = [];
  out.push(`# Reconstructed compression prompt for ${target.id}\n`);
  out.push(`Source range: ${target.sourceRange.first} … ${target.sourceRange.last}\n`);
  out.push(`Source messages: ${target.sourceIds.length}\n`);
  out.push(`Prior L1s: ${priorL1s.length} (L1-0..L1-${targetIdx - 1})\n`);
  out.push(`Head raw messages (not in prior L1s): ${headMessages.length}\n`);
  out.push(`\n## SYSTEM PROMPT\n\n${systemPrompt}\n`);
  out.push(`\n## MESSAGES (${prompt.length} total)\n`);

  let totalChars = 0;
  for (let i = 0; i < prompt.length; i++) {
    const p = prompt[i];
    out.push(`\n### [${i}] role=${p.role} participant=${p.participant} (${p.description}) — ${p.text.length} chars`);
    out.push('');
    out.push(p.text);
    out.push('');
    out.push('---');
    totalChars += p.text.length;
  }
  out.push(`\n## TOTAL: ${prompt.length} messages, ${totalChars} chars (~${Math.ceil(totalChars / 4)} tokens)`);

  if (outputPath) {
    writeFileSync(outputPath, out.join('\n'));
    console.log(`Wrote prompt → ${outputPath}`);
  } else {
    console.log(out.join('\n'));
  }

  manager.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
