/**
 * Migrate a llr.json transcript into a fresh chronicle, exercising the
 * adaptive-resolution path end-to-end.
 *
 * Usage:
 *   tsx scripts/migrate-llr.ts <input.json> <store-path> [--mock|--real]
 *
 * Modes:
 *   --mock (default): use a deterministic mock LLM. Fast, no API calls.
 *                     Useful for verifying structure and budget behavior.
 *   --real:           use ANTHROPIC_API_KEY for real summary production.
 *                     Slow and costly but produces a real working chronicle.
 *
 * The script:
 *   1. Loads the input JSON (expects { model, messages: [{role, content}...] }).
 *   2. Opens a fresh ContextManager at <store-path> with adaptiveResolution.
 *   3. Adds every message — the chunker shards large messages at ingestion.
 *   4. Drains compression (tick until ready).
 *   5. Reports: shard counts per bodyGroup, summary tree shape, picker
 *      behavior under a sample budget.
 */

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

interface InputMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
}

interface InputJSON {
  model?: string;
  messages: InputMessage[];
}

function makeMockMembrane() {
  let callCount = 0;
  return {
    complete: async () => {
      callCount++;
      return {
        content: [
          {
            type: 'text',
            text: `[mock summary #${callCount}] Brief recall of an earlier portion of the conversation, approximating what would be produced by the real LLM.`,
          },
        ],
      };
    },
    get callCount() {
      return callCount;
    },
  };
}

async function makeRealMembrane() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('--real mode requires ANTHROPIC_API_KEY env var');
  }
  const { Membrane, AnthropicAdapter } = await import('@animalabs/membrane');
  return new Membrane(new AnthropicAdapter({ apiKey }));
}

function normalizeContent(content: InputMessage['content']): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content } as ContentBlock];
  }
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push({ type: 'text', text: b.text } as ContentBlock);
    } else {
      // Pass through unknown blocks as best-effort text representation
      out.push({ type: 'text', text: JSON.stringify(b) } as ContentBlock);
    }
  }
  return out;
}

function participantFor(role: string): string {
  // ContextManager treats lowercase 'user' specially for injection positioning
  return role === 'assistant' ? 'Claude' : 'User';
}

function estimateTokens(content: ContentBlock[]): number {
  let total = 0;
  for (const b of content) {
    if (b.type === 'text') total += Math.ceil(b.text.length / 4);
  }
  return total;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: migrate-llr <input.json> <store-path> [--mock|--real]');
    process.exit(1);
  }
  const [inputPath, storePath, modeArg] = args;
  const real = modeArg === '--real';

  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Fresh chronicle: remove any existing store at the path so we get a clean run.
  if (existsSync(storePath)) {
    console.log(`Removing existing store at ${storePath}`);
    rmSync(storePath, { recursive: true, force: true });
  }

  // Parse input
  console.log(`Loading ${inputPath}...`);
  const input: InputJSON = JSON.parse(readFileSync(inputPath, 'utf8'));
  console.log(`Input: ${input.messages.length} messages, model=${input.model ?? '(unspecified)'}`);

  // Compute input token estimate
  let totalInputChars = 0;
  let biggestMsg = { idx: -1, chars: 0 };
  for (let i = 0; i < input.messages.length; i++) {
    const content = normalizeContent(input.messages[i].content);
    const chars = content
      .filter((b) => b.type === 'text')
      .reduce((acc: number, b: any) => acc + b.text.length, 0);
    totalInputChars += chars;
    if (chars > biggestMsg.chars) {
      biggestMsg = { idx: i, chars };
    }
  }
  console.log(
    `Input totals: ${totalInputChars} chars (~${Math.ceil(totalInputChars / 4)} tokens). ` +
      `Biggest message: [${biggestMsg.idx}] ${biggestMsg.chars} chars (~${Math.ceil(biggestMsg.chars / 4)} tokens).`
  );

  // Set up strategy
  const membrane = real ? await makeRealMembrane() : makeMockMembrane();
  const strategy = new AutobiographicalStrategy({
    adaptiveResolution: true,
    targetChunkTokens: 3000, // → chunker threshold 6000, shard size ~3000
    recentWindowTokens: 30000,
    mergeThreshold: 6,
    compressionSlackRatio: 0.1,
  });
  const manager = await ContextManager.open({
    path: storePath,
    strategy,
    membrane: membrane as any,
  });

  // Ingest messages
  console.log('\nIngesting messages...');
  const startIngest = Date.now();
  for (let i = 0; i < input.messages.length; i++) {
    const msg = input.messages[i];
    const content = normalizeContent(msg.content);
    const tokensApprox = estimateTokens(content);
    if (tokensApprox > 10000) {
      console.log(
        `  [${i}/${input.messages.length}] role=${msg.role} tokens=${tokensApprox} ← chunking...`
      );
    }
    manager.addMessage(participantFor(msg.role), content);
  }
  const ingestDuration = Date.now() - startIngest;
  console.log(`Ingest complete in ${ingestDuration}ms.`);

  // Report storage shape
  const allStored = manager.getAllMessages();
  console.log(`\nStored: ${allStored.length} records (input was ${input.messages.length} messages).`);

  // Count bodyGroups
  const groups = new Map<string, number>();
  for (const m of allStored) {
    if (m.bodyGroupId) {
      groups.set(m.bodyGroupId, (groups.get(m.bodyGroupId) ?? 0) + 1);
    }
  }
  console.log(`BodyGroups: ${groups.size}`);
  for (const [gid, count] of Array.from(groups.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  ${gid}: ${count} shards`);
  }

  // Drain compression
  console.log('\nDraining compression queue...');
  const startCompress = Date.now();
  let tickCount = 0;
  const maxTicks = real ? 1000 : 10000; // cap to avoid runaway in case of bugs
  while (!manager.isReady() && tickCount < maxTicks) {
    await manager.tick();
    tickCount++;
    if (tickCount % 10 === 0) {
      const stats = strategy.getStats();
      const llmCalls = (membrane as any).callCount ?? 0;
      console.log(
        `  tick ${tickCount}: L1=${stats.l1} L2=${stats.l2} L3=${stats.l3}, llmCalls=${llmCalls}`
      );
    }
  }
  const compressDuration = Date.now() - startCompress;
  console.log(`Compression complete in ${compressDuration}ms after ${tickCount} ticks.`);
  console.log(`LLM calls: ${(membrane as any).callCount ?? 0}`);

  const stats = strategy.getStats();
  console.log(
    `\nFinal summary state: L1=${stats.l1} L2=${stats.l2} L3=${stats.l3} pendingMerges=${stats.pendingMerges}`
  );
  // For unbounded L_n, also check for L4+
  const allSummaries = (strategy as any).summaries as Array<{ level: number }>;
  const byLevel: Record<number, number> = {};
  for (const s of allSummaries) byLevel[s.level] = (byLevel[s.level] ?? 0) + 1;
  console.log(`Summary level distribution: ${JSON.stringify(byLevel)}`);

  // Try compile at a few budgets and report shape
  console.log('\nCompile probes:');
  const budgets = [200_000, 100_000, 50_000, 20_000];
  for (const budget of budgets) {
    try {
      const compiled = await manager.compile({
        maxTokens: budget,
        reserveForResponse: 4000,
      });
      const totalTokens = compiled.messages.reduce((acc, m) => {
        for (const b of m.content) {
          if (b.type === 'text') acc += Math.ceil(b.text.length / 4);
        }
        return acc;
      }, 0);
      const userCount = compiled.messages.filter((m) => m.participant.toLowerCase() === 'user').length;
      const assistantCount = compiled.messages.filter(
        (m) => m.participant.toLowerCase() === 'claude' || m.participant.toLowerCase() === 'assistant'
      ).length;
      const cmCount = compiled.messages.filter((m) => m.participant === 'Context Manager').length;
      console.log(
        `  budget=${budget}: ${compiled.messages.length} entries, ` +
          `${totalTokens} tokens (${userCount} user / ${assistantCount} claude / ${cmCount} CM)`
      );
    } catch (err) {
      console.log(`  budget=${budget}: THREW ${(err as Error).constructor.name}: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  // Final state on disk
  const resolutions = (strategy as any).resolutions as Map<string, number>;
  const locked = (strategy as any).locked as Set<string>;
  console.log(`\nStrategy state: ${resolutions.size} resolutions recorded, ${locked.size} locks.`);
  // Resolution distribution
  const resDist: Record<number, number> = {};
  for (const lvl of resolutions.values()) resDist[lvl] = (resDist[lvl] ?? 0) + 1;
  console.log(`Resolution distribution: ${JSON.stringify(resDist)}`);

  manager.close();
  console.log(`\nDone. Store at: ${storePath}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
