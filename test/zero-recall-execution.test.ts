import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

for (const scenario of ['success', 'repeat', 'mismatch', 'unsafe', 'provider-error']) {
  test(`executing surgery CLI offline: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ze-'));
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    try {
      const receiptPath = join(dir, 'receipt.json');
      const tracePath = join(dir, 'trace.jsonl');
      writeFileSync(join(dir, 'records.log'), 'stopped backup');
      writeFileSync(join(dir, 'tools.json'), '[]');
      writeFileSync(join(dir, 'op.json'), JSON.stringify({
        storePath: dir, toolsPath: join(dir, 'tools.json'), receiptPath,
        expectedRecordsSha256: hash('stopped backup'), expectedToolsSha256: hash('[]'),
        namespace: 'offline', branchName: 'surgery/offline', expectedParentBranch: 'main',
        targetChunkIndex: 0, expectedSourceRange: ['first', 'last'], expectedQuarantineKey: 'quarantined',
        summaryParticipant: 'Claude', strategyConfig: { compressionInstructions: { templates: { opening: 'offline opening' } } }, acknowledgeStoppedCopiedOrBackedUpStore: true,
      }));
      const loader = pathToFileURL(resolve('test/fixtures/zero-recall-execution-loader.mjs')).href;
      const registration = 'data:text/javascript,' + encodeURIComponent(
        `import { register } from 'node:module'; register(${JSON.stringify(loader)});`);
      const result = spawnSync(process.execPath, ['--import', registration,
        resolve('dist/scripts/one-shot-zero-recall-surgery.js'), '--config', join(dir, 'op.json'), '--execute'],
      { encoding: 'utf8', timeout: 30000, env: { ...process.env, ANTHROPIC_API_KEY: 'offline-stub-only',
        SURGERY_TRACE: tracePath, SURGERY_CASE: scenario } });
      assert.ok(existsSync(tracePath), result.stderr || result.stdout);
      const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const sent = trace.filter(event => event.sent).map(event => event.sent);
      assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stderr);
      assert.equal(sent.length, ['success', 'repeat', 'provider-error'].includes(scenario) ? 1 : 0);
      if (scenario === 'unsafe') {
        assert.match(result.stderr, /Raw recall-shaped/);
        assert.ok(!trace.some(event => event.fork || event.cleared), 'source safety precedes mutation');
        assert.ok(!existsSync(receiptPath));
        return;
      }
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (sent.length) {
        assert.deepEqual(sent[0].messages.map((m: { content: unknown }) => m.content), [
          [{ type: 'text', text: 'offline opening' }],
          [{ type: 'text', text: 'raw source must survive' }],
        ]);
        assert.deepEqual(receipt.call.removedRecallIds, ['memory']);
        assert.equal(receipt.call.originalMessages, 4);
        assert.equal(receipt.call.sentMessages, 2);
        assert.equal(receipt.provenanceMode, 'authored-request');
        assert.equal(receipt.call.transformedMessagesSha256, hash(JSON.stringify(sent[0].messages)));
        const original = trace.find(event => event.original).original;
        assert.equal(original.messages.length, 4);
        assert.equal(receipt.call.originalMessagesSha256, hash(JSON.stringify(original.messages)));
        assert.equal(receipt.call.originalRequestSha256, hash(JSON.stringify(original.messages)),
          'legacy original alias hashes the pre-surgery messages, not the authored request');
        assert.equal(receipt.call.transformedRequestSha256, hash(JSON.stringify(sent[0].messages)),
          'legacy transformed alias hashes the messages actually sent');
        assert.equal(receipt.call.originalRequestSha256, receipt.call.originalMessagesSha256);
        assert.equal(receipt.call.transformedRequestSha256, receipt.call.transformedMessagesSha256);
        assert.notEqual(receipt.call.originalRequestSha256, receipt.call.transformedRequestSha256);
      }
      if (scenario === 'repeat') assert.match(receipt.error.message, /ONE_CALL_CAP/);
      if (scenario === 'mismatch') assert.match(receipt.error.message, /differs from trusted/);
      if (scenario === 'provider-error') assert.equal(receipt.call.status, 'error');
      if (scenario !== 'success') assert.match(receipt.recovery, /restore a fresh copy/);
      else assert.equal(receipt.after.newSummaries.length, 1);
      assert.equal(readFileSync(join(dir, 'records.log'), 'utf8'), 'stopped backup');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
