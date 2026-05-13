/**
 * Reopen an existing chronicle and verify adaptive state persistence.
 *
 * Usage: tsx scripts/reopen-test.ts <store-path>
 *
 * Performs a compile, snapshots resolutions, closes, reopens, compiles
 * again, and verifies the state matches.
 */

import { existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

function makeMockMembrane() {
  let callCount = 0;
  return {
    complete: async () => {
      callCount++;
      return {
        content: [{ type: 'text', text: `[mock #${callCount}]` }],
      };
    },
    get callCount() {
      return callCount;
    },
  };
}

async function compileAndSnapshot(storePath: string, label: string) {
  console.log(`\n[${label}] Opening ${storePath}`);
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
  const messages = manager.getAllMessages();
  const stats = strategy.getStats();
  const resolutions = (strategy as any).resolutions as Map<string, number>;
  const locked = (strategy as any).locked as Set<string>;
  const allSummaries = (strategy as any).summaries as Array<{ level: number }>;
  const byLevel: Record<number, number> = {};
  for (const s of allSummaries) byLevel[s.level] = (byLevel[s.level] ?? 0) + 1;

  console.log(`[${label}] Stored: ${messages.length} records`);
  console.log(`[${label}] Stats: L1=${stats.l1} L2=${stats.l2} L3=${stats.l3}`);
  console.log(`[${label}] Summary distribution: ${JSON.stringify(byLevel)}`);
  console.log(`[${label}] Resolutions: ${resolutions.size}`);
  console.log(`[${label}] Locks: ${locked.size}`);

  // Compile at a tight budget to exercise the picker
  const compiled = await manager.compile({ maxTokens: 50_000, reserveForResponse: 4000 });
  const tokens = compiled.messages.reduce((acc, m) => {
    for (const b of m.content) {
      if (b.type === 'text') acc += Math.ceil(b.text.length / 4);
    }
    return acc;
  }, 0);
  console.log(`[${label}] Compile @ 50K budget: ${compiled.messages.length} entries, ${tokens} tokens`);

  const resDist: Record<number, number> = {};
  for (const lvl of resolutions.values()) resDist[lvl] = (resDist[lvl] ?? 0) + 1;
  console.log(`[${label}] Resolution distribution after compile: ${JSON.stringify(resDist)}`);

  manager.close();
  return {
    messageCount: messages.length,
    resolutions: new Map(resolutions),
    locks: new Set(locked),
    summaryLevels: byLevel,
    compiledEntries: compiled.messages.length,
    compiledTokens: tokens,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: reopen-test <store-path>');
    process.exit(1);
  }
  const [storePath] = args;
  if (!existsSync(storePath)) {
    console.error(`Store not found: ${storePath}`);
    process.exit(1);
  }

  const phase1 = await compileAndSnapshot(storePath, 'PHASE 1 (initial)');
  const phase2 = await compileAndSnapshot(storePath, 'PHASE 2 (reopen)');

  console.log('\n=== VERIFICATION ===');
  let ok = true;
  if (phase1.messageCount !== phase2.messageCount) {
    console.log(`FAIL: message count ${phase1.messageCount} vs ${phase2.messageCount}`);
    ok = false;
  }
  if (phase1.resolutions.size !== phase2.resolutions.size) {
    console.log(`FAIL: resolutions size ${phase1.resolutions.size} vs ${phase2.resolutions.size}`);
    ok = false;
  }
  let resolutionMatches = 0;
  let resolutionMismatches = 0;
  for (const [id, level] of phase1.resolutions) {
    if (phase2.resolutions.get(id) === level) {
      resolutionMatches++;
    } else {
      resolutionMismatches++;
      if (resolutionMismatches < 5) {
        console.log(`  Mismatch for ${id}: phase1=L${level} phase2=L${phase2.resolutions.get(id)}`);
      }
    }
  }
  console.log(`Resolutions: ${resolutionMatches} match, ${resolutionMismatches} differ`);
  if (resolutionMismatches > 0) ok = false;

  if (phase1.compiledEntries !== phase2.compiledEntries) {
    console.log(`FAIL: compiled entry count ${phase1.compiledEntries} vs ${phase2.compiledEntries}`);
    ok = false;
  }
  if (phase1.compiledTokens !== phase2.compiledTokens) {
    console.log(`FAIL: compiled tokens ${phase1.compiledTokens} vs ${phase2.compiledTokens}`);
    ok = false;
  }

  console.log(ok ? '\n✓ STATE PERSISTS CORRECTLY' : '\n✗ STATE MISMATCH DETECTED');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
