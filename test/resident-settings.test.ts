import { it } from 'node:test';
import assert from 'node:assert/strict';
import { residentStrategyOptions } from '../scripts/resident-settings.js';
import { AutobiographicalStrategy } from '../src/index.js';

class Expose extends AutobiographicalStrategy {
  opening() { return this.getCompressionOpening(); }
}

const forward = (recipeStrategy: Record<string, unknown>) =>
  residentStrategyOptions(recipeStrategy, 'test-model', 'Ada');

it('resident settings forward recipe instructions, which the constructor validates', () => {
  const recipe = JSON.parse('{"agent":{"strategy":{"compressionInstructions":{"templates":{"opening":"DRAIN CUSTOM"}},"identityReminder":"REMINDER","unknown":"ignored"}}}');
  const forwarded = forward(recipe.agent.strategy);
  assert.deepEqual(forwarded.compressionInstructions, { templates: { opening: 'DRAIN CUSTOM' } });
  assert.equal(forwarded.identityReminder, 'REMINDER');
  assert.equal('unknown' in forwarded, false);
  assert.equal(new Expose(forwarded).opening(), 'DRAIN CUSTOM');
  assert.equal('compressionInstructions' in forward({}), false);
  for (const compressionInstructions of [{ templates: { opening: '{unknown}' } }, { preset: 'factual' }]) {
    const options = forward({ compressionInstructions });
    assert.deepEqual(options.compressionInstructions, compressionInstructions);
    assert.throws(() => new Expose(options as never), {
      name: 'TypeError', message: /^Invalid compressionInstructions configuration: /,
    });
  }
  assert.throws(() => new Expose(forward({
    witnessedInstruction: 'OLD', compressionInstructions: { templates: { witnessedChunk: 'NEW' } },
  })), { name: 'TypeError', message: 'Conflicting witnessed instruction configuration' });
});
