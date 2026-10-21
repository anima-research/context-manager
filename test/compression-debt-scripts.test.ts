/**
 * The scripts that read getCompressionDebt(), run as an operator runs them,
 * on a store whose compression quarantine ledger can't be read once it is
 * open: the drain stops before any tick and fails rather than reporting the
 * store drained, a drain whose last report can't read it fails though it
 * finished, and the audit prints the report's error beside its state.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AutobiographicalStrategy, ContextManager } from '../src/index.js';

const DRAIN = join(process.cwd(), 'dist/scripts/drain-autobiographical.js');
const AUDIT = join(process.cwd(), 'dist/scripts/audit-topology.js');
const dir = mkdtempSync(join(tmpdir(), 'debt-scripts-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Loaded before a script: once its store is open, the quarantine ledger read throws. Opening reads the ledger too. */
const UNREADABLE_LEDGER = `data:text/javascript,${encodeURIComponent(`
import { AutobiographicalStrategy, ContextManager } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/src/index.js')).href)};
const read = AutobiographicalStrategy.prototype.readCompressionQuarantineProjection;
let opened = false;
AutobiographicalStrategy.prototype.readCompressionQuarantineProjection = function () {
  if (opened) throw new Error('ledger unreadable (test)');
  return read.call(this);
};
const open = ContextManager.open;
ContextManager.open = async function (...args) {
  const manager = await open.apply(this, args);
  opened = true;
  return manager;
};
`)}`;

/** Loaded before the drain: on an empty store it reports its debt four times,
 *  at its start, as its first final, before its first step, where it finds
 *  the store drained, and as its last. The ledger read throws from the fourth. */
const LAST_REPORT_UNREADABLE = `data:text/javascript,${encodeURIComponent(`
import { AutobiographicalStrategy } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/src/index.js')).href)};
const debt = AutobiographicalStrategy.prototype.getCompressionDebt;
const read = AutobiographicalStrategy.prototype.readCompressionQuarantineProjection;
let reports = 0;
AutobiographicalStrategy.prototype.getCompressionDebt = function (...args) {
  reports += 1;
  return debt.apply(this, args);
};
AutobiographicalStrategy.prototype.readCompressionQuarantineProjection = function () {
  if (reports >= 4) throw new Error('ledger unreadable (test)');
  return read.call(this);
};
`)}`;

function run(script: string, args: string[], loaded?: string) {
  const result = spawnSync(process.execPath, [...(loaded ? ['--import', loaded] : []), script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // The drain needs a key to build its provider, and a tick it shouldn't take
    // goes to a port nothing listens on rather than to a provider.
    env: { ...process.env, ANTHROPIC_API_KEY: 'unused (test)', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The drain's JSON event lines. */
const events = (stdout: string) => stdout.split('\n')
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line) as Record<string, unknown>);

/** A store whose closed chunks wait for compression, so a drain that doesn't stop would tick. */
async function storeWithPendingChunks(path: string): Promise<void> {
  const strategy = new AutobiographicalStrategy({
    autoTickOnNewMessage: false, targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0, minChunkCharsForLLM: 0,
  } as never);
  const membrane = { complete: async () => { throw new Error('no provider call while seeding (test)'); } };
  const manager = await ContextManager.open({ path, namespace: 'probe', strategy, membrane: membrane as never });
  for (let i = 0; i < 16; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ${'words '.repeat(30)}` }]);
  await manager.compile();
  manager.close();
}

const drainArgs = (store: string) => [store, 'probe', '--apply', '--model=unused', '--participant=probe', '--max-steps=1'];

describe('the scripts on a store whose compression quarantine ledger can\'t be read', () => {
  const pending = join(dir, 'pending');

  it('the drain finishes a store it can read', () => {
    const r = run(DRAIN, drainArgs(join(dir, 'empty')));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(events(r.stdout).at(-1)?.completed, true);
  });

  it('the drain stops before any tick and fails', async () => {
    await storeWithPendingChunks(pending);
    const r = run(DRAIN, drainArgs(pending), UNREADABLE_LEDGER);
    assert.equal(r.status, 1, r.stderr);
    const seen = events(r.stdout);
    assert.ok(Number(seen[0]?.pendingChunks) > 0, `setup: chunks wait for compression, so it would tick:\n${r.stdout}`);
    assert.deepEqual(seen.map((e) => e.event), ['start', 'finish'], 'no step: it never ticked');
    const finish = seen.at(-1)!;
    assert.equal(finish.completed, false);
    assert.equal(finish.quarantines, null);
    assert.match(String(finish.debtError), /compression quarantine ledger \(ledger unreadable \(test\)\)\./);
  });

  it('the drain fails when its last report can\'t read the ledger, though it finished', () => {
    const r = run(DRAIN, drainArgs(join(dir, 'empty-last')), LAST_REPORT_UNREADABLE);
    assert.equal(r.status, 1, r.stderr);
    const finish = events(r.stdout).at(-1)!;
    assert.equal(finish.completed, true, `setup: it finished, and only its last report failed:\n${r.stdout}`);
    assert.equal(finish.quarantines, null);
    assert.match(String(finish.debtError), /compression quarantine ledger \(ledger unreadable \(test\)\)\./);
  });

  it('the audit prints the report\'s error, and exits 0 with no topology violations', () => {
    const r = run(AUDIT, [pending, '--namespace', 'probe'], UNREADABLE_LEDGER);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /compression debt unknown\n  Compression of new conversation has stalled\.\n  Cause: the store couldn't read this agent's compression quarantine ledger \(ledger unreadable \(test\)\)\.\n  Effect: [^\n]+\n  Fix: [^\n]+\n/,
      'the summary, then the error a line each');
  });

  it('the audit prints no error on a store it can read, and exits 0', () => {
    const r = run(AUDIT, [pending, '--namespace', 'probe']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /compression debt (healthy|degraded|critical)\n/, r.stdout);
    assert.doesNotMatch(r.stdout, /Cause:|Effect:|Fix:/);
  });
});
