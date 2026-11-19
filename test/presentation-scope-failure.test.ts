/**
 * A stored row whose onNewMessage adapter can't observe its presentation
 * scope (the store's branch) or window mode stays pending in memory on the
 * manager rather than failing the add after storing. The backlog is
 * logged once per failure episode and counted by stats().
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';
import { markStoreBranchSwitch, observeStoreBranch } from '../src/branch-generation.js';

const inside = (value: object): any => value;

async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'presentation-scope-'));
  const store = JsStore.openOrCreate({ path });
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0 });
  const manager = await ContextManager.open({ store, strategy });
  return { store, strategy, manager, close() { manager.close(); store.close(); rmSync(path, { recursive: true, force: true }); } };
}

/** A strategy with only the legacy onNewMessage hook, as a custom adapter has. */
async function legacyFixture() {
  const path = mkdtempSync(join(tmpdir(), 'presentation-scope-legacy-'));
  const heard: string[] = [];
  const manager = await ContextManager.open({ path, strategy: {
    name: 'legacy-notifications',
    checkReadiness() { return { ready: true }; },
    select() { throw new Error('not used'); },
    async onNewMessage(row: { id: string }) { heard.push(row.id); },
  } });
  const raw = inside(manager);
  const lines: string[] = [];
  raw.diag = {
    error(...args: unknown[]) { lines.push(args.map(String).join(' ')); },
    warn(...args: unknown[]) { lines.push(args.map(String).join(' ')); },
  };
  return { manager, raw, heard, lines, close() { manager.close(); rmSync(path, { recursive: true, force: true }); } };
}

it('a stored legacy presentation is deferred when scope observation fails, and the failed drain stops', async () => {
  const fx = await fixture(); const manager = inside(fx.manager); let heard = 0;
  try {
    Object.defineProperty(fx.strategy, 'onPresented', { configurable: true, value: undefined });
    (fx.strategy as any).onNewMessage = async () => { heard++; };
    manager.diag = { error() {}, warn() {} };
    const scope = manager.hookScope;
    let failedObservations = 0;
    manager.hookScope = () => {
      // An unbounded drain escapes at ten so the regression fails, not hangs.
      if (++failedObservations >= 10) return scope.call(manager);
      throw new Error('scope unavailable');
    };
    const id = fx.manager.addMessage('User', [{ type: 'text', text: 'stored' }]);
    assert.equal(heard, 0);
    assert.ok(manager.presentedUnheard.has(id));
    fx.manager.addMessage('User', [{ type: 'text', text: 'pending too' }]);
    assert.equal(heard, 0);
    assert.ok(failedObservations < 10, 'failed drain must stop instead of retrying its own requeue');
    assert.equal(manager.presentedUnheard.size, 2);
    manager.hookScope = scope;
    fx.manager.addMessage('User', [{ type: 'text', text: 'next' }]);
    assert.equal(heard, 3);
    assert.equal(manager.presentedUnheard.size, 0);
  } finally { fx.close(); }
});

for (const drain of [false, true]) {
  it(`legacy add notifications survive a failed mode lookup (${drain ? 'drain' : 'initial delivery'})`, async () => {
    const path = mkdtempSync(join(tmpdir(), 'presentation-mode-'));
    const heard: string[] = [];
    let arm = false;
    let failMode = false;
    const strategy = {
      name: 'legacy-notifications',
      checkReadiness() { return { ready: true }; },
      select() { throw new Error('not used'); },
      get onNewMessage() {
        // Fail the adapter's observation, after the append's legacy check.
        if (arm) { arm = false; failMode = true; }
        return async (row: { id: string }) => { heard.push(row.id); };
      },
    };
    const manager = await ContextManager.open({ path, strategy });
    const raw = inside(manager);
    const mode = raw.windowIndex.mode;
    const hookScope = raw.hookScope;
    let failScope = drain;
    let failures = 0;
    raw.diag = { error() {}, warn() {} };
    raw.windowIndex.mode = function () {
      if (failMode) { failMode = false; failures++; throw new Error('mode unavailable'); }
      return mode.call(this);
    };
    raw.hookScope = function () {
      if (failScope) { failScope = false; throw new Error('scope unavailable'); }
      return hookScope.call(this);
    };
    try {
      arm = !drain;
      const first = manager.addMessage('user', [{ type: 'text', text: 'first' }]);
      assert.deepEqual(heard, []);
      // In the drain case the first add queued a known legacy row. Fail the
      // retried adapter lookup, then give a third public notification to retry.
      arm = drain;
      const second = manager.addMessage('user', [{ type: 'text', text: 'second' }]);
      const third = drain ? manager.addMessage('user', [{ type: 'text', text: 'third' }]) : undefined;
      assert.equal(failures, 1, 'the mode observation must actually fail');
      assert.deepEqual(heard, [first, second, ...(third ? [third] : [])]);
      assert.deepEqual(manager.getAllMessages().map(row => row.id), heard, 'each stored row is heard once, in order');
    } finally { manager.close(); rmSync(path, { recursive: true, force: true }); }
  });
}

it('an unreadable presentation mode does not grant legacy delivery on another branch', async () => {
  const fx = await fixture(); const manager = inside(fx.manager); let heard = 0;
  const mode = manager.windowIndex.mode;
  try {
    Object.defineProperty(fx.strategy, 'onPresented', { configurable: true, value: undefined });
    (fx.strategy as any).onNewMessage = async () => { heard++; };
    manager.diag = { error() {}, warn() {} };
    const id = fx.manager.addMessage('User', [{ type: 'text', text: 'shared record' }]);
    fx.store.createBranchAt('other-legacy', 'main', fx.store.currentSequence());
    fx.manager.presentRows([]);
    fx.manager.retractRows([id]);
    heard = 0;
    let failMode = true;
    Object.defineProperty(fx.strategy, 'onNewMessage', { configurable: true, get() {
      if (failMode) {
        failMode = false;
        manager.windowIndex.mode = function () {
          manager.windowIndex.mode = mode;
          throw new Error('mode unavailable');
        };
      }
      return async () => { heard++; };
    } });
    fx.manager.presentRows([id]);
    assert.equal(manager.presentedUnheard.get(id), false, 'unknown mode cannot confer legacy eligibility');
    await fx.manager.switchBranch('other-legacy');
    assert.equal(heard, 0);
  } finally { manager.windowIndex.mode = mode; fx.close(); }
});

it('a persistent scope failure logs once per episode and stats() shows the in-memory backlog', async () => {
  const fx = await legacyFixture();
  const hookScope = fx.raw.hookScope;
  try {
    const healthy = fx.manager.stats().pendingStrategyNotifications;
    assert.deepEqual(healthy, { presented: 0, retracted: 0, presentationScopeFailing: false });
    fx.raw.hookScope = () => { throw new Error('scope unavailable'); };
    const stored: string[] = [];
    for (let i = 0; i < 50; i++) stored.push(fx.manager.addMessage('user', [{ type: 'text', text: `row ${i}` }]));
    assert.deepEqual(fx.heard, [], 'no row is heard while the scope is unreadable');
    assert.deepEqual(fx.manager.stats().pendingStrategyNotifications, { presented: 50, retracted: 0, presentationScopeFailing: true });
    const failures = fx.lines.filter(line => line.includes('presentation scope lookup failed'));
    assert.equal(failures.length, 1, `one failure line per episode, not per add; got ${fx.lines.length} lines`);
    assert.match(failures[0]!, /in memory on this manager until a later notification/);
    assert.match(failures[0]!, /close discards them/);

    fx.raw.hookScope = hookScope;
    stored.push(fx.manager.addMessage('user', [{ type: 'text', text: 'after recovery' }]));
    assert.deepEqual(fx.heard, stored, 'every stored row is heard once, in order, at the next notification');
    assert.deepEqual(fx.manager.stats().pendingStrategyNotifications, { presented: 0, retracted: 0, presentationScopeFailing: false });
    assert.equal(fx.lines.filter(line => line.includes('presentation scope lookup recovered')).length, 1);

    // A second episode is logged again.
    fx.raw.hookScope = () => { throw new Error('scope unavailable again'); };
    fx.manager.addMessage('user', [{ type: 'text', text: 'second episode' }]);
    fx.manager.addMessage('user', [{ type: 'text', text: 'second episode, more' }]);
    assert.equal(fx.lines.filter(line => line.includes('presentation scope lookup failed')).length, 2);
    assert.equal(fx.manager.stats().pendingStrategyNotifications.presented, 2);
  } finally { fx.raw.hookScope = hookScope; fx.close(); }
});

it('a throwing onPresented/onNewMessage member lookup is contained after the row is stored', async () => {
  const path = mkdtempSync(join(tmpdir(), 'presentation-lookup-'));
  const lines: string[] = [];
  const manager = await ContextManager.open({ path, strategy: {
    name: 'throwing-lookup',
    checkReadiness() { return { ready: true }; },
    select() { throw new Error('not used'); },
    get onPresented(): never { throw new Error('lookup unavailable'); },
  } });
  inside(manager).diag = { error(...args: unknown[]) { lines.push(args.map(String).join(' ')); }, warn() {} };
  try {
    const id = manager.addMessage('user', [{ type: 'text', text: 'stored' }]);
    assert.deepEqual(manager.getAllMessages().map(row => row.id), [id], 'the add returns its stored id');
    assert.equal(lines.filter(line => line.includes('presentation hook lookup failed')).length, 1);
  } finally { manager.close(); rmSync(path, { recursive: true, force: true }); }
});

for (const operation of ['switchBranch', 'fork'] as const) {
  it(`${operation} rejects a requested B superseded during bookkeeping by C`, async () => {
    const fx = await fixture(), branch = fx.store.currentBranch;
    try {
      fx.store.createBranchAt('B', 'main', fx.store.currentSequence());
      fx.store.createBranchAt('C', 'main', fx.store.currentSequence());
      let armed = true;
      fx.store.currentBranch = function () {
        const result = branch.call(this);
        if (armed && result.name === 'B') { armed = false; this.switchBranch('C'); markStoreBranchSwitch(this); }
        return result;
      };
      if (operation === 'fork') fx.store.deleteBranch('B');
      await assert.rejects(fx.manager[operation]('B'), /supersed|requested B/i);
      assert.equal(branch.call(fx.store).name, 'C');
    } finally { fx.store.currentBranch = branch; fx.close(); }
  });
}

it('unstable fork bookkeeping blocks mutations and identifies the created branch and recovery', async () => {
  const fx = await fixture(), branch = fx.store.currentBranch;
  try {
    let nested = false;
    fx.store.currentBranch = function () {
      const result = branch.call(this);
      if (!nested && result.name !== 'main') {
        nested = true;
        try { markStoreBranchSwitch(this); } finally { nested = false; }
      }
      return result;
    };
    await assert.rejects(fx.manager.fork('created-B'), /created-B.*earlier.*inspect.*retry/i);
    fx.store.currentBranch = branch;
    assert.throws(() => fx.manager.addMessage('User', [{ type: 'text', text: 'must be blocked' }]), /requires successful strategy initialization/);
    await fx.manager.setStrategy(fx.strategy);
    fx.manager.addMessage('User', [{ type: 'text', text: 'recovered' }]);
  } finally { fx.store.currentBranch = branch; fx.close(); }
});

for (const observe of [observeStoreBranch, markStoreBranchSwitch]) {
  it(`${observe.name} reconciles even when a nested record matches a stale outer name`, async () => {
    const fx = await fixture(), branch = fx.store.currentBranch;
    try {
      fx.store.createBranchAt('B', 'main', fx.store.currentSequence());
      let armed = true;
      fx.store.currentBranch = function () {
        const captured = branch.call(this);
        if (armed) { armed = false; markStoreBranchSwitch(this); this.switchBranch('B'); }
        return captured;
      };
      assert.equal(observe(fx.store).name, 'B');
    } finally { fx.store.currentBranch = branch; fx.close(); }
  });
}

/** An app-owned store, so stats() still answers after close(). */
async function closingFixture() {
  const path = mkdtempSync(join(tmpdir(), 'presentation-scope-close-'));
  const store = JsStore.openOrCreate({ path });
  const heard: string[] = [];
  const manager = await ContextManager.open({ store, strategy: {
    name: 'legacy-notifications',
    checkReadiness() { return { ready: true }; },
    select() { throw new Error('not used'); },
    async onNewMessage(row: { id: string }) { heard.push(row.id); },
  } });
  const raw = inside(manager);
  return { store, manager, raw, heard, close() { manager.close(); store.close(); rmSync(path, { recursive: true, force: true }); } };
}

it('a retry drain whose failing scope lookup closes the manager does not restore its rows', async () => {
  const fx = await closingFixture();
  try {
    fx.raw.diag = { error() {}, warn() {} };
    const scope = fx.raw.hookScope;
    let lookups = 0;
    fx.raw.hookScope = function (this: unknown) {
      // Only the delivery's own lookup fails: the first add's, then the drain's.
      if (new Error().stack!.includes('tellPresented') && ++lookups <= 2) {
        if (lookups === 2) fx.manager.close();
        throw new Error('adapter branch unavailable');
      }
      return scope.call(this);
    };
    fx.manager.addMessage('User', [{ type: 'text', text: '1' }]);
    fx.manager.addMessage('User', [{ type: 'text', text: '2' }]);
    assert.equal(lookups, 2);
    assert.equal(fx.manager.isClosed(), true);
    assert.equal(fx.raw.presentedUnheard.size, 0, 'close discards pending rows');
    assert.equal(fx.manager.stats().pendingStrategyNotifications.presented, 0);
    assert.deepEqual(fx.heard, []);
  } finally { fx.close(); }
});

it('a recovery log sink that closes the manager stops the drain before any row is delivered', async () => {
  const fx = await closingFixture();
  try {
    fx.raw.diag = {
      error() {},
      warn(line: unknown) { if (String(line).includes('lookup recovered')) fx.manager.close(); },
    };
    const scope = fx.raw.hookScope;
    let lookups = 0;
    fx.raw.hookScope = function (this: unknown) {
      if (new Error().stack!.includes('tellPresented') && ++lookups === 1) throw new Error('adapter branch unavailable');
      return scope.call(this);
    };
    fx.manager.addMessage('User', [{ type: 'text', text: '1' }]);
    fx.manager.addMessage('User', [{ type: 'text', text: '2' }]);
    assert.equal(fx.manager.isClosed(), true, 'the recovery line closed the manager');
    assert.deepEqual(fx.heard, [], 'nothing reaches the strategy after close');
    assert.equal(fx.raw.presentedUnheard.size, 0);
  } finally { fx.close(); }
});
