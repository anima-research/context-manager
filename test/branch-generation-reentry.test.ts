import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsStore } from '@animalabs/chronicle';
import { observeStoreBranch, markStoreBranchSwitch } from '../src/branch-generation.js';
import { compressionQuarantineHolds } from '../src/strategies/autobiographical.js';

it('observation reconciles a reentered branch when the outer read returns another name', () => {
  let name = 'A'; let hook: (() => void) | undefined;
  const store = { currentBranch() { const run = hook; hook = undefined; run?.(); return { name }; } } as JsStore;
  const a = observeStoreBranch(store);
  hook = () => { name = 'B'; observeStoreBranch(store); name = 'A'; };
  const current = observeStoreBranch(store);
  assert.equal(current.name, 'A');
  assert.ok(current.generation > a.generation);
  assert.equal(observeStoreBranch(store), current);
});
it('outer switch cannot overwrite a newer reentrant switch observation', () => {
  let name = 'A'; let hook: (() => void) | undefined;
  const store = { currentBranch() { const result = { name }; const run = hook; hook = undefined; run?.(); return result; } } as JsStore;
  observeStoreBranch(store);
  let nested: ReturnType<typeof markStoreBranchSwitch> | undefined;
  name = 'B'; hook = () => { name = 'C'; nested = markStoreBranchSwitch(store); };
  assert.equal(markStoreBranchSwitch(store), nested);
  assert.equal(observeStoreBranch(store), nested);
});
it('repair projection never reads a superseded legacy snapshot beside a non-list ledger', () => {
  const result = compressionQuarantineHolds({ damaged: true }, () => { throw new Error('obsolete snapshot'); });
  assert.deepEqual(result.unlisted, ['the ledger']);
  assert.equal(result.holds(['a']), false);
});

it('a switch reconciles a nested observation followed by a real switch back', () => {
  let name = 'A'; let hook: (() => void) | undefined;
  const store = { currentBranch() { const result = { name }; const run = hook; hook = undefined; run?.(); return result; } } as JsStore;
  const a = observeStoreBranch(store);
  name = 'B';
  hook = () => { name = 'C'; observeStoreBranch(store); name = 'B'; };
  const current = markStoreBranchSwitch(store);
  assert.equal(current.name, 'B');
  assert.ok(current.generation > a.generation);
  assert.equal(observeStoreBranch(store), current);
});

it('persistently reentrant observation refuses instability without unbounded recursion', () => {
  let nested = false;
  let reads = 0;
  let armed = false;
  const store = { currentBranch() {
    if (++reads > 20) throw new Error('unbounded observation');
    if (nested) return { name: 'B' };
    if (armed) {
      nested = true;
      markStoreBranchSwitch(store);
      nested = false;
    }
    return { name: 'A' };
  } } as JsStore;
  observeStoreBranch(store);
  armed = true;
  assert.throws(() => observeStoreBranch(store), /did not stabilize/);
  assert.ok(reads < 10);
});
