/**
 * Issue #37 regression: compression/merge requests carry cache breakpoints
 * at their stability strata (end of head, last level>=2 recall pair, last
 * recall pair), a 1h cache TTL, and NO markers when the recall ladder was
 * budget-capped (front-eviction shifts the prefix, making cache writes pure
 * waste) or when the kill switch is off.
 *
 * The mint request previously went to the API as bare {participant, content}
 * messages — the inline builders structurally stripped every cache field —
 * so every mint re-read its whole recall prefix cold (field data: 42/42 and
 * 47/47 mints/day fully uncached).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-compression-cache-seams';
const TEST_COMPRESSION_MODEL = 'test-compression-model';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

const t = (text: string): ContentBlock => ({ type: 'text', text });

const RECALL_RE = /^\[CM\] Recall memory (.+)\.$/;
const MARKER_SNIPPET = 'You will soon form a new memory';

interface CapturedCall { request: NormalizedRequest }

function createCapturingMembrane() {
  const calls: CapturedCall[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push({ request });
      const summary =
        'A stretch of routine traffic worth remembering in some detail: ' +
        'word '.repeat(40);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: summary }],
        usage: { input_tokens: 1000, output_tokens: 50 },
      };
    },
  };
  return { membrane, calls };
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

/** Indices of recall-pair headers (single-text CM messages) in a request. */
function recallHeaderIndices(request: NormalizedRequest): number[] {
  const out: number[] = [];
  request.messages.forEach((m, i) => {
    const b = m.content[0];
    if (
      m.participant === 'Context Manager' &&
      m.content.length === 1 &&
      b?.type === 'text' &&
      RECALL_RE.test(b.text)
    ) out.push(i);
  });
  return out;
}

function breakpointIndices(request: NormalizedRequest): number[] {
  const out: number[] = [];
  request.messages.forEach((m, i) => { if (m.cacheBreakpoint) out.push(i); });
  return out;
}

function isMerge(request: NormalizedRequest): boolean {
  return !request.messages.some((m) =>
    m.content.some((b) => b.type === 'text' && b.text.includes(MARKER_SNIPPET)));
}

async function runWorkload(
  options: Record<string, unknown>,
  turns: number,
): Promise<CapturedCall[]> {
  cleanup();
  const { membrane, calls } = createCapturingMembrane();
  const strategy = new AutobiographicalStrategy({
    compressionModel: TEST_COMPRESSION_MODEL,
    targetChunkTokens: 80,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: true,
    ...options,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
  const manager = await ContextManager.open({
    path: TEST_STORE_PATH,
    strategy,
    membrane: membrane as any,
  });
  for (let i = 0; i < turns; i++) {
    manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [
      t(`turn ${i} of steady substantive traffic about the ongoing work `.repeat(3)),
    ]);
    await drain(manager);
  }
  await manager.close();
  return calls;
}

describe('Compression requests: cache seams (issue #37)', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('mints with a recall ladder mark the frontier pair and set the 1h TTL', async () => {
    const calls = await runWorkload({}, 40);
    const laddered = calls.filter((c) => recallHeaderIndices(c.request).length > 0 && !isMerge(c.request));
    assert.ok(laddered.length >= 2, `expected laddered compress calls, got ${laddered.length}`);
    for (const { request } of laddered) {
      const headers = recallHeaderIndices(request);
      const bps = breakpointIndices(request);
      const frontierAnswer = headers[headers.length - 1] + 1;
      assert.ok(bps.includes(frontierAnswer),
        `frontier answer (idx ${frontierAnswer}) not marked; bps=[${bps}] headers=[${headers}]`);
      assert.ok(bps.length <= 3, `at most 3 seams expected, got ${bps.length}`);
      // Every marker must sit inside the ladder region (never on the marker,
      // chunk slice, or instruction that follow the last pair).
      for (const bp of bps) {
        assert.ok(bp <= frontierAnswer, `marker at ${bp} lies past the frontier (${frontierAnswer})`);
      }
      assert.strictEqual(request.cacheTtl, '1h');
    }
  });

  it('the first mint (no prior ladder) carries no markers', async () => {
    const calls = await runWorkload({}, 40);
    const first = calls[0].request;
    assert.strictEqual(recallHeaderIndices(first).length, 0, 'first mint should have no recall pairs');
    assert.strictEqual(breakpointIndices(first).length, 0, 'no ladder → nothing to mark');
  });

  it('merge requests mark only prior-ladder pairs, never expanded sources', async () => {
    const calls = await runWorkload({ mergeThreshold: 2 }, 60);
    const merges = calls.filter((c) => isMerge(c.request));
    assert.ok(merges.length >= 2, `expected >=2 merges, got ${merges.length}`);
    // The first merge consumes the oldest L1s — its prior ladder is empty
    // (and, being an L2 merge, its sources expand to RAW messages, not
    // pairs) — so it must carry no markers at all.
    const firstMerge = merges[0].request;
    assert.strictEqual(breakpointIndices(firstMerge).length, 0,
      'empty prior ladder → no markers');
    // Later merges with consolidated priors mark the prior frontier: every
    // marker must sit on some recall-pair answer.
    const marked = merges.filter((m) => breakpointIndices(m.request).length > 0);
    assert.ok(marked.length >= 1, 'expected at least one merge with a prior ladder to be marked');
    for (const { request } of marked) {
      const answers = new Set(recallHeaderIndices(request).map((h) => h + 1));
      for (const bp of breakpointIndices(request)) {
        assert.ok(answers.has(bp), `marker at ${bp} is not a recall-pair answer`);
      }
    }
    // L3+ merges expand their SOURCES as recall pairs too — those trail the
    // prior ladder (pair answer directly before the closing instruction).
    // Markers must never reach that source expansion.
    const l3Merges = merges.filter((m) => {
      const n = m.request.messages.length;
      const headers = recallHeaderIndices(m.request);
      return headers.length >= 2 && headers[headers.length - 1] === n - 3;
    });
    for (const { request } of l3Merges) {
      const headers = recallHeaderIndices(request);
      // mergeThreshold 2 → exactly two trailing source pairs.
      const firstSourceHeader = headers[headers.length - 2];
      for (const bp of breakpointIndices(request)) {
        assert.ok(bp < firstSourceHeader,
          `marker at ${bp} reaches the source expansion (starts at ${firstSourceHeader})`);
      }
    }
  });

  it('a budget-capped recall ladder suppresses all markers', async () => {
    const calls = await runWorkload({ compressionRecallBudgetTokens: 150 }, 60);
    const capped = calls.filter((c) => {
      const headers = recallHeaderIndices(c.request);
      return headers.length > 0 && !isMerge(c.request);
    });
    // With a 150-token ladder budget, later mints are necessarily capped
    // (each summary is ~100 chars + 50 overhead); every capped request must
    // carry zero markers.
    const late = calls.slice(-3).filter((c) => !isMerge(c.request));
    assert.ok(late.length > 0, 'expected late compress calls');
    for (const { request } of late) {
      assert.strictEqual(breakpointIndices(request).length, 0,
        'capped ladder → markers suppressed (front-eviction shifts the prefix)');
    }
    assert.ok(capped.length > 0, 'expected at least one laddered call in the capped run');
  });

  it('compressionCacheMarkers: false disables seams entirely', async () => {
    const calls = await runWorkload({ compressionCacheMarkers: false }, 40);
    for (const { request } of calls) {
      assert.strictEqual(breakpointIndices(request).length, 0);
    }
  });

  it('stale block-level cache_control on replayed content is stripped (4-breakpoint safety)', async () => {
    cleanup();
    const { membrane, calls } = createCapturingMembrane();
    const strategy = new AutobiographicalStrategy({
      compressionModel: TEST_COMPRESSION_MODEL,
      targetChunkTokens: 80,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      hierarchical: true,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as any,
    });
    for (let i = 0; i < 40; i++) {
      // Imported histories can carry request-time cache_control on stored
      // blocks (Arc exports). The formatter counts those toward Anthropic's
      // 4-breakpoint limit alongside the seams.
      const block = {
        type: 'text',
        text: `turn ${i} of imported traffic with stale markers `.repeat(3),
        cache_control: { type: 'ephemeral' },
      } as unknown as ContentBlock;
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [block]);
      await drain(manager);
    }
    await manager.close();
    assert.ok(calls.length > 0, 'expected compression calls');
    for (const { request } of calls) {
      for (const m of request.messages) {
        for (const b of m.content) {
          assert.strictEqual((b as { cache_control?: unknown }).cache_control, undefined,
            'stale block-level cache_control must not reach the mint request');
        }
      }
      assert.ok(breakpointIndices(request).length <= 3,
        'total breakpoints must stay within the seam budget');
    }
  });

  it('head window present → the message before the first pair is marked', async () => {
    const calls = await runWorkload({ headWindowTokens: 60 }, 40);
    const laddered = calls.filter((c) => recallHeaderIndices(c.request).length > 0 && !isMerge(c.request));
    assert.ok(laddered.length >= 1, 'expected laddered compress calls');
    const { request } = laddered[laddered.length - 1];
    const headers = recallHeaderIndices(request);
    const bps = breakpointIndices(request);
    if (headers[0] > 0) {
      assert.ok(bps.includes(headers[0] - 1),
        `head end (idx ${headers[0] - 1}) not marked; bps=[${bps}]`);
    }
  });
});
