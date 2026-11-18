import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

for (const scenario of ['success', 'repeat', 'mismatch', 'unsafe', 'opening-collision', 'receipt-inside', 'receipt-existing', 'provider-error', 'receipt-dangling', 'wrong-chunk', 'unreadable', 'clear-error', 'close-error', 'no-summary', 'refusal', 'fork-mismatch', 'wrong-range', 'summary-without-call', 'error-then-cap', 'receipt-sync-error']) {
  test(`executing surgery CLI offline: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ze-'));
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    try {
      const receiptPath = scenario === 'receipt-inside' ? join(dir, 'store', 'records.log') : join(dir, 'receipt.json');
      if (scenario === 'receipt-existing') writeFileSync(receiptPath, 'preserve me');
      if (scenario === 'receipt-dangling') symlinkSync(join(dir, 'missing'), receiptPath);
      const tracePath = join(dir, 'trace.jsonl');
      const storePath = join(dir, 'store');
      mkdirSync(storePath);
      writeFileSync(join(storePath, 'records.log'), 'stopped backup');
      writeFileSync(join(dir, 'tools.json'), '[]');
      writeFileSync(join(dir, 'op.json'), JSON.stringify({
        storePath, toolsPath: join(dir, 'tools.json'), receiptPath,
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
        SURGERY_TRACE: tracePath, SURGERY_RECEIPT: receiptPath, SURGERY_CASE: scenario } });
      if (scenario === 'receipt-inside' || scenario === 'receipt-existing' || scenario === 'receipt-dangling') {
        assert.equal(result.status, 1);
        assert.match(result.stderr, scenario === 'receipt-inside' ? /outside the disposable store/ : /EEXIST/);
        assert.ok(!existsSync(tracePath), 'receipt safety is checked before opening the store');
        if (scenario === 'receipt-dangling') return;
        assert.equal(readFileSync(receiptPath, 'utf8'), scenario === 'receipt-inside' ? 'stopped backup' : 'preserve me');
        return;
      }
      assert.match(result.stderr, /restore a fresh copy/, 'recovery guidance precedes mutation');
      assert.ok(existsSync(tracePath), result.stderr || result.stdout);
      const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const sent = trace.filter(event => event.sent).map(event => event.sent);
      assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stderr);
      assert.equal(sent.length, ['success', 'repeat', 'provider-error', 'close-error', 'refusal', 'wrong-range', 'error-then-cap', 'receipt-sync-error'].includes(scenario) ? 1 : 0);
      if (scenario === 'unsafe' || scenario === 'opening-collision') {
        assert.match(result.stdout, scenario === 'unsafe' ? /Raw recall-shaped/ : /collides with compression opening/);
        assert.ok(!trace.some(event => event.fork || event.cleared), 'source safety precedes mutation');
        assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).status, 'failed');
        return;
      }
      if (scenario === 'success') {
        assert.ok(trace.some(event => event.fork === 'surgery/offline'));
        assert.ok(trace.some(event => event.cleared === 'quarantined'));
      }
      if (scenario === 'wrong-chunk' || scenario === 'unreadable') {
        assert.ok(!trace.some(event => event.fork || event.cleared));
        assert.match(result.stdout, scenario === 'wrong-chunk' ? /does not belong/ : /ledger unreadable/);
      }
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (scenario === 'receipt-sync-error') {
        assert.match(result.stdout, /"status": "uncertain"/);
        assert.match(result.stdout, /final receipt sync failed/);
        assert.match(result.stdout, /"status": "completed"/);
        assert.ok(!result.stdout.includes('RECEIPT_SHA256'));
        return;
      }
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
      assert.ok(trace.filter(event => event.closed).every(event => event.statusAtClose !== 'finished'));
      if (scenario !== 'success' && scenario !== 'close-error') assert.equal(receipt.status, 'failed');
      if (scenario === 'fork-mismatch') {
        assert.ok(trace.some(event => event.fork));
        assert.ok(!trace.some(event => event.cleared));
      }
      if (scenario === 'close-error') {
        assert.equal(receipt.status, 'uncertain');
        assert.match(receipt.closeError, /durability is uncertain/);
        assert.equal(receipt.closeCause.message, "sync failed");
        assert.ok(!result.stdout.includes('"status": "finished"'));
      }
      if (scenario === 'success') {
        assert.equal(receipt.status, 'finished');
        assert.ok(result.stdout.includes('RECEIPT_SHA256 ' + hash(readFileSync(receiptPath, 'utf8'))));
      }
      if (scenario === 'clear-error') {
        assert.ok(trace.some(event => event.fork));
        assert.ok(trace.some(event => event.clearEntered === 'quarantined'));
        assert.match(receipt.error.message, /clear failed/);
      }
      if (scenario === 'provider-error') assert.ok(!(result.stdout + result.stderr).includes('private source echoed'));
      if (scenario === 'wrong-range') { assert.equal(receipt.call.status, 'completed'); assert.equal(receipt.after.newSummaries.length, 1); }
      if (scenario === 'summary-without-call') { assert.equal(receipt.call, null); assert.equal(receipt.after.newSummaries.length, 1); }
      if (scenario === 'error-then-cap') assert.match(receipt.error.message, /ONE_CALL_CAP/);
      if (scenario === 'repeat') assert.match(receipt.error.message, /ONE_CALL_CAP/);
      if (scenario === 'mismatch') assert.match(receipt.error.message, /differs from trusted/);
      if (scenario === 'provider-error') assert.equal(receipt.call.status, 'error');
      if (scenario !== 'success') assert.match(receipt.recovery, /restore a fresh copy/);
      else { assert.equal(receipt.after.newSummaries.length, 1); assert.equal(receipt.branch, 'surgery/offline'); }
      assert.equal(readFileSync(join(dir, 'store', 'records.log'), 'utf8'), 'stopped backup');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
