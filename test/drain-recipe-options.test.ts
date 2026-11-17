import { it } from 'node:test';
import assert from 'node:assert/strict';
import { drainRecipeOptions } from '../scripts/drain-recipe-options.js';
import { AutobiographicalStrategy } from '../src/index.js';

it('drain forwards synthetic recipe instructions before construction, which validates them', () => {
  class Expose extends AutobiographicalStrategy {
    opening() { return this.getCompressionOpening(); }
  }
  const recipe = JSON.parse('{"agent":{"strategy":{"compressionInstructions":{"templates":{"opening":"DRAIN CUSTOM"}},"identityReminder":"REMINDER","unknown":"ignored"}}}');
  const forwarded = drainRecipeOptions(recipe.agent.strategy);
  assert.deepEqual(forwarded, {
    compressionInstructions: { templates: { opening: 'DRAIN CUSTOM' } }, identityReminder: 'REMINDER',
  });
  assert.equal(new Expose(forwarded).opening(), 'DRAIN CUSTOM');
  assert.deepEqual(drainRecipeOptions({}), {});
  for (const compressionInstructions of [{ templates: { opening: '{unknown}' } }, { preset: 'factual' }]) {
    const options = drainRecipeOptions({ compressionInstructions });
    assert.deepEqual(options, { compressionInstructions });
    assert.throws(() => new Expose(options as never), {
      name: 'TypeError', message: /^Invalid compressionInstructions configuration: /,
    });
  }
  assert.throws(() => new Expose(drainRecipeOptions({
    witnessedInstruction: 'OLD', compressionInstructions: { templates: { witnessedChunk: 'NEW' } },
  })), { name: 'TypeError', message: 'Conflicting witnessed instruction configuration' });
});
