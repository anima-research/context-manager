import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy, MessageStore } from '../src/index.js';
import type { SummaryEntry } from '../src/types/index.js';

// inspect-store is mutation-free strategy inspection (room-225 lane 5, the
// brosefo household incident): it never constructs a strategy or a
// ContextManager unless a sample compile is asked for, so it creates no
// strategy, chunk or namespace state, and a wrong namespace is reported
// rather than silently registered (June-1016, #42676).

const SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'scripts', 'inspect-store.js');
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

class Seeder extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
}
const text = (t: string): ContentBlock => ({ type: 'text', text: t });

/** A resident's store under `agents/Ada`, with messages and one L1. */
async function residentStore(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'inspect-store-'));
  dirs.push(dir);
  const path = join(dir, 'store');
  const strategy = new Seeder({ autoTickOnNewMessage: false, targetChunkTokens: 100_000, headWindowTokens: 0, recentWindowTokens: 0 } as never);
  const manager = await ContextManager.open({
    path, strategy, namespace: 'agents/Ada',
    membrane: { complete: async () => ({ content: [text('x')] }) } as never,
  });
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push(manager.addMessage(i % 2 ? 'Ada' : 'User', [text(`zz message ${i} ` + 'word '.repeat(20))]));
  strategy.seed({ id: 'L1-1', level: 1, content: 'zz authored memory', tokens: 10, sourceLevel: 0, sourceIds: ids.slice(0, 2), sourceRange: { first: ids[0]!, last: ids[1]! }, created: 1 });
  manager.close();
  return path;
}

/**
 * A store where `agents/Ada` kept its messages isolated, then switched to the
 * shared slot: both slots are registered, each with its own history.
 */
async function switchedStore(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'inspect-store-'));
  dirs.push(dir);
  const path = join(dir, 'store');
  for (const slot of ['isolated', 'shared'] as const) {
    const manager = await ContextManager.open({
      path, strategy: new Seeder({ autoTickOnNewMessage: false } as never), namespace: 'agents/Ada',
      membrane: { complete: async () => ({ content: [text('x')] }) } as never,
      ...(slot === 'isolated' ? { isolate: true } : {}),
    });
    for (let i = 0; i < 3; i++) manager.addMessage(i % 2 ? 'Ada' : 'User', [text(`zz ${slot} message ${i}`)]);
    manager.close();
  }
  return path;
}

const SLOT_IDS = { isolated: 'agents/Ada/messages', shared: 'messages' } as const;

/** Every state id with its item count, and every strategy state's value, exactly. */
function snapshot(path: string): string {
  const store = JsStore.open({ path });
  try {
    const states = store.listStates().map((s) => ({ id: s.id, items: s.itemCount ?? null })).sort((a, b) => a.id.localeCompare(b.id));
    const strategy = Object.fromEntries(states
      .filter((s) => s.id.includes('/autobio:') || s.id.includes('/kvunified:'))
      .map((s) => [s.id, JSON.stringify(store.getStateJson(s.id))]));
    return JSON.stringify({ states, strategy });
  } finally { store.close(); }
}

/** The script run as a process: its exit code, and both streams whatever the code. */
function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('inspect-store', () => {
  it('inspects a namespace without changing any state, and compiles nothing unless asked', async () => {
    const path = await residentStore();
    const out = join(path, '..', 'out');
    const before = snapshot(path);
    const { code, stdout, stderr } = run([path, '--namespace', 'agents/Ada', '--output', out]);
    assert.equal(code, 0);
    assert.doesNotMatch(stderr, /torn tail/, 'a cleanly closed store has no truncation to report');
    assert.match(stdout, /Summaries: 1 /);
    assert.match(stdout, /Messages: 6 \(the shared message slot messages\)/, 'the sole registered slot, named');
    assert.deepEqual(readdirSync(out).sort(), ['messages.md', 'summary-lineage.md', 'summary-tree.md'], 'the inspection files and no compile, unless asked');
    const tree = readFileSync(join(out, 'summary-tree.md'), 'utf8');
    assert.match(tree, /## L1-1 \(L1, 10 tokens\)/, 'the stored summary, by id and level');
    assert.match(tree, /zz authored memory/, 'with its content');
    assert.match(readFileSync(join(out, 'summary-lineage.md'), 'utf8'), /## L1-1 \(L1\)\nSource range: .+\nLeaf message ids \(2\): /, 'and the two messages it covers');
    assert.equal(snapshot(path), before, 'every state and every strategy value is unchanged');
  });

  it('a namespace without strategy state is reported, nothing is inspected, and no state is created for it', async () => {
    const path = await residentStore();
    const before = snapshot(path);
    const { code, stderr } = run([path, '--namespace', 'agents/Nobody', '--output', join(path, '..', 'out-nobody')]);
    assert.equal(code, 2);
    assert.match(stderr, /namespace "agents\/Nobody" has no strategy state/);
    assert.match(stderr, /Namespaces with strategy state: agents\/Ada/);
    assert.equal(snapshot(path), before, 'no strategy, chunk or namespace state was created');
    assert.equal(existsSync(join(path, '..', 'out-nobody')), false);
  });

  it('accepts --ns as the old name of --namespace', async () => {
    const path = await residentStore();
    const { code, stdout } = run([path, '--ns', 'agents/Ada', '--output', join(path, '..', 'out-ns')]);
    assert.equal(code, 0);
    assert.match(stdout, /Overview \(agents\/Ada\)/);
  });

  it('--sample-compile writes one compile at that budget, labelled a sample using tool defaults', async () => {
    const path = await residentStore();
    const out = join(path, '..', 'out-sample');
    const { code, stderr } = run([path, '--namespace', 'agents/Ada', '--output', out, '--sample-compile', '20000']);
    assert.equal(code, 0, stderr);
    assert.deepEqual(readdirSync(out).sort(), ['messages.md', 'sample-compile-20000.md', 'summary-lineage.md', 'summary-tree.md']);
    const sample = readFileSync(join(out, 'sample-compile-20000.md'), 'utf8');
    assert.match(sample, /default strategy configuration, not the resident's own/);
    assert.match(sample, /registers the namespace's states, re-applies the message slot's registration \(its snapshot cadence\), may migrate legacy chunk records, and may rewrite the summaries state/, 'the file carries the warning, not only stderr');
    assert.match(stderr, /This open writes: it registers the namespace's states, re-applies the message slot's registration/);
  });

  it('reads the message slot it is told to, and refuses to guess when both are registered', async () => {
    const path = await switchedStore();
    const before = snapshot(path);
    const guess = join(path, '..', 'out-guess');
    const refused = run([path, '--namespace', 'agents/Ada', '--output', guess]);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /both message slots registered, agents\/Ada\/messages \(isolated\) and messages \(shared\)/);
    assert.match(refused.stderr, /choose with --message-slot isolated or --message-slot shared/);
    assert.equal(existsSync(guess), false, 'nothing written');
    for (const slot of ['isolated', 'shared'] as const) {
      const other = slot === 'isolated' ? 'shared' : 'isolated';
      const out = join(path, '..', `out-${slot}`);
      const { code, stdout, stderr } = run([path, '--namespace', 'agents/Ada', '--message-slot', slot, '--output', out]);
      assert.equal(code, 0, stderr);
      assert.ok(stdout.includes(`Messages: 3 (the ${slot} message slot ${SLOT_IDS[slot]})`), stdout);
      const listing = readFileSync(join(out, 'messages.md'), 'utf8');
      assert.ok(listing.includes(`Total stored: 3 (the ${slot} message slot ${SLOT_IDS[slot]})`), listing);
      assert.match(listing, new RegExp(`zz ${slot} message 2`));
      assert.doesNotMatch(listing, new RegExp(`zz ${other} message`));
    }
    assert.equal(snapshot(path), before, 'no state changed');
  });

  it('--sample-compile compiles the chosen slot: isolate follows --message-slot', async () => {
    const path = await switchedStore();
    for (const slot of ['isolated', 'shared'] as const) {
      const other = slot === 'isolated' ? 'shared' : 'isolated';
      const out = join(path, '..', `out-sample-${slot}`);
      const { code, stderr } = run([path, '--namespace', 'agents/Ada', '--message-slot', slot, '--output', out, '--sample-compile', '20000']);
      assert.equal(code, 0, stderr);
      const sample = readFileSync(join(out, 'sample-compile-20000.md'), 'utf8');
      assert.ok(sample.includes(`from the ${slot} message slot ${SLOT_IDS[slot]}`), sample);
      assert.match(sample, new RegExp(`zz ${slot} message 2`));
      assert.doesNotMatch(sample, new RegExp(`zz ${other} message`));
    }
  });

  it('a chosen message slot that is not registered is refused, and never created', async () => {
    const path = await residentStore();
    const before = snapshot(path);
    for (const extra of [[], ['--sample-compile', '20000']]) {
      const out = join(path, '..', `out-absent-${extra.length}`);
      const { code, stderr } = run([path, '--namespace', 'agents/Ada', '--message-slot', 'isolated', '--output', out, ...extra]);
      assert.equal(code, 2);
      assert.match(stderr, /--message-slot isolated: agents\/Ada\/messages is not registered in this store; nothing was inspected\. The shared slot messages is\./);
      assert.equal(existsSync(out), false, 'nothing written');
    }
    assert.equal(snapshot(path), before, 'the isolated slot was not created');
  });

  it('with no message slot, summaries are inspected, and a sample compile is refused before any output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inspect-store-'));
    dirs.push(dir);
    const path = join(dir, 'store');
    const store = JsStore.openOrCreate({ path });
    store.registerState({ id: 'agents/Ada/autobio:summaries', strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 10 });
    store.registerState({ id: 'agents/Ada/autobio:resolutions', strategy: 'snapshot' });
    store.close();
    const before = snapshot(path);
    const refused = run([path, '--namespace', 'agents/Ada', '--output', join(dir, 'out-sample'), '--sample-compile', '20000']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /--sample-compile: "agents\/Ada" has no message slot .* so there is no history to compile; nothing was inspected/);
    assert.equal(existsSync(join(dir, 'out-sample')), false, 'nothing written');
    assert.equal(snapshot(path), before, 'no message slot was registered');
    const { code, stdout, stderr } = run([path, '--namespace', 'agents/Ada', '--output', join(dir, 'out')]);
    assert.equal(code, 0);
    assert.match(stdout, /Messages: 0 \(no message slot\)/);
    // Registered and never written: chronicle reads such a state as null, which is "nothing stored yet", not damage.
    assert.match(stdout, /Summaries: 0 \(\{\}\), as stored/);
    assert.match(stdout, /Resolutions recorded: 0\n/);
    assert.doesNotMatch(stderr, /unreadable|holds /);
  });

  it('a malformed invocation is refused before anything is opened or written (#48901)', async () => {
    const path = await residentStore();
    // A store that also has a "default" namespace, which a malformed selection must not fall back to.
    const strategy = new Seeder({ autoTickOnNewMessage: false } as never);
    const manager = await ContextManager.open({ path, strategy, membrane: { complete: async () => ({ content: [] }) } as never });
    strategy.seed({ id: 'L1-9', level: 1, content: 'zz default memory', tokens: 5, sourceLevel: 0, sourceIds: ['x'], sourceRange: { first: 'x', last: 'x' }, created: 1 });
    manager.close();
    const before = snapshot(path);
    // A torn tail, appended after the snapshot (whose own open would truncate it): any open before the invocation is
    // refused would truncate it and say so, which the checks below would see.
    const log = join(path, 'records.log');
    appendFileSync(log, Buffer.from([1, 2, 3, 4, 5, 6, 7]));
    const torn = readFileSync(log);
    // OUT stands for the case's own output directory, which must not appear.
    const cases: Array<[string[], RegExp]> = [
      [['--namespace'], /--namespace needs a value/],
      [['--ns'], /--ns needs a value/],
      [['--namespace', '--output', 'OUT'], /--namespace needs a value/],
      [['--sample-compile'], /--sample-compile needs a value/],
      [['--output'], /--output needs a value/],
      [['--namespace', 'agents/Ada', '--ns'], /--ns needs a value/],
      [['--namespace', 'agents/Ada', '--ns', 'agents/Ada'], /option given twice: --namespace and --ns/],
      [['--namespace', 'agents/Ada', '--namespace', 'default'], /option given twice: --namespace and --namespace/],
      [['--namspace', 'agents/Ada'], /unknown option --namspace/],
      [['agents/Ada'], /unexpected argument "agents\/Ada"/],
      [['--message-slot', 'own'], /--message-slot takes isolated or shared, not "own"/],
      [['--namespace', ''], /--namespace needs a non-empty value/],
      ...['abc', '0', '1.5', '-5', '1e3', '0x10', '050'].map((value): [string[], RegExp] =>
        [['--sample-compile', value], new RegExp(`--sample-compile takes a positive whole number of tokens, not "${value}"`)]),
    ];
    cases.forEach(([args, message], i) => {
      const out = join(path, '..', `out-malformed-${i}`);
      const given = args.map((arg) => (arg === 'OUT' ? out : arg));
      const { code, stderr } = run([path, ...given, ...(args.includes('--output') ? [] : ['--output', out])]);
      assert.equal(code, 1, args.join(' '));
      assert.match(stderr, message, args.join(' '));
      assert.doesNotMatch(stderr, /torn tail/, `${args.join(' ')}: refused before the store was opened`);
      assert.equal(existsSync(out), false, `${args.join(' ')}: nothing written`);
    });
    const first = run(['--namespace', 'agents/Ada', path]);
    assert.equal(first.code, 1);
    assert.match(first.stderr, /the store path comes first/);
    assert.deepEqual(readFileSync(log), torn, 'no case opened the store: its torn tail is still there');
    assert.equal(snapshot(path), before);
    // Checked before the store is even looked for.
    const absent = run([join(path, '..', 'absent'), '--namespace', 'agents/Ada', '--ns']);
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /--ns needs a value/);
    assert.equal(existsSync(join(path, '..', 'absent')), false);
  });

  it('reports a torn tail that opening the store truncated from records.log, and changes no state', async () => {
    const path = await residentStore();
    const before = snapshot(path); // taken before the tail is added: the snapshot's own open would truncate it
    const log = join(path, 'records.log');
    const clean = readFileSync(log);
    appendFileSync(log, Buffer.from([1, 2, 3, 4, 5, 6, 7])); // a partial frame, as an append that didn't complete leaves
    const { code, stderr } = run([path, '--namespace', 'agents/Ada', '--output', join(path, '..', 'out-torn')]);
    assert.equal(code, 0, stderr);
    assert.match(stderr, new RegExp(`truncated a torn tail from records\\.log: it dropped 7 bytes, and the log now ends at byte ${clean.length}\\.`));
    assert.deepEqual(readFileSync(log), clean, 'the open truncated the log back to its last valid record');
    assert.equal(snapshot(path), before, 'every state and every strategy value is unchanged');
  });

  it('reports a torn tail that the open truncated even when the open then fails', async () => {
    const path = await residentStore();
    const log = join(path, 'records.log');
    const clean = readFileSync(log);
    appendFileSync(log, Buffer.from([1, 2, 3, 4, 5, 6, 7]));
    // A state.bin that no longer reads (a crash during its rewrite can leave one). Chronicle loads it only after
    // truncating the log's tail, so the open fails having already truncated.
    const stateBin = join(path, 'state.bin');
    writeFileSync(stateBin, readFileSync(stateBin).fill(0, 0, 4)); // its magic
    const { code, stderr } = run([path, '--namespace', 'agents/Ada', '--output', join(path, '..', 'out-failed')]);
    assert.equal(code, 1, stderr);
    assert.match(stderr, new RegExp(`truncated a torn tail from records\\.log: it dropped 7 bytes, and the log now ends at byte ${clean.length}\\.`));
    assert.ok(stderr.indexOf('torn tail') < stderr.indexOf('FATAL'), 'the report, then the failed open');
    assert.deepEqual(readFileSync(log), clean, 'the failed open had truncated the log');
  });

  it('reads an isolated slot by default when it is the only one registered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inspect-store-'));
    dirs.push(dir);
    const path = join(dir, 'store');
    const manager = await ContextManager.open({
      path, strategy: new Seeder({ autoTickOnNewMessage: false } as never), namespace: 'agents/Ada', isolate: true,
      membrane: { complete: async () => ({ content: [text('x')] }) } as never,
    });
    for (let i = 0; i < 3; i++) manager.addMessage(i % 2 ? 'Ada' : 'User', [text(`zz isolated message ${i}`)]);
    manager.close();
    const { code, stdout, stderr } = run([path, '--namespace', 'agents/Ada', '--output', join(dir, 'out')]);
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes('Messages: 3 (the isolated message slot agents/Ada/messages)'), stdout);
    assert.match(readFileSync(join(dir, 'out', 'messages.md'), 'utf8'), /zz isolated message 2/);
  });

  it('shows resolutions as stored, and reports entries whose level is not a number', async () => {
    const path = await residentStore();
    const store = JsStore.open({ path });
    const firstId = new MessageStore(store, {}).getAll()[0]!.id;
    const resolutionsId = 'agents/Ada/autobio:resolutions';
    if (!store.listStates().some((state) => state.id === resolutionsId)) store.registerState({ id: resolutionsId, strategy: 'snapshot' });
    store.setStateJson(resolutionsId, { [firstId]: 2, raw: 0, broken: 'x' });
    store.close();
    const out = join(path, '..', 'out-res');
    const { code, stdout, stderr } = run([path, '--namespace', 'agents/Ada', '--output', out]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Resolutions recorded: 1 \(1 unreadable entry not shown\)/, 'a level-0 entry is raw, not a resolution');
    assert.match(stdout, /Resolution distribution: \{"2":1\}/);
    assert.match(stderr, /agents\/Ada\/autobio:resolutions has 1 entry whose level isn't a number/);
    assert.match(readFileSync(join(out, 'messages.md'), 'utf8'), /\[000\] User .* res=L2: zz message 0/, 'the resolved message is labelled');
  });

  it('reports a summaries state that is not a list, and a resolutions state that is not a map, rather than reading either as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inspect-store-'));
    dirs.push(dir);
    const path = join(dir, 'store');
    const store = JsStore.openOrCreate({ path });
    store.registerState({ id: 'agents/Bad/autobio:summaries', strategy: 'snapshot' });
    store.setStateJson('agents/Bad/autobio:summaries', { not: 'a list' });
    store.registerState({ id: 'agents/Bad/autobio:resolutions', strategy: 'snapshot' });
    store.setStateJson('agents/Bad/autobio:resolutions', ['not', 'a map']);
    store.close();
    const { code, stdout, stderr } = run([path, '--namespace', 'agents/Bad', '--output', join(dir, 'out')]);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /agents\/Bad\/autobio:summaries holds a map, not a list of summaries/);
    assert.match(stdout, /Summaries: unreadable \(agents\/Bad\/autobio:summaries holds a map\)/);
    assert.match(stderr, /agents\/Bad\/autobio:resolutions holds a list, not a map of message ids to levels/);
    assert.match(stdout, /Resolutions recorded: unreadable \(agents\/Bad\/autobio:resolutions holds a list\)/);
  });

  it('refuses a store another process holds open, saying so, and writes nothing', async () => {
    const path = await residentStore();
    const held = JsStore.open({ path });
    try {
      const out = join(path, '..', 'out-locked');
      const { code, stderr } = run([path, '--namespace', 'agents/Ada', '--output', out]);
      assert.equal(code, 1);
      assert.match(stderr, /is locked: a running resident \(or another process\) holds it open\. Stop it, or inspect a copy of the store\./);
      assert.equal(existsSync(out), false, 'not even the output directory');
    } finally { held.close(); }
  });

  it('never creates a store that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inspect-store-none-'));
    dirs.push(dir);
    const { code } = run([join(dir, 'absent'), '--output', join(dir, 'out')]);
    assert.equal(code, 1);
    assert.equal(existsSync(join(dir, 'absent')), false);
  });
});
