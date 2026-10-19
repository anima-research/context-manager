/**
 * Internal machinery for GREEDY folding solvers (flat-profile, oldest-first).
 *
 * These solvers decide one group-raise at a time; that iteration is their
 * algorithm, so it lives here as a private implementation detail behind the
 * solver protocol — the picker never sees intermediate steps. Monotonic by
 * construction: greedy steps only raise (kv-stable is the only solver that
 * plans bidirectionally, and it solves in closed form). The one exception is
 * the seed: a pinned chunk starts at 0, whatever it carried, and a chunk
 * carried at a level where it has no summary starts at the next level down
 * where it has one.
 *
 * A chunk's summary at a level is the one `SummaryTree.ancestorAt` gives, so
 * it lists the chunk. Raising a summary moves the leaves whose summary at its
 * level it is, the chunk that chose it among them; a leaf the summary lists
 * whose own lineage has another summary there, or none, keeps its level. A
 * step raises a chunk through its next summary up
 * (`GreedyState.nextAncestor`), past a level where it has none.
 *
 * Extracted from the former picker-side `MutableFoldingState` when the op
 * walk was retired (see folding-strategy.ts header).
 */

import type {
  ChunkId,
  SummaryId,
  FoldingBudget,
  FoldingSolution,
  ProduceRequest,
} from './folding-strategy.js';
import type { PickerInputs, PickerChunk } from './picker.js';
import { SummaryTree, type SummaryNode } from './summary-tree.js';

/** Read-only chunk view for greedy step decisions. */
export interface GreedyChunkView {
  id: ChunkId;
  sequence: number;
  rawTokens: number;
  currentResolution: number;
  /** The chunk's summary at `level`, which lists it
   *  (`SummaryTree.ancestorAt`), or null when it has none there. */
  ancestorAt(level: number): SummaryNode | null;
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
  /** The chunk's summary at the lowest level above its current one where it
   *  has one, or null when no summary above lists it. A level its lineage
   *  skips, or one whose summary doesn't list it, is passed over, since the
   *  strategy can't produce a summary there: below that level the lineage
   *  already links upward, and its production (`handleProducedOps`) makes an
   *  L1 only for a chunk without one, and merges only summaries that link to
   *  none, two or more at a time. With null, a step asks for the next level,
   *  which that production makes only on those terms. A method of the state
   *  rather than of each view, since the engine makes every view again after
   *  each raise. */
  nextAncestor(chunk: GreedyChunkView): SummaryNode | null;
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
  private readonly tree: SummaryTree;
  private readonly headChunkIds: ReadonlySet<ChunkId>;
  private readonly tailChunkIds: ReadonlySet<ChunkId>;
  private readonly headTokens: number;
  private readonly tailTokens: number;
  private readonly resolutions = new Map<ChunkId, number>();
  private foldableCache: GreedyChunkView[] | null = null;
  private tokenCacheValid = false;
  private tokenCacheValue = 0;

  constructor(inputs: PickerInputs) {
    this.tree = new SummaryTree(inputs);
    this.chunkOrder = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
    for (const c of this.chunkOrder) {
      this.chunkById.set(c.id, c);
      // A pinned chunk renders raw, as computeTokens and the picker's
      // accounting already price it, whether or not the agent locked it. Its
      // carried resolution can be a fold from before the pin was added, and
      // the frontier is what renders (and what the strategy stores), so it
      // starts at 0. A level carried from before the summary tree's links
      // changed can be one where the chunk has no summary, which a greedy
      // step, only raising, would never leave: it starts at the next level
      // down where it has one.
      this.resolutions.set(c.id, c.pinned ? 0 : this.tree.renderableLevel(c.id, c.currentResolution));
    }
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

  nextAncestor(chunk: GreedyChunkView): SummaryNode | null {
    const from = (this.resolutions.get(chunk.id) ?? 0) + 1;
    const next = this.tree.ancestorAt(chunk.id, from);
    if (next) return next;
    const top = this.tree.maxLevel(chunk.id);
    for (let k = from + 1; k <= top; k++) {
      const node = this.tree.ancestorAt(chunk.id, k);
      if (node) return node;
    }
    return null;
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

  /** Raise every unprotected leaf whose summary at groupRoot's level is
   *  groupRoot to that level. */
  applyRaise(groupRoot: SummaryId): void {
    const summary = this.tree.summary(groupRoot);
    if (!summary) throw new Error(`greedy fold: applyRaise: unknown groupRoot ${groupRoot}`);
    const targetLevel = summary.level;
    for (const id of summary.leafChunkIds) {
      const chunk = this.chunkById.get(id);
      if (!chunk) continue;
      if (chunk.pinned || chunk.lockedByAgent) continue;
      if (this.headChunkIds.has(id) || this.tailChunkIds.has(id)) continue;
      if (this.tree.ancestorAt(id, targetLevel)?.id !== groupRoot) continue;
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
      ancestorAt(level: number): SummaryNode | null {
        return self.tree.ancestorAt(c.id, level);
      },
    };
  }

  /** Mirrors the picker's applied-frontier accounting (see picker.ts) for
   *  the frontiers this engine plans, where each chunk's level has a summary
   *  that lists it. */
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
      const ancestor = this.tree.ancestorAt(c.id, effectiveResolution);
      if (!ancestor) {
        total += c.rawTokens;
        continue;
      }
      if (renderedSummaries.has(ancestor.id)) continue;
      renderedSummaries.add(ancestor.id);
      total += ancestor.recallTokens;
    }
    return total;
  }
}
