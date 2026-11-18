/** Local cancellation ownership and stale-result health/report callbacks. */
import { it } from 'node:test';
import { AsyncResource } from 'node:async_hooks';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';

const inside = (value: object): any => value;
async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'c13-'));
  const store = JsStore.openOrCreate({ path });
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false });
  const manager = await ContextManager.open({ store, strategy });
  return { store, strategy, manager, close() { manager.close(); store.close(); rmSync(path, { recursive: true, force: true }); } };
}

it('library provider cancellation preserves the cancelled origin, including an abort listener timer', async () => {
  const fx = await fixture();
  let settle!: (value: unknown) => void;
  let timerDone!: () => void;
  const done = new Promise<void>(resolve => { timerDone = resolve; });
  let failure: unknown;
  const pending = inside(fx.strategy).callProvider({ complete(_request: unknown, { signal }: { signal: AbortSignal }) {
    signal.addEventListener('abort', () => {
      setTimeout(() => {
        try { fx.strategy.resetHeadWindow('obsolete-abort-timer'); }
        catch (error) { failure = error; }
        finally { timerDone(); }
      }, 0);
    }, { once: true });
    return new Promise(resolve => { settle = resolve; });
  } }, {});
  try {
    await fx.manager.setStrategy(fx.strategy);
    await done;
    assert.ok(failure instanceof Error, 'cancelled provider timer must refuse its old origin');
    assert.match(failure.message, /stale|reinitializ/);
    assert.notEqual(inside(fx.strategy).headWindowStartId, 'obsolete-abort-timer');
  } finally { settle({}); await pending; fx.close(); }
});

for (const replacement of ['setStrategy', 'switchBranch', 'fork'] as const) {
  it(`a host interval's stale debt error handler never throws after ${replacement}`, async () => {
    const fx = await fixture();
    let run!: () => void;
    let done!: () => void;
    const completed = new Promise<void>(resolve => { done = resolve; });
    let failure: unknown;
    let report: ReturnType<AutobiographicalStrategy['getCompressionDebt']> | undefined;
    // The alarm's host callback owns its interval; gate execution until reload.
    let armed = false;
    const timer = inside(fx.strategy).branchOperations.run(inside(fx.strategy).loadedBranchIdentity, () => {
      fx.strategy.setQuarantineAlarmHandler(() => {
        run = () => { try { report = fx.strategy.getCompressionDebt(); } catch (error) { failure = error; } finally { done(); } };
      });
      inside(fx.strategy).onQuarantineAlarm({ count: 1, keys: [], spans: [] });
      return setInterval(() => { if (armed) { armed = false; run(); } }, 1);
    });
    try {
      if (replacement === 'setStrategy') await fx.manager.setStrategy(fx.strategy);
      else if (replacement === 'fork') await fx.manager.fork('next');
      else await fx.manager.switchBranch('main');
      inside(fx.strategy).compressionDebtFailureLogged = 'replacement log state';
      armed = true;
      await completed;
      assert.equal(failure, undefined);
      assert.equal(report?.state, 'unknown');
      assert.equal(report?.failure, 'report');
      assert.equal(inside(fx.strategy).compressionDebtFailureLogged, 'replacement log state');
    } finally { clearInterval(timer); fx.close(); }
  });
}

it('repair handler can reload synchronously while draining the same process-wide queue', async () => {
  const fx = await fixture();
  let replacement: Promise<void> | undefined;
  const handed: string[] = [];
  try {
    const queue = inside(fx.strategy).heldLoadRepairs;
    inside(fx.strategy).deliverLoadRepair({ stateId: 'first' });
    inside(fx.strategy).deliverLoadRepair({ stateId: 'second' });
    assert.doesNotThrow(() => fx.strategy.setLoadRepairHandler(report => {
      handed.push(report.stateId);
      if (!replacement) replacement = fx.manager.setStrategy(fx.strategy);
    }));
    await replacement;
    assert.equal(inside(fx.strategy).heldLoadRepairs, queue);
    assert.deepEqual(handed, ['first', 'second']);
    assert.equal(fx.strategy.getLatestLoadRepairReport()?.stateId, 'second');
  } finally { await replacement; fx.close(); }
});

it('alarm episode clocks and handlers are cross-load metadata, not cloned branch mirrors', async () => {
  const fx = await fixture();
  try {
    const scope = { ns: 'same', branch: 'same' };
    inside(fx.strategy).quarantineAlarmScope = scope;
    await fx.manager.setStrategy(fx.strategy);
    assert.equal(inside(fx.strategy).quarantineAlarmScope, scope);
    // A host callback may register process-wide handlers after its load ends.
    const old = inside(fx.strategy).branchOperations.run(inside(fx.strategy).loadedBranchIdentity,
      () => new Promise<void>((resolve, reject) => setImmediate(() => {
        try {
          fx.strategy.setQuarantineAlarmHandler(() => {});
          inside(fx.strategy).quarantineAlarmLastAt = 123;
          inside(fx.strategy).quarantineAlarmActive = true;
          assert.equal(inside(fx.strategy).quarantineAlarmLastAt, 123);
          assert.equal(inside(fx.strategy).quarantineAlarmActive, true);
          resolve();
        } catch (error) { reject(error); }
      })));
    await fx.manager.setStrategy(fx.strategy);
    await old;
  } finally { fx.close(); }
});

it('release migration names host callback refusals, dispatch limits and the internal error constructor', () => {
  const breaking = readdirSync('changelog.d').filter(name => name.startsWith('cm490-') && name.endsWith('.breaking.md'))
    .map(name => readFileSync(join('changelog.d', name), 'utf8')).join('\n') +
    // Release folding consumes fragments; keep validating the published migration.
    readFileSync('CHANGELOG.md', 'utf8').split(/^### /m).filter(section => section.startsWith('Breaking\n'))
      .map(section => section.split(/^## /m)[0]).join('\n');
  assert.match(breaking, /\*\*Host callback owners/);
  assert.match(breaking, /not exported/);
  assert.match(breaking, /instanceof/);
  assert.match(breaking, /dispatcher/);
  assert.match(breaking, /runInAsyncScope/);
  const prose = (text: string) => text.replace(/\n\s*\*?\s*/g, ' ');
  const lifecyclePath = 'changelog.d/cm490-operation-scope.added.md';
  const lifecycle = readFileSync(existsSync(lifecyclePath) ? lifecyclePath : 'CHANGELOG.md', 'utf8');
  const types = readFileSync('src/types/strategy.ts', 'utf8');
  const guidance = readFileSync('docs/keyed-compression-quarantine.md', 'utf8');
  // Check the migration's concepts independently; equivalent wording in one
  // document must not require synchronized literal prose in all the others.
  for (const text of [breaking, lifecycle, types, guidance].map(prose)) {
    assert.match(text, /lifecycle/i);
    assert.match(text, /(?:supported only through|must be invoked via)\s+`?ContextManager/);
    assert.match(text, /direct.{0,100}(?:unsupported|not supported)/i);
    assert.match(text, /invalidat.{0,50}(?:load|generation)/i);
    assert.match(text, /throw/i);
  }
  assert.match(breaking, /abort listeners/);
  assert.match(breaking, /prototype/);
});

it('new operation-scope release entries are not presented as fixes to released scope machinery', () => {
  for (const name of ['cm490-r11c.fixed.md', 'cm490-r11d.fixed.md', '490-lifecycle-override-origins.fixed.md']) {
    assert.ok(!readdirSync('changelog.d').includes(name), `${name} describes newly added machinery`);
  }
  const path = 'changelog.d/cm490-continuations.fixed.md';
  const fixes = existsSync(path) ? readFileSync(path, 'utf8') : ''; // consumed at release
  assert.doesNotMatch(fixes, /epoch|Guarded mirror|Nested operation|Stale continuation/);
});

it('an uncertain final reset retains the original typed failure as its cause', async () => {
  const fx = await fixture();
  const original = new TypeError('custom reset failed', { cause: new Error('original cause') });
  try {
    Object.defineProperty(fx.strategy, 'resetHeadWindow', { configurable: true, value() { throw original; } });
    await assert.rejects(fx.manager.resetHeadWindow('transition'), error => {
      assert.equal((error as Error).cause, original);
      assert.match((error as Error).message, /another transition message/);
      return true;
    });
  } finally { fx.close(); }
});


it('startup AsyncResource dispatch leaves both old boundary and strategy storage', async () => {
  const dispatcher = new AsyncResource('host-startup-dispatch');
  const fx = await fixture();
  try {
    const raw = inside(fx.strategy);
    await raw.branchOperations.run(raw.loadedBranchIdentity, async () => {
      await dispatcher.runInAsyncScope(async () => {
        await fx.manager.fork('fresh-dispatch');
        assert.equal(fx.store.currentBranch().name, 'fresh-dispatch');
        assert.notEqual(fx.strategy.getCompressionDebt().state, 'unknown');
        const id = fx.manager.addMessage('User', [{ type: 'text', text: 'fresh intent' }]);
        assert.doesNotThrow(() => fx.strategy.resetHeadWindow(id));
        assert.equal(raw.headWindowStartId, id);
      });
      assert.equal(fx.strategy.getCompressionDebt().state, 'unknown', 'dispatch does not rebind the obsolete caller');
    });
  } finally { dispatcher.emitDestroy(); fx.close(); }
});
