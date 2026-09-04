/**
 * `viewFilter` under the AutobiographicalStrategy — the resident's actual
 * memory machinery (review on #54, Anarchid majors 4/5).
 *
 * Two pins:
 *
 *  1. The LIVE path is clean. With a filter installed, hidden messages never
 *     reach the summarizer's payloads, never appear in compiled output, and
 *     the coverage invariants hold (no UncoveredDropError / assertFullCoverage
 *     throw) — while the store keeps every message. This is tune-out's
 *     situation: a diverted message is stamped in the same write that stores
 *     it, so it is hidden from its first instant.
 *
 *  2. The filter is NOT retroactive over persisted summaries — documented on
 *     `ContextManagerConfig.viewFilter`. A summary written while its sources
 *     were visible still loads and compiles after a later filter hides those
 *     sources. Excision of already-folded content is a chronicle-branch
 *     operation, not a filter. This pin exists so the limitation is a
 *     deliberate, visible contract rather than an unstated one; a future
 *     invalidation feature would update it knowingly.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const BASE = './test-view-filter-autobio';
let storeSeq = 0;
function freshPath(): string {
  return `${BASE}-${storeSeq++}`;
}
after(() => {
  for (let i = 0; i < storeSeq + 1; i++) {
    const p = `${BASE}-${i}`;
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

const t = (s: string): ContentBlock => ({ type: 'text', text: s });
const SECRET = 'DIVERTED-SECRET';

interface ApiMessage { participant: string; content: ContentBlock[] }

/** Summarizer mock: its summary text records whether the payload carried the secret. */
function mockMembrane() {
  const calls: Array<{ messages: ApiMessage[] }> = [];
  return {
    calls,
    membrane: {
      complete: async (request: { messages: ApiMessage[] }) => {
        calls.push({ messages: request.messages });
        const inputText = request.messages
          .flatMap((m) => m.content)
          .map((b) => (b as { text?: string }).text ?? '')
          .join('\n');
        const echo = inputText.includes(SECRET) ? ` (sources contained ${SECRET})` : '';
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: `[mock memory inChars=${inputText.length}]${echo} ` + 'x '.repeat(40) }],
          usage: { input_tokens: Math.ceil(inputText.length / 4), output_tokens: 25 },
        };
      },
    } as never,
  };
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('strategy never became ready');
}

function strategy() {
  return new AutobiographicalStrategy({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 300,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: true,
  });
}

const payloadText = (calls: Array<{ messages: ApiMessage[] }>): string =>
  calls.flatMap((c) => c.messages).flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
const compiledText = (r: { messages: ApiMessage[] }): string =>
  r.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');

describe('viewFilter under AutobiographicalStrategy', () => {
  it('live path: hidden messages never reach the summarizer or the compiled context, and coverage holds', async () => {
    const path = freshPath();
    const { membrane, calls } = mockMembrane();
    const manager = await ContextManager.open({
      path,
      strategy: strategy(),
      membrane: membrane as never,
      viewFilter: (m) => !m.metadata?.tuneOut,
    });

    // 120 messages, 40 hidden: the 80 VISIBLE ones must close at least one
    // 300-token chunk (the trailing partial chunk never compresses).
    const filler = (i: number) => `message ${i} ` + 'word '.repeat(8);
    for (let i = 0; i < 120; i++) {
      if (i % 3 === 0) {
        manager.addMessage('bob', [t(`${SECRET} ${filler(i)}`)], { tuneOut: { epochId: 'e1' } });
      } else {
        manager.addMessage(i % 2 ? 'agent' : 'user', [t(filler(i))]);
      }
    }

    await drain(manager); // throws if the coverage invariants trip
    assert.ok(calls.length > 0, 'compression ran');
    assert.ok(!payloadText(calls).includes(SECRET), 'no summarizer payload carried a hidden message');

    const result = await manager.compile();
    assert.ok(!compiledText(result).includes(SECRET), 'compiled context carries no hidden message');
    assert.equal(manager.getAllMessages().length, 120, 'the store keeps everything');
    assert.equal(
      manager.getAllMessages().filter((m) => (m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut).length,
      40,
    );
    await manager.close();
  });

  it('is NOT retroactive: a summary written while its sources were visible still compiles after a filter hides them', async () => {
    const path = freshPath();
    const { membrane, calls } = mockMembrane();
    // Round 1: no filter. The secret-bearing messages get summarized.
    const open1 = await ContextManager.open({ path, strategy: strategy(), membrane: membrane as never });
    const filler = (i: number) => `message ${i} ` + 'word '.repeat(8);
    for (let i = 0; i < 60; i++) {
      if (i % 3 === 0) {
        open1.addMessage('bob', [t(`${SECRET} ${filler(i)}`)], { hideLater: true });
      } else {
        open1.addMessage(i % 2 ? 'agent' : 'user', [t(filler(i))]);
      }
    }
    await drain(open1);
    assert.ok(payloadText(calls).includes(SECRET), 'precondition: the secret was summarized while visible');
    await open1.close();

    // Round 2: reopen with a filter that hides those sources.
    const open2 = await ContextManager.open({
      path,
      strategy: strategy(),
      membrane: membrane as never,
      viewFilter: (m) => !m.metadata?.hideLater,
    });
    const result = await open2.compile();
    const compiled = compiledText(result);
    assert.ok(
      !result.messages.some((m) => m.participant === 'bob'),
      'the hidden raw messages themselves do not compile',
    );
    assert.ok(
      compiled.includes(`sources contained ${SECRET}`),
      'but a summary written from them does — the filter is not retroactive over derived memory',
    );
    await open2.close();
  });
});
