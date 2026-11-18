import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

it('operation benchmark reaches real compressed selection, adaptive picker, provider and reload paths', () => {
  const output = execFileSync(process.execPath, ['scripts/bench-operation-scope.mjs', 'dist/src/index.js', '--smoke'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  const rows = output.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.mode), ['raw', 'compressed', 'adaptive']);
  for (const row of rows) {
    assert.ok(row.compileMedianMs >= 0);
    assert.ok(row.reloadMs >= 0);
    assert.ok(row.cappedForSendCalls > 0, row.mode);
    if (row.mode !== 'raw') {
      assert.equal(row.rendersSummary, true);
      assert.ok(row.summaries > 0, `${row.mode} must actually create summaries`);
      assert.ok(row.providerCalls > 0, `${row.mode} must actually compress`);
      assert.ok(row.compressionMedianMs >= 0);
    }
    if (row.mode === 'adaptive') assert.ok(row.buildPickerCalls > 0);
  }
});
