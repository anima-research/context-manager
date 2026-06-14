/**
 * getRenderStats must INSPECT what select() actually rendered, not RECONSTRUCT
 * a hierarchical view. Regression for the adaptive-resolution case where the
 * reconstructed pyramid (head/tail windows + every live summary) bore no
 * relation to the folded output — and had no bucket at all for raw messages the
 * picker kept verbatim in the middle.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { RenderStats } from '../src/types/index.js';

const TEST_STORE_PATH = './test-render-stats';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}
function text(t: string): ContentBlock[] {
  return [{ type: 'text', text: t }];
}

function assertConsistent(rs: RenderStats): void {
  const s = rs.summaries;
  const sumTokens =
    rs.head.tokens + rs.tail.tokens + rs.middleRaw.tokens +
    s.l1.tokens + s.l2.tokens + s.l3.tokens;
  assert.strictEqual(rs.total.tokens, sumTokens, 'total.tokens === sum of bucket tokens');
  const sumMsgs =
    rs.head.messages + rs.tail.messages + rs.middleRaw.messages +
    (s.l1.count + s.l2.count + s.l3.count) * 2;
  assert.strictEqual(rs.total.messages, sumMsgs, 'total.messages === sum of bucket messages');
}

describe('getRenderStats — inspect, not reconstruct', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('reflects the actually-rendered raw conversation (every message accounted for once)', async () => {
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({ adaptiveResolution: true }),
    });
    const N = 8;
    for (let i = 0; i < N; i++) {
      manager.addMessage(i % 2 ? 'lena' : 'user', text(`message ${i} ${'x'.repeat(20)}`));
    }
    await manager.compile();

    const rs = manager.getRenderStats();
    assert.ok(rs, 'stats present after compile');
    assertConsistent(rs!);
    // Small conversation, no membrane => no compression => no summaries.
    assert.strictEqual(
      rs!.summaries.l1.count + rs!.summaries.l2.count + rs!.summaries.l3.count,
      0,
      'no summaries for a small raw conversation',
    );
    const rawMsgs = rs!.head.messages + rs!.tail.messages + rs!.middleRaw.messages;
    assert.strictEqual(rawMsgs, N, 'every raw message accounted for exactly once');
    assert.ok(rs!.total.tokens > 0, 'non-zero rendered tokens');
    manager.close();
  });

  it('populates middleRaw for mid-conversation messages the picker keeps verbatim', async () => {
    // Small head/recent windows push most messages into the MIDDLE region; with
    // no summaries to fold into, the picker keeps them raw — which the old
    // reconstruction would have reported as 0 middle / all-pyramid.
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({
        adaptiveResolution: true,
        headWindowTokens: 100,
        recentWindowTokens: 100,
      }),
    });
    const N = 20;
    for (let i = 0; i < N; i++) {
      manager.addMessage(i % 2 ? 'lena' : 'user', text(`msg ${i} ${'y'.repeat(40)}`));
    }
    // Generous budget so nothing is evicted (and the picker doesn't go over-budget).
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 1_000 });

    const rs = manager.getRenderStats();
    assert.ok(rs, 'stats present');
    assertConsistent(rs!);
    assert.ok(
      rs!.middleRaw.messages > 0,
      'middle messages kept raw by the picker must show up in middleRaw (inspect, not reconstruct)',
    );
    const rawMsgs = rs!.head.messages + rs!.tail.messages + rs!.middleRaw.messages;
    assert.strictEqual(rawMsgs, N, 'all raw, all accounted for');
    manager.close();
  });

  it('returns a non-null shape (with the new fields) before any compile', async () => {
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({ adaptiveResolution: true }),
    });
    manager.addMessage('user', text('hi'));
    const rs = manager.getRenderStats(); // no compile yet -> reconstruction fallback
    assert.ok(rs, 'fallback stats present');
    assert.ok(rs!.middleRaw && rs!.total, 'fallback includes middleRaw + total');
    manager.close();
  });
});
