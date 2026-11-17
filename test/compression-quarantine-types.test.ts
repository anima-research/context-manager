import { it } from 'node:test';
import assert from 'node:assert/strict';
import { isKeyedCompressionQuarantineStrategy, type ContextManager, type ContextStrategy } from '../src/index.js';

// Compile-only: mirrors the documentation, including explicit operator choice.
async function documentedSelection(manager: ContextManager, operatorSelectedKey: string) {
  const strategy = manager.getStrategy();
  if (!isKeyedCompressionQuarantineStrategy(strategy)) throw new Error('unsupported');
  const view = strategy.inspectCompressionRefusalQuarantine({ limit: 50 });
  if (view.status !== 'ok') throw new Error(`Quarantine unavailable: ${view.status}`);
  const selected = view.records.find((record) => record.key === operatorSelectedKey);
  if (!selected || !selected.selectable || selected.generation === null) throw new Error('unavailable');
  const intent = { key: selected.key, expectedGeneration: selected.generation, expectedBinding: view.binding };
  // Only after separate confirmation and revalidation of this loaded instance:
  return strategy.releaseCompressionRefusalQuarantine({ ...intent });
}

// A two-method guard cannot establish unrelated members on unknown input.
function capabilityNarrowing(unknownValue: unknown, strategy: ContextStrategy) {
  if (isKeyedCompressionQuarantineStrategy(unknownValue)) {
    unknownValue.inspectCompressionRefusalQuarantine();
    // @ts-expect-error only the two checked methods are established
    unknownValue.initialize;
    // @ts-expect-error no full strategy contract was validated
    const full: ContextStrategy = unknownValue;
    void full;
  }
  if (isKeyedCompressionQuarantineStrategy(strategy)) {
    strategy.initialize; // existing ContextStrategy type survives as intersection
    strategy.inspectCompressionRefusalQuarantine();
  }
}
void documentedSelection;
void capabilityNarrowing;

it('F9 recognizes only the optional two-method capability at runtime', () => {
  const onlyTwo = { inspectCompressionRefusalQuarantine() {}, releaseCompressionRefusalQuarantine() {} };
  assert.equal(isKeyedCompressionQuarantineStrategy(onlyTwo), true);
  assert.equal('initialize' in onlyTwo, false);
  assert.equal(isKeyedCompressionQuarantineStrategy({ inspectCompressionRefusalQuarantine() {} }), false);
});
