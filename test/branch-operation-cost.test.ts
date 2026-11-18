import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy } from '../src/strategies/autobiographical.js';
import { ContextManager } from '../src/context-manager.js';
import { BranchOperationScope, callStrategy, registerUnfencedStrategy } from '../src/branch-operation-scope.js';

it('ordinary add fence work stays bounded as record and message history grows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-'));
  const strategy = new AutobiographicalStrategy({
    autoTickOnNewMessage: false, compressionModel: 'offline', targetChunkTokens: 200,
    headWindowTokens: 0, recentWindowTokens: 0, l1HoldbackChunks: 1, quarantineAlarmIntervalMs: 0,
  });
  // Count ALL context resolutions (including helper wrappers) and mirror
  // guards, not just store probes or wall time. Instrument after installation.
  const scope = (strategy as any).branchOperations;
  let contexts = 0, mirrors = 0;
  const context = scope.context, guard = scope.assertBindingCurrent;
  scope.context = function () { contexts++; return context.call(this); };
  scope.assertBindingCurrent = function () { mirrors++; return guard.call(this); };
  const manager = await ContextManager.open({ path: dir, strategy });
  try {
    const samples: Array<{ contexts: number; mirrors: number }> = [];
    for (let i = 0; i <= 4096; i++) {
      contexts = mirrors = 0;
      manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `MSG-${i} ${'word '.repeat(110)}` }]);
      if (i === 1024 || i === 4096) samples.push({ contexts, mirrors });
    }
    assert.ok((strategy as any).chunkRecords.length >= 1024, 'real persisted chunk history reached');
    for (const sample of samples) {
      assert.ok(sample.contexts > 0 && sample.mirrors > 0, 'fence probes actually ran');
      assert.ok(sample.contexts < 500 && sample.mirrors < 200, JSON.stringify(samples));
    }
    assert.ok(samples[1]!.contexts <= samples[0]!.contexts + 10, JSON.stringify(samples));
    assert.ok(samples[1]!.mirrors <= samples[0]!.mirrors + 10, JSON.stringify(samples));
  } finally { manager.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('explicit unfenced fast path is revoked by fence installation and never transferred to proxies', () => {
  const target = {};
  registerUnfencedStrategy(target);
  let symbols = 0;
  const proxy = new Proxy(target, { get(object, key, receiver) {
    if (typeof key === 'symbol') symbols++;
    return Reflect.get(object, key, receiver);
  } });
  assert.equal(callStrategy(target, 'read', () => 1), 1);
  assert.equal(callStrategy(proxy, 'read', () => 2), 2);
  assert.equal(symbols, 1, 'unknown proxy still resolves the protocol inside a boundary');
  let captures = 0;
  const scope = new BranchOperationScope(() => { captures++; return {}; }, () => true, () => 0);
  scope.install(target, new Set(), new Set());
  assert.equal(callStrategy(target, 'read', () => scope.identity !== undefined), true);
  assert.equal(captures, 1, 'installed fence cannot be bypassed by an earlier opt-out');
});

it('operation-local helpers still refuse stale mirror access after a generation change', () => {
  class Target {
    rows: number[] = [];
    helper() { this.rows.push(1); }
  }
  let generation = 0;
  const target = new Target();
  const original = target.rows;
  const scope = new BranchOperationScope(() => ({}), () => true, () => generation);
  scope.install(target, new Set(), new Set());
  callStrategy(target, 'work', () => {
    const helper = scope.local(target, target.helper);
    helper();
    generation++;
    assert.throws(helper, /stale branch/);
  });
  assert.deepEqual(original, [1]);
});
