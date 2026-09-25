/**
 * Compression holds (agent-framework #159 tool-result guard).
 *
 * The guard stages a tool_result with a short placeholder via addMessage and,
 * on acceptance, swaps in the real output with editMessage. Edits do not
 * reach `derived` context entries or the strategy, and Autobiographical dedupes
 * chunks by message id — so if the placeholder is summarized while pending,
 * the real output never reaches compressed memory.
 *
 * A compression hold keeps a message (and everything after it, plus the
 * tool_use it answers) out of every compressible chunk until released; it is
 * transient (in-memory only) so a crash never leaves a permanent stall.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { SummaryEntry } from '../src/types/index.js';

const TEST_STORE_PATH = './test-compression-hold';
const PLACEHOLDER = 'PLACEHOLDER-tool-result-pending';
const REAL = 'REAL-ACCEPTED-TOOL-OUTPUT';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

const filler = (n: number) => 'word '.repeat(n);

function recordingMembrane() {
  const prompts: string[] = [];
  return {
    prompts,
    membrane: {
      complete: async (req: unknown) => {
        prompts.push(JSON.stringify(req));
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${prompts.length}` }] };
      },
    },
  };
}

function newStrategy() {
  return new AutobiographicalStrategy({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 50,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    l1HoldbackChunks: 0,
  });
}

type S = { compressionQueue: number[]; summaries: SummaryEntry[] };

async function drain(manager: ContextManager, strategy: AutobiographicalStrategy) {
  const s = strategy as unknown as S;
  await manager.compile();
  let guard = 0;
  while (s.compressionQueue.length > 0 && guard++ < 50) await manager.tick();
}

/** Seeds history, then a tool exchange staged like the guard does. */
function seed(manager: ContextManager, opts: { holdOnAdd: boolean }) {
  manager.setToolDefinitions([
    { name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} } },
  ]);
  for (let i = 0; i < 6; i++) {
    manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: filler(30) }]);
  }
  const useId = manager.addMessage('Claude', [
    { type: 'text', text: filler(20) },
    { type: 'tool_use', id: 'tu-1', name: 'search', input: { q: filler(10) } },
  ]);
  const resultId = manager.addMessage(
    'User',
    [{ type: 'tool_result', toolUseId: 'tu-1', content: PLACEHOLDER }],
    undefined,
    undefined,
    opts.holdOnAdd ? { holdCompression: true } : undefined,
  );
  // Deferred messages flushed right behind the staged batch push it out of
  // the (zero-size) protected tail.
  for (let i = 0; i < 6; i++) {
    manager.addMessage(i % 2 === 0 ? 'Claude' : 'User', [{ type: 'text', text: filler(30) }]);
  }
  return { useId, resultId };
}

describe('compression holds', () => {
  beforeEach(() => cleanup());
  after(() => cleanup());

  it('baseline (no hold): the placeholder is what gets summarized', async () => {
    const { prompts, membrane } = recordingMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: membrane as never });
    const { resultId } = seed(manager, { holdOnAdd: false });
    await drain(manager, strategy);
    manager.editMessage(resultId, [{ type: 'tool_result', toolUseId: 'tu-1', content: REAL }]);
    await drain(manager, strategy);
    assert.ok(prompts.some((p) => p.includes(PLACEHOLDER)), 'placeholder was summarized');
    assert.ok(!prompts.some((p) => p.includes(REAL)), 'real output never reaches memory without a hold');
    manager.close();
  });

  it('held on add: placeholder never summarized; accepted output reaches memory after release', async () => {
    const { prompts, membrane } = recordingMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: membrane as never });
    const { useId, resultId } = seed(manager, { holdOnAdd: true });
    assert.deepStrictEqual([...manager.getCompressionHolds()], [resultId]);

    await drain(manager, strategy);
    const s = strategy as unknown as S;
    assert.ok(s.summaries.some((x) => x.level === 1), 'history before the hold still compresses');
    assert.ok(!prompts.some((p) => p.includes(PLACEHOLDER)), 'placeholder must not be summarized while held');
    for (const sum of s.summaries) {
      assert.ok(!sum.sourceIds.includes(resultId), 'held message not in any summary');
      assert.ok(!sum.sourceIds.includes(useId), 'paired tool_use not in any summary while held');
    }
    // Held message and its tool_use still render raw.
    const compiled = JSON.stringify((await manager.compile()).messages);
    assert.ok(compiled.includes(PLACEHOLDER) && compiled.includes('tu-1'));

    // Acceptance: edit while held, then release.
    manager.editMessage(resultId, [{ type: 'tool_result', toolUseId: 'tu-1', content: REAL }]);
    manager.releaseCompression([resultId]);
    assert.strictEqual(manager.getCompressionHolds().size, 0);
    await drain(manager, strategy);

    assert.ok(prompts.some((p) => p.includes(REAL)), 'accepted output reached a compression request');
    assert.ok(!prompts.some((p) => p.includes(PLACEHOLDER)), 'placeholder never summarized');
    assert.ok(
      s.summaries.some((x) => x.level === 1 && x.sourceIds.includes(resultId) && x.sourceIds.includes(useId)),
      'tool_use + accepted tool_result compressed together into memory',
    );
    manager.close();
  });

  it('holdCompression() after add (before the next compile) also protects the message', async () => {
    const { prompts, membrane } = recordingMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: membrane as never });
    const { resultId } = seed(manager, { holdOnAdd: false });
    manager.holdCompression([resultId]);
    await drain(manager, strategy);
    // Chunks closed before the hold (including ones AFTER it, whose lead-in
    // would carry the placeholder) must wait.
    assert.ok(!prompts.some((p) => p.includes(PLACEHOLDER)));

    manager.editMessage(resultId, [{ type: 'tool_result', toolUseId: 'tu-1', content: REAL }]);
    manager.releaseCompression([resultId]);
    await drain(manager, strategy);
    const s = strategy as unknown as S;
    assert.ok(prompts.some((p) => p.includes(REAL)));
    assert.ok(!prompts.some((p) => p.includes(PLACEHOLDER)));
    assert.ok(s.summaries.some((x) => x.sourceIds.includes(resultId)));
    manager.close();
  });

  it('holds are transient: not persisted across reopen (no permanent stall)', async () => {
    const first = recordingMembrane();
    let strategy = newStrategy();
    let manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: first.membrane as never });
    const { resultId } = seed(manager, { holdOnAdd: true });
    manager.sync();
    manager.close();

    const second = recordingMembrane();
    strategy = newStrategy();
    manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: second.membrane as never });
    manager.setToolDefinitions([
      { name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} } },
    ]);
    assert.strictEqual(manager.getCompressionHolds().size, 0);
    await drain(manager, strategy);
    const s = strategy as unknown as S;
    assert.ok(s.summaries.some((x) => x.sourceIds.includes(resultId)), 'withheld placeholder compresses normally after restart');
    manager.close();
  });

  it('removing a held message drops its hold', async () => {
    const { membrane } = recordingMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: membrane as never });
    const { resultId } = seed(manager, { holdOnAdd: true });
    manager.removeMessage(resultId);
    assert.strictEqual(manager.getCompressionHolds().size, 0);
    manager.close();
  });

  it('release/hold of unknown ids is a no-op', async () => {
    const { membrane } = recordingMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, membrane: membrane as never });
    manager.releaseCompression(['nope']);
    manager.holdCompression(['nope']);
    assert.strictEqual(manager.getCompressionHolds().size, 0);
    manager.close();
  });
});
