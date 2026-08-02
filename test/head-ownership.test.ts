/**
 * One-to-one representation: ownership wins over the token-derived head window.
 *
 * Chunk records (and the summaries over them) are the persistent authority on
 * how a message is represented in compression/merge payloads. The token-derived
 * head boundary is only chunking *policy* — it is recomputed from the live
 * estimator on every call and is NOT stable: estimator changes move it,
 * transient headWindowTokens<=0 states let sweeps take ownership of head
 * messages, and store surgery can do the same (all observed in production —
 * issue #42: fable's L1-403 owned message indices [0,1,2, 3189…3197] after a
 * middle-L1 sweep, so every compression payload carried the seed twice: raw
 * head + recall pair).
 *
 * The invariant under test: every message appears EXACTLY ONCE in a
 * compression/merge payload — raw if un-owned, via its (single) recall pair /
 * target expansion if covered by a live summary. The head loop must skip
 * covered messages; broad/partial/sparse overlaps lose their head-range
 * messages to the recall pair but keep everything else, so no memory coverage
 * is ever dropped (the over-exclusion failure of the first, reverted fix).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { SummaryEntry } from '../src/types/index.js';
import type { StrategyContext } from '../src/types/strategy.js';
import type { ContentBlock } from '@animalabs/membrane';

const TEST_STORE_PATH = './test-head-ownership';
const SEED_MARKER = 'SEED_ANCHOR_UNIQUE_MARKER';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

let storeCounter = 0;
function freshPath(): string {
  return `${TEST_STORE_PATH}-${storeCounter++}`;
}

/** Count non-overlapping occurrences of `needle` in the JSON of a request. */
function countIn(req: unknown, needle: string): number {
  const blob = JSON.stringify(req);
  let count = 0;
  let at = blob.indexOf(needle);
  while (at >= 0) {
    count++;
    at = blob.indexOf(needle, at + needle.length);
  }
  return count;
}

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void {
    this.pushSummary(entry);
  }

  runCompress(chunk: Chunk, ctx: StrategyContext): Promise<void> {
    return this.compressChunkHierarchical(chunk, ctx);
  }

  runMerge(targetLevel: number, sourceIds: string[], ctx: StrategyContext): Promise<void> {
    return this.executeMerge(targetLevel as never, sourceIds, ctx);
  }

  headBounds(ctx: StrategyContext): { start: number; end: number } {
    return {
      start: this.getHeadWindowStartIndex(ctx.messageStore),
      end: this.getHeadWindowEnd(ctx.messageStore),
    };
  }

  /** Pin the token-derived head boundary to exactly `count` messages: set the
   *  budget to the cumulative estimate of the first `count` messages (the
   *  boundary lands on the first message whose cumulative sum EXCEEDS it). */
  calibrateHeadWindowToMessages(ctx: StrategyContext, count: number): void {
    const messages = ctx.messageStore.getAll();
    let sum = 0;
    for (let i = 0; i < count && i < messages.length; i++) {
      sum += ctx.messageStore.estimateTokens(messages[i]!);
    }
    this.config.headWindowTokens = sum;
  }

  queueLength(): number {
    return this.compressionQueue.length;
  }

  summariesView(): SummaryEntry[] {
    return [...this.summaries];
  }
}

function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

function summary(
  id: string,
  level: number,
  sourceIds: string[],
  tokens = 20,
  content = `authored ${id}`,
): SummaryEntry {
  return {
    id,
    level,
    content,
    tokens,
    sourceLevel: level - 1,
    sourceIds,
    sourceRange: { first: sourceIds[0]!, last: sourceIds[sourceIds.length - 1]! },
    created: Number(id.replace(/\D/g, '')) || 1,
  };
}

describe('One-to-one representation: ownership vs head window', () => {
  before(() => cleanup());
  after(() => {
    cleanup();
    for (let i = 0; i < storeCounter; i++) {
      const p = `${TEST_STORE_PATH}-${i}`;
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
  });

  it('sweep-artifact store: compression payload renders owned head messages via recall pair only', async () => {
    const captured: unknown[] = [];
    const membrane = {
      complete: async (req: unknown) => {
        captured.push(structuredClone(req));
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'fresh L1 summary text' }] };
      },
    };
    const strategy = new ProbeStrategy({
      compressionModel: 'test-compression-model',
      headWindowTokens: 60,
      recentWindowTokens: 0,
      targetChunkTokens: 1_000_000, // no organic chunking; we drive compression manually
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
    });
    const manager = await ContextManager.open({
      path: freshPath(),
      strategy,
      membrane: membrane as never,
    });

    // 10 messages, each with a unique marker.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(manager.addMessage(i % 2 === 0 ? 'user' : 'assistant', textBlock(
        `MSG${i}_MARKER ` + 'word '.repeat(18),
      )));
    }

    // Sweep artifact: an L1 that owns the first two (head-window) messages
    // PLUS a sparse straggler far outside the head — fable's L1-403 shape.
    // Dropping this summary whole would lose the straggler's coverage; the
    // one-to-one rule keeps the summary and yields the head messages to it.
    const sweep = summary('L1-100', 1, [ids[0]!, ids[1]!, ids[9]!]);
    strategy.seed(sweep);

    const ctx = managerContext(manager);
    strategy.calibrateHeadWindowToMessages(ctx, 3); // head = messages 0..2
    const { start, end } = strategy.headBounds(ctx);
    assert.equal(start, 0, 'no topic transition: head starts at 0');
    assert.ok(end >= 2, 'precondition: token-derived head window covers the owned messages');
    assert.ok(end < 6, 'precondition: head window must end before the target chunk');

    // Target chunk over messages 6..7 (uncompressed, outside head).
    const allMessages = ctx.messageStore.getAll();
    const target: Chunk = {
      index: 999,
      startIndex: 6,
      endIndex: 8,
      messages: allMessages.slice(6, 8),
      tokens: 100,
      compressed: false,
    };
    await strategy.runCompress(target, ctx);

    assert.equal(captured.length, 1, 'exactly one compression call');
    const req = captured[0]!;

    // Owned head messages: never raw — represented by the recall pair.
    assert.equal(countIn(req, 'MSG0_MARKER'), 0, 'owned head message 0 must not render raw');
    assert.equal(countIn(req, 'MSG1_MARKER'), 0, 'owned head message 1 must not render raw');
    assert.equal(countIn(req, `Recall memory ${sweep.id}.`), 1, 'the owning summary is recalled exactly once');
    assert.equal(countIn(req, `authored ${sweep.id}`), 1, 'the owning summary content appears exactly once');

    // Un-owned head messages inside the token boundary: raw, exactly once.
    for (let i = 2; i < end; i++) {
      assert.equal(countIn(req, `MSG${i}_MARKER`), 1, `un-owned head message ${i} renders raw exactly once`);
    }
    // The sparse straggler is owned: not raw (neither middle nor tail).
    assert.equal(countIn(req, 'MSG9_MARKER'), 0, 'sparse straggler is covered by the summary, not raw');
    // Chunk content: raw, exactly once.
    assert.equal(countIn(req, 'MSG6_MARKER'), 1, 'chunk message renders raw exactly once');
    assert.equal(countIn(req, 'MSG7_MARKER'), 1, 'chunk message renders raw exactly once');

    await manager.close();
  });

  it('sweep-artifact store: merge payload renders owned head messages via prior recall / target expansion only', async () => {
    const captured: unknown[] = [];
    const membrane = {
      complete: async (req: unknown) => {
        captured.push(structuredClone(req));
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'consolidated L2 text' }] };
      },
    };
    const strategy = new ProbeStrategy({
      compressionModel: 'test-compression-model',
      headWindowTokens: 120, // token boundary reaches over messages owned by L1-100 AND L1-101
      recentWindowTokens: 0,
      targetChunkTokens: 1_000_000,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
    });
    const manager = await ContextManager.open({
      path: freshPath(),
      strategy,
      membrane: membrane as never,
    });

    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push(manager.addMessage(i % 2 === 0 ? 'user' : 'assistant', textBlock(
        `MSG${i}_MARKER ` + 'word '.repeat(18),
      )));
    }

    // L1-100 owns head messages 0..1 (prior, outside the merge tree);
    // L1-101/L1-102 own 2..5 and are the merge sources.
    const prior = summary('L1-100', 1, [ids[0]!, ids[1]!]);
    const srcA = summary('L1-101', 1, [ids[2]!, ids[3]!]);
    const srcB = summary('L1-102', 1, [ids[4]!, ids[5]!]);
    strategy.seed(prior);
    strategy.seed(srcA);
    strategy.seed(srcB);

    const ctx = managerContext(manager);
    strategy.calibrateHeadWindowToMessages(ctx, 4); // head = messages 0..3 — reaches into the merge tree
    const { end } = strategy.headBounds(ctx);
    assert.ok(end >= 4, 'precondition: token-derived head window reaches into the merge tree');

    await strategy.runMerge(2, [srcA.id, srcB.id], ctx);

    assert.equal(captured.length, 1, 'exactly one merge call');
    const req = captured[0]!;

    // Owned head messages: via the prior recall pair, never raw.
    assert.equal(countIn(req, 'MSG0_MARKER'), 0, 'owned head message 0 must not render raw');
    assert.equal(countIn(req, 'MSG1_MARKER'), 0, 'owned head message 1 must not render raw');
    assert.equal(countIn(req, `Recall memory ${prior.id}.`), 1, 'prior summary recalled exactly once');
    assert.equal(countIn(req, `authored ${prior.id}`), 1, 'prior summary content appears exactly once');

    // Merge-tree leaves: exactly once, via the TARGET expansion (raw for an
    // L2 merge) — the head loop must not also emit them.
    for (let i = 2; i <= 5; i++) {
      assert.equal(countIn(req, `MSG${i}_MARKER`), 1, `merge-tree message ${i} appears exactly once (target expansion)`);
    }

    await manager.close();
  });

  it('lifecycle: advance -> compress seed -> snap back -> recompress represents the seed exactly once (via its summary)', async () => {
    cleanup();
    const payloads: unknown[] = [];
    let n = 0;
    const membrane = {
      complete: async (req: unknown) => {
        payloads.push(structuredClone(req));
        n++;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${n}` }] };
      },
    };
    const strategy = new ProbeStrategy({
      compressionModel: 'test-compression-model',
      headWindowTokens: 60,
      recentWindowTokens: 0,
      targetChunkTokens: 25,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: membrane as never,
    });
    const filler = (w: number) => 'word '.repeat(w);

    // 1. Seed / genesis head — the anchor whose double representation
    //    stalled fable (issue #42).
    const seedIds: string[] = [];
    seedIds.push(manager.addMessage('user', textBlock(`${SEED_MARKER}: ${filler(20)}`)));
    seedIds.push(manager.addMessage('assistant', textBlock(`${SEED_MARKER} reply: ${filler(20)}`)));

    // 2. Topic transition -> head window advances past the seed, making the
    //    seed compressible (ownership may now extend into the old head).
    const transitionId = manager.addMessage('Context Manager', textBlock('[Topic Transition]\n\nMoving on.'));
    strategy.resetHeadWindow(transitionId);

    // 3. Topic B filler forms compressible chunks; the chunker takes
    //    ownership of the seed.
    for (let i = 0; i < 8; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'assistant', textBlock(`Topic B ${i}: ${filler(20)}`));
    }
    await manager.compile();
    let guard = 0;
    while (strategy.queueLength() > 0 && guard++ < 40) await manager.tick();

    const seedL1 = strategy.summariesView().find(
      (x) => x.level === 1 && x.sourceIds.some((id) => seedIds.includes(id)),
    );
    assert.ok(seedL1, 'precondition: seed must have been compressed into an L1 covering it');

    // 4. Snap the head window back to the seed (the reset-to-0 / silent
    //    id-fallback case).
    strategy.resetHeadWindow(seedIds[0]!);

    // 5. New content -> fresh compressions. Ownership is persistent, so the
    //    seed renders via its summary — never raw, never twice.
    payloads.length = 0;
    for (let i = 0; i < 8; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'assistant', textBlock(`Topic C ${i}: ${filler(20)}`));
    }
    await manager.compile();
    guard = 0;
    while (strategy.queueLength() > 0 && guard++ < 40) await manager.tick();

    assert.ok(payloads.length > 0, 'a compression call should have been issued for the new chunk');
    for (const req of payloads) {
      assert.equal(
        countIn(req, SEED_MARKER),
        0,
        'the seed is owned by its L1: it must not render raw in any compression payload',
      );
      const frontierId = frontierOver(strategy.summariesView(), seedL1.id);
      assert.equal(
        countIn(req, `Recall memory ${frontierId}.`),
        1,
        `the seed's frontier summary ${frontierId} is recalled exactly once`,
      );
    }

    await manager.close();
  });
});

/** Follow mergedInto links up to the live frontier summary over `id`. */
function frontierOver(summaries: SummaryEntry[], id: string): string {
  const byId = new Map(summaries.map((s) => [s.id, s]));
  let cur = byId.get(id);
  while (cur?.mergedInto && byId.has(cur.mergedInto)) cur = byId.get(cur.mergedInto);
  return cur?.id ?? id;
}
