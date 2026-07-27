/**
 * Scenario: Passthrough (append-only) vs. Autobiographical (head-rewriting)
 * on the same synthetic workload, with a constant-ratio compressor.
 *
 * Expected directional result:
 *   - Passthrough: high cache-hit % (each turn's prefix == previous turn + new tail)
 *   - Autobiographical: hit % drops sharply whenever a chunk is compressed,
 *     because compression inserts a new summary block in the middle of the
 *     prefix, busting cache for everything past it.
 *
 * Run: npx tsx bench/cache/scenarios/passthrough-vs-autobio.ts
 */

import {
  PassthroughStrategy,
  AutobiographicalStrategy,
} from '../../../src/index.js';

import { generateWorkload } from '../../../test/_harness/workload.js';
import { constantRatio } from '../compressor-profile.js';
import { runScenario, formatComparison, type BenchResult } from '../driver.js';

async function main() {
  const turns = parseInt(process.env.TURNS ?? '60', 10);
  const ratio = parseFloat(process.env.RATIO ?? '0.2');
  const seed = parseInt(process.env.SEED ?? '1337', 10);
  const verbose = process.env.VERBOSE === '1';

  const workload = generateWorkload({
    turns,
    avgUserTokens: 150,
    avgAssistantTokens: 400,
    toolCallProbability: 0.3,
    seed,
  });
  const profile = constantRatio(ratio);

  console.log(
    `bench: turns=${turns}, profile=${profile.name}, seed=${seed}`,
  );
  console.log('');

  const results: BenchResult[] = [];

  results.push(
    await runScenario(
      'Passthrough',
      () => new PassthroughStrategy(),
      workload,
      profile,
      { verbose },
    ),
  );

  // Shrink Autobiographical thresholds so compression fires within the bench
  // length. Default thresholds (3000/30000 tokens) won't trigger in a 60-turn
  // synthetic workload.
  results.push(
    await runScenario(
      'Autobiographical(legacy)',
      () =>
        new AutobiographicalStrategy({
          compressionModel: 'bench-compression-model',
          targetChunkTokens: 400,
          recentWindowTokens: 1500,
          hierarchical: false,
          autoTickOnNewMessage: false,
        }),
      workload,
      profile,
      { verbose },
    ),
  );

  results.push(
    await runScenario(
      'Autobiographical(hierarchical)',
      () =>
        new AutobiographicalStrategy({
          compressionModel: 'bench-compression-model',
          targetChunkTokens: 400,
          recentWindowTokens: 1500,
          hierarchical: true,
          mergeThreshold: 3,
          summaryTargetTokens: 200,
          autoTickOnNewMessage: false,
        }),
      workload,
      profile,
      { verbose },
    ),
  );

  // Adaptive-resolution mode: picker decides per-message resolution (raw vs
  // L1/L2/L3 summary) given a token budget. Defaults flat-profile picker
  // and speculative production. The bench has to drive ticks since
  // autoTickOnNewMessage is off — speculativeProduction may also enqueue
  // L1 work via the picker's produce ops on each select().
  results.push(
    await runScenario(
      'Autobiographical(adaptive,flat-profile)',
      () =>
        new AutobiographicalStrategy({
          compressionModel: 'bench-compression-model',
          targetChunkTokens: 400,
          recentWindowTokens: 1500,
          hierarchical: true,
          adaptiveResolution: true,
          foldingStrategy: 'flat-profile',
          mergeThreshold: 3,
          summaryTargetTokens: 200,
          autoTickOnNewMessage: false,
        }),
      workload,
      profile,
      { verbose },
    ),
  );

  results.push(
    await runScenario(
      'Autobiographical(adaptive,oldest-first)',
      () =>
        new AutobiographicalStrategy({
          compressionModel: 'bench-compression-model',
          targetChunkTokens: 400,
          recentWindowTokens: 1500,
          hierarchical: true,
          adaptiveResolution: true,
          foldingStrategy: 'oldest-first',
          mergeThreshold: 3,
          summaryTargetTokens: 200,
          autoTickOnNewMessage: false,
        }),
      workload,
      profile,
      { verbose },
    ),
  );

  // Tight-budget adaptive runs: force the picker to substitute summaries for
  // raw chunks, since the default 100k budget leaves the picker idle on our
  // small workload (max ~14k tokens). At 4k budget the picker must engage.
  const tightBudget = { maxTokens: 4000, reserveForResponse: 500 };

  results.push(
    await runScenario(
      'Autobiographical(adaptive,flat,tight)',
      () =>
        new AutobiographicalStrategy({
          compressionModel: 'bench-compression-model',
          targetChunkTokens: 400,
          recentWindowTokens: 1500,
          hierarchical: true,
          adaptiveResolution: true,
          foldingStrategy: 'flat-profile',
          mergeThreshold: 3,
          summaryTargetTokens: 200,
          autoTickOnNewMessage: false,
        }),
      workload,
      profile,
      { verbose, compileBudget: tightBudget },
    ),
  );

  results.push(
    await runScenario(
      'Autobiographical(adaptive,oldest,tight)',
      () =>
        new AutobiographicalStrategy({
          compressionModel: 'bench-compression-model',
          targetChunkTokens: 400,
          recentWindowTokens: 1500,
          hierarchical: true,
          adaptiveResolution: true,
          foldingStrategy: 'oldest-first',
          mergeThreshold: 3,
          summaryTargetTokens: 200,
          autoTickOnNewMessage: false,
        }),
      workload,
      profile,
      { verbose, compileBudget: tightBudget },
    ),
  );

  console.log(formatComparison(results));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
