/** A refused compile must not commit its rejected fold frontier. */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { OverBudgetError } from '../src/adaptive/index.js';
import type { PickerInputs } from '../src/adaptive/picker.js';

const PATH = './test-overbudget-transaction-store';
const clean = () => { if (existsSync(PATH)) rmSync(PATH, { recursive: true, force: true }); };

class RejectedFrontierStrategy extends AutobiographicalStrategy {
  persistCalls = 0;
  reportedTokens = 10_000;
  protected buildPicker(inputs: PickerInputs): any {
    const finalResolutions = new Map(inputs.chunks.map((c) => [c.id, 1]));
    return {
      solverName: 'rejected-frontier-fixture',
      run: () => ({
        finalResolutions,
        produced: [],
        finalTokens: this.reportedTokens,
        budgetMet: false,
        exhausted: true,
        moves: finalResolutions.size,
        deadFrontierIds: 0,
        unrealizable: 0,
      }),
    };
  }
  protected persistResolutions(): void {
    this.persistCalls++;
    (super.persistResolutions as () => void).call(this);
  }
  resolutionSnapshot(): Record<string, number> {
    return Object.fromEntries((this as any).resolutions as Map<string, number>);
  }
}

describe('rejected compile is resolution-transactional', () => {
  beforeEach(clean);
  after(clean);

  it('throws without changing or persisting the carried resolution frontier', async () => {
    const strategy = new RejectedFrontierStrategy({
      compressionModel: 'mock',
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      targetChunkTokens: 40,
      autoTickOnNewMessage: false,
    });
    const manager = await ContextManager.open({ path: PATH, strategy });
    for (let i = 0; i < 12; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Turn ${i}. ${'word '.repeat(30)}` }]);
    }
    const before = strategy.resolutionSnapshot();
    await assert.rejects(
      manager.compile({ maxTokens: 500, reserveForResponse: 100 }),
      (err: unknown) => err instanceof OverBudgetError,
    );
    assert.deepStrictEqual(strategy.resolutionSnapshot(), before,
      'a rejected frontier must not become the next compile\'s carried state');
    assert.strictEqual(strategy.persistCalls, 0,
      'a rejected frontier must not be persisted to Chronicle');
    manager.close();
  });

  it('also rolls back the frontier when final emission — not the picker plan — exceeds budget', async () => {
    const strategy = new RejectedFrontierStrategy({
      compressionModel: 'mock',
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      targetChunkTokens: 40,
      autoTickOnNewMessage: false,
    });
    // Lie low at plan time; level-1 summaries do not exist, so rendering must
    // fall back to the large raw middle and fail at the emission hard wall.
    strategy.reportedTokens = 100;
    const manager = await ContextManager.open({ path: PATH, strategy });
    for (let i = 0; i < 12; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Turn ${i}. ${'word '.repeat(30)}` }]);
    }
    const before = strategy.resolutionSnapshot();
    await assert.rejects(
      manager.compile({ maxTokens: 500, reserveForResponse: 100 }),
      (err: unknown) => err instanceof OverBudgetError,
    );
    assert.deepStrictEqual(strategy.resolutionSnapshot(), before,
      'a late emission refusal must not commit the rejected frontier');
    assert.strictEqual(strategy.persistCalls, 0,
      'a late emission refusal must not persist the rejected frontier');
    manager.close();
  });
});
