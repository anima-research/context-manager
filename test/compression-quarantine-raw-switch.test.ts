/**
 * A store adapter that moves the raw store handle from inside its own
 * branch read, a switch the manager does not track. These pin what the
 * keyed release and the legacy clear still promise there: no acknowledgement
 * that the release's own post-write reread contradicts, and no write
 * authorized by a branch the operation never validated. The reread reads the
 * branch the handle is on, so an adapter that also redirects the reread could
 * still get `released` while the bound branch holds the generation; neither
 * test redirects the reread. Synthetic stores only.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager } from '../src/index.js';

const ledgerId = 'default/autobio:compression-refusal-quarantine-events';
const historical = (): Record<string, any>[] =>
  JSON.parse(readFileSync('test/fixtures/quarantine-pre-source-ids.json', 'utf8')).events;

async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'cm-quarantine-raw-switch-'));
  const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0 });
  const manager = await ContextManager.open({ path, strategy });
  const store = manager.getStore();
  const current = store.currentBranch;
  return {
    strategy, manager, store, current,
    kinds: () => (store.getStateJson(ledgerId) as Record<string, any>[] | null)?.map((event) => event.kind) ?? null,
    close() { store.currentBranch = current; manager.close(); rmSync(path, { recursive: true, force: true }); },
  };
}

it('release is not acknowledged when its tombstone landed on a branch the adapter switched to and back from', async () => {
  const fx = await fixture();
  try {
    fx.store.setStateJson(ledgerId, historical());
    // B shares main's historical native generation.
    fx.store.createBranchAt('B', 'main', fx.store.currentSequence());
    const view = fx.strategy.inspectCompressionRefusalQuarantine();
    assert.equal(view.status, 'ok');
    if (view.status !== 'ok') return;
    const record = view.records[0]!;
    const { current, store } = fx;
    let armed = true;
    // The append's own branch read captures main, moves the handle to B and
    // reports main; the next read moves it back. No manager switch, no mark.
    store.currentBranch = function (this: typeof store) {
      if (!armed && current.call(this).name === 'B') this.switchBranch('main');
      const branch = current.call(this);
      if (armed && new Error().stack!.includes('appendCompressionQuarantineEvent')) {
        armed = false;
        this.switchBranch('B');
      }
      return branch;
    };
    let result: Awaited<ReturnType<typeof fx.strategy.releaseCompressionRefusalQuarantine>> | undefined;
    try {
      result = await fx.strategy.releaseCompressionRefusalQuarantine({ key: record.key, expectedGeneration: record.generation!, expectedBinding: view.binding });
    } catch (error) {
      assert.match(String(error), /release uncertain/);
    }
    assert.equal(armed, false, 'the adapter moved the handle during the append');
    store.currentBranch = current;
    await fx.manager.switchBranch('main');
    const main = fx.strategy.inspectCompressionRefusalQuarantine();
    assert.equal(main.status, 'ok');
    const stillHeld = main.status === 'ok' && main.records.some((held) => held.key === record.key && held.generation === record.generation);
    // Here the reread runs on main (the adapter moved the handle back), so a
    // `released` that main contradicts would be a false acknowledgement. An
    // adapter that redirected the reread too is not covered, and where the
    // tombstone lands is outside the guard.
    if (result !== undefined) {
      assert.equal(result.status, 'released');
      assert.equal(stillHeld, false, 'released was acknowledged while main still held the generation');
    }
  } finally { fx.close(); }
});

it('legacy clear writes nothing when its second branch read moves the handle to a branch that holds the key', async () => {
  const fx = await fixture();
  try {
    const events = historical();
    fx.store.createBranchAt('B', 'main', fx.store.currentSequence());
    fx.store.switchBranch('B');
    fx.store.setStateJson(ledgerId, events);
    fx.store.switchBranch('main');
    const main = fx.strategy.inspectCompressionRefusalQuarantine();
    assert.equal(main.status === 'ok' && main.totalRecords, 0);
    const { current, store } = fx;
    let reads = 0;
    // Returns the branch the handle is actually on: no stale read result.
    store.currentBranch = function (this: typeof store) {
      if (++reads === 2) this.switchBranch('B');
      return current.call(this);
    };
    const append = store.appendToStateJsonWithIdentity;
    let appended = 0;
    store.appendToStateJsonWithIdentity = function (this: typeof store, ...args: Parameters<typeof append>) {
      appended++;
      return append.apply(this, args);
    };
    try {
      // Whether the move is seen as a no-op or reported as uncertain, nothing
      // may be written under the branch the handle moved to.
      await fx.strategy.clearCompressionRefusalQuarantine(events[0]!.key);
    } catch (error) {
      assert.match(String(error), /uncertain|stale branch|binding changed|requires reinitialization/);
    } finally {
      store.currentBranch = current;
      store.appendToStateJsonWithIdentity = append;
    }
    assert.ok(reads >= 2, 'the handle moved during the clear');
    assert.equal(appended, 0, 'no event was appended under an unvalidated branch');
    assert.equal(store.currentBranch().name, 'B');
    assert.equal(fx.kinds()!.includes('clear'), false, "B's hold was not cleared");
  } finally { fx.close(); }
});
