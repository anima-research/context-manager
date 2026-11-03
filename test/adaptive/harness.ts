/**
 * Synthetic test harness for the adaptive-resolution picker.
 *
 * Builds a minimal in-memory chronicle simulator with:
 *  - Chunks (PickerChunk shape) with deterministic token counts.
 *  - A mocked LLM that produces deterministic "summaries" by hashing input.
 *  - A summary tree that grows as the LLM is called.
 *  - A function to run the picker against a built state.
 *
 * The mock LLM doesn't actually call any API — it constructs fake summary
 * content so we can validate picker logic, fold semantics, and cache stickiness
 * without external dependencies.
 */

import type { SummaryEntry } from '../../src/types/strategy.js';
import type { PickerChunk, PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId, SummaryId } from '../../src/adaptive/folding-strategy.js';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import type { ExactPolicyCandidate } from '../../src/adaptive/kv-unified-policy.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';

/**
 * Default tokens per recall pair, regardless of source level.
 * The design specifies that L_k summaries target a constant size (~2K tokens
 * by convention) so each level's recall pair has predictable footprint.
 */
export const DEFAULT_RECALL_PAIR_TOKENS = 200;

/** Default group size: how many L_k items combine into one L_{k+1}. */
export const DEFAULT_MERGE_THRESHOLD = 6;

export interface MockChronicleOptions {
  /** Tokens for each recall pair. */
  recallPairTokens?: number;
  /** L_k items per L_{k+1} parent. */
  mergeThreshold?: number;
}

/**
 * Mutable in-memory chronicle. Mirrors what the real strategy would manage
 * but trimmed to just what the picker needs.
 */
export class MockChronicle {
  readonly chunks: PickerChunk[] = [];
  readonly summaries = new Map<SummaryId, SummaryEntry>();
  readonly recallPairTokens = new Map<SummaryId, number>();
  private summaryCounter = new Map<number, number>(); // level -> next id

  readonly mergeThreshold: number;
  readonly defaultRecallPairTokens: number;

  /** Mock LLM call count, for telemetry assertions. */
  llmCalls = 0;

  constructor(opts: MockChronicleOptions = {}) {
    this.mergeThreshold = opts.mergeThreshold ?? DEFAULT_MERGE_THRESHOLD;
    this.defaultRecallPairTokens = opts.recallPairTokens ?? DEFAULT_RECALL_PAIR_TOKENS;
  }

  /**
   * Add a chunk to the chronicle (e.g., a chat message or a doc shard).
   *
   * @returns the created PickerChunk
   */
  addChunk(opts: {
    id: ChunkId;
    rawTokens: number;
    bodyGroupId?: string;
    pinned?: boolean;
    lockedByAgent?: boolean;
  }): PickerChunk {
    const chunk: PickerChunk = {
      id: opts.id,
      sequence: this.chunks.length,
      rawTokens: opts.rawTokens,
      currentResolution: 0,
      lockedByAgent: opts.lockedByAgent ?? false,
      bodyGroupId: opts.bodyGroupId,
      pinned: opts.pinned ?? false,
    };
    this.chunks.push(chunk);
    return chunk;
  }

  /**
   * Produce an L1 summary for a range of chunks. Mocks the LLM call.
   * Idempotent: the same chunk range produces the same summary id.
   *
   * @returns the produced SummaryEntry (or the existing one if already produced)
   */
  produceL1(chunkIds: ChunkId[]): SummaryEntry {
    const sortedIds = [...chunkIds].sort();
    const sourceKey = `L1:${sortedIds.join(',')}`;
    // Idempotency check
    for (const existing of this.summaries.values()) {
      if (existing.level === 1 && summaryKey(existing) === sourceKey) {
        return existing;
      }
    }
    const id = this.allocSummaryId(1);
    const entry: SummaryEntry = {
      id,
      level: 1,
      content: `[mock L1 summary covering ${chunkIds.length} chunks: ${chunkIds.join(', ')}]`,
      tokens: this.defaultRecallPairTokens,
      sourceLevel: 0,
      sourceIds: [...chunkIds],
      sourceRange: { first: chunkIds[0], last: chunkIds[chunkIds.length - 1] },
      created: Date.now(),
    };
    this.summaries.set(id, entry);
    this.recallPairTokens.set(id, this.defaultRecallPairTokens);
    this.linkChunksToL1(chunkIds, id);
    this.llmCalls++;
    return entry;
  }

  /**
   * Produce an L_{k+1} summary from N L_k summaries.
   */
  produceUpper(level: number, sourceSummaryIds: SummaryId[]): SummaryEntry {
    if (level < 2) {
      throw new Error('produceUpper requires level >= 2; use produceL1 for level 1');
    }
    const sortedIds = [...sourceSummaryIds].sort();
    const sourceKey = `L${level}:${sortedIds.join(',')}`;
    for (const existing of this.summaries.values()) {
      if (existing.level === level && summaryKey(existing) === sourceKey) {
        return existing;
      }
    }
    const sources = sourceSummaryIds.map((sid) => {
      const s = this.summaries.get(sid);
      if (!s) throw new Error(`produceUpper: unknown source summary ${sid}`);
      if (s.level !== level - 1) {
        throw new Error(`produceUpper: source ${sid} is level ${s.level}, expected ${level - 1}`);
      }
      return s;
    });
    const id = this.allocSummaryId(level);
    const entry: SummaryEntry = {
      id,
      level,
      content: `[mock L${level} summary merging ${sourceSummaryIds.length} L${level - 1}s]`,
      tokens: this.defaultRecallPairTokens,
      sourceLevel: level - 1,
      sourceIds: [...sourceSummaryIds],
      sourceRange: {
        first: sources[0].sourceRange.first,
        last: sources[sources.length - 1].sourceRange.last,
      },
      created: Date.now(),
    };
    this.summaries.set(id, entry);
    this.recallPairTokens.set(id, this.defaultRecallPairTokens);
    for (const sid of sourceSummaryIds) {
      const s = this.summaries.get(sid)!;
      s.parentId = id;
    }
    this.llmCalls++;
    return entry;
  }

  /**
   * Speculative pre-producer: when N siblings exist sharing the same potential
   * parent at level k+1, eagerly produce L_{k+1}. Bottom-up, idempotent.
   * Mirrors the design's background pre-producer (§7 #2 settled decisions).
   */
  preProduceUpperLevels(): void {
    let changed = true;
    while (changed) {
      changed = false;
      // Find the deepest existing level
      let maxLevel = 0;
      for (const s of this.summaries.values()) maxLevel = Math.max(maxLevel, s.level);

      for (let level = 1; level <= maxLevel; level++) {
        // Group orphaned (parentId === undefined) summaries at this level
        // by their position in source order. Take consecutive groups of
        // mergeThreshold and produce the L_{k+1} parent.
        const orphans: SummaryEntry[] = [];
        for (const s of this.summaries.values()) {
          if (s.level === level && !s.parentId) orphans.push(s);
        }
        // Sort by sequence of the first chunk in their source range.
        orphans.sort((a, b) => this.firstChunkSeq(a) - this.firstChunkSeq(b));
        while (orphans.length >= this.mergeThreshold) {
          const group = orphans.splice(0, this.mergeThreshold);
          this.produceUpper(
            level + 1,
            group.map((s) => s.id)
          );
          changed = true;
        }
      }
    }
  }

  /**
   * Build a head/tail bookkeeping from chunk indices.
   */
  computeHeadTail(opts: {
    headTokens: number;
    tailTokens: number;
  }): {
    headTokens: number;
    tailTokens: number;
    headChunkIds: Set<ChunkId>;
    tailChunkIds: Set<ChunkId>;
  } {
    const headIds = new Set<ChunkId>();
    const tailIds = new Set<ChunkId>();

    let used = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (used + c.rawTokens > opts.headTokens) break;
      headIds.add(c.id);
      used += c.rawTokens;
    }
    used = 0;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      if (used + c.rawTokens > opts.tailTokens && tailIds.size > 0) break;
      tailIds.add(c.id);
      used += c.rawTokens;
      if (used >= opts.tailTokens) break;
    }

    return {
      headTokens: this.sumTokens(headIds),
      tailTokens: this.sumTokens(tailIds),
      headChunkIds: headIds,
      tailChunkIds: tailIds,
    };
  }

  /**
   * Apply a snapshot of resolutions back onto the chunks (used after running
   * the picker to commit the new state for subsequent turns).
   */
  applyResolutions(resolutions: ReadonlyMap<ChunkId, number>): void {
    for (const c of this.chunks) {
      const r = resolutions.get(c.id);
      if (r !== undefined && r !== c.currentResolution) {
        c.currentResolution = r;
      }
    }
  }

  private linkChunksToL1(chunkIds: ChunkId[], l1Id: SummaryId): void {
    const idSet = new Set(chunkIds);
    for (const c of this.chunks) {
      if (idSet.has(c.id)) c.l1Id = l1Id;
    }
  }

  private allocSummaryId(level: number): SummaryId {
    const n = (this.summaryCounter.get(level) ?? 0);
    this.summaryCounter.set(level, n + 1);
    return `L${level}-${n}`;
  }

  private firstChunkSeq(s: SummaryEntry): number {
    const c = this.chunks.find((ch) => ch.id === s.sourceRange.first);
    return c?.sequence ?? 0;
  }

  private sumTokens(ids: ReadonlySet<ChunkId>): number {
    let t = 0;
    for (const c of this.chunks) if (ids.has(c.id)) t += c.rawTokens;
    return t;
  }
}

function summaryKey(s: SummaryEntry): string {
  return `L${s.level}:${[...s.sourceIds].sort().join(',')}`;
}

/**
 * Convenience: build N chunks with uniform token size, then auto-produce
 * the full summary chain (L1, L2, …) bottom-up via the mergeThreshold rule.
 *
 * Returns the populated MockChronicle.
 */
export function buildChronicleWithChain(opts: {
  chunkCount: number;
  tokensPerChunk: number;
  mergeThreshold?: number;
  recallPairTokens?: number;
  produceChain?: boolean;
}): MockChronicle {
  const chronicle = new MockChronicle({
    mergeThreshold: opts.mergeThreshold,
    recallPairTokens: opts.recallPairTokens,
  });
  for (let i = 0; i < opts.chunkCount; i++) {
    chronicle.addChunk({ id: `c-${i.toString().padStart(4, '0')}`, rawTokens: opts.tokensPerChunk });
  }
  if (opts.produceChain ?? true) {
    // Produce L1s in batches of mergeThreshold (one L1 per batch).
    const threshold = chronicle.mergeThreshold;
    for (let i = 0; i < chronicle.chunks.length; i += threshold) {
      const group = chronicle.chunks.slice(i, i + threshold).map((c) => c.id);
      chronicle.produceL1(group);
    }
    // Bottom-up pre-produce L2, L3, …
    chronicle.preProduceUpperLevels();
  }
  return chronicle;
}

export function seededPolicyFixture(seed: number, external = false, large = false) {
  let state = seed * 2654435761 >>> 0 || 1;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
  const n = large ? 6 + Math.floor(random() * 7) : 4 + Math.floor(random() * 6);
  const chronicle = new MockChronicle({ recallPairTokens: 20 + Math.floor(random() * 40) });
  const ties = random() < 0.25;
  for (let i = 0; i < n; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: ties ? 60 : 10 + Math.floor(random() * 150) });
  const ownerless = external ? Math.floor(random() * 4) : 0;
  const shape = pick(['chain', 'gap', 'holes', 'mixed'] as const);
  const ids = chronicle.chunks.map((chunk) => chunk.id);
  const l1s = [];
  if (shape === 'gap') {
    l1s.push(chronicle.produceL1(ids.filter((_, i) => i % 2 === 0)));
    l1s.push(chronicle.produceL1(ids.filter((_, i) => i % 2 === 1)));
  } else {
    for (let i = 0; i + 1 < n; i += 2 + Math.floor(random() * 2)) l1s.push(chronicle.produceL1(ids.slice(i, Math.min(n, i + 2 + Math.floor(random() * 2)))));
  }
  if (l1s.length >= 2 && random() < 0.5) chronicle.produceUpper(2, [l1s[0].id, l1s[1].id]);
  for (let i = 0; i < ownerless; i++) chronicle.addChunk({ id: `o${i}`, rawTokens: 10 + Math.floor(random() * 90) });
  for (const chunk of chronicle.chunks) {
    if (!ties) chunk.salience = random();
    if ((shape === 'holes' || shape === 'mixed') && random() < 0.25) chunk.pinned = true;
  }
  if (!ties) for (const [id] of chronicle.recallPairTokens) chronicle.recallPairTokens.set(id, 10 + Math.floor(random() * 50));
  const inputs: PickerInputs = { chunks: chronicle.chunks, summaries: chronicle.summaries,
    recallPairTokens: chronicle.recallPairTokens, headTokens: Math.floor(random() * 20), tailTokens: Math.floor(random() * 20),
    headChunkIds: new Set(external && random() < 0.3 ? ['c0'] : []),
    tailChunkIds: new Set(external && random() < 0.4 ? [chronicle.chunks[chronicle.chunks.length - 1].id, ...(random() < 0.5 ? [`c${n - 1}`] : [])] : []) };
  const forest = new CanonicalSummaryForest(inputs, { preserveGapBearingSummaries: true });
  const cuts = forest.enumerateExactCuts().candidates;
  const prior = pick(cuts);
  const layout = renderLayout(inputs, new SummaryTree(inputs), prior.frontier);
  const presented = random();
  const leaves = new Map(inputs.chunks.filter(() => random() < presented).map((chunk) => {
    const level = prior.frontier.get(chunk.id) ?? 0;
    const sid = forest.leaf(chunk.id)!.summaryIds.find((id) => forest.summary(id)!.level === level);
    const hash = random() < 0.15 ? 'summary:stale' : level === 0 ? `raw:${chunk.id}` : `summary:${sid}`;
    return [chunk.id, { level, repHash: hash, lastChangedSeq: Math.floor(random() * 4) }];
  }));
  const floor = forest.minimumTokens();
  const everyMarker = random() < 0.5;
  const grid = large ? pick([[200, 200, 200], [100, 60, 60], [400, 300, 300], [50, 30, 100]])
    : pick([[0, 0, 0], [50, 30, 100], [1000, 1000, 1000], [20, 5, 5], [7, 3, 11]]);
  const options = {
    maxTokens: (floor.floorTokens ?? 0) + Math.floor(random() * 400),
    adoptEpsilon: pick([0, 0, 5, 20]),
    presentation: presented > 0.1 ? { currentSeq: 5, leaves } : undefined,
    cache: { immutablePrefixHash: 'same', layout, markers: everyMarker
      ? layout.units.map((_, i) => ({ unitIndex: i + 1, offset: layout.units[i + 1]?.offset ?? layout.totalTokens }))
      : [{ unitIndex: Math.max(1, Math.floor(layout.units.length / 2)), offset: 100 }, { unitIndex: layout.units.length, offset: layout.totalTokens }] },
    currentImmutablePrefixHash: random() < 0.25 ? 'changed' : 'same',
    tokenBucketSize: grid[0], continuityBucketSize: grid[1], fidelityBucketSize: grid[2],
    policy: { continuityLambda: 50 + Math.floor(random() * 500), cacheLambda: 50 + Math.floor(random() * 500), continuityScale: 100, cacheScale: 100 },
    terminalEvaluation: pick(['full', 'selective'] as const),
  };
  return { inputs, forest, options, prior, random };
}

export const candidateMetrics = (candidates: readonly ExactPolicyCandidate[]) => candidates
  .map((c) => [c.renderedTokens, c.fidelityLoss, c.continuityLoss, c.cacheChurn, c.score].map((v) => Math.round(v * 1e6) / 1e6).join('/'))
  .sort();
