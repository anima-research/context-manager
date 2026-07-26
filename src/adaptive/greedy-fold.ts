/**
 * Internal machinery for GREEDY folding solvers (flat-profile, oldest-first).
 *
 * These solvers decide one group-raise at a time; that iteration is their
 * algorithm, so it lives here as a private implementation detail behind the
 * solver protocol — the picker never sees intermediate steps. Monotonic by
 * construction: greedy steps only raise (kv-stable is the only solver that
 * plans bidirectionally, and it solves in closed form).
 *
 * Extracted from the former picker-side `MutableFoldingState` when the op
 * walk was retired (see folding-strategy.ts header).
 */

import type { SummaryEntry } from '../types/strategy.js';
import { getSummaryParentId } from '../types/strategy.js';
import type {
  ChunkId,
  SummaryId,
  FoldingBudget,
  FoldingSolution,
  ProduceRequest,
} from './folding-strategy.js';
import type { PickerInputs, PickerChunk } from './picker.js';

/** Read-only chunk view for greedy step decisions. */
export interface GreedyChunkView {
  id: ChunkId;
  sequence: number;
  rawTokens: number;
  currentResolution: number;
  ancestorAt(level: number): SummaryEntry | null;
}

/** One greedy decision. */
export type GreedyOp =
  | { kind: 'raise'; groupRoot: SummaryId }
  | { kind: 'produce'; request: ProduceRequest };

export interface GreedyState {
  /** Foldable middle (not head/tail, not pinned, not locked), source order. */
  foldableMiddle(): readonly GreedyChunkView[];
  /** Rendered-token estimate at the current resolutions. */
  tokenCount(): number;
}

/**
 * Drive a greedy step function to a full solution.
 *
 * The step is called with the current state and must return a raise, a
 * produce (recorded; solving stops — the caller enqueues production and the
 * next compile retries), or null (done). The internal bound is a safety net
 * against a non-monotonic step; a well-behaved greedy step raises each chunk
 * at most maxLevel times.
 */
export function runGreedy(
  inputs: PickerInputs,
  budget: FoldingBudget,
  step: (state: GreedyState, budget: FoldingBudget) => GreedyOp | null,
): FoldingSolution {
  const engine = new GreedyEngine(inputs);
  const produced: ProduceRequest[] = [];
  const bound = Math.max(1000, inputs.chunks.length * 10);
  let iterations = 0;

  for (;;) {
    if (iterations++ >= bound) {
      throw new Error(
        `greedy fold solver exceeded internal bound (${bound} for ${inputs.chunks.length} chunks); non-monotonic step`,
      );
    }
    const op = step(engine, budget);
    if (!op) break;
    if (op.kind === 'produce') {
      produced.push(op.request);
      break; // record and stop; caller enqueues, next compile retries
    }
    engine.applyRaise(op.groupRoot);
  }

  return {
    frontier: engine.snapshotResolutions(),
    produced,
    // Greedy exhaustion: folded until out of moves (and nothing to produce),
    // yet still above the soft target — see FoldingSolution.exhausted.
    exhausted: produced.length === 0 && engine.tokenCount() > budget.targetBudget,
  };
}

class GreedyEngine implements GreedyState {
  private readonly chunkOrder: PickerChunk[];
  private readonly chunkById = new Map<ChunkId, PickerChunk>();
  private readonly summaries: ReadonlyMap<SummaryId, SummaryEntry>;
  private readonly recallPairTokens: ReadonlyMap<SummaryId, number>;
  private readonly headChunkIds: ReadonlySet<ChunkId>;
  private readonly tailChunkIds: ReadonlySet<ChunkId>;
  private readonly headTokens: number;
  private readonly tailTokens: number;
  private readonly resolutions = new Map<ChunkId, number>();
  private foldableCache: GreedyChunkView[] | null = null;
  private tokenCacheValid = false;
  private tokenCacheValue = 0;

  constructor(inputs: PickerInputs) {
    this.chunkOrder = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
    for (const c of this.chunkOrder) {
      this.chunkById.set(c.id, c);
      this.resolutions.set(c.id, c.currentResolution);
    }
    this.summaries = inputs.summaries;
    this.recallPairTokens = inputs.recallPairTokens ?? new Map();
    this.headChunkIds = inputs.headChunkIds;
    this.tailChunkIds = inputs.tailChunkIds;
    this.headTokens = inputs.headTokens;
    this.tailTokens = inputs.tailTokens;
  }

  foldableMiddle(): readonly GreedyChunkView[] {
    if (this.foldableCache) return this.foldableCache;
    const out: GreedyChunkView[] = [];
    for (const c of this.chunkOrder) {
      if (this.headChunkIds.has(c.id) || this.tailChunkIds.has(c.id)) continue;
      if (c.pinned || c.lockedByAgent) continue;
      out.push(this.makeView(c));
    }
    this.foldableCache = out;
    return out;
  }

  tokenCount(): number {
    if (this.tokenCacheValid) return this.tokenCacheValue;
    this.tokenCacheValue = this.computeTokens();
    this.tokenCacheValid = true;
    return this.tokenCacheValue;
  }

  snapshotResolutions(): ReadonlyMap<ChunkId, number> {
    return new Map(this.resolutions);
  }

  /** Raise every unprotected leaf under groupRoot to the summary's level. */
  applyRaise(groupRoot: SummaryId): void {
    const summary = this.summaries.get(groupRoot);
    if (!summary) throw new Error(`greedy fold: applyRaise: unknown groupRoot ${groupRoot}`);
    const targetLevel = summary.level;
    for (const id of this.collectLeafIds(summary)) {
      const chunk = this.chunkById.get(id);
      if (!chunk) continue;
      if (chunk.pinned || chunk.lockedByAgent) continue;
      if (this.headChunkIds.has(id) || this.tailChunkIds.has(id)) continue;
      const current = this.resolutions.get(id) ?? 0;
      if (current < targetLevel) this.resolutions.set(id, targetLevel);
    }
    this.foldableCache = null;
    this.tokenCacheValid = false;
  }

  private makeView(c: PickerChunk): GreedyChunkView {
    const self = this;
    return {
      id: c.id,
      sequence: c.sequence,
      rawTokens: c.rawTokens,
      get currentResolution() {
        return self.resolutions.get(c.id) ?? 0;
      },
      ancestorAt(level: number): SummaryEntry | null {
        return self.ancestorAt(c, level);
      },
    };
  }

  private ancestorAt(chunk: PickerChunk, level: number): SummaryEntry | null {
    if (level <= 0) return null;
    if (!chunk.l1Id) return null;
    let current: SummaryEntry | undefined = this.summaries.get(chunk.l1Id);
    while (current && current.level < level) {
      const parentId = getSummaryParentId(current);
      if (!parentId) return null;
      current = this.summaries.get(parentId);
    }
    if (!current || current.level !== level) return null;
    return current;
  }

  private collectLeafIds(summary: SummaryEntry): ChunkId[] {
    const out: ChunkId[] = [];
    const visit = (s: SummaryEntry): void => {
      if (s.sourceLevel === 0) {
        for (const mid of s.sourceIds) out.push(mid);
      } else {
        for (const sid of s.sourceIds) {
          const child = this.summaries.get(sid);
          if (child) visit(child);
        }
      }
    };
    visit(summary);
    return out;
  }

  /** Mirrors the picker's applied-frontier accounting (see picker.ts). */
  private computeTokens(): number {
    let total = this.headTokens + this.tailTokens;
    const renderedSummaries = new Set<SummaryId>();
    for (const c of this.chunkOrder) {
      if (this.headChunkIds.has(c.id) || this.tailChunkIds.has(c.id)) continue;
      const effectiveResolution = c.pinned ? 0 : this.resolutions.get(c.id) ?? 0;
      if (effectiveResolution === 0) {
        total += c.rawTokens;
        continue;
      }
      const ancestor = this.ancestorAt(c, effectiveResolution);
      if (!ancestor) {
        total += c.rawTokens;
        continue;
      }
      if (renderedSummaries.has(ancestor.id)) continue;
      renderedSummaries.add(ancestor.id);
      total += this.recallPairTokens.get(ancestor.id) ?? ancestor.tokens;
    }
    return total;
  }
}
