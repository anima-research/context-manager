import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('receipt provenanceMode migration is in Breaking, not Fixed', () => {
  const breaking = readFileSync('changelog.d/compression-recall-hook.breaking.md','utf8');
  const fixed = readFileSync('changelog.d/zero-recall-construction.added.md','utf8');
  assert.match(breaking, /provenanceMode.*authored-request/);
  assert.match(breaking, /external-receipt-only/);
  assert.ok(!fixed.includes('**Surgery receipt consumers:**'));
});
