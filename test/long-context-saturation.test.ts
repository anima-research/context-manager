/**
 * Saturation liveness — the regression gate for the 2026-08-03 production
 * outage class (boter clerk, fail→wake→fail on `UncoveredDropError`).
 *
 * A long-lived agent's summary pyramid grows monotonically. The legacy
 * hierarchical renderer emits head → summaries → middle → tail with no
 * tail reservation and no way to shed summary mass, so at a fixed budget
 * it eventually cannot afford its own recent window: newest-first
 * eviction digs into the recent window, the evicted messages have no
 * summary coverage (the recent window is excluded from the compressible
 * zone), and under the fatal coverage invariant (76e95a0, v0.6.0) the
 * compile refuses. The refusal is terminal — the host-side drain breaker
 * kicks tick(), but compression is forbidden for exactly the span that
 * was dropped. Long-lived agents belong on the adaptive path, which
 * solves a frontier TO FIT the budget: tail reserved first, older
 * history folding deeper until it fits.
 *
 * Pinned here:
 *  1. adaptive + kv-stable stays live — zero refusals — across a workload
 *     whose raw history is many multiples of the compile budget;
 *  2. under pathological pressure, any refusal the adaptive path does
 *     produce is the recoverable class (`OverBudgetError`, which the
 *     drain breaker can act on), never `UncoveredDropError`.
 *
 * The hierarchical renderer's saturation refusal is documented behavior,
 * deliberately not asserted: pinning brokenness would turn a future fix
 * into a test failure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { AutobiographicalStrategy } from '../src/index.js';
import { generateWorkload } from './_harness/workload.js';
import { runStrategyOnWorkload } from './_harness/strategy-runner.js';

const UNCOVERED_SIGNATURE = /no summary covers/i;
const OVERBUDGET_SIGNATURE = /exceed hard budget/i;

function adaptiveStrategy(overrides: Record<string, unknown> = {}): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    compressionModel: 'mock-compressor',
    targetChunkTokens: 500,
    headWindowTokens: 0,
    recentWindowTokens: 2000,
    ...overrides,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
}

describe('AutobiographicalStrategy: budget-saturation liveness (adaptive)', () => {
  it('compiles every turn with raw history at several times the budget', async () => {
    // ~400 turns × ~90 avg tokens ≈ 36k raw against an 11k select target:
    // deep folding is mandatory well before the run ends. Tool-free on
    // purpose: the harness compiles after EVERY message, including mid
    // tool-cycle (assistant tool_use stored, tool_result not yet) — a moment
    // real hosts never compile at — and the pairing trims then refuse the
    // turn for reasons orthogonal to the budget geometry pinned here. Tool
    // pairing has its own gates (tool-pairing-invariant, chunker-tool-boundary).
    const workload = generateWorkload({
      turns: 400,
      avgUserTokens: 60,
      avgAssistantTokens: 120,
      toolCallProbability: 0,
      seed: 20260803,
    });

    const result = await runStrategyOnWorkload(
      () => adaptiveStrategy(),
      workload,
      {
        label: 'saturation-live',
        compileBudget: { maxTokens: 12_000, reserveForResponse: 1_000 },
        compressor: (call) =>
          `Recalled span ${call.callIndex}: routine exchange, nothing externally binding.`,
      },
    );

    const failed = result.perTurn.filter((t) => t.compileError !== undefined);
    assert.strictEqual(
      result.compileErrors,
      0,
      `adaptive path refused ${result.compileErrors}/${result.perTurn.length} turns; ` +
        `first: turn ${failed[0]?.turnIndex}: ${failed[0]?.compileError}`,
    );
  });

  it('never refuses with UncoveredDropError, even under pathological pressure', async () => {
    // Deliberately cruel geometry: a tiny budget with a proportionally large
    // reserved tail and bloated summaries. Refusals are acceptable here —
    // but every refusal must be the recoverable class. An uncovered drop
    // means the renderer lost history without representation: the terminal,
    // breaker-immune outage shape.
    // Tool-free for the same reason as above.
    const workload = generateWorkload({
      turns: 300,
      avgUserTokens: 80,
      avgAssistantTokens: 160,
      toolCallProbability: 0,
      seed: 803,
    });

    const result = await runStrategyOnWorkload(
      () => adaptiveStrategy({ recentWindowTokens: 1500, targetChunkTokens: 400 }),
      workload,
      {
        label: 'saturation-pathological',
        compileBudget: { maxTokens: 6_000, reserveForResponse: 1_000 },
        // Bloated summaries: each recall pair costs a large slice of the
        // budget, forcing merge pressure and, eventually, hard refusals.
        compressor: (call) =>
          `Recalled span ${call.callIndex}: ` + 'remembered detail, '.repeat(40),
      },
    );

    const uncovered = result.perTurn.filter(
      (t) => t.compileError !== undefined && UNCOVERED_SIGNATURE.test(t.compileError),
    );
    assert.strictEqual(
      uncovered.length,
      0,
      `adaptive path produced ${uncovered.length} uncovered-drop refusal(s); ` +
        `first: turn ${uncovered[0]?.turnIndex}: ${uncovered[0]?.compileError}`,
    );

    // Sanity on the signature itself: if refusals happened, they must be the
    // over-budget class — a rewording of either error message would rot both
    // regexes silently, so pin the one we expect to see.
    const refusals = result.perTurn.filter((t) => t.compileError !== undefined);
    for (const t of refusals) {
      assert.ok(
        OVERBUDGET_SIGNATURE.test(t.compileError!),
        `turn ${t.turnIndex}: unexpected refusal class: ${t.compileError}`,
      );
    }
  });
});
