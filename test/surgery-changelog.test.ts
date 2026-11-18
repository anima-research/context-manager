import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Releases fold and delete fragments. Check Breaking, not the whole changelog.
function breakingText(root = '.'): string {
  const fragment = join(root, 'changelog.d/compression-recall-hook.breaking.md');
  if (existsSync(fragment)) return readFileSync(fragment, 'utf8');
  let inBreaking = false;
  return readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n').filter(line => {
    if (/^##? /.test(line)) inBreaking = false;
    if (/^### /.test(line)) inBreaking = /^### Breaking\b/.test(line);
    return inBreaking;
  }).join('\n');
}
function assertMigration(text: string) {
  assert.match(text, /provenanceMode.*authored-request/);
  assert.match(text, /external-receipt-only/);
}
test('receipt provenanceMode migration remains in Breaking after release', () => {
  assertMigration(breakingText());
});
test('changelog check handles consumed fragments and rejects a non-breaking migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'surgery-changelog-'));
  const migration = '- `provenanceMode` is `authored-request`, not `external-receipt-only`.';
  try {
    mkdirSync(join(root, 'changelog.d'));
    const fragment = join(root, 'changelog.d/compression-recall-hook.breaking.md');
    writeFileSync(fragment, migration);
    assertMigration(breakingText(root));
    rmSync(fragment);
    writeFileSync(join(root, 'CHANGELOG.md'), `# Changelog\n## 1.0.0\n### Breaking (subclass authors)\n${migration}\n### Fixed\n- Other fix.`);
    assertMigration(breakingText(root));
    writeFileSync(join(root, 'CHANGELOG.md'), `# Changelog\n## 1.0.0\n### Breaking\n- Other migration.\n### Fixed\n${migration}`);
    assert.throws(() => assertMigration(breakingText(root)));
  } finally { rmSync(root, {recursive:true, force:true}); }
});
