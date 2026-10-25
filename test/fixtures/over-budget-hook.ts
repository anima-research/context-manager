/**
 * Records what each refusal through `AutobiographicalStrategy`'s protected
 * `overBudgetError` hook was given, so a test can check that an override of
 * the hook still gets a library stage's words as `stage`, as it did before
 * `stageId`. Importing this wraps the hook for the importing test file.
 */
import assert from 'node:assert/strict';
import { AutobiographicalStrategy, OverBudgetError } from '../../src/index.js';

type HookOptions = { stage?: string; stageId?: string };

/** The words each of AutobiographicalStrategy's stages gave the hook before stageId, as `main` gave them. */
const HOOK_WORDS: Record<string, string> = {
  'head-tail-reservation': 'Head/tail reservation exceeded budget',
  'emission-overran-plan': 'Emission overran the plan (planner/emitter estimator drift)',
  'tail-emission-dropped': 'Tail emission dropped reserved recent-window messages',
  'repair-lost-newest-turn': 'Structural repair did not retain the newest turn',
  'hierarchical-emission-overran': 'Hierarchical emission overran the budget',
  'hierarchical-system-changes': 'Hierarchical: its system changes alone exceed the budget',
};

const given = new WeakMap<OverBudgetError, HookOptions>();
const proto = AutobiographicalStrategy.prototype as unknown as {
  overBudgetError(budget: unknown, opts: HookOptions): OverBudgetError;
};
const original = proto.overBudgetError;
proto.overBudgetError = function (this: unknown, budget: unknown, opts: HookOptions): OverBudgetError {
  const error = original.call(this, budget, opts);
  given.set(error, { stage: opts.stage, stageId: opts.stageId });
  return error;
};

/**
 * `error` is an `OverBudgetError` naming `stageId`. A refusal of
 * `AutobiographicalStrategy`'s (any but passthrough's and windowed
 * passthrough's) came through the hook, which was given that id and exactly
 * the words `main` gave it, which open its message, or, for the picker's own
 * refusal, neither, as before.
 */
export function assertStage(error: unknown, stageId: string): void {
  assert.ok(error instanceof OverBudgetError, String(error));
  assert.equal(error.stageId, stageId);
  const hook = given.get(error);
  if (stageId.startsWith('windowed-') || stageId.startsWith('passthrough-')) return;
  assert.ok(hook !== undefined, `${stageId}: the refusal came through the hook`);
  if (stageId === 'picker-exhausted') {
    assert.deepEqual(hook, { stage: undefined, stageId: undefined }, 'the picker\'s refusal gives the hook no stage');
    return;
  }
  assert.equal(hook.stageId, stageId);
  assert.equal(hook.stage, HOOK_WORDS[stageId], `${stageId}: the hook was given the words main gave it`);
  assert.ok(error.message.startsWith(`${hook.stage} but `), `the words open the message: ${error.message.slice(0, 80)}`);
}
