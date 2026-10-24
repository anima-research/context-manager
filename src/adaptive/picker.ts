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

import type { Diagnostics } from '../diagnostics.js';
import type {
  FoldingSolver,
  FoldingBudget,
  ChunkId,
  SummaryId,
  ProduceRequest,
} from './folding-strategy.js';
import type { SummaryEntry } from '../types/strategy.js';
import { getSummaryParentId } from '../types/strategy.js';

/** Diagnostic snapshot of the selection or emission stage that refused. */
export interface OverBudgetDiagnostics {
  headTokens: number;
  tailTokens: number;
  middleTokens: number;
  /** Count for the refusing stage, in middleCountUnit; the legacy field name is retained for compatibility. */
  middleChunkCount: number;
  /** Adaptive counts one picker chunk per source message/shard; hierarchical counts selection items or raw messages, not emitted wire messages. */
  middleCountUnit?: 'picker-chunks' | 'selection-items' | 'raw-messages';
  /** Level interpreted by deepestLevelKind. */
  deepestLevel: number;
  /** Entire adaptive plan's maximum, the hierarchical representation attempted, or no plan computed yet (numeric zero is then only a legacy sentinel). Absent retains generic wording. */
  deepestLevelKind?: 'planned' | 'attempted' | 'unplanned';
  /** Deepest level in the loaded summary inventory, before pin/lock/geometry eligibility checks; 0 if empty. */
  deepestAvailableLevel?: number;
  /** Distinct loaded summaries per level, including merged children. */
  summaryCountsByLevel?: Record<number, number>;
  /** Configured total window, including the response reserve. */
  configuredBudget?: number;
  reserveForResponse?: number;
  /** Configured window minus the response reserve, before over-budget grace. */
  inputBudget?: number;
  /**
   * The pins that keep messages raw in the adaptive plan's middle, which
   * compression would otherwise fold: outside the head and recent windows.
   * `tokens` is the raw tokens they keep there together, estimated as the
   * plan prices them, and each pin gives its own; a message two pins cover
   * counts once in `tokens` and toward each pin. Set only by the refusal of a
   * plan whose middle is over the budget ("Adaptive picker exhausted but …");
   * every other refusal leaves it out, as does that one when no pin keeps
   * any.
   */
  rawPins?: { tokens: number; pins: readonly OverBudgetRawPin[] };
}

/** A pin that keeps messages raw in an over-budget refusal's middle (`OverBudgetDiagnostics.rawPins`). */
export interface OverBudgetRawPin {
  /** The pin's id, as `unpin` takes it. */
  pinId: string;
  kind: 'pin' | 'document';
  /** Its name, when it was given one. */
  name?: string;
  firstMessageId: string;
  lastMessageId: string;
  /**
   * Under adaptive resolution, how many stored messages the pin covers when
   * it covers more than its ids name: a pin on part of a message stored in
   * parts covers that message's parts, less a part locked with `lockChunk`
   * outside the span its ids name. Left out otherwise.
   */
  parts?: number;
  /** Raw tokens the pin keeps in the middle. */
  tokens: number;
}

/**
 * What clears an over-budget refusal at run time besides a larger budget,
 * which clears any of them: waiting, or a hot setting. Cold configuration,
 * such as the head window's size, isn't named, and neither is a head-window
 * reset (`resetHeadWindow`), which clears a head that's over but starts a new
 * topic, nor newer messages that would shrink a head holding images, since
 * the image strip takes the oldest images first but may not take enough.
 * The strategy that refuses sets it, since it knows which part of the
 * context is over and what can shrink that part:
 * - `'compression'`: compression work that would shrink this context is
 *   running or queued, as `tick` would take it: a compression in flight;
 *   the queued chunks, in `tick`'s order, while the speculative cap lets it
 *   take one, the cap read as it stands when the count is asked (an L1
 *   `tick` makes on the way can take the drain past the cap and queue a
 *   merge before it reaches a chunk that counts, and the merge that holds
 *   the cap may fold nothing and release it when it lands); and after
 *   them, with `hierarchical` merging on and a
 *   compression model, the queued merges, in `tick`'s order up to one a
 *   compression hold blocks, where `tick` stops. Each counts only when the
 *   compile can fold now one of the messages its summary would cover: one
 *   outside the head and recent windows that no pin keeps raw, since the
 *   compile renders the rest raw whatever summary covers them. A chunk's
 *   messages are its own, a merge's are the leaves of its sources in
 *   memory, and the work in flight's are those of the chunk or merge `tick`
 *   is working on. The work in flight counts only while no compression hold
 *   placed since reaches it, since its landing checks the hold and discards
 *   what the call returns, and, for a chunk, until its summary has landed,
 *   which can come before the call ends. When it doesn't count, the count
 *   goes on to the queue, where a merge in flight is still the head, and it
 *   goes past a queued merge that folds nothing, which `tick` runs before it
 *   takes the next once that call lands or drops it. A call that fails, is
 *   refused or is withdrawn leaves the merge at the head, so the count can
 *   name work behind it that `tick` reaches only after that. A merge counts
 *   even when `tick` will drop it as stale without a model call: a source
 *   isn't loaded or is already merged into another summary, or its sources
 *   fail the merge's topology check, in which case `tick` quarantines it.
 *   So the count can name compression for such a merge until `tick`
 *   reaches it and drops it, while a source in memory covers a message the
 *   compile can fold; one with no source in memory names nothing. A queued
 *   chunk counts when `tick` would adopt an L1 for it, stub it or compress
 *   it. One that needs a model call while the compression quarantine holds
 *   it, one `tick` defers until the host declares its tools, or one the
 *   compile can fold none of, doesn't, and the count goes on past it where
 *   `tick` does. The count reads a chunk's tool blocks
 *   as stored, where `tick` strips unpaired ones first, so it can leave out
 *   a chunk `tick` would compress, but never counts one `tick` defers. It
 *   stops at a chunk that needs a model call without a compression model,
 *   or while the quarantine can't be read, where `tick` throws and a host's
 *   tick loop ends. It stops there even where `tick` would defer that chunk
 *   for the host's tools and go on, since its stored read can't always
 *   tell, so it can leave out the work behind such a chunk, but never
 *   counts a chunk `tick` throws at. A chunk that counts is still
 *   uncompressed, holds no held message, has a message the compile can fold
 *   now, and has no message an L1 in memory already covers, since the
 *   adaptive picker already folds through that L1, unless the selector is
 *   the hierarchical one with chunk persistence on and `tick` would adopt
 *   an L1 that matches the chunk exactly, which ends the raw fallback the
 *   selector renders for an uncompressed chunk. It assumes the manager has
 *   a membrane to run compression. For the adaptive picker's refusals, its
 *   plan must also still have summaries to produce. For a hierarchical
 *   refusal in the middle, between the head and the recent window, the work
 *   must also fold a message of what refused, the middle up to and including
 *   the refused item, raw or under a summary sent there, since other work
 *   can't shrink it. Work in flight with nothing recorded beside it counts
 *   as before, since nothing says what it folds. Whether that work is
 *   enough to fit isn't checked, so a host can tell an agent that
 *   compression may make room, not that it will.
 * - `'newer-message'`: the newest message alone is over the budget, and a
 *   newer message that fits moves the window past it.
 * - `'smaller-recent-window'`: the raw recent window, which compression never
 *   touches, is what's over the budget, and the head fits beside the newest
 *   turn as the compile must keep it raw, or beside everything from a
 *   compression hold if one starts earlier. That's the newest message (for
 *   one split into shards, its newest shard, since the earlier shards can
 *   fold), unless the newest message's body holds a tool_result, on its first
 *   shard: then it's that whole body and the whole call before it, which the
 *   result must follow raw. A smaller
 *   `recentWindowTokens` (the hot `tailTokens`) moves the rest out of the raw
 *   window into the middle, which folds once its chunks have closed and
 *   compression has summarized them.
 *
 * Each list describes the refusal that was hit. Clearing it can bring the
 * next one: a smaller recent window can leave the picker waiting for
 * compression.
 */
export type OverBudgetClearedBy = 'compression' | 'newer-message' | 'smaller-recent-window';

/** The sentence naming the pins that keep raw tokens in a refusal's middle, or nothing when none do. */
function rawPinsText(raw: OverBudgetDiagnostics['rawPins']): string {
  if (!raw || raw.pins.length === 0) return '';
  const { tokens: total, pins } = raw;
  const each = pins.map((pin) => {
    const what = pin.kind === 'document' ? 'document mark' : 'pin';
    const label = pin.name !== undefined ? `"${pin.name}" (${pin.pinId})` : pin.pinId;
    const span = pin.firstMessageId === pin.lastMessageId
      ? `message ${pin.firstMessageId}` : `messages ${pin.firstMessageId} to ${pin.lastMessageId}`;
    const parts = pin.parts === undefined ? ''
      : pin.firstMessageId === pin.lastMessageId ? `, covering ${pin.parts} stored parts of its message`
        : `, covering ${pin.parts} stored messages`;
    // A lone pin's own tokens are the total, already given.
    return `${what} ${label}, ${span}${parts}${pins.length === 1 ? '' : `, ~${pin.tokens} tokens`}`;
  });
  // Several pins can cover one message, so unpinning one of them frees none
  // of it: the remedy speaks of them together, whose tokens count it once.
  // It says who can act rather than telling its reader to, since a host can
  // pass the text on to an agent that can do neither. It comes last and is
  // kept under 140 characters, so a host that quotes a long message by its
  // head and last quarter, cut at 600 characters, still quotes it whole.
  const remedy = `Whoever manages pins can unpin ${pins.length === 1 ? 'it' : 'them'}, freeing up to those tokens; ` +
    `whoever sets the hard budget can raise it if the model's window allows.`;
  return `. ${pins.length === 1 ? 'A pin keeps' : 'Pins keep'} ~${total} tokens raw in the middle: ${each.join('; ')}. ${remedy}`;
}

/**
 * Error raised when the picker has folded everything it can and the
 * resulting context still exceeds the hard token budget.
 *
 * Thrown rather than silently dropping entries. The host application decides
 * how to respond — typical responses: raise the budget, switch to a
 * larger-context model, drop the head/tail windows explicitly, or surface a
 * "context too large" error to the user.
 *
 * Cross-package behavioral surface: agent-framework gates its OverBudget
 * drain breaker on this error (AF PR #58), so it is re-exported from the
 * package root for a real `instanceof` across the boundary.
 *
 * See `docs/adaptive-resolution-design.md` §3.10.
 */
export class OverBudgetError extends Error {
  /** The hard budget the strategy was trying to fit under. */
  readonly budget: number;
  /** The token count the strategy could not reduce below `budget`. */
  readonly actual: number;
  /** Diagnostic snapshot of the picker's final state. */
  readonly diagnostics: OverBudgetDiagnostics;
  /**
   * What clears this refusal at run time besides a larger budget (see
   * {@link OverBudgetClearedBy}). Empty when nothing else is known to clear it.
   */
  readonly clearedBy: readonly OverBudgetClearedBy[];

  constructor(opts: {
    budget: number;
    actual: number;
    diagnostics: OverBudgetError['diagnostics'];
    /** What clears the refusal besides a larger budget; empty when left out. */
    clearedBy?: readonly OverBudgetClearedBy[];
    /** Which stage refused — defaults to the plan-stage wording. Emission
     *  sites pass their own so a planner/emitter drift refusal doesn't
     *  masquerade as picker exhaustion (it cost a debugging session once). */
    stage?: string;
  }) {
    const countLabels = {
      'picker-chunks': 'middle picker chunks',
      'selection-items': 'selected middle representations',
      'raw-messages': 'middle raw messages',
    };
    const countLabel = opts.diagnostics.middleCountUnit && countLabels[opts.diagnostics.middleCountUnit];
    const middleCount = countLabel
      ? `, ${countLabel}=${opts.diagnostics.middleChunkCount}`
      : ` across ${opts.diagnostics.middleChunkCount} chunks`;
    const depthLabel = opts.diagnostics.deepestLevelKind === 'planned'
      ? 'deepest planned level'
      : opts.diagnostics.deepestLevelKind === 'attempted'
        ? 'attempted representation level'
        : 'deepest fold level';
    const depth = opts.diagnostics.deepestLevelKind === 'unplanned'
      ? 'fold plan=not computed'
      : `${depthLabel}=L${opts.diagnostics.deepestLevel}`;
    super(
      `${opts.stage ?? 'Adaptive picker exhausted'} but ${opts.actual} tokens still exceed hard budget ${opts.budget}` +
        ` (head=${opts.diagnostics.headTokens}, tail=${opts.diagnostics.tailTokens},` +
        ` middle=${opts.diagnostics.middleTokens}${middleCount}, ${depth}` +
        (opts.diagnostics.deepestAvailableLevel === undefined ? '' :
          `, deepest available level=L${opts.diagnostics.deepestAvailableLevel}`) +
        (opts.diagnostics.summaryCountsByLevel === undefined ? '' :
          `, summary inventory: ${Object.entries(opts.diagnostics.summaryCountsByLevel)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([level, count]) => `L${level}=${count}`).join(' ') || 'empty'}`) +
        (opts.diagnostics.configuredBudget === undefined ? '' : `, configured=${opts.diagnostics.configuredBudget}`) +
        (opts.diagnostics.reserveForResponse === undefined ? '' : `, response reserve=${opts.diagnostics.reserveForResponse}`) +
        (opts.diagnostics.inputBudget === undefined ? '' : `, input budget=${opts.diagnostics.inputBudget}`) +
        ')' + rawPinsText(opts.diagnostics.rawPins)
    );
    // Writable per Error convention so instanceof-by-name works across
    // iframe / vm boundaries; the field stays writable on the prototype.
    this.name = 'OverBudgetError';
    this.budget = opts.budget;
    this.actual = opts.actual;
    this.diagnostics = opts.diagnostics;
    this.clearedBy = Object.freeze([...(opts.clearedBy ?? [])]);
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
  /**
   * The level this chunk starts the solve at (0 = raw). The autobiographical
   * strategy passes the level it carries in from the last committed solve, or,
   * when the summaries over it no longer reach that level, the deepest level
   * below it that they reach. The greedy solvers and kv-stable render a pinned
   * chunk raw whatever it carries (the greedy solvers seed it at 0); kv-unified
   * composes a pin with the chunk's other constraints, a lock among them.
   */
  currentResolution: number;
  lockedByAgent: boolean;
  bodyGroupId?: string;
  /**
   * A pin keeps this chunk raw: never folded. That's a classic pin, a level
   * or cap of 0, and under a folding strategy that doesn't read level
   * bounds, every pin. A chunk carries at most one of `pinned`, `pinLevel`
   * and `pinMaxLevel`, as its pins resolve (the autobiographical strategy's
   * `resolvedPinBounds`).
   */
  pinned: boolean;
  /**
   * V2 dynamic pin — fix this chunk at this fold level, above 0 (a level of 0
   * arrives as `pinned`). Set from a `ProtectedRange.level`, only under the
   * folding strategies that read it (kv-stable, kv-unified, with adaptive
   * resolution). Such a chunk is NOT `pinned` (the controller must be able to
   * move it to its level), but the controller holds it there and never
   * folds/un-folds it. Under kv-stable, a level where the chunk has no
   * summary (deeper than its summaries go, one its lineage skips, or one
   * whose own-lineage summary doesn't list it) is lowered to the next one
   * down where it has one (`SummaryTree.renderableLevel`), or to raw.
   */
  pinLevel?: number;
  /**
   * V2 dynamic pin — this chunk may fold no deeper than this level (hard cap),
   * above 0 (a cap of 0 arrives as `pinned`). Set from a
   * `ProtectedRange.maxLevel`, only under the folding strategies that read it
   * (kv-stable, kv-unified, with adaptive resolution), and only when no
   * `level` applies.
   * The KV-stable controller honors it throughout the solve — there is no
   * emergency path (design §13).
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
  /** Applied resolution per live chunk (the solver's frontier, validated).
   *  Built on first read; `levelAt` answers without it. */
  readonly finalResolutions: ReadonlyMap<ChunkId, number>;
  /** Applied resolution of the chunk with this sequence and id: by position
   *  when the solver supplied levels by sequence, else from its frontier. */
  levelAt(sequence: number, id: ChunkId): number;
  /** The solver's levels by sequence, when it supplied them (see
   *  FoldingSolution.levelsBySequence). */
  levelsBySequence?: ArrayLike<number>;
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
  /** Number of chunks whose resolution changed from the `currentResolution`
   *  they started at. */
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
  frontier: ReadonlyMap<ChunkId, number> | ((chunk: PickerChunk) => number),
): { tokens: number; unrealizable: ChunkId[] } {
  const levelOf = typeof frontier === 'function' ? frontier : (c: PickerChunk) => frontier.get(c.id) ?? 0;
  const summaries = inputs.summaries;
  const recallPairTokens = inputs.recallPairTokens ?? new Map<SummaryId, number>();
  // The walk from an L1 to its ancestor at a level is the same for every
  // chunk under that L1; answer it once per (L1, level).
  const ancestors = new Map<SummaryId, (SummaryEntry | null | undefined)[]>();
  const ancestorAt = (chunk: PickerChunk, level: number): SummaryEntry | null => {
    if (level <= 0 || !chunk.l1Id) return null;
    let known = ancestors.get(chunk.l1Id);
    if (known === undefined) ancestors.set(chunk.l1Id, known = []);
    const cached = known[level];
    if (cached !== undefined) return cached;
    let current: SummaryEntry | undefined = summaries.get(chunk.l1Id);
    while (current && current.level < level) {
      const parentId = getSummaryParentId(current);
      if (!parentId) { current = undefined; break; }
      current = summaries.get(parentId);
    }
    return known[level] = current && current.level === level ? current : null;
  };

  let total = inputs.headTokens + inputs.tailTokens;
  const renderedSummaries = new Set<SummaryId>();
  const unrealizable: ChunkId[] = [];
  for (const c of inputs.chunks) {
    if (inputs.headChunkIds.has(c.id) || inputs.tailChunkIds.has(c.id)) continue;
    const effective = c.pinned ? 0 : levelOf(c);
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
  constructor(
    private readonly solver: FoldingSolver,
    /** Where its lines go: a strategy's diagnostics, which name its namespace (#239). */
    private readonly log: Diagnostics = console,
  ) {}

  /** Name of the solver this picker runs — surfaced so every compile can be
   *  attributed to the policy that actually planned it (solver observability:
   *  a config clobber that silently downgrades kv-stable → flat-profile is
   *  invisible without this). */
  get solverName(): string {
    return this.solver.name;
  }

  run(inputs: PickerInputs, budget: FoldingBudget): PickerResult {
    const solution = this.solver.solve(inputs, budget);
    const { produced } = solution;
    const bySequence = solution.levelsBySequence;

    // Apply: the frontier is authoritative for live chunks. Entries for ids
    // with no live chunk (summaries whose sources were removed by surgery)
    // are dropped and counted — never persisted. With levels by sequence
    // the solver's leaves are exactly the live chunks, so nothing is dead
    // and the frontier map is never materialized unless a caller reads it.
    const clamp = (lvl: number): number => (!Number.isFinite(lvl) || lvl < 0 ? 0 : lvl);
    const levelAt = (sequence: number, id: ChunkId): number =>
      clamp(bySequence && sequence >= 0 && sequence < bySequence.length
        ? bySequence[sequence]
        : solution.frontier.get(id) ?? 0);
    const levelOf = (c: PickerChunk): number => levelAt(c.sequence, c.id);
    let moves = 0;
    for (const c of inputs.chunks) if (levelOf(c) !== c.currentResolution) moves++;
    let final: Map<ChunkId, number> | null = null;
    const finalResolutions = (): Map<ChunkId, number> => {
      if (!final) {
        final = new Map();
        for (const c of inputs.chunks) final.set(c.id, levelOf(c));
      }
      return final;
    };
    const deadFrontierIds = !bySequence && solution.frontier.size > inputs.chunks.length
      ? [...solution.frontier.keys()].filter((id) => !finalResolutions().has(id)).length
      : 0;

    // Account + validate. An unrealizable target is a solver bug: it is
    // accounted as raw (the renderer makes the same call) and reported
    // LOUDLY — the walk's silent skip is exactly what hid the 2026-07
    // plan/render divergence.
    const { tokens, unrealizable } = accountFrontier(inputs, levelOf);
    if (unrealizable.length > 0) {
      this.log.error(
        `[picker-unrealizable] solver=${this.solver.name}: ${unrealizable.length} chunk(s) target ` +
          `a level whose summary does not exist (first: ${unrealizable.slice(0, 3).join(', ')}). ` +
          `Accounted as raw. This is a solver bug — the frontier must be realizable by contract.`,
      );
    }
    if (deadFrontierIds > 0) {
      this.log.error(
        `[picker-dead-ids] solver=${this.solver.name}: dropped ${deadFrontierIds} frontier ` +
          `entr${deadFrontierIds === 1 ? 'y' : 'ies'} referencing no live chunk (store surgery residue).`,
      );
    }

    return {
      get finalResolutions() { return finalResolutions(); },
      levelAt,
      levelsBySequence: bySequence,
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
