/**
 * Issue #41: OverBudgetError is cross-package behavioral surface.
 *
 * agent-framework gates its OverBudget drain breaker (AF PR #58) on this
 * error, but with the class buried in `adaptive/picker.ts` it could not
 * `instanceof` it across the package boundary and fell back to matching
 * `err.name === 'OverBudgetError'` — stringly-typed coupling that made the
 * constructor's message wording implicitly load-bearing.
 *
 * These tests pin the root export: the class is reachable from the package
 * root, it is the SAME class object the picker throws (so `instanceof`
 * works), and the diagnostics fields consumers read are present.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { OverBudgetError, UncoveredDropError } from '../src/index.js';
import type { OverBudgetDiagnostics } from '../src/index.js';
import {
  OverBudgetError as PickerOverBudgetError,
  UncoveredDropError as PickerUncoveredDropError,
} from '../src/adaptive/picker.js';

const diagnostics: OverBudgetDiagnostics = {
  headTokens: 1000,
  tailTokens: 2000,
  middleTokens: 5000,
  middleChunkCount: 7,
  deepestLevel: 3,
};

describe('OverBudgetError root export (issue #41)', () => {
  it('is the same class object as the one the picker throws', () => {
    // Identity, not just shape — if these ever diverge, a consumer's
    // root-import `instanceof` silently stops matching picker throws.
    assert.strictEqual(OverBudgetError, PickerOverBudgetError);
  });

  it('instanceof works on an error constructed by the picker module', () => {
    const err: unknown = new PickerOverBudgetError({ budget: 4000, actual: 8000, diagnostics });
    assert.ok(err instanceof OverBudgetError);
    assert.ok(err instanceof Error);
  });

  it('carries the diagnostics shape consumers read', () => {
    const err = new OverBudgetError({ budget: 4000, actual: 8000, diagnostics });
    assert.strictEqual(err.budget, 4000);
    assert.strictEqual(err.actual, 8000);
    assert.deepStrictEqual(err.diagnostics, diagnostics);
  });

  it('keeps name (the pre-export detection contract AF currently relies on)', () => {
    const err = new OverBudgetError({ budget: 4000, actual: 8000, diagnostics });
    assert.strictEqual(err.name, 'OverBudgetError');
  });
});

describe('UncoveredDropError root export (issue #41)', () => {
  // AF gates its context_refusal classification on this error by name too
  // (framework.ts classifyInferenceError) — same boundary, same fix.
  it('is the same class object as the one the picker throws', () => {
    assert.strictEqual(UncoveredDropError, PickerUncoveredDropError);
  });

  it('instanceof works and name is kept', () => {
    const err: unknown = new PickerUncoveredDropError({
      droppedIds: ['chunk-1', 'chunk-2'],
      site: 'selectHierarchical',
      diagnostics: { budget: 4000, totalTokens: 8000 },
    });
    assert.ok(err instanceof UncoveredDropError);
    assert.strictEqual((err as Error).name, 'UncoveredDropError');
  });
});
