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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const STRANDED = `data:text/javascript,${encodeURIComponent(`
import { AutobiographicalStrategy } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/src/index.js')).href)};
AutobiographicalStrategy.prototype.getStrandedSummaries = function () {
  return { tokens: 320, summaries: [
    { id: 'L1-7', level: 1, tokens: 120, beside: [{ kind: 'compression-quarantine', id: 'k1', side: 'after', level: 0 }] },
    { id: 'L1-9', level: 1, tokens: 30, beside: [{ kind: 'hold', id: 'L1-8', side: 'after', level: 1 }, { kind: 'merge-quarantine', id: 'k2', side: 'after', level: 1 }, { kind: 'merge-quarantine', id: 'k6', side: 'after', level: 1 }] },
    { id: 'L1-11', level: 1, tokens: 30, beside: [{ kind: 'hold', id: 'L1-10', side: 'before', level: 1 }, { kind: 'compression-quarantine', id: 'k4', side: 'after', level: 0 }] },
    { id: 'L2-4', level: 2, tokens: 30, beside: [{ kind: 'merge-quarantine', id: 'k3', side: 'before', level: 1 }] },
    { id: 'L2-6', level: 2, tokens: 30, beside: [{ kind: 'hold', id: 'L1-12', side: 'after', level: 1 }, { kind: 'merge-quarantine', id: 'k5', side: 'after', level: 1 }] },
    { id: 'L3-2', level: 3, tokens: 80, beside: [] },
  ] };
};
`)}`;

const SETTINGS = `data:text/javascript,${encodeURIComponent(`
import { AutobiographicalStrategy } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/src/index.js')).href)};
AutobiographicalStrategy.prototype.getStrandedSummaries = function () {
  const c = this.config;
  const id = [c.mergeThreshold, c.mergeMaxSourceSpanMessages, (c.mergeHoldSummaryIds ?? []).join('+'), c.speculativeProduction].join('/');
  return { tokens: 1, summaries: [{ id, level: 1, tokens: 1, beside: [] }] };
};
`)}`;

const ANSWERS = `data:text/javascript,${encodeURIComponent(`
import { AutobiographicalStrategy } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/src/index.js')).href)};
AutobiographicalStrategy.prototype.callProvider = async function () {
  return { stopReason: 'end_turn', content: [{ type: 'text', text: 'what happened here, in a few words' }] };
};
`)}`;

const REJECTS = `data:text/javascript,${encodeURIComponent(`
import { AutobiographicalStrategy } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/src/index.js')).href)};
AutobiographicalStrategy.prototype.callProvider = async function () {
  throw new Error('the provider is down (test)');
};
`)}`;

const STRAYS_FAIL = `data:text/javascript,${encodeURIComponent(`
import { AutobiographicalStrategy } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/src/index.js')).href)};
AutobiographicalStrategy.prototype.getStrandedSummaries = function () {
  return { summaries: null, tokens: null, error: 'The stranded-summaries read failed.\\nCause: zz (test)' };
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
async function storeWithPendingChunks(path: string, messages = 16): Promise<void> {
  const strategy = new AutobiographicalStrategy({
    autoTickOnNewMessage: false, targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 0, minChunkCharsForLLM: 0,
  } as never);
  const membrane = { complete: async () => { throw new Error('no provider call while seeding (test)'); } };
  const manager = await ContextManager.open({ path, namespace: 'probe', strategy, membrane: membrane as never });
  for (let i = 0; i < messages; i++) manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ${'words '.repeat(30)}` }]);
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

  it('the drain takes the run settings a rebuild plan reads from the recipe, the holdback included, and prints them', () => {
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({ agent: { strategy: { mergeThreshold: 3, mergeMaxSourceSpanMessages: 40, mergeHoldSummaryIds: ['x'], l1HoldbackChunks: 0, speculativeProduction: false } } }));
    const r = run(DRAIN, [...drainArgs(join(dir, 'empty')), `--recipe=${recipe}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(events(r.stdout)[0]?.runs, { mergeThreshold: 3, mergeMaxSourceSpanMessages: 40, mergeHoldSummaryIds: ['x'], speculativeProduction: false, l1HoldbackChunks: 0 });
    const plain = run(DRAIN, drainArgs(join(dir, 'empty')));
    assert.deepEqual(events(plain.stdout)[0]?.runs, { mergeThreshold: 6, mergeMaxSourceSpanMessages: 1500, mergeHoldSummaryIds: [], speculativeProduction: true, l1HoldbackChunks: 1 });
  });

  it('the drain finishes once nothing is pending, queued or waiting to be picked, on the last allowed tick too', async () => {
    const answered = join(dir, 'answered');
    await storeWithPendingChunks(answered);
    const r = run(DRAIN, [...drainArgs(answered).filter((a) => !a.startsWith('--max-steps')), '--max-steps=200'], ANSWERS);
    assert.equal(r.status, 0, r.stderr);
    const seen = events(r.stdout);
    assert.ok(Number(seen[0]?.pendingChunks) > 0, 'premise: chunks waited for compression');
    const finish = seen.at(-1)!;
    assert.deepEqual([finish.event, finish.completed, finish.stopped, finish.pendingChunks, finish.mergesUnpicked], ['finish', true, 'drained', 0, false], r.stdout);
    const ticks = seen.filter((e) => e.event === 'step').length;
    assert.ok(ticks > 0, 'premise: it ticked');
    const again = join(dir, 'answered-again');
    await storeWithPendingChunks(again);
    const last = run(DRAIN, [...drainArgs(again).filter((a) => !a.startsWith('--max-steps')), `--max-steps=${ticks}`], ANSWERS);
    assert.equal(last.status, 0, last.stdout + last.stderr);
    assert.equal(events(last.stdout).at(-1)?.completed, true);
    const cut = join(dir, 'answered-cut');
    await storeWithPendingChunks(cut);
    const short = run(DRAIN, [...drainArgs(cut).filter((a) => !a.startsWith('--max-steps')), '--max-steps=1'], ANSWERS);
    assert.equal(short.status, 1, short.stdout + short.stderr);
    assert.deepEqual([events(short.stdout).at(-1)?.completed, events(short.stdout).at(-1)?.stopped], [false, 'max-steps'], short.stdout);
    assert.match(short.stderr, /not drained \(max-steps\): run the drain again with the same flags, leaving out --clear-merge-quarantine, which goes on from the store as it stands\nrestarting the resident instead: it finishes by its own rules and can leave strays the audit lists; run the drain again first to land the plan as projected/);
    const rest = run(DRAIN, [...drainArgs(cut).filter((a) => !a.startsWith('--max-steps')), '--max-steps=200'], ANSWERS);
    assert.equal(rest.status, 0, rest.stdout + rest.stderr);
    assert.notDeepEqual(events(short.stdout).at(-1)?.summaries, events(short.stdout)[0]?.summaries, 'premise: the first run landed a summary');
    assert.deepEqual(events(rest.stdout)[0]?.summaries, events(short.stdout).at(-1)?.summaries, 'run again, it starts from what the first run landed');
    assert.deepEqual([events(rest.stdout).at(-1)?.completed, events(rest.stdout).at(-1)?.stopped], [true, 'drained'], rest.stdout);
  });

  it('the drain runs the picks a landed merge puts off before it finishes, so a merge above it isn\'t left unpicked', async () => {
    const cascade = join(dir, 'cascade');
    await storeWithPendingChunks(cascade, 48);
    const recipe = join(dir, 'cascade-recipe.json');
    writeFileSync(recipe, JSON.stringify({ agent: { strategy: { mergeThreshold: 2 } } }));
    const args = [...drainArgs(cascade).filter((a) => !a.startsWith('--max-steps')), '--max-steps=400', `--recipe=${recipe}`];
    const r = run(DRAIN, args, ANSWERS);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const finish = events(r.stdout).at(-1)!;
    assert.equal(finish.completed, true);
    assert.ok(Number((finish.summaries as { l3?: number } | undefined)?.l3) > 0, 'premise: the L2s merged on');
    const again = run(DRAIN, args, ANSWERS);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    const seen = events(again.stdout);
    assert.deepEqual([seen[0]?.mergeQueue, seen[0]?.mergesUnpicked], [0, false], 'nothing left to pick when the store opens again');
    assert.equal(seen.filter((e) => e.event === 'step').length, 0, 'so a second run takes no step');
    assert.deepEqual([seen.at(-1)?.completed, seen.at(-1)?.stopped], [true, 'drained'], again.stdout);
  });

  it('the drain ends at a tick that fails, with its merges reported unpicked, when its chunks can\'t compress', async () => {
    const stalled = join(dir, 'stalled');
    await storeWithPendingChunks(stalled);
    const r = run(DRAIN, [...drainArgs(stalled).filter((a) => !a.startsWith('--max-steps')), '--max-steps=3'], REJECTS);
    assert.equal(r.status, 1, r.stderr);
    const finish = events(r.stdout).at(-1)!;
    assert.equal(finish.event, 'finish', r.stdout + r.stderr);
    assert.equal(finish.completed, false);
    assert.ok(Number(finish.pendingChunks) > 0, 'premise: chunks still wait for compression');
    assert.equal(finish.mergesUnpicked, true);
    assert.match(String(finish.tickError), /the provider is down \(test\)/);
    assert.equal(finish.stopped, 'tick-error');
    assert.match(r.stderr, /not drained \(tick-error\): run the drain again with the same flags, leaving out --clear-merge-quarantine, which goes on from the store as it stands\n/);
  });

  it('the drain stops once only work waiting on the resident\'s tools is left, and says so', async () => {
    const waiting = join(dir, 'waiting');
    await storeWithPendingChunks(waiting);
    const args = [...drainArgs(waiting).filter((a) => !a.startsWith('--max-steps') && !a.startsWith('--model')), '--model=claude-fable-5-1', '--max-steps=200'];
    const r = run(DRAIN, args);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const finish = events(r.stdout).at(-1)!;
    assert.deepEqual([finish.event, finish.completed, finish.stopped, finish.tickError], ['finish', false, 'waiting-on-tools', undefined], r.stdout);
    assert.ok(Number(finish.waitingOnTools) > 0, 'premise: chunks wait on the tools');
    assert.match(r.stderr, /not drained \(waiting-on-tools\): \d+ chunks and merges wait on the resident's tool definitions; run the drain again with --tools-log=<a log of its requests>\n/);
  });

  it('the drain stops before any tick and fails', async () => {
    await storeWithPendingChunks(pending);
    const r = run(DRAIN, drainArgs(pending), UNREADABLE_LEDGER);
    assert.equal(r.status, 1, r.stderr);
    const seen = events(r.stdout);
    assert.ok(Number(seen[0]?.pendingChunks) > 0, `setup: chunks wait for compression, so it would tick:\n${r.stdout}`);
    assert.deepEqual(seen.map((e) => e.event), ['start', 'finish'], 'no step');
    assert.equal(seen.at(-1)?.tickError, undefined, 'and no tick that threw: it never ticked');
    const finish = seen.at(-1)!;
    assert.equal(finish.completed, false);
    assert.equal(finish.stopped, 'debt-unreadable');
    assert.equal(finish.quarantines, null);
    assert.match(r.stderr, /not drained \(debt-unreadable\): run the drain again with the same flags, leaving out --clear-merge-quarantine, which goes on from the store as it stands, once the debt report can be read\n/);
    assert.match(r.stderr, /quarantines not counted: compression and merge quarantines together; audit-topology names each one beside a stray, and a merge's quarantine clears with --clear-merge-quarantine=<key>/);
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

  it('the audit lists each stranded summary with the holes beside it', () => {
    const r = run(AUDIT, [pending, '--namespace', 'probe'], STRANDED);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    const line = (id: string) => lines.find((l) => l.startsWith(`  stranded L`) && l.includes(` ${id}: `));
    assert.equal(line('L1-7'), '  stranded L1 L1-7: 120 tokens, after it, quarantined chunk k1: once quarantine k1 is cleared (clearCompressionRefusalQuarantine, a strategy method connectome-host has no command for) and the chunk compresses, it may merge with what then stands there; if it is still listed after that, a rebuild (repair-topology --mode rebuild) can give it partners where it can free a neighbour of its level, which its dry run shows');
    assert.equal(line('L1-9'), "  stranded L1 L1-9: 30 tokens, after it, operator hold on L1-8 and quarantined merge k2 and quarantined merge k6: once the hold on L1-8 is lifted (mergeHoldSummaryIds) and merge k2 is cleared (the strategy's clearMergeQuarantine, or a drain run with --clear-merge-quarantine=k2) and merge k6 is cleared (the strategy's clearMergeQuarantine, or a drain run with --clear-merge-quarantine=k6), it may merge with what then stands there, unless a clear queues k2's or k6's own group again at once, which leaves this summary out; if it is still listed after that, a rebuild (repair-topology --mode rebuild) can give it partners where it can free a neighbour of its level, which its dry run shows");
    assert.equal(line('L1-11'), '  stranded L1 L1-11: 30 tokens, before it, operator hold on L1-10: once the hold on L1-10 is lifted (mergeHoldSummaryIds), it may merge with what then stands there; after it, quarantined chunk k4: once quarantine k4 is cleared (clearCompressionRefusalQuarantine, a strategy method connectome-host has no command for) and the chunk compresses, it may merge with what then stands there; if it is still listed after that, a rebuild (repair-topology --mode rebuild) can give it partners where it can free a neighbour of its level, which its dry run shows');
    assert.equal(line('L2-6'), '  stranded L2 L2-6: 30 tokens, after it, operator hold on L1-12 and quarantined merge k5: once the hold on L1-12 is lifted (mergeHoldSummaryIds) and merge k5 is cleared (the strategy\'s clearMergeQuarantine, or a drain run with --clear-merge-quarantine=k5) and runs, it may merge with what then stands there; if it is still listed after that, a rebuild (repair-topology --mode rebuild) can give it partners where it can free a neighbour of its level, which its dry run shows');
    assert.equal(line('L2-4'), '  stranded L2 L2-4: 30 tokens, before it, quarantined merge k3: once merge k3 is cleared (the strategy\'s clearMergeQuarantine, or a drain run with --clear-merge-quarantine=k3) and runs, it may merge with what then stands there; if it is still listed after that, a rebuild (repair-topology --mode rebuild) can give it partners where it can free a neighbour of its level, which its dry run shows');
    assert.match(r.stdout, /\n  stranded L3 L3-2: 80 tokens, nothing quarantined or held beside it, so a rebuild \(repair-topology --mode rebuild\) can give it partners where it can free a neighbour of its level, which its dry run shows\n/, r.stdout);
  });

  it('the audit\'s --json output carries the stray list and the run settings it read', () => {
    const r = run(AUDIT, [pending, '--namespace', 'probe', '--json', '--merge-threshold', '3'], STRANDED);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { runs: { mergeThreshold: number }; stranded: { summaries: Array<{ id: string; beside: unknown[] }> | null } };
    assert.equal(out.runs.mergeThreshold, 3);
    assert.deepEqual(out.stranded.summaries?.find((x) => x.id === 'L1-7')?.beside, [{ kind: 'compression-quarantine', id: 'k1', side: 'after', level: 0 }], r.stdout);
  });

  it('the audit advises no clear and no rebuild below a merge threshold of 2, where no merge lands', () => {
    const r = run(AUDIT, [pending, '--namespace', 'probe', '--merge-threshold', '1'], STRANDED);
    assert.equal(r.status, 0, r.stderr);
    const strays = r.stdout.split('\n').filter((l) => l.startsWith('  stranded L'));
    assert.equal(strays.length, 6, r.stdout);
    for (const l of strays) assert.match(l, /: [0-9]+ tokens, below a merge threshold of 2 no merge lands, so neither clearing what stands beside it nor a rebuild gives it a partner$/, l);
  });

  it('the audit says the stray check did not run when the ledger could not be read, naming the report\'s error once', () => {
    const r = run(AUDIT, [pending, '--namespace', 'probe'], UNREADABLE_LEDGER);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\n  stranded summaries: not checked \(see above\)\n/, r.stdout);
    assert.equal(r.stdout.split("couldn't read this agent's compression quarantine ledger").length, 2, 'the ledger error is printed once');
  });

  it('the audit prints the stray list\'s own error when only that read fails', () => {
    const r = run(AUDIT, [pending, '--namespace', 'probe'], STRAYS_FAIL);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\n  stranded summaries: not checked:\n    The stranded-summaries read failed\.\n    Cause: zz \(test\)\n/, r.stdout);
  });

  it('the audit gives the strategy the run settings its flags name, in either form, prints them, and refuses a bad number', () => {
    const defaults = run(AUDIT, [pending, '--namespace', 'probe'], SETTINGS);
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.match(defaults.stdout, /\n  stranded L1 6\/1500\/\/true: /, defaults.stdout);
    const given = run(AUDIT, [pending, '--namespace=probe', '--merge-threshold', '3', '--merge-max-span=40', '--merge-hold', 'L1-7, L2-1', '--no-speculative-production'], SETTINGS);
    assert.equal(given.status, 0, given.stderr);
    assert.match(given.stdout, /\n  stranded L1 3\/40\/L1-7\+L2-1\/false: /, given.stdout);
    assert.match(given.stdout, /\n  run settings the stray rule read: mergeThreshold 3, mergeMaxSourceSpanMessages 40, mergeHoldSummaryIds L1-7,L2-1, speculativeProduction off /, given.stdout);
    const bad = run(AUDIT, [pending, '--namespace', 'probe', '--merge-threshold=three']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--merge-threshold must be a whole number, got three/);
    for (const value of ['1.5', '-1']) {
      const refused = run(AUDIT, [pending, '--namespace', 'probe', `--merge-max-span=${value}`]);
      assert.equal(refused.status, 1, value);
      assert.match(refused.stderr, new RegExp(`--merge-max-span must be a whole number, got ${value.replace('.', '\\.')}`));
    }
    for (const [args, said] of [
      [['--merge-threshold'], /--merge-threshold needs a value/],
      [['--merge-max-span='], /--merge-max-span needs a value/],
      [['--merge-threshold', ' '], /--merge-threshold needs a value/],
      [['--merge-hold', '--json'], /--merge-hold needs a value/],
      [['--no-speculative-production=true'], /--no-speculative-production takes no value/],
      [['--no-speculative-production', 'false'], /one store path is read, but 2 arguments are no flag or flag value: .* false/],
      [['--merge-threshold', '6', '--merge-threshold='], /--merge-threshold is given more than once/],
      [['--merge-max-span', '40', '--merge-max-span=40'], /--merge-max-span is given more than once/],
      [['--no-speculative-production', '--no-speculative-production'], /--no-speculative-production is given more than once/],
    ] as const) {
      const refused = run(AUDIT, [pending, '--namespace', 'probe', ...args], SETTINGS);
      assert.equal(refused.status, 1, `${args.join(' ')}: ${refused.stdout}`);
      assert.match(refused.stderr, said);
    }
    const before = run(AUDIT, ['--merge-threshold', '3', pending, '--namespace', 'probe'], SETTINGS);
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /\n  stranded L1 3\/1500\/\/true: /, before.stdout);
  });

  it('the audit\'s run flags reach the stray list it reads from a stored store', async () => {
    const path = join(dir, 'held-stray');
    const seed = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false });
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) };
    const manager = await ContextManager.open({ path, strategy: seed, namespace: 'probe', membrane: membrane as never });
    const m: string[] = [];
    for (let i = 0; i < 30; i++) m.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(20) }]));
    const one = (id: string, at: number, parent?: string) => ({
      id, level: 1, content: `s ${id}`, tokens: 50, sourceLevel: 0, sourceIds: [m[at]!, m[at + 1]!], sourceRange: { first: m[at]!, last: m[at + 1]! }, created: 1, ...(parent ? { mergedInto: parent } : {}),
    });
    const l1s = [...Array.from({ length: 6 }, (_, i) => one(`p${i}`, i * 2, 'P')), one('S', 12), one('H', 14), ...Array.from({ length: 6 }, (_, i) => one(`q${i}`, 16 + i * 2, 'Q')), one('n', 28)];
    const over = (id: string, from: number, to: number, src: string[]) => ({ id, level: 2, content: `s ${id}`, tokens: 50, sourceLevel: 1, sourceIds: src, sourceRange: { first: m[from]!, last: m[to]! }, created: 1 });
    const internals = seed as unknown as { store: { setStateJson(id: string, v: unknown): void }; summariesStateId: string; chunksStateId: string };
    internals.store.setStateJson(internals.summariesStateId, [...l1s, over('P', 0, 11, l1s.slice(0, 6).map((s) => s.id)), over('Q', 16, 27, l1s.slice(8, 14).map((s) => s.id))]);
    internals.store.setStateJson(internals.chunksStateId, l1s.map((s) => ({ id: `c-${s.id}`, sourceIds: s.sourceIds, compressed: true, summaryId: s.id })));
    manager.close();
    const free = run(AUDIT, [path, '--namespace', 'probe']);
    assert.equal(free.status, 0, free.stderr);
    assert.doesNotMatch(free.stdout, /stranded L1 /, 'with nothing held, S and H are a run, which merges at two');
    const held = run(AUDIT, [path, '--namespace', 'probe', '--merge-hold', 'H']);
    assert.equal(held.status, 0, held.stderr);
    assert.match(held.stdout, /\n  stranded L1 S: 50 tokens, after it, operator hold on H: /, held.stdout);
  });

  it('the audit prints no error on a store it can read, and exits 0', () => {
    const r = run(AUDIT, [pending, '--namespace', 'probe']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /compression debt (healthy|degraded|critical)\n/, r.stdout);
    assert.doesNotMatch(r.stdout, /Cause:|Effect:|Fix:/);
  });
});
