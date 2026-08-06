/**
 * Picker for the adaptive-resolution design.
 *
 * The picker is a thin, stateless wrapper around a FoldingSolver: one solve
 * produces the complete target frontier; the picker VALIDATES it (loudly —
 * an unrealizable target is a solver bug, never silently absorbed), APPLIES
 * it to the live chunk set, and ACCOUNTS its rendered-token cost with the
 * same unit model the renderer uses.
 *
 * There is no op walk. Through 2026-07 the picker looped over group-atomic
 * 'raise'/'lower' ops emitted by the strategy; group ops cannot express a
 * frontier that cuts through a summary group (which V2 leveled pins require
 * by design), so the walk oscillated and silently rendered frontiers that
 * diverged from the solve while reconciliation metrics — anchored on the
 * walked state — reported zero drift. See folding-strategy.ts for the
 * history; the walk was removed deliberately and durably.
 *
 * See `docs/adaptive-resolution-design.md` §5.
 */

import type {
  FoldingSolver,
  FoldingBudget,
  ChunkId,
  SummaryId,
  ProduceRequest,
} from './folding-strategy.js';
import type { SummaryEntry } from '../types/strategy.js';
import { getSummaryParentId } from '../types/strategy.js';

/**
 * Error raised when the picker has folded everything it can and the
 * resulting context still exceeds the hard token budget.
 *
 * Thrown rather than silently dropping entries. The host application decides
 * how to respond — typical responses: raise the budget, switch to a
 * larger-context model, drop the head/tail windows explicitly, or surface a
 * "context too large" error to the user.
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
    /** Which stage refused — defaults to the plan-stage wording. Emission
     *  sites pass their own so a planner/emitter drift refusal doesn't
     *  masquerade as picker exhaustion (it cost a debugging session once). */
    stage?: string;
  }) {
    super(
      `${opts.stage ?? 'Adaptive picker exhausted'} but ${opts.actual} tokens still exceed hard budget ${opts.budget}` +
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
  readonly droppedIds: readonly ChunkId[];
  readonly site: string;
  readonly diagnostics: { budget: number; totalTokens: number };

  constructor(opts: {
    droppedIds: readonly ChunkId[];
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
   * there and never folds/un-folds it. Ignored by non-kv-stable solvers.
   */
  pinLevel?: number;
  /**
   * V2 dynamic pin — this chunk may fold no deeper than this level (hard cap).
   * Set from a `ProtectedRange.maxLevel`. Honored only by the KV-stable
   * controller, throughout the solve — there is no emergency path (design
   * §13). Ignored elsewhere.
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
  /** Applied resolution per live chunk (the solver's frontier, validated). */
  finalResolutions: ReadonlyMap<ChunkId, number>;
  /** Production requests the solver emitted (summaries that don't exist yet). */
  produced: ProduceRequest[];
  /** Rendered-token estimate of the applied frontier. */
  finalTokens: number;
  /** True if the applied frontier is at or below the soft target. */
  budgetMet: boolean;
  /** Solver-owned exhaustion (see FoldingSolution.exhausted): greedy =
   *  above soft target with nothing left to fold/produce; kv-stable = even
   *  full folding exceeds the hard wall (a dead-band hold is NOT exhausted).
   *  Falls back to the greedy formula when a solver doesn't set it. */
  exhausted: boolean;
  /** Number of chunks whose resolution changed vs the carried state. */
  moves: number;
  /** Solver-frontier entries that reference no live chunk (summaries whose
   *  sources were removed by store surgery). Dropped from application;
   *  counted here for observability. */
  deadFrontierIds: number;
  /** Live chunks whose targeted level has no existing ancestor summary —
   *  a solver bug, accounted as raw and reported loudly. */
  unrealizable: number;
}

/**
 * Rendered-token accounting for a frontier — mirrors the renderer's unit
 * model: raw chunks contribute rawTokens; folded chunks contribute their
 * L_k ancestor's recall pair once per distinct ancestor; pinned chunks
 * render raw regardless of resolution.
 *
 * Returns the ids whose targeted level has NO existing ancestor (accounted
 * as raw — "the renderer will need to make the same call").
 */
export function accountFrontier(
  inputs: PickerInputs,
  frontier: ReadonlyMap<ChunkId, number>,
): { tokens: number; unrealizable: ChunkId[] } {
  const summaries = inputs.summaries;
  const recallPairTokens = inputs.recallPairTokens ?? new Map<SummaryId, number>();
  const ancestorAt = (chunk: PickerChunk, level: number): SummaryEntry | null => {
    if (level <= 0 || !chunk.l1Id) return null;
    let current: SummaryEntry | undefined = summaries.get(chunk.l1Id);
    while (current && current.level < level) {
      const parentId = getSummaryParentId(current);
      if (!parentId) return null;
      current = summaries.get(parentId);
    }
    return current && current.level === level ? current : null;
  };

  let total = inputs.headTokens + inputs.tailTokens;
  const renderedSummaries = new Set<SummaryId>();
  const unrealizable: ChunkId[] = [];
  for (const c of inputs.chunks) {
    if (inputs.headChunkIds.has(c.id) || inputs.tailChunkIds.has(c.id)) continue;
    const effective = c.pinned ? 0 : frontier.get(c.id) ?? 0;
    if (effective === 0) {
      total += c.rawTokens;
      continue;
    }
    const ancestor = ancestorAt(c, effective);
    if (!ancestor) {
      unrealizable.push(c.id);
      total += c.rawTokens;
      continue;
    }
    if (renderedSummaries.has(ancestor.id)) continue;
    renderedSummaries.add(ancestor.id);
    total += recallPairTokens.get(ancestor.id) ?? ancestor.tokens;
  }
  return { tokens: total, unrealizable };
}

export class Picker {
  constructor(private readonly solver: FoldingSolver) {}

  run(inputs: PickerInputs, budget: FoldingBudget): PickerResult {
    const solution = this.solver.solve(inputs, budget);
    const { frontier, produced } = solution;

    // Apply: the frontier is authoritative for live chunks. Entries for ids
    // with no live chunk (summaries whose sources were removed by surgery)
    // are dropped and counted — never persisted.
    const final = new Map<ChunkId, number>();
    let moves = 0;
    for (const c of inputs.chunks) {
      let lvl = frontier.get(c.id) ?? 0;
      if (!Number.isFinite(lvl) || lvl < 0) lvl = 0;
      final.set(c.id, lvl);
      if (lvl !== c.currentResolution) moves++;
    }
    const deadFrontierIds = frontier.size > final.size
      ? [...frontier.keys()].filter((id) => !final.has(id)).length
      : 0;

    // Account + validate. An unrealizable target is a solver bug: it is
    // accounted as raw (the renderer makes the same call) and reported
    // LOUDLY — the walk's silent skip is exactly what hid the 2026-07
    // plan/render divergence.
    const { tokens, unrealizable } = accountFrontier(inputs, final);
    if (unrealizable.length > 0) {
      console.error(
        `[picker-unrealizable] solver=${this.solver.name}: ${unrealizable.length} chunk(s) target ` +
          `a level whose summary does not exist (first: ${unrealizable.slice(0, 3).join(', ')}). ` +
          `Accounted as raw. This is a solver bug — the frontier must be realizable by contract.`,
      );
    }
    if (deadFrontierIds > 0) {
      console.error(
        `[picker-dead-ids] solver=${this.solver.name}: dropped ${deadFrontierIds} frontier ` +
          `entr${deadFrontierIds === 1 ? 'y' : 'ies'} referencing no live chunk (store surgery residue).`,
      );
    }

    return {
      finalResolutions: final,
      produced,
      finalTokens: tokens,
      budgetMet: tokens <= budget.targetBudget,
      exhausted: solution.exhausted ?? (produced.length === 0 && tokens > budget.targetBudget),
      moves,
      deadFrontierIds,
      unrealizable: unrealizable.length,
    };
  }
}
