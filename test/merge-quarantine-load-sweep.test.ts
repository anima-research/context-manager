/**
 * A stale merge-quarantine record (its sources merged or repaired while the
 * store was closed) holds every one of its sources. It must be swept when the
 * store loads, not only when the alarm next fires; with
 * `quarantineAlarmIntervalMs: 0` the alarm never fires at all (#117 review).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'mq-load-sweep-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'summary' }], usage: { inputTokens: 10, outputTokens: 5 } }) };
const open = () => ContextManager.open({
  path: join(dir, 'store'),
  strategy: new AutobiographicalStrategy({ compressionModel: 'm', hierarchical: true, autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0 }),
  membrane: membrane as never,
});

test('a stale merge-quarantine record is swept at load', async () => {
  const first = await open();
  first.addMessage('User', [{ type: 'text', text: 'hello' }]);
  const strategy = (first as unknown as { strategy: { store: { setStateJson(id: string, v: unknown): void }; mergeQuarantineStateId: string } }).strategy;
  // Sources that no longer exist: the record is orphaned (paid off by a repair).
  strategy.store.setStateJson(strategy.mergeQuarantineStateId, [
    { key: 'stale', level: 2, sourceIds: ['L1-gone-1', 'L1-gone-2'], attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
  ]);
  first.close();

  const reopened = await open();
  const status = (reopened as unknown as { strategy: AutobiographicalStrategy }).strategy.getMergeQuarantineStatus();
  assert.equal(status.count, 0, 'swept on load, without any tick or alarm');
  reopened.close();
});
