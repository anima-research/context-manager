import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { drainRecipeOptions } from '../scripts/drain-recipe-options.js';
import { pathToFileURL } from 'node:url';
import type { NormalizedRequest } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

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

it('drain executable dispatches a valid custom recipe through the real manager and store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-drain-valid-'));
  try {
    const store = join(dir, 'store');
    const manager = await ContextManager.open({ path: store, strategy: new AutobiographicalStrategy({
      headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false,
    }) });
    const source = manager.addMessage('user', [{ type: 'text', text: 'substantive offline source '.repeat(100) }]);
    manager.addMessage('Claude', [{ type: 'text', text: 'later source '.repeat(100) }]);
    manager.getStore().setStateJson('default/autobio:chunks', [{ id: 'seeded-raw', sourceIds: [source], compressed: false }]);
    manager.close();
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({ agent: { strategy: {
      headWindowTokens: 0, recentWindowTokens: 0, l1HoldbackChunks: 0, mergeThreshold: 99,
      compressionInstructions: { templates: { opening: 'DRAIN EXEC OPEN', chunk: 'DRAIN EXEC CHUNK {targetTokens}' } },
    } } }));
    const loader = pathToFileURL(resolve('test/fixtures/drain-execution-loader.mjs')).href;
    const registration = 'data:text/javascript,' + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`);
    const trace = join(dir, 'sent.jsonl');
    const result = spawnSync(process.execPath, ['--import', registration, resolve('dist/scripts/drain-autobiographical.js'),
      store, 'default', '--apply', '--model=mock-only', '--participant=Claude', '--max-steps=5', `--recipe=${recipe}`], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: 'offline', DRAIN_TRACE: trace },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(trace), 'real tick must actually dispatch');
    const calls: NormalizedRequest[] = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.length > 0 && calls.length <= 5);
    for (const request of calls) {
      const text = request.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text));
      assert.ok(text.includes('DRAIN EXEC OPEN'));
      assert.equal(text.at(-1), 'DRAIN EXEC CHUNK 2000');
    }
    assert.match(result.stdout, /"stopped":"drained"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
