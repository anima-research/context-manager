import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
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

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('inspect-store', () => {
  it('inspects a namespace without changing any state, and compiles nothing unless asked', async () => {
    const path = await residentStore();
    const out = join(path, '..', 'out');
    const before = snapshot(path);
    const { code, stdout } = run([path, '--namespace', 'agents/Ada', '--output', out]);
    assert.equal(code, 0);
    assert.match(stdout, /Summaries: 1 /);
    assert.match(stdout, /Messages: 6/);
    for (const file of ['summary-tree.md', 'summary-lineage.md', 'messages.md']) assert.ok(existsSync(join(out, file)), file);
    assert.equal(existsSync(join(out, 'sample-compile-50000.md')), false, 'no compile unless asked');
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

  it('--sample-compile writes one compile at that budget (a live, audit-only open)', async () => {
    const path = await residentStore();
    const out = join(path, '..', 'out-sample');
    const { code, stderr } = run([path, '--namespace', 'agents/Ada', '--output', out, '--sample-compile', '20000']);
    assert.equal(code, 0, stderr);
    assert.ok(existsSync(join(out, 'sample-compile-20000.md')));
  });

  it('never creates a store that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inspect-store-none-'));
    dirs.push(dir);
    const { code } = run([join(dir, 'absent'), '--output', join(dir, 'out')]);
    assert.equal(code, 1);
    assert.equal(existsSync(join(dir, 'absent')), false);
  });
});
