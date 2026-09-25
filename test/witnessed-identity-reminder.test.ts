/**
 * Witnessed vs live identity reminders, pinned on the wire.
 *
 * A resident whose Chronicle begins with reviewed inherited history
 * (witnessedBeforeSequence) needs two reminders: a frozen one for wholly
 * inherited material, and a neutral, revisable one for everything it lived.
 * The rule:
 *   - all-witnessed source material  -> witnessedIdentityReminder
 *   - wholly live material            -> identityReminder
 *   - mixed inherited/live merges     -> identityReminder (the sources' own
 *     witnessed stamps keep attribution inside the resulting memory)
 * These tests read the actual compression requests the model would receive.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { SILENT_IDENTITY_SUFFIX } from '../src/strategies/autobiographical.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const STORE = './test-zz-witnessed-identity';
const WITNESSED = 'WITNESSED-REMINDER: inherited record; attribute it to its participants.';
const LIVE = 'LIVE-REMINDER: first person only for your own actions and experience.';
const L1_WITNESSED_MARK = 'predates your own first turn';
const MERGE_WITNESSED_MARK = 'witnessed through the record you carry';
const L1_MARK = 'You will soon form a new memory';

const t = (text: string): ContentBlock => ({ type: 'text', text });
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };

function instruction(req: NormalizedRequest): string {
  const last = req.messages[req.messages.length - 1]!;
  return last.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
}
const isL1 = (req: NormalizedRequest) => req.messages.some((m) =>
  m.content.some((b) => b.type === 'text' && (b as { text: string }).text.includes(L1_MARK)));

async function run(strategyOptions: Record<string, unknown>): Promise<NormalizedRequest[]> {
  cleanup();
  const calls: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(request);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'A memory of this stretch: ' + 'detail '.repeat(40) }],
        usage: { input_tokens: 1000, output_tokens: 50 },
      };
    },
  };
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'zz-model',
    targetChunkTokens: 80,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: true,
    mergeThreshold: 2,
    ...strategyOptions,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
  const manager = await ContextManager.open({ path: STORE, strategy, membrane: membrane as any });
  for (let i = 0; i < 80; i++) {
    manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(`turn ${i} of steady substantive traffic about the work `.repeat(3))]);
    for (let k = 0; k < 500 && !manager.isReady(); k++) await manager.tick();
  }
  await manager.close();
  cleanup();
  return calls;
}

describe('witnessedIdentityReminder', () => {
  before(cleanup);
  after(cleanup);

  it('wholly witnessed targets get the witnessed reminder; live and mixed get the live one', async () => {
    const calls = await run({ witnessedBeforeSequence: 30, identityReminder: LIVE, witnessedIdentityReminder: WITNESSED });
    const l1 = calls.filter(isL1);
    const merges = calls.filter((r) => !isL1(r));
    const l1W = l1.filter((r) => instruction(r).includes(L1_WITNESSED_MARK));
    const l1L = l1.filter((r) => !instruction(r).includes(L1_WITNESSED_MARK));
    const mW = merges.filter((r) => instruction(r).includes(MERGE_WITNESSED_MARK));
    const mL = merges.filter((r) => !instruction(r).includes(MERGE_WITNESSED_MARK));
    assert.ok(l1W.length > 0 && l1L.length > 0, `need both kinds of L1 (w=${l1W.length}, l=${l1L.length})`);
    assert.ok(mW.length > 0 && mL.length > 0, `need both kinds of merge (w=${mW.length}, l=${mL.length})`);
    for (const r of [...l1W, ...mW]) {
      assert.ok(instruction(r).includes(WITNESSED), 'witnessed target carries the witnessed reminder');
      assert.ok(!instruction(r).includes(LIVE), 'and not the live one');
    }
    for (const r of [...l1L, ...mL]) {
      assert.ok(instruction(r).includes(LIVE), 'live or mixed target carries the live reminder');
      assert.ok(!instruction(r).includes(WITNESSED), 'and never the witnessed one');
    }
  });

  it('unset: every target uses identityReminder (unchanged behavior)', async () => {
    const calls = await run({ witnessedBeforeSequence: 30, identityReminder: LIVE });
    assert.ok(calls.length > 0);
    for (const r of calls) {
      assert.ok(instruction(r).endsWith(`\n\n${LIVE}`), 'bare live reminder on every request');
    }
  });

  it('identityReminderSilent appends the silence instruction after whichever reminder applies', async () => {
    const calls = await run({
      witnessedBeforeSequence: 30, identityReminder: LIVE, witnessedIdentityReminder: WITNESSED,
      identityReminderSilent: true,
    });
    for (const r of calls) {
      const text = instruction(r);
      assert.ok(
        text.endsWith(`\n\n${WITNESSED}\n\n${SILENT_IDENTITY_SUFFIX}`) || text.endsWith(`\n\n${LIVE}\n\n${SILENT_IDENTITY_SUFFIX}`),
        'reminder followed by the silence instruction',
      );
    }
  });

  it('no reminders configured: instructions are untouched', async () => {
    const calls = await run({ witnessedBeforeSequence: 30 });
    for (const r of calls) {
      assert.ok(!instruction(r).includes('REMINDER'));
      assert.ok(!instruction(r).includes(SILENT_IDENTITY_SUFFIX));
    }
  });
});
