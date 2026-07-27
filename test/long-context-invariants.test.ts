/**
 * Long-context structural invariants for AutobiographicalStrategy.
 *
 * Runs the strategy through a multi-hundred-turn synthetic workload via
 * the shared harness and asserts on the strategy's summary/chunk state
 * after every turn. The goal is to catch the broad class of
 * compression-loop bugs as a wide net, without a hand-crafted repro per
 * bug.
 *
 * Headline invariant: at any point during a run, every source message
 * ID must be claimed by at most ONE active (non-merged) L1 summary. The
 * stacking-overlap pattern once observed in production ("Bug A": 13 L1
 * summaries with the same start ID but growing end IDs) violates this
 * directly — finding it in production took manual chronicle inspection
 * after the agent had already wasted compression calls; finding it here
 * is a test failure with a turn number. Bug A itself has since been
 * fixed (tool-pair chunk guard + L1 dedup, compress-only-closed-chunks,
 * one-to-one representation); this test is the regression gate for the
 * class.
 *
 * Workload tuning: small messages (avgUser=40, avgAsst=80) with a larger
 * target chunk size (500 tokens) reliably produce the trailing-partial-
 * chunk-then-grow sequence Bug A depended on. With Bug A live in the
 * May-era src, the overlap fired within ~15 turns; the longer run gives
 * the other invariants (compression budget, compile survival) something
 * meaningful to measure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { AutobiographicalStrategy } from '../src/index.js';
import { generateWorkload } from './_harness/workload.js';
import {
  runStrategyOnWorkload,
  type CompressionCallRecord,
  type StrategySnapshot,
} from './_harness/strategy-runner.js';

interface OverlapFinding {
  sourceId: string;
  firstOwner: string;
  secondOwner: string;
}

function findActiveL1Overlap(
  snapshot: StrategySnapshot,
): OverlapFinding | null {
  const ownerOf = new Map<string, string>();
  for (const s of snapshot.summaries) {
    if (s.level !== 1 || s.parentId) continue;
    for (const id of s.sourceIds) {
      const prior = ownerOf.get(id);
      if (prior !== undefined && prior !== s.id) {
        return { sourceId: id, firstOwner: prior, secondOwner: s.id };
      }
      ownerOf.set(id, s.id);
    }
  }
  return null;
}

function findDuplicateFirstId(
  snapshot: StrategySnapshot,
): { firstId: string; ids: string[] } | null {
  const byFirst = new Map<string, string[]>();
  for (const s of snapshot.summaries) {
    if (s.level !== 1 || s.parentId) continue;
    const arr = byFirst.get(s.sourceRange.first) ?? [];
    arr.push(s.id);
    byFirst.set(s.sourceRange.first, arr);
  }
  for (const [firstId, ids] of byFirst) {
    if (ids.length > 1) return { firstId, ids };
  }
  return null;
}

describe('AutobiographicalStrategy: long-context invariants', () => {
  it('active L1s stay disjoint, compressions bounded, compile survives', async () => {
    const turns = parseInt(process.env.LONG_TURNS ?? '200', 10);
    // Small messages + larger target → many "trailing partial chunk closes
    // before reaching target" events, the same pattern that triggers Bug A
    // in production. With healthy code this is uneventful; with the bug
    // live, L1 stacking appears within ~15 turns.
    const workload = generateWorkload({
      turns,
      avgUserTokens: 40,
      avgAssistantTokens: 80,
      toolCallProbability: 0.3,
      seed: 4242,
    });

    const result = await runStrategyOnWorkload(
      () =>
        new AutobiographicalStrategy({
          compressionModel: 'test-compression-model',
          targetChunkTokens: 500,
          recentWindowTokens: 600,
          headWindowTokens: 0,
          // Disable merges so L1s stay visible. Merging would hide
          // overlapping L1s behind a `parentId`, masking the bug class
          // this test exists to catch.
          mergeThreshold: 999,
        }),
      workload,
      {
        compressor: (call: CompressionCallRecord) =>
          `digest #${call.callIndex} (turn ${call.turnIndex})`,
        verbose: process.env.LONG_VERBOSE === '1',
        label: 'long-invariants',
      },
    );

    // --- Per-turn invariants. Fail on first violation; the assertion
    // message names the turn so the repro is one workload-seed away. ---
    for (const turn of result.perTurn) {
      const overlap = findActiveL1Overlap(turn.snapshot);
      if (overlap) {
        assert.fail(
          `turn ${turn.turnIndex + 1}/${result.perTurn.length}: ` +
            `source message ${overlap.sourceId} is claimed by both ` +
            `active L1 summaries ${overlap.firstOwner} and ${overlap.secondOwner}. ` +
            `This is the stacked-overlapping-L1 pattern from ` +
            `bug-compression-loop.md — a previously-compressed chunk was ` +
            `re-queued (likely after growth) and produced a second summary ` +
            `for an overlapping range instead of being recognized as the same logical chunk.`,
        );
      }

      const dup = findDuplicateFirstId(turn.snapshot);
      if (dup) {
        assert.fail(
          `turn ${turn.turnIndex + 1}/${result.perTurn.length}: ` +
            `active L1 summaries ${dup.ids.join(', ')} share sourceRange.first=${dup.firstId}. ` +
            `Two L1s starting at the same message ID — same logical chunk compressed twice.`,
        );
      }
    }

    // --- Non-vacuity. Compression defers indefinitely when history has
    // tool blocks but no tool definitions are declared; if that (or any
    // future gate) silences compression entirely, every invariant above
    // passes on an empty set. ---
    assert.ok(
      result.totalCompressions > 0,
      'no compression ran at all — invariants passed vacuously ' +
        '(check setToolDefinitions wiring in the harness)',
    );

    // --- Compression-call budget. Every chunk should be compressed about
    // once. Generous ceiling (2x active L1s + small slack) so legitimate
    // chunk reshapes don't trip us, but unbounded re-compression loops do. ---
    const finalSnap = result.perTurn[result.perTurn.length - 1].snapshot;
    const activeL1 = finalSnap.summaries.filter(
      (s) => s.level === 1 && !s.parentId,
    ).length;
    // Compressions ran (asserted above) but the snapshot shows no active
    // L1s → the harness's protected-field structural cast has drifted from
    // the strategy's actual field names, and every per-turn invariant above
    // was checked against empty state.
    assert.ok(
      activeL1 > 0,
      'compressions ran but the final snapshot has no active L1 summaries — ' +
        'the protected-field cast in test/_harness/strategy-runner.ts has ' +
        'likely drifted from AutobiographicalStrategy internals',
    );
    const ceiling = activeL1 * 2 + 4;
    assert.ok(
      result.totalCompressions <= ceiling,
      `Compression-call budget exceeded: ` +
        `${result.totalCompressions} calls vs ${activeL1} active L1s at end ` +
        `(ceiling ${ceiling}). Likely a re-compression loop.`,
    );

    // --- Compile pipeline survival. The known orphan-tool-use-at-head
    // edge case can fire occasionally on synthetic workloads; allow a
    // small fraction but cap at 5% so a broad composition regression surfaces. ---
    const errorFraction = result.compileErrors / result.perTurn.length;
    assert.ok(
      errorFraction < 0.05,
      `Compile errors fired on ${result.compileErrors}/${result.perTurn.length} ` +
        `turns (${(errorFraction * 100).toFixed(1)}%) — above 5% indicates ` +
        `a broad composition problem beyond the known orphan-tool-use edge case.`,
    );
  });
});
