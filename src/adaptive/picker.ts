/**
 * Picker orchestrator for the adaptive-resolution design.
 *
 * The picker is a thin loop: build a FoldingState, call strategy.selectNextFold
 * until it returns null, applying 'raise'/'lower' ops as they come and recording
 * 'produce' ops for the caller to enqueue.
 *
 * The picker is stateless across runs — all persistent state lives on the
 * per-chunk fields. Each run builds a fresh FoldingState from the inputs.
 *
 * See `docs/adaptive-resolution-design.md` §5.
 */

import type {
  FoldingStrategy,
  FoldingState,
  FoldingBudget,
  FoldOp,
  ChunkView,
  ChunkId,
  SummaryId,
  ChunkRange,
} from './folding-strategy.js';
import type { SummaryEntry } from '../types/strategy.js';
import { getSummaryParentId } from '../types/strategy.js';

/**
 * Error raised by the strategy when the picker has folded everything it can
 * and the resulting context still exceeds the hard token budget.
 *
 * The strategy throws this rather than silently dropping entries. The host
 * application decides how to respond — typical responses: raise the budget,
 * switch to a larger-context model, drop the head/tail windows explicitly,
 * or surface a "context too large" error to the user.
 *
 * See `docs/adaptive-resolution-design.md` §3.10.
 */
export class OverBudgetError extends Error {
  /** The hard budget the strategy was trying to fit under. */
  readonly budget: number;
  /** The token count the strategy could not reduce below `budget`. */
  readonly actual: number;
  /** Diagnostic snapshot of the picker's final state. */
  readonly diagnostics: {
    headTokens: number;
    tailTokens: number;
    middleTokens: number;
    middleChunkCount: number;
    deepestLevel: number;
  };

  constructor(opts: {
    budget: number;
    actual: number;
    diagnostics: OverBudgetError['diagnostics'];
  }) {
    super(
      `Adaptive picker exhausted but ${opts.actual} tokens still exceed hard budget ${opts.budget}` +
        ` (head=${opts.diagnostics.headTokens}, tail=${opts.diagnostics.tailTokens},` +
        ` middle=${opts.diagnostics.middleTokens} across ${opts.diagnostics.middleChunkCount} chunks,` +
        ` deepest fold level=L${opts.diagnostics.deepestLevel})`
    );
    // Writable per Error convention so instanceof-by-name works across
    // iframe / vm boundaries; the field stays writable on the prototype.
    this.name = 'OverBudgetError';
    this.budget = opts.budget;
    this.actual = opts.actual;
    this.diagnostics = opts.diagnostics;
  }
}

/**
 * Error raised when the renderer dropped middle-region messages that NO
 * emitted summary covers — i.e. content that exists in the store but would
 * appear nowhere in the compiled context.
 *
 * This is the counterpart to `OverBudgetError` for the per-message path.
 * `OverBudgetError` fires when the WHOLE window cannot be made to fit; this
 * fires when the window "fit" only because raw middle messages were silently
 * discarded. The distinction matters because the raw-middle path is a
 * fallback for chunks that have not been compressed yet — when it drops, the
 * messages have no summary to fall back to and are simply gone.
 *
 * Silent elision here is indistinguishable from a successful render, so the
 * failure mode is an agent quietly missing a stretch of its own history. It
 * shows up hardest on a FRESH IMPORT, where chunks exist but no summaries
 * have been generated yet — every revived resident hits it on turn one.
 * (First observed 2026-07-26: Rhys, a custody migration, lost 126 of his
 * oldest turns from the window with no error of any kind.)
 *
 * Remediation is a config change, not a retry: raise `recentWindowTokens` so
 * the raw tail covers the un-summarized span, raise `contextBudgetTokens`, or
 * let compression run so the middle has summaries to render.
 */
export class UncoveredDropError extends Error {
  /** Ids of middle-region messages dropped without summary coverage. */
  readonly droppedIds: string[];
  /** Where in the renderer the drop happened (selector + site). */
  readonly site: string;
  readonly diagnostics: { budget: number; totalTokens: number };

  constructor(opts: {
    droppedIds: string[];
    site: string;
    diagnostics: UncoveredDropError['diagnostics'];
  }) {
    const n = opts.droppedIds.length;
    const sample = opts.droppedIds.slice(0, 3).join(', ');
    super(
      `Renderer dropped ${n} middle message(s) that no summary covers ` +
        `(site=${opts.site}, budget=${opts.diagnostics.budget}, ` +
        `rendered=${opts.diagnostics.totalTokens}). These messages would be ` +
        `absent from the agent's context entirely. First ids: ${sample}` +
        (n > 3 ? `, … (+${n - 3} more)` : '') +
        `. Raise recentWindowTokens so the raw tail covers the un-summarized ` +
        `span, raise contextBudgetTokens, or let compression produce summaries.`
    );
    this.name = 'UncoveredDropError';
    this.droppedIds = opts.droppedIds;
    this.site = opts.site;
    this.diagnostics = opts.diagnostics;
  }
}

/**
 * Minimal chunk representation used by the picker. Real callers will adapt
 * their `StoredMessage` instances to this shape.
 */
export interface PickerChunk {
  id: ChunkId;
  sequence: number;
  rawTokens: number;
  currentResolution: number;
  lockedByAgent: boolean;
  bodyGroupId?: string;
  pinned: boolean;
  /**
   * V2 dynamic pin — fix this chunk at EXACTLY this fold level (0 = raw). Set
   * from a `ProtectedRange.level`. Such a chunk is NOT `pinned` (the controller
   * must be able to move it to its level), but the KV-stable controller holds it
   * there and never folds/un-folds it. Ignored by non-kv-stable strategies.
   */
  pinLevel?: number;
  /**
   * V2 dynamic pin — this chunk may fold no deeper than this level (hard cap).
   * Set from a `ProtectedRange.maxLevel`. Honored only by the KV-stable
   * controller (in normal and emergency shedding). Ignored elsewhere.
   */
  pinMaxLevel?: number;
  /**
   * The L1 summary covering this chunk, if any. Higher levels are derived
   * by walking parentId pointers in the summary tree.
   */
  l1Id?: SummaryId;
  /**
   * Salience ∈ [0,1] — the coefficient on this chunk's information loss
   * (design §13.3). Lower = folds earlier and costs less when folded:
   * content whose payload is externalized (code on disk, tool output,
   * images, link drops) vs conversation that exists nowhere else. Default 1.
   * Honored by the kv-stable controller; never overrides hard protections.
   */
  salience?: number;
}

export interface PickerInputs {
  /** All chunks in source order (oldest first). */
  chunks: PickerChunk[];
  /** All summaries, indexed by id. */
  summaries: ReadonlyMap<SummaryId, SummaryEntry>;
  /**
   * Token count for each summary's recall pair. Keyed by summary id.
   * If missing, falls back to SummaryEntry.tokens.
   */
  recallPairTokens?: ReadonlyMap<SummaryId, number>;
  /** Tokens consumed by the head window (fixed, not foldable). */
  headTokens: number;
  /** Tokens consumed by the tail window (fixed, not foldable). */
  tailTokens: number;
  /** Indices into chunks[] that are inside the head window. */
  headChunkIds: ReadonlySet<ChunkId>;
  /** Indices into chunks[] that are inside the tail window. */
  tailChunkIds: ReadonlySet<ChunkId>;
}

export interface PickerResult {
  /** Final resolution state per chunk after all applied ops. */
  finalResolutions: ReadonlyMap<ChunkId, number>;
  /** Ops applied this run, in order. */
  applied: FoldOp[];
  /** Pending production requests the picker emitted. */
  produced: FoldOp[];
  /** Final token count after applying all ops. */
  finalTokens: number;
  /** True if the picker stopped because budget was met. */
  budgetMet: boolean;
  /** True if the picker stopped because no further folds were possible. */
  exhausted: boolean;
  /** Number of iterations the picker performed. */
  iterations: number;
}

/**
 * Floor for the per-run loop bound. Scales with chronicle size to keep the
 * picker from spuriously declaring non-convergence on large stores. See
 * {@link iterationBound}.
 */
const MIN_ITERATIONS = 1_000;

/**
 * Compute the per-run loop bound from chronicle size. A well-behaved strategy
 * converges in at most ~one op per chunk per level (`chunks.length * log_N`),
 * so `chunks.length * 10` is a generous safety net at any reasonable N, and
 * `MIN_ITERATIONS` ensures small chronicles still get adequate headroom for
 * exploratory ops before the strategy commits to a fold.
 *
 * Returning a numeric bound rather than a constant means a 5K-chunk run no
 * longer trips a fixed 10K ceiling that wasn't sized for it.
 */
function iterationBound(chunkCount: number): number {
  return Math.max(MIN_ITERATIONS, chunkCount * 10);
}

export class Picker {
  constructor(private readonly strategy: FoldingStrategy) {}

  run(inputs: PickerInputs, budget: FoldingBudget): PickerResult {
    const state = new MutableFoldingState(inputs);
    const applied: FoldOp[] = [];
    const produced: FoldOp[] = [];
    let iterations = 0;
    const maxIterations = iterationBound(inputs.chunks.length);

    while (iterations < maxIterations) {
      const op = this.strategy.selectNextFold(state, budget);
      if (!op) break;
      iterations++;

      if (op.kind === 'raise') {
        state.applyRaise(op.groupRoot);
        applied.push(op);
      } else if (op.kind === 'lower') {
        state.applyLower(op.groupRoot);
        applied.push(op);
      } else {
        // produce — record and stop. Caller enqueues; next compile retries.
        produced.push(op);
        break;
      }
    }

    if (iterations >= maxIterations) {
      throw new Error(
        `Picker: strategy ${this.strategy.name} exceeded iteration bound (${maxIterations}` +
          ` for ${inputs.chunks.length} chunks); likely non-converging`
      );
    }

    return {
      finalResolutions: state.snapshotResolutions(),
      applied,
      produced,
      finalTokens: state.tokenCount(),
      budgetMet: state.tokenCount() <= budget.targetBudget,
      exhausted: produced.length === 0 && state.tokenCount() > budget.targetBudget,
      iterations,
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Internal mutable state used during one picker run.
 *
 * Implements FoldingState (the strategy-facing view) and additional methods
 * for applying fold ops.
 */
class MutableFoldingState implements FoldingState {
  private readonly chunkById = new Map<ChunkId, PickerChunk>();
  private readonly chunkOrder: PickerChunk[];
  private readonly summaries: ReadonlyMap<SummaryId, SummaryEntry>;
  private readonly recallPairTokens: ReadonlyMap<SummaryId, number>;
  private readonly headChunkIds: ReadonlySet<ChunkId>;
  private readonly tailChunkIds: ReadonlySet<ChunkId>;
  private readonly headTokens: number;
  private readonly tailTokens: number;

  // Cached: chunks that are foldable (middle, not pinned, not locked).
  // Updated lazily when needed.
  private foldableCache: ChunkView[] | null = null;
  private allChunkViews: ChunkView[] | null = null;
  private tokenCacheValid = false;
  private tokenCacheValue = 0;

  // For each chunk, its current resolution (mirrors PickerChunk.currentResolution).
  private resolutions = new Map<ChunkId, number>();

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

  // ---- FoldingState interface ----

  chunks(): readonly ChunkView[] {
    if (!this.allChunkViews) {
      this.allChunkViews = this.chunkOrder.map((c) => this.makeView(c));
    }
    return this.allChunkViews;
  }

  foldableMiddle(): readonly ChunkView[] {
    if (this.foldableCache) return this.foldableCache;
    const out: ChunkView[] = [];
    for (const c of this.chunkOrder) {
      const inHead = this.headChunkIds.has(c.id);
      const inTail = this.tailChunkIds.has(c.id);
      if (inHead || inTail || c.pinned || c.lockedByAgent) continue;
      out.push(this.makeView(c));
    }
    this.foldableCache = out;
    return out;
  }

  getSummary(id: SummaryId): SummaryEntry | null {
    return this.summaries.get(id) ?? null;
  }

  leavesUnder(groupRoot: SummaryId): readonly ChunkView[] {
    const summary = this.summaries.get(groupRoot);
    if (!summary) return [];
    const leafIds = this.collectLeafIds(summary);
    const views: ChunkView[] = [];
    for (const id of leafIds) {
      const c = this.chunkById.get(id);
      if (c) views.push(this.makeView(c));
    }
    return views;
  }

  tokenCount(): number {
    if (this.tokenCacheValid) return this.tokenCacheValue;
    this.tokenCacheValue = this.computeTokens();
    this.tokenCacheValid = true;
    return this.tokenCacheValue;
  }

  // ---- Mutation methods (picker-internal) ----

  applyRaise(groupRoot: SummaryId): void {
    const summary = this.summaries.get(groupRoot);
    if (!summary) {
      throw new Error(`Picker: applyRaise: unknown groupRoot ${groupRoot}`);
    }
    const targetLevel = summary.level;
    const leafIds = this.collectLeafIds(summary);
    for (const id of leafIds) {
      const chunk = this.chunkById.get(id);
      if (!chunk) continue;
      // Skip chunks that the picker has no authority over for resolution.
      // Pinned chunks always render raw (handled at render time), but we
      // also avoid setting stale resolution state on them — the resolution
      // field is meaningless while pinned and might be visited later if
      // the pin is removed, which would be surprising.
      if (chunk.pinned) continue;
      if (chunk.lockedByAgent) continue;
      if (this.headChunkIds.has(id) || this.tailChunkIds.has(id)) continue;
      const current = this.resolutions.get(id) ?? 0;
      if (current < targetLevel) {
        this.resolutions.set(id, targetLevel);
      }
    }
    this.invalidateCaches();
  }

  applyLower(groupRoot: SummaryId): void {
    const summary = this.summaries.get(groupRoot);
    if (!summary) {
      throw new Error(`Picker: applyLower: unknown groupRoot ${groupRoot}`);
    }
    // Lower every leaf under groupRoot by one level (clamped at 0).
    const leafIds = this.collectLeafIds(summary);
    for (const id of leafIds) {
      const chunk = this.chunkById.get(id);
      if (!chunk) continue;
      if (chunk.lockedByAgent) continue;
      const current = this.resolutions.get(id) ?? 0;
      if (current > 0) {
        this.resolutions.set(id, current - 1);
      }
    }
    this.invalidateCaches();
  }

  snapshotResolutions(): ReadonlyMap<ChunkId, number> {
    return new Map(this.resolutions);
  }

  // ---- Internals ----

  private invalidateCaches(): void {
    this.foldableCache = null;
    this.allChunkViews = null;
    this.tokenCacheValid = false;
  }

  private makeView(c: PickerChunk): ChunkView {
    const self = this;
    return {
      id: c.id,
      sequence: c.sequence,
      rawTokens: c.rawTokens,
      currentResolution: self.resolutions.get(c.id) ?? 0,
      lockedByAgent: c.lockedByAgent,
      bodyGroupId: c.bodyGroupId,
      inHead: self.headChunkIds.has(c.id),
      inTail: self.tailChunkIds.has(c.id),
      pinned: c.pinned,
      ancestorAt(level: number): SummaryEntry | null {
        return self.ancestorAt(c, level);
      },
      maxAvailableLevel(): number {
        return self.maxAvailableLevel(c);
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

  private maxAvailableLevel(chunk: PickerChunk): number {
    if (!chunk.l1Id) return 0;
    let current: SummaryEntry | undefined = this.summaries.get(chunk.l1Id);
    let max = 0;
    while (current) {
      max = current.level;
      const parentId = getSummaryParentId(current);
      if (!parentId) break;
      current = this.summaries.get(parentId);
    }
    return max;
  }

  private collectLeafIds(summary: SummaryEntry): ChunkId[] {
    // Walk down the summary tree from `summary` to leaf chunks.
    // sourceLevel === 0 means sourceIds are message ids (leaves).
    // Otherwise sourceIds are summary ids and we recurse.
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

  /**
   * Compute total tokens given current resolutions.
   * Algorithm:
   *  - Head + tail are fixed.
   *  - For chunks in foldableMiddle: those at L0 contribute rawTokens.
   *  - Those at L_k (k>0): emit the recall pair for the chunk's L_k ancestor
   *    once per distinct ancestor (sibling chunks under the same ancestor
   *    share the same rendered recall pair).
   */
  private computeTokens(): number {
    let total = this.headTokens + this.tailTokens;
    const renderedSummaries = new Set<SummaryId>();
    for (const c of this.chunkOrder) {
      if (this.headChunkIds.has(c.id) || this.tailChunkIds.has(c.id)) continue;
      // Pinned chunks render at L0 regardless of resolution.
      const effectiveResolution = c.pinned ? 0 : this.resolutions.get(c.id) ?? 0;
      if (effectiveResolution === 0) {
        total += c.rawTokens;
        continue;
      }
      const ancestor = this.ancestorAt(c, effectiveResolution);
      if (!ancestor) {
        // Resolution is set but summary doesn't exist — treat as L0 for
        // accounting purposes (the renderer will need to make the same call).
        total += c.rawTokens;
        continue;
      }
      if (renderedSummaries.has(ancestor.id)) continue;
      renderedSummaries.add(ancestor.id);
      const tok = this.recallPairTokens.get(ancestor.id) ?? ancestor.tokens;
      total += tok;
    }
    return total;
  }
}
