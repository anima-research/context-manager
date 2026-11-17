import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('preview validates instruction settings without opening a store or using a provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zp-'));
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  try {
    // Deliberately not a Chronicle store: preview must not try opening it.
    writeFileSync(join(dir, 'records.log'), 'hash-only preview');
    writeFileSync(join(dir, 'tools.json'), '[]');
    const config = { storePath: dir, toolsPath: join(dir, 'tools.json'),
      expectedRecordsSha256: hash('hash-only preview'), expectedToolsSha256: hash('[]'),
      branchName: 'surgery/preview', targetChunkIndex: 0,
      acknowledgeStoppedCopiedOrBackedUpStore: true,
      strategyConfig: { compressionInstructions: { templates: { chunk: 'bad {unknownPlaceholder}' } } } };
    const path = join(dir, 'op.json');
    const preview = () => spawnSync(process.execPath,
      [resolve('dist/scripts/one-shot-zero-recall-surgery.js'), '--config', path],
      { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' }, timeout: 30000 });
    writeFileSync(path, JSON.stringify(config));
    const invalid = preview();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Invalid compressionInstructions/);
    config.strategyConfig.compressionInstructions.templates.chunk = 'valid {targetTokens}';
    writeFileSync(path, JSON.stringify(config));
    const valid = preview();
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).execute, false);
    assert.deepEqual(readdirSync(dir).sort(), ['op.json', 'records.log', 'tools.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
