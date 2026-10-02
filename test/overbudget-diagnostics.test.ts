import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, OverBudgetError } from '../src/index.js';
import type { SummaryEntry, SummaryLevel } from '../src/types/index.js';
import { Picker, type PickerInputs } from '../src/adaptive/picker.js';
import type { FoldingBudget } from '../src/adaptive/folding-strategy.js';

class DiagnosticStrategy extends AutobiographicalStrategy {
  level = 1;
  drift = false;
  useRealPicker = false;

  seedPyramid(ids: string[], depth: number): void {
    for (let level = 1; level <= depth; level++) {
      const content = 'summary '.repeat(100);
      const summary: SummaryEntry = {
        id: `L${level}-diagnostic`,
        level: level as SummaryLevel,
        sourceLevel: (level - 1) as SummaryLevel,
        sourceIds: level === 1 ? ids : [`L${level - 1}-diagnostic`],
        sourceRange: { first: ids[0], last: ids[ids.length - 1] },
        content,
        tokens: 200,
        created: 0,
        ...(level < depth ? { mergedInto: `L${level + 1}-diagnostic` } : {}),
      };
      this.pushSummary(summary);
    }
  }

  protected buildPicker(inputs: PickerInputs): Picker {
    if (this.useRealPicker) return super.buildPicker(inputs);
    const level = this.level;
    class DriftPicker extends Picker {
      run(inputs: PickerInputs, budget: FoldingBudget) {
        const result = super.run(inputs, budget);
        return { ...result, finalTokens: 1, budgetMet: true };
      }
    }
    const Constructor = this.drift ? DriftPicker : Picker;
    return new Constructor({
      name: 'diagnostic-fixture',
      solve: (inputs) => ({
        frontier: new Map(inputs.chunks.map(chunk => [chunk.id, chunk.pinned || !chunk.l1Id ? 0 : level])),
        produced: [],
      }),
    });
  }
}

async function withManager(strategy: AutobiographicalStrategy, run: (manager: ContextManager) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'cm-budget-diagnostics-'));
  const manager = await ContextManager.open({ path: join(directory, 'store'), strategy });
  try {
    await run(manager);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function refusal(manager: ContextManager): Promise<OverBudgetError> {
  try {
    await manager.compile({ maxTokens: 100, reserveForResponse: 20 });
    assert.fail('compile should refuse');
  } catch (error) {
    assert.ok(error instanceof OverBudgetError);
    return error;
  }
}

function checkBudget(error: OverBudgetError): void {
  // Runtime shape assertions also run against the old implementation.
  assert.equal(Reflect.get(error.diagnostics, 'configuredBudget'), 100);
  assert.equal(Reflect.get(error.diagnostics, 'reserveForResponse'), 20);
  assert.equal(Reflect.get(error.diagnostics, 'inputBudget'), 80);
  assert.equal(error.budget, 100, '25% grace applies to the 80-token input budget');
  assert.match(error.message, /configured=100, response reserve=20, input budget=80/);
}

describe('OverBudgetError diagnostics', () => {
  for (const adaptiveResolution of [true, false]) {
    it(`reports budget arithmetic and empty inventory for an early ${adaptiveResolution ? 'adaptive' : 'hierarchical'} refusal`, async () => {
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution,
        headWindowTokens: 10_000,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
        const error = await refusal(manager);
        checkBudget(error);
        assert.equal(Reflect.get(error.diagnostics, 'deepestAvailableLevel'), 0);
        assert.deepEqual(Reflect.get(error.diagnostics, 'summaryCountsByLevel'), {});
        assert.match(error.message, /summary inventory: empty/);
      });
    });
  }

  for (const level of [1, 5]) {
    it(`distinguishes planned L${level} from available L5 and render units from summaries`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: true,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.level = level;
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 12 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        strategy.seedPyramid(ids, 5);
        // A locked planned representation still counts toward the plan's depth.
        for (const id of ids) strategy.lockChunk(id);
        const error = await refusal(manager);
        checkBudget(error);
        assert.equal(error.diagnostics.deepestLevel, level);
        assert.equal(Reflect.get(error.diagnostics, 'deepestAvailableLevel'), 5);
        assert.deepEqual(Reflect.get(error.diagnostics, 'summaryCountsByLevel'), { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
        assert.equal(error.diagnostics.middleChunkCount, 12);
        assert.match(error.message, /across 12 render units/);
        assert.match(error.message, new RegExp(`deepest fold level=L${level}, deepest available level=L5`));
        assert.match(error.message, /summary inventory: L1=1 L2=1 L3=1 L4=1 L5=1/);
      });
    });
  }

  it('enriches emission-stage failures as well as picker-stage failures', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.drift = true;
    strategy.level = 5;
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'raw '.repeat(200) }]);
      const id = manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
      strategy.seedPyramid([id], 5);
      const error = await refusal(manager);
      assert.match(error.message, /^Emission overran the plan/);
      checkBudget(error);
      assert.equal(error.diagnostics.deepestLevel, 5, 'the first raw emission fails, but the complete plan reaches L5');
      assert.equal(Reflect.get(error.diagnostics, 'deepestAvailableLevel'), 5);
      assert.deepEqual(Reflect.get(error.diagnostics, 'summaryCountsByLevel'), { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
    });
  });

  it('logs both depths when the real kv-stable solver escalates', async (t) => {
    const logs: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.map(String).join(' ')));
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      foldingStrategy: 'kv-stable',
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.useRealPicker = true;
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 12 }, () =>
        manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]));
      strategy.seedPyramid(ids, 5);
      const error = await refusal(manager);
      const escalation = logs.find(line => line.startsWith('[kv-escalation]'));
      assert.ok(escalation, 'fixture must exercise an actual solver override');
      assert.match(escalation, new RegExp(`deepestPlannedLevel=L${error.diagnostics.deepestLevel}`));
      assert.match(escalation, /deepestAvailableLevel=L5/);
    });
  });

  it('keeps the original external constructor shape usable without inventing inventory', () => {
    const diagnostics = { headTokens: 1, tailTokens: 2, middleTokens: 3, middleChunkCount: 4, deepestLevel: 0 };
    const error = new OverBudgetError({ actual: 6, budget: 5, diagnostics });
    assert.strictEqual(error.diagnostics, diagnostics);
    assert.equal(error.name, 'OverBudgetError');
    assert.match(error.message, /across 4 render units/);
    assert.doesNotMatch(error.message, /available|inventory|configured|undefined/);
  });
});
