import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
  })), { name: 'TypeError', message: 'Conflicting witnessedInstruction and compressionInstructions.templates.witnessedChunk; remove one setting' });
});

it('drain executable rejects conflicting forwarded settings before tools/store access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-drain-'));
  try {
    const recipe = join(dir, 'recipe.json');
    const store = join(dir, 'must-not-exist');
    writeFileSync(recipe, JSON.stringify({ agent: { strategy: {
      witnessedInstruction: '', compressionInstructions: { templates: { witnessedChunk: 'CUSTOM' } },
    } } }));
    const result = spawnSync(process.execPath, [resolve('dist/scripts/drain-autobiographical.js'),
      store, 'test', '--apply', '--model=mock-only', '--participant=Test',
      `--recipe=${recipe}`, `--tools-log=${join(dir, 'missing-tools')}`], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: 'synthetic-not-a-key' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Conflicting witnessedInstruction and compressionInstructions.templates.witnessedChunk; remove one setting/);
    assert.ok(!existsSync(store));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
