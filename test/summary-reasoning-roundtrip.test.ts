/**
 * Reasoning-block preservation for autobiographical summaries (2026-07-15).
 *
 * Fable-5/Sonnet-5-class models require encrypted reasoning tokens (signed
 * `thinking` / `redacted_thinking` blocks) to be supplied back alongside any
 * model-generated text that is replayed as an assistant turn. Summaries are
 * replayed in the agent's own voice, so the summarizer's reasoning blocks
 * must survive: generation → SummaryEntry.responseContent → chronicle
 * persistence → reload → compile emission, byte-identical (signatures cover
 * block content verbatim).
 *
 * Previously all compression sites stored text-only ("summarizer scratch
 * thinking is not agent history"), which silently stripped the signatures.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { SummaryEntry } from '../src/types/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-summary-reasoning-roundtrip';
const TEST_COMPRESSION_MODEL = 'test-compression-model';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

/** Membrane stub whose responses carry signed + redacted thinking blocks. */
function makeThinkingMembrane() {
  let calls = 0;
  return {
    callCount: () => calls,
    complete: async () => {
      calls++;
      return {
        content: [
          {
            type: 'thinking',
            thinking: `scratch reasoning for call ${calls}`,
            signature: `sig-${calls}-0123456789abcdef`,
          },
          { type: 'redacted_thinking', data: `enc-${calls}-payload==` },
          { type: 'text', text: `Summary #${calls}: things happened and I remember them.` },
        ],
        usage: { inputTokens: 500, outputTokens: 120 },
      };
    },
  };
}

function strategyConfig() {
  return {
    compressionModel: TEST_COMPRESSION_MODEL,
    targetChunkTokens: 50,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    summaryParticipant: 'Claude',
  } as const;
}

const filler = (n: number) => 'word '.repeat(n);

describe('Summary reasoning round-trip (Fable-5 signed thinking)', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('captures, persists, reloads and re-emits summarizer reasoning blocks verbatim', async () => {
    cleanup();

    const membrane = makeThinkingMembrane();
    const strategy = new AutobiographicalStrategy(strategyConfig());
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as never,
    });

    for (let i = 0; i < 8; i++) {
      manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', [
        { type: 'text', text: filler(30) },
      ]);
    }

    await manager.compile();
    await manager.tick();

    const s = strategy as unknown as { summaries: SummaryEntry[] };
    const l1s = s.summaries.filter((e) => e.level === 1);
    assert.ok(l1s.length >= 1, 'setup: at least one L1 produced');
    assert.ok(membrane.callCount() >= 1, 'setup: LLM path was used');

    // ---- 1. Captured verbatim on the entry ----
    const entry = l1s[0];
    assert.ok(entry.responseContent, 'L1 carries responseContent');
    assert.deepStrictEqual(
      entry.responseContent,
      [
        { type: 'thinking', thinking: 'scratch reasoning for call 1', signature: 'sig-1-0123456789abcdef' },
        { type: 'redacted_thinking', data: 'enc-1-payload==' },
        { type: 'text', text: 'Summary #1: things happened and I remember them.' },
      ],
      'reasoning + text blocks stored verbatim in provider order',
    );
    // `content` stays text-only for text consumers.
    assert.strictEqual(entry.content, 'Summary #1: things happened and I remember them.');

    await manager.close();

    // ---- 2. Survives chronicle persistence + reload ----
    const strategy2 = new AutobiographicalStrategy(strategyConfig());
    const manager2 = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: strategy2,
      membrane: makeThinkingMembrane() as never,
    });
    const s2 = strategy2 as unknown as { summaries: SummaryEntry[] };
    const reloaded = s2.summaries.find((e) => e.id === entry.id);
    assert.ok(reloaded, 'entry reloaded from chronicle');
    assert.deepStrictEqual(
      reloaded!.responseContent,
      entry.responseContent,
      'responseContent byte-identical after chronicle round-trip',
    );

    // ---- 3. Emission: the compiled window replays the blocks verbatim ----
    const compiled = await manager2.compile();
    const answer = compiled.messages.find(
      (m) => m.participant === 'Claude' && m.content.some((b) => b.type === 'thinking'),
    );
    assert.ok(answer, 'compiled window contains a summary answer turn with thinking');
    const types = answer!.content.map((b: ContentBlock) => b.type);
    assert.deepStrictEqual(
      types.slice(0, 3),
      ['thinking', 'redacted_thinking', 'text'],
      'blocks emitted in provider order, reasoning before text',
    );
    const thinkingBlock = answer!.content[0] as { signature?: string; thinking?: string };
    assert.strictEqual(thinkingBlock.signature, 'sig-1-0123456789abcdef', 'signature untouched');
    const redacted = answer!.content[1] as { data?: string };
    assert.strictEqual(redacted.data, 'enc-1-payload==', 'encrypted payload untouched');

    await manager2.close();
  });

  it('captures reasoning on merged (L2+) summaries too', async () => {
    cleanup();

    const membrane = makeThinkingMembrane();
    const strategy = new AutobiographicalStrategy({
      ...strategyConfig(),
      mergeThreshold: 2,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as never,
    });

    for (let i = 0; i < 24; i++) {
      manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', [
        { type: 'text', text: filler(30) },
      ]);
    }

    await manager.compile();
    // Drive ticks until merges settle (bounded).
    for (let i = 0; i < 12; i++) await manager.tick();

    const s = strategy as unknown as { summaries: SummaryEntry[] };
    const merged = s.summaries.filter((e) => e.level >= 2);
    assert.ok(merged.length >= 1, 'setup: at least one L2 merge happened');
    for (const m of merged) {
      assert.ok(m.responseContent, `merged ${m.id} carries responseContent`);
      const mTypes = m.responseContent!.map((b) => b.type);
      assert.ok(mTypes.includes('thinking'), 'merged summary kept its thinking block');
      assert.ok(mTypes.includes('text'), 'merged summary kept its text');
    }

    await manager.close();
  });

  it('leaves responseContent absent for reasoning-free responses (non-thinking models)', async () => {
    cleanup();

    let calls = 0;
    const plainMembrane = {
      complete: async () => {
        calls++;
        return {
          content: [{ type: 'text', text: `Plain summary #${calls}.` }],
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      },
    };
    const strategy = new AutobiographicalStrategy(strategyConfig());
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: plainMembrane as never,
    });

    for (let i = 0; i < 8; i++) {
      manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', [
        { type: 'text', text: filler(30) },
      ]);
    }
    await manager.compile();
    await manager.tick();

    const s = strategy as unknown as { summaries: SummaryEntry[] };
    const l1s = s.summaries.filter((e) => e.level === 1);
    assert.ok(l1s.length >= 1, 'setup: at least one L1 produced');
    assert.strictEqual(l1s[0].responseContent, undefined, 'no responseContent for text-only responses');

    await manager.close();
  });
});
