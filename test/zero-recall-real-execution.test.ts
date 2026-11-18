import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

for (const scenario of ['sdk-rate', 'sdk-overload', 'carrier', 'rejection', 'rate', 'overload', 'merge-cap', 'merge-relief', 'merge-failed', 'merge-empty', 'mismatch']) {
  test(`surgery CLI with real manager and public strategy tick: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zr-'));
    try {
      const storePath = join(dir, 'store');
      const options = { compressionModel: 'mock', headWindowTokens: 0, recentWindowTokens: 0,
        targetChunkTokens: 100, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
        mergeThreshold: 99, autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0,
        compressionRefusalCurveFallbacks: 0, compressionSourceOnlyFallback: true,
        ...(scenario === 'merge-cap' ? {maxSpeculativeL1s: 0} : {}) };
      const manager = await ContextManager.open({ path: storePath, strategy: new AutobiographicalStrategy(options) });
      const first = manager.addMessage('user', [{type:'text',text:'covered history'}]);
      const second = manager.addMessage('user', [{type:'text',text:'second covered history'}]);
      const source = manager.addMessage('user', [{type:'text',text:'raw source '.repeat(80)}]);
      manager.addMessage('user', [{type:'text',text:'tail '.repeat(100)}]);
      manager.getStore().setStateJson('default/autobio:summaries', [{ id:'L1-100', level:1,
        sourceLevel:0, sourceIds:[first], sourceRange:{first,last:first}, content:'prior memory', tokens:20, created:1 }, { id:'L1-101', level:1, sourceLevel:0, sourceIds:[second],
        sourceRange:{first:second,last:second}, content:'second prior memory', tokens:20, created:2 }]);
      manager.getStore().setStateJson('default/autobio:chunks', [
        {id:'c-first',sourceIds:[first],compressed:true,summaryId:'L1-100'},
        {id:'c-second',sourceIds:[second],compressed:true,summaryId:'L1-101'},
        {id:'c-source',sourceIds:[source],compressed:false}]);
      manager.getStore().registerState({ id: 'default/autobio:compression-refusal-quarantine', strategy: 'snapshot' });
      manager.getStore().setStateJson('default/autobio:compression-refusal-quarantine', [{
        key: 'fixture', familyKey: 'fixture-family', model: 'mock', sourceIds: [source],
        chunkSourceHash: createHash('sha256').update(JSON.stringify([source])).digest('hex'),
        normalizedConfig: { accountingVersion: 2 }, created: 1,
      }]);
      manager.close();
      const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
      const receiptPath = join(dir,'receipt.json');
      writeFileSync(join(dir,'tools.json'), '[]');
      writeFileSync(join(dir,'op.json'), JSON.stringify({ storePath, toolsPath:join(dir,'tools.json'), receiptPath,
        expectedRecordsSha256:hash(readFileSync(join(storePath,'records.log'))), expectedToolsSha256:hash('[]'),
        namespace:'default', branchName:'surgery/test', expectedParentBranch:'main', targetChunkIndex:2,
        expectedSourceRange:[source,source], expectedQuarantineKey:'fixture', summaryParticipant:'Claude',
        strategyConfig:options, acknowledgeStoppedCopiedOrBackedUpStore:true }));
      const loader = pathToFileURL(resolve('test/fixtures/zero-recall-real-loader.mjs')).href;
      const registration = 'data:text/javascript,' + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`);
      const log = join(dir,'log.jsonl');
      const result = spawnSync(process.execPath, ['--import',registration,resolve('dist/scripts/one-shot-zero-recall-surgery.js'), '--config',join(dir,'op.json'),'--execute'], {
        encoding:'utf8', timeout:30000, env:{...process.env,ANTHROPIC_API_KEY:'offline',SURGERY_CASE:scenario,
          SURGERY_TRACE:join(dir,'sent'),SURGERY_STATE:join(dir,'state'),CONTEXT_MANAGER_COMPRESSION_LOG:log} });
      assert.ok(existsSync(receiptPath), result.stdout + result.stderr);
      const receipt = JSON.parse(readFileSync(receiptPath,'utf8'));
      const state = JSON.parse(readFileSync(join(dir,'state'),'utf8'));
      const logs = existsSync(log) ? readFileSync(log,'utf8') : '';
      assert.ok(!(result.stdout + result.stderr + logs + JSON.stringify(state)).includes('private source echoed'));
      assert.equal(receipt.clearedQuarantineKey, 'fixture', result.stdout + result.stderr);
      if (scenario === 'carrier' || scenario === 'rejection') {
        assert.equal(state.pause, undefined, 'unsent call-cap withdrawal never pauses the lane');
        assert.equal(receipt.error?.name, 'CompressionWithdrawn');
        assert.match(receipt.error?.message ?? '', /ONE_CALL_CAP/, 'a second admission actually reached the cap');
      }
      if (scenario !== 'merge-empty' && scenario !== 'mismatch') assert.ok(existsSync(join(dir,'sent')), result.stdout + result.stderr);
      assert.equal(existsSync(join(dir,'sent')) ? readFileSync(join(dir,'sent'),'utf8').trim().split('\n').length : 0, scenario === 'merge-empty' || scenario === 'mismatch' ? 0 : 1, 'at most one provider call');
      if (scenario === 'mismatch') {
        assert.equal(result.status, 1);
        assert.equal(receipt.status, 'failed');
        assert.equal(receipt.error.name, 'CompressionWithdrawn');
        assert.match(receipt.error.message, /differs from trusted/);
        assert.equal(receipt.call, null);
        assert.equal(state.pause, undefined);
        assert.equal(state.progress, null, 'local mismatch records no ladder outcome');
        assert.equal(state.l1Failures.length, 0);
        assert.equal(state.l1Runs.length, 0);
        assert.equal(receipt.after.quarantine.count, 0, 'only the explicitly cleared operator hold changed');
      } else if (scenario === 'merge-empty') {
        assert.equal(result.status,1);
        assert.equal(receipt.status,'failed');
        assert.equal(state.mergeFailures.length,0);
        assert.equal(state.mergeRuns.length,0);
        assert.equal(state.mergeQueue.length,1);
      } else if (scenario.startsWith('merge-')) {
        assert.equal(result.status,0,result.stdout + result.stderr);
        assert.equal(receipt.status,'finished');
        assert.equal(receipt.after.newSummaries.length,1);
        assert.equal(state.mergeFailures.length,0);
        assert.equal(state.mergeRuns.length,0);
        assert.ok(state.mergeQueue.some((m: {sourceIds:string[]}) => m.sourceIds.includes('L1-101')), 'unrelated merge stays queued');
      } else if (scenario.startsWith('sdk-')) {
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(receipt.call.status, 'error');
        const sends = readFileSync(join(dir,'sent'),'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(sends, [{sdkRetries:0, redirect:'error'}], 'real CLI installed one-send SDK policy');
        assert.equal(receipt.call.providerError.httpStatus, scenario === 'sdk-rate' ? 429 : 500);
      } else {
        assert.equal(result.status,1);
        assert.equal(receipt.status,'failed');
        assert.equal(receipt.call.providerError.name,'ProviderError');
        assert.equal(receipt.call.providerError.httpStatus, scenario === 'rate' ? 429 : scenario === 'overload' ? 529 : 400);
        assert.equal(receipt.call.providerError.type, scenario === 'rate' ? 'rate_limit' : scenario === 'overload' ? 'overloaded' : 'invalid_request');
        if (scenario === 'carrier' || scenario === 'rejection') {
          assert.ok(JSON.stringify(state.progress).includes(scenario === 'carrier' ? 'canonical:carrier-rejected' : 'provider_error'), JSON.stringify(state));
          if (scenario === 'carrier') assert.match(logs,/carrier-transport-fallback/);
        } else assert.match(JSON.stringify(state), new RegExp(`${scenario === 'rate' ? 'rate_limit' : 'overloaded'}:${scenario === 'rate' ? 429 : 529}`));
      }
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
}
