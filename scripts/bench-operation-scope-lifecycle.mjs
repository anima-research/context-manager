// Offline SF1 probe. Build first, then run in a fresh node --expose-gc process
// per size/mode. "disable" is a counterfactual, NOT a safe production policy:
// this fixture installs no callbacks or provider work that can outlive close.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager } from '../dist/src/index.js';

const count = Number(process.argv[2] ?? 500);
const mode = process.argv[3] ?? 'retain';
if (!Number.isSafeInteger(count) || count < 0 || !['retain', 'disable'].includes(mode) || !global.gc) {
  throw new Error('Usage: node --expose-gc scripts/bench-operation-scope-lifecycle.mjs [count] [retain|disable]');
}
const path = mkdtempSync(join(tmpdir(), 'cm-als-'));
const store = JsStore.openOrCreate({ path });
async function lifecycle(cleanup) {
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false });
  strategy.diag = { debug() {}, info() {}, warn() {}, error() {} };
  const manager = await ContextManager.open({ store, strategy, namespace: 'als' });
  manager.close();
  if (cleanup) strategy.branchOperations.storage.disable();
}
async function unrelatedAwaits() {
  for (let i = 0; i < 20_000; i++) await null;
}
try {
  await lifecycle(true); // register persistent states and warm the common path
  for (let i = 0; i < count; i++) await lifecycle(mode === 'disable');
  // Measure from a host context, after the final closed manager unwinds.
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 4; i++) global.gc();
  const { heapUsed } = process.memoryUsage();
  await unrelatedAwaits();
  const ms = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await unrelatedAwaits();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(JSON.stringify({ node: process.version, count, mode, heapUsed, medianMs: ms[2], ms }));
} finally {
  store.close();
  rmSync(path, { recursive: true, force: true });
}
