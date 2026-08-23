/**
 * Prompt-cache breakpoints on compression (L1) and merge (L2+) requests.
 *
 * A summarizer prompt re-sends the tools, the head window and the whole recall
 * frontier around a chunk that is a small fraction of the payload, and used to
 * carry no breakpoint at all — the stable prefix was re-billed in full on
 * every call.
 *
 * Load-bearing properties:
 *  - a compression request marks the end of the head window and the in-band
 *    compression marker, and nothing else;
 *  - marks reach the request as the message-level `cacheBreakpoint` flag, not
 *    as `cache_control` written onto a block: membrane applies the flag only
 *    when prompt caching is on, so a transport that rejects `cache_control`
 *    keeps working, and the flag is counted so the redundant tools/system
 *    fallbacks are suppressed;
 *  - the assembly-time block sentinel never survives into the request;
 *  - no recall-pair answer is marked — `buildRecallCurveVariants` matches a
 *    pair to expand by exact JSON equality against `summaryAnswerContent`,
 *    so a marked pair body would silently lose that parent its fallback;
 *  - the store's own content blocks are never mutated;
 *  - merge requests are marked too;
 *  - at most 2 strategy breakpoints per request, leaving room under the
 *    provider's 4-block limit.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-compression-cache-breakpoints';
const TEST_COMPRESSION_MODEL = 'test-compression-model';
const HEAD_SENTINEL = 'HEAD_SENTINEL_OPENING';
const MARKER_PREFIX = 'System: You will soon form a new memory';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

interface ApiMessage { participant: string; content: ContentBlock[]; cacheBreakpoint?: boolean }
interface ApiRequest { messages: ApiMessage[]; cacheTtl?: string }

function createCapturingMembrane() {
  const calls: ApiRequest[] = [];
  const membrane = {
    complete: async (request: ApiRequest) => {
      calls.push(request);
      const inputChars = request.messages
        .flatMap((m) => m.content)
        .map((b) => (b as { text?: string }).text ?? '')
        .join('').length;
      const summary = `[mock summary] ` + 'x '.repeat(Math.max(30, Math.floor(inputChars / 10)));
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: summary }],
        usage: { input_tokens: Math.ceil(inputChars / 4), output_tokens: Math.ceil(summary.length / 4) },
      };
    },
  };
  return { membrane, calls };
}

const t = (s: string): ContentBlock => ({ type: 'text', text: s });

function flatText(m: ApiMessage): string {
  return m.content.map((b) => (b as { text?: string }).text ?? '').join(' ');
}

/** Indices of messages flagged as cache breakpoints. */
function markedMessageIndexes(messages: ApiMessage[]): number[] {
  return messages.map((m, i) => (m.cacheBreakpoint ? i : -1)).filter((i) => i >= 0);
}

/**
 * Blocks carrying either the assembly-time sentinel or a hand-written
 * `cache_control`. Both must be zero in a built request: the sentinel is
 * internal, and writing `cache_control` directly would bypass membrane's
 * prompt-caching gate.
 */
function strayMarkedBlocks(messages: ApiMessage[]): number {
  return messages.reduce(
    (n, m) =>
      n +
      m.content.filter((b) => {
        const rec = b as unknown as Record<string, unknown>;
        return !!rec['__cmCacheBreakpoint'] || !!rec['cache_control'];
      }).length,
    0,
  );
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

describe('Compression prompt-cache breakpoints', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('marks the head window and the in-band marker, and nothing else', async () => {
    cleanup();
    const { membrane, calls } = createCapturingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 80,
      headWindowTokens: 60, // covers the two sentinel opening messages
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 100, // keep this test on pure L1 calls
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    manager.addMessage('user', [t(`${HEAD_SENTINEL} can you explore a story with me`)]);
    manager.addMessage('agent', [t('HEAD_SENTINEL_REPLY yes let us explore that story together')]);

    const filler = (i: number) => `event ${i} ` + 'substantive words about real happenings '.repeat(8);
    for (let i = 0; i < 40; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(filler(i))]);
    }

    await drain(manager);
    assert.ok(calls.length >= 2, `expected multiple L1 calls, got ${calls.length}`);

    let withRecalls = 0;
    for (const call of calls) {
      const texts = call.messages.map(flatText);
      const headIdx = texts.findIndex((s) => s.includes(HEAD_SENTINEL));
      const markerIdx = texts.findIndex((s) => s.includes(MARKER_PREFIX));
      assert.ok(headIdx >= 0, 'head window must be present in every compression request');
      assert.ok(markerIdx >= 0, 'in-band compression marker must be present');

      // The head breakpoint sits on the LAST head message, which is the one
      // immediately before the first recall pair (or before the marker when
      // the frontier is empty) — not necessarily the sentinel itself.
      const marked = markedMessageIndexes(call.messages);
      assert.equal(
        marked.length,
        2,
        `expected exactly 2 marked messages, got ${marked.length} in [${marked.join(', ')}]`,
      );
      assert.equal(
        strayMarkedBlocks(call.messages),
        0,
        'no block may carry the internal sentinel or a hand-written cache_control',
      );
      assert.ok(
        marked[0]! >= headIdx && marked[0]! < markerIdx,
        `head breakpoint (idx ${marked[0]}) must land in the head window, before the marker (idx ${markerIdx})`,
      );
      assert.equal(marked[1], markerIdx, 'second breakpoint must be the in-band marker');

      const recallIdx = texts.findIndex((s) => s.includes('[CM] Recall memory'));
      if (recallIdx >= 0) {
        withRecalls++;
        assert.ok(
          marked[0]! < recallIdx,
          'head breakpoint must precede the recall frontier so it survives frontier churn',
        );
      }

      // Every marked message ends in a non-empty text block, so membrane's
      // lastCacheableBlockIndex can never be forced onto a thinking block.
      for (const i of marked) {
        const content = call.messages[i]!.content;
        const last = content[content.length - 1] as { type: string; text?: string };
        assert.equal(last.type, 'text', 'a marked message must end in a text block');
        assert.ok((last.text ?? '').trim().length > 0, 'that text block must be non-empty');
      }
      assert.equal(call.cacheTtl, '1h', 'default breakpoint TTL');
    }
    assert.ok(withRecalls >= 1, 'expected at least one call carrying recall pairs');

    await manager.close();
  });

  it('leaves recall-pair answers unmarked (recall-curve variants match by exact JSON)', async () => {
    cleanup();
    const { membrane, calls } = createCapturingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 80,
      headWindowTokens: 60,
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 100,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    manager.addMessage('user', [t(`${HEAD_SENTINEL} can you explore a story with me`)]);
    manager.addMessage('agent', [t('HEAD_SENTINEL_REPLY yes let us explore that story together')]);
    const filler = (i: number) => `event ${i} ` + 'substantive words about real happenings '.repeat(8);
    for (let i = 0; i < 40; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(filler(i))]);
    }
    await drain(manager);

    let pairsChecked = 0;
    for (const call of calls) {
      const texts = call.messages.map(flatText);
      for (let i = 0; i < call.messages.length - 1; i++) {
        if (!texts[i]!.includes('[CM] Recall memory')) continue;
        pairsChecked++;
        for (const idx of [i, i + 1]) {
          assert.ok(
            !call.messages[idx]!.cacheBreakpoint,
            `recall pair message ${idx} must not be a breakpoint`,
          );
          assert.equal(
            strayMarkedBlocks([call.messages[idx]!]),
            0,
            `recall pair message ${idx} must be byte-identical to its canonical construction ` +
              '— any added field here costs that parent its refusal-curve variant',
          );
        }
      }
    }
    assert.ok(pairsChecked >= 1, 'expected at least one recall pair to check');

    await manager.close();
  });

  it('never mutates the stored content blocks', async () => {
    cleanup();
    const { membrane } = createCapturingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 80,
      headWindowTokens: 60,
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 100,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    manager.addMessage('user', [t(`${HEAD_SENTINEL} can you explore a story with me`)]);
    manager.addMessage('agent', [t('HEAD_SENTINEL_REPLY yes let us explore that story together')]);
    const filler = (i: number) => `event ${i} ` + 'substantive words about real happenings '.repeat(8);
    for (let i = 0; i < 40; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(filler(i))]);
    }
    await drain(manager);

    const stored = manager.getAllMessages();
    assert.ok(stored.length > 0, 'fixture must have stored messages');
    for (const m of stored) {
      assert.equal(
        strayMarkedBlocks([{ participant: m.participant, content: m.content }]),
        0,
        'a mark on a stored block would leak into the live compile and ' +
          'spend one of the provider\'s four breakpoints',
      );
    }

    await manager.close();
  });

  it('marks merge requests too', async () => {
    cleanup();
    const { membrane, calls } = createCapturingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 80,
      headWindowTokens: 60,
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 3, // force L2 merges
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    manager.addMessage('user', [t(`${HEAD_SENTINEL} can you explore a story with me`)]);
    manager.addMessage('agent', [t('HEAD_SENTINEL_REPLY yes let us explore that story together')]);
    const filler = (i: number) => `event ${i} ` + 'substantive words about real happenings '.repeat(8);
    for (let i = 0; i < 80; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(filler(i))]);
    }
    await drain(manager);

    // Merge requests carry the merge instruction rather than the L1 marker.
    const merges = calls.filter((c) => !c.messages.some((m) => flatText(m).includes(MARKER_PREFIX)));
    assert.ok(merges.length >= 1, `expected at least one merge call, got ${merges.length}`);
    for (const call of merges) {
      const marked = markedMessageIndexes(call.messages);
      assert.ok(marked.length >= 1, 'a merge request must carry at least the head breakpoint');
      assert.ok(
        marked.length <= 2,
        `at most 2 strategy breakpoints (provider allows 4 incl. membrane fallbacks), got ${marked.length}`,
      );
      assert.equal(strayMarkedBlocks(call.messages), 0, 'no stray block-level marks');
      for (const i of marked) {
        const content = call.messages[i]!.content;
        const last = content[content.length - 1] as { type: string };
        assert.equal(last.type, 'text', 'a marked message must end in a text block');
      }
    }

    await manager.close();
  });

  it('honors compressionCacheTtl', async () => {
    cleanup();
    const { membrane, calls } = createCapturingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 80,
      headWindowTokens: 60,
      recentWindowTokens: 0,
      hierarchical: true,
      mergeThreshold: 100,
      compressionCacheTtl: '5m',
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });

    manager.addMessage('user', [t(`${HEAD_SENTINEL} can you explore a story with me`)]);
    manager.addMessage('agent', [t('HEAD_SENTINEL_REPLY yes let us explore that story together')]);
    const filler = (i: number) => `event ${i} ` + 'substantive words about real happenings '.repeat(8);
    for (let i = 0; i < 24; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(filler(i))]);
    }
    await drain(manager);

    assert.ok(calls.length >= 1, 'expected at least one compression call');
    for (const call of calls) {
      assert.equal(call.cacheTtl, '5m', 'configured breakpoint TTL reaches the request');
      assert.ok(
        markedMessageIndexes(call.messages).length >= 1,
        'expected at least one breakpoint alongside the configured ttl',
      );
    }

    await manager.close();
  });
});
