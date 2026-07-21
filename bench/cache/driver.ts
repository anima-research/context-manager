/**
 * Bench driver — layers cache-prefix analysis on top of the shared
 * strategy harness in `test/_harness/strategy-runner.ts`. The harness
 * runs the workload and captures the raw provider request per turn;
 * this file diffs those requests against a rolling cache state to
 * compute hit/write/fresh token counts.
 *
 * Scenarios use `runScenario(name, factory, workload, profile)` and
 * `formatComparison(results)` to print a table.
 */

import {
  runStrategyOnWorkload,
  type CompressionCallRecord,
} from '../../test/_harness/strategy-runner.js';
import type { WorkloadTurn } from '../../test/_harness/workload.js';
import type { ContextStrategy } from '../../src/types/index.js';

import {
  CacheState,
  linearizeRequest,
  simulateCacheHit,
  type CacheReport,
} from './cache-simulator.js';
import { type CompressionProfile } from './compressor-profile.js';

export interface BenchResult {
  strategyName: string;
  profileName: string;
  turns: number;
  perTurn: CacheReport[];
  totals: {
    hitTokens: number;
    writeTokens: number;
    freshTokens: number;
    requestTokens: number;
    bustEvents: number;
    compressionsTriggered: number;
  };
}

export interface RunOptions {
  agentSystemPrompt?: string;
  compileBudget?: { maxTokens: number; reserveForResponse: number };
  /** Tick loop iterations per turn (drains queued compression). Default 10. */
  maxTicksPerTurn?: number;
  /** When true, prints per-turn hit/bust to stderr while running. */
  verbose?: boolean;
}

export async function runScenario(
  strategyName: string,
  strategyFactory: () => ContextStrategy,
  workload: WorkloadTurn[],
  profile: CompressionProfile,
  opts: RunOptions = {},
): Promise<BenchResult> {
  const compressor = (call: CompressionCallRecord) => {
    const inputText = JSON.stringify(call.inputMessages);
    return profile.compress(inputText, call.callIndex);
  };

  const harnessResult = await runStrategyOnWorkload(strategyFactory, workload, {
    compressor,
    agentSystemPrompt: opts.agentSystemPrompt,
    compileBudget: opts.compileBudget,
    maxTicksPerTurn: opts.maxTicksPerTurn,
    verbose: opts.verbose,
    label: strategyName,
  });

  const perTurn: CacheReport[] = [];
  const cache = new CacheState();
  for (let i = 0; i < harnessResult.perTurn.length; i++) {
    const turn = harnessResult.perTurn[i];
    if (turn.rawRequest === null) {
      // Compile threw on this turn (harness counted it) — no request went
      // out, so there is nothing to feed the cache simulation. Skipping
      // keeps the cache state honest: the next real request diffs against
      // the last real one, exactly as the provider would see it.
      if (opts.verbose) {
        process.stderr.write(
          `  [${strategyName}] turn ${i + 1}/${harnessResult.perTurn.length}: ` +
            `no request (compile error) — skipped in cache sim\n`,
        );
      }
      continue;
    }
    const currPrefix = linearizeRequest(turn.rawRequest);
    const report = simulateCacheHit(cache, currPrefix);
    perTurn.push(report);
    cache.ingest(currPrefix);

    if (opts.verbose) {
      const hitPct =
        currPrefix.totalTokens > 0
          ? (report.cacheHitTokens / currPrefix.totalTokens) * 100
          : 0;
      process.stderr.write(
        `  [${strategyName}] turn ${i + 1}/${harnessResult.perTurn.length}: ` +
          `${currPrefix.totalTokens}tok req, ` +
          `${report.cacheHitTokens}tok hit (${hitPct.toFixed(0)}%), ` +
          `diverge@${report.divergeAt}, cache=${cache.size()}\n`,
      );
    }
  }

  const totals = {
    hitTokens: 0,
    writeTokens: 0,
    freshTokens: 0,
    requestTokens: 0,
    bustEvents: 0,
    compressionsTriggered: harnessResult.totalCompressions,
  };
  for (let i = 0; i < perTurn.length; i++) {
    const r = perTurn[i];
    totals.hitTokens += r.cacheHitTokens;
    totals.writeTokens += r.cacheWriteTokens;
    totals.freshTokens += r.freshTokens;
    totals.requestTokens += r.requestTokens;
    if (i > 0) {
      const hitFraction =
        r.requestTokens > 0 ? r.cacheHitTokens / r.requestTokens : 0;
      if (hitFraction < 0.5) totals.bustEvents++;
    }
  }

  return {
    strategyName,
    profileName: profile.name,
    turns: workload.length,
    perTurn,
    totals,
  };
}

export interface ComparisonRow {
  strategy: string;
  profile: string;
  cacheHitPercent: number;
  avgHitTokensPerTurn: number;
  bustEvents: number;
  cumulativeInputTokens: number;
  compressions: number;
}

export function summarize(result: BenchResult): ComparisonRow {
  const { totals, turns } = result;
  const cacheHitPercent =
    totals.requestTokens > 0
      ? (totals.hitTokens / totals.requestTokens) * 100
      : 0;
  return {
    strategy: result.strategyName,
    profile: result.profileName,
    cacheHitPercent,
    avgHitTokensPerTurn: turns > 0 ? totals.hitTokens / turns : 0,
    bustEvents: totals.bustEvents,
    cumulativeInputTokens: totals.requestTokens,
    compressions: totals.compressionsTriggered,
  };
}

export function formatComparison(results: BenchResult[]): string {
  const rows = results.map(summarize);
  const cols = [
    { name: 'strategy', width: 22, align: 'left' as const },
    { name: 'cache hit %', width: 12, align: 'right' as const },
    { name: 'avg hit tok/turn', width: 18, align: 'right' as const },
    { name: 'busts', width: 6, align: 'right' as const },
    { name: 'cumul input', width: 13, align: 'right' as const },
    { name: 'compressions', width: 12, align: 'right' as const },
  ];

  const fmt = (v: string, w: number, align: 'left' | 'right') =>
    align === 'left' ? v.padEnd(w) : v.padStart(w);

  const lines: string[] = [];
  lines.push(cols.map((c) => fmt(c.name, c.width, c.align)).join(' | '));
  lines.push(cols.map((c) => '-'.repeat(c.width)).join('-+-'));
  for (const r of rows) {
    lines.push(
      [
        fmt(r.strategy, 22, 'left'),
        fmt(r.cacheHitPercent.toFixed(1), 12, 'right'),
        fmt(
          Math.round(r.avgHitTokensPerTurn).toLocaleString(),
          18,
          'right',
        ),
        fmt(r.bustEvents.toString(), 6, 'right'),
        fmt(r.cumulativeInputTokens.toLocaleString(), 13, 'right'),
        fmt(r.compressions.toString(), 12, 'right'),
      ].join(' | '),
    );
  }
  return lines.join('\n');
}
