/**
 * #116 review: a raw pin inside a merged summary must open only the branch
 * that contains it. Before the mixed frontier, one pinned message made the
 * canonical L1 prompt replay the whole covering L3 raw (reviewer's repro: 187
 * old messages raw vs 9 in the live view), on every L1 while the pin existed.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'l1-recall-pins-'));
after(() => rmSync(dir, { recursive: true, force: true }));

async function forest(name: string) {
  const requests: any[] = [];
  let calls = 0;
  const membrane = { complete: async (req: unknown) => { requests.push(JSON.parse(JSON.stringify(req))); calls++;
    return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${calls}: ordinary events.` }], usage: { inputTokens: 500, outputTokens: 100 } }; } };
  const strategy = new AutobiographicalStrategy({ compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, summaryParticipant: 'Claude', hierarchical: true, mergeThreshold: 6, adaptiveResolution: true });
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane: membrane as never });
  const ids: string[] = [];
  for (let i = 0; i < 240; i++) ids.push(cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `OLD-${i} ${'word '.repeat(30)}` }]));
  for (let r = 0; r < 200; r++) { await cm.compile(); await cm.tick(); if (calls > 150) break; }
  return { cm, strategy, ids, requests };
}

function firstL1After(cm: ContextManager, requests: any[]) {
  return async () => {
    requests.length = 0;
    for (let i = 0; i < 20; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `NEW-${i} ${'word '.repeat(30)}` }]);
    await cm.compile(); await cm.tick();
    const l1 = requests[0];
    const texts: string[] = l1.messages.flatMap((m: any) => m.content).filter((b: any) => typeof b.text === 'string').map((b: any) => b.text);
    return { oldRaw: texts.filter((t) => t.startsWith('OLD-')).length, recall: texts.filter((t) => t.startsWith('[CM] Recall memory')).length };
  };
}

describe('raw pins open only their own branch of the L1 recall frontier', () => {
  it('one pinned message deep in a merged summary adds at most its chunk raw', async () => {
    const { cm, strategy, ids, requests } = await forest('one-pin');
    const levels: Record<number, number> = {};
    for (const s of (strategy as unknown as { summaries: Array<{ level: number; mergedInto?: string }> }).summaries) if (!s.mergedInto) levels[s.level] = (levels[s.level] ?? 0) + 1;
    assert.ok((levels[2] ?? 0) + (levels[3] ?? 0) > 0, `need an L2+ frontier, got ${JSON.stringify(levels)}`);

    const baseline = await firstL1After(cm, requests)();
    cm.pinRange(ids[5], ids[5], { name: 'one-message' });
    const pinned = await firstL1After(cm, requests)();

    // The pinned message's L1 chunk (a handful of messages) opens; nothing else.
    assert.ok(pinned.oldRaw - baseline.oldRaw <= 12, `raw grew by ${pinned.oldRaw - baseline.oldRaw} (was 180+ before the fix)`);
    assert.ok(pinned.oldRaw > baseline.oldRaw, 'the pinned chunk itself is shown raw');
    assert.ok(pinned.recall >= baseline.recall, 'sibling branches stay summarized as recall pairs');
    cm.close();
  });
});

describe('pin precedence matches the kv-stable selector', () => {
  const raw = AutobiographicalStrategy.isForceRawPinBound;
  const cases: Array<[string, { level?: number; maxLevel?: number } | undefined, boolean]> = [
    ['classic raw pin (no bound)', undefined, true],
    ['level: 0', { level: 0 }, true],
    ['maxLevel: 0', { maxLevel: 0 }, true],
    ['level: 2', { level: 2 }, false],
    ['maxLevel: 2', { maxLevel: 2 }, false],
    ['overlapping {level: 2, maxLevel: 0}: level wins', { level: 2, maxLevel: 0 }, false],
    ['overlapping {level: 0, maxLevel: 3}', { level: 0, maxLevel: 3 }, true],
  ];
  for (const [name, bound, expected] of cases) it(name, () => assert.equal(raw(bound), expected));
});
