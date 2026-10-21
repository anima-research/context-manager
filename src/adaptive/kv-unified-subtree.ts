import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import { tailUnits } from './render-offsets.js';
import {
  CanonicalSummaryForest,
  SparseLabelCeilingError,
  type CanonicalLeaf,
  type CanonicalSummary,
  type MinimumTokenResult,
} from './kv-unified.js';
import { TerminalPolicyEvaluator, presentedLeavesByIndex, type FrontierTraceSource } from './kv-unified-terminal.js';
import { scoreBoundedCandidates } from './kv-unified-selective.js';
import {
  ExactKvUnifiedPolicySolver,
  bandedAge,
  continuityLeafBase,
  fidelityLeafBase,
  frontierSignature,
  normalizePolicy,
  withBestScoreUnder,
  type KvUnifiedWelfarePolicy,
  type PresentedLeaf,
} from './kv-unified-policy.js';
import type { ApproximationEnvelope, ParetoPolicySolveResult, ParetoSolveOptions } from './kv-unified-pareto.js';

/**
 * Subtree-memoized select/expand engine.
 *
 * The DAG engines walk the ownership forest root by root and, inside each
 * summary, select or expand with the whole label set of the prefix in hand.
 * Every objective the walk accumulates is additive over leaves (tokens,
 * extension, fidelity, continuity), and the provider-cache state only
 * follows the carried layout, so what a summary subtree contributes to a
 * label whose cache prefix has already broken does not depend on the
 * prefix: it is a set of deltas, pruned on the same grid, that the prefix
 * labels are combined with. This engine computes that delta set once per
 * summary object and keeps it (`memo`, keyed by the summary object every
 * derived forest shares) while nothing it was computed from has changed:
 * the leaves under it (their weights, constraints, zone and receipt
 * entries, hashed per solve) and the solve's policy, grid and wall. A
 * compile then re-solves only the subtrees an append, a band crossing, a
 * new summary or a move touched, and combines the rest.
 *
 * At most one label enters a subtree with its cache prefix intact (the one
 * that followed the receipt), and its alternatives inside the subtree are
 * the intact path's deviations composed with the children's broken-entry
 * sets. On a chronological forest its deltas are memoized too, keyed by the
 * receipt units over the span. On a forest with gap-bearing ownership or
 * internal protected holes the intact label is walked directly, with the
 * DAG engines' buffered emissions and hole restrictions, and the broken
 * sets it composes with are the memoized ones.
 *
 * The result is the same kind of bucketed approximation as the DAG engines
 * (the same representatives per cell, the same envelope accounting); the
 * cells are placed from each subtree's own origin instead of the prefix's,
 * so the retained candidates can differ within the reported error bound.
 * With no grid the composition is exact Pareto algebra and matches the
 * object engine's nondominated terminal set.
 */

interface CacheState {
  readonly intact: boolean;
  readonly matchedUnits: number;
  readonly cachedTokens: number;
  readonly cachedUnits: number;
}

interface PendingEmission {
  readonly kind: 'raw' | 'recall';
  readonly key: string;
  readonly tokens: number;
  readonly sequence: number;
}

type TraceNode =
  | { readonly parent: TraceNode | null; readonly ids: readonly ChunkId[]; readonly level: number }
  | { readonly parent: TraceNode | null; readonly delta: TraceNode | null };

interface Label {
  readonly tokens: number;
  readonly extension: number;
  readonly continuity: number;
  readonly fidelity: number;
  readonly cache: CacheState;
  /** Cache-relevant units waiting for a chronologically earlier ownership
   * branch; non-empty only for an intact label on a buffered forest. */
  readonly pending: readonly PendingEmission[];
  readonly trace: TraceNode | null;
  readonly approximation: ApproximationEnvelope;
}

/** What a subtree adds to a label that enters it. `marker` is the last
 * provider marker the subtree's units reached while the prefix was intact
 * (absolute offsets, as the receipt records them); `units` the receipt units
 * it matched. Both are meaningful only for an intact entry. */
interface Delta {
  readonly tokens: number;
  readonly extension: number;
  readonly continuity: number;
  readonly fidelity: number;
  readonly exitIntact: boolean;
  readonly units: number;
  readonly marker: { readonly cachedTokens: number; readonly cachedUnits: number } | null;
  readonly trace: TraceNode | null;
  readonly approximation: ApproximationEnvelope;
}

/** The propagation counters a delta set's computation moved. They are
 * charged again whenever the set is reused, so a solve reports the counts
 * of the same solve done cold, whatever the memo held. */
interface Work {
  readonly states: number;
  readonly created: number;
  readonly expanded: number;
  readonly dominated: number;
  readonly maximum: number;
}

interface MemoEntry {
  /** The summary object the entry was last validated against; a different
   * object with the same structure rebinds the entry (a full forest build
   * makes new objects for unchanged summaries). */
  summary: CanonicalSummary;
  /** The subtree's structure, two independent lanes: this summary's own
   * and every descendant's. A rebind also compares the summary's own
   * level, recall cost and child count exactly. */
  readonly structureA: number;
  readonly structureB: number;
  readonly solveKey: string;
  readonly hashA: number;
  readonly hashB: number;
  broken: readonly Delta[] | null;
  brokenWork: Work | null;
  intactWork: Work | null;
  /** Deltas for an intact entry at receipt unit `units`, over the receipt's
   * units covering this span (`slice`). */
  intact: { readonly units: number; readonly slice: string; readonly deltas: readonly Delta[] } | null;
  /** The solve that computed each set (a token, so an entry keeps no
   * solver alive): a set read by another solve is a reuse across compiles,
   * which is what the stats report. Within one solve a parent's two entry
   * modes read the same child set. */
  brokenBy: object | null;
  intactBy: object | null;
}

/** Delta sets per summary id, kept in a solve's reuse holder across
 * compiles (`KvUnifiedReuse.subtree`). An entry is read through the summary
 * object it was validated against; summary objects are shared by every
 * forest derived from one build (the live forest and the what-if forests
 * alike), and a summary whose leaves or children changed is a new object,
 * which the entry's structure signature then tells from a rebuilt one. */
export type SubtreeMemo = Map<string, MemoEntry>;

/** Memo for solves without a reuse holder: per summary object, for the
 * forest's lifetime. */
const unheld = new WeakMap<CanonicalSummary, MemoEntry>();

/** KVU_SUBTREE_DIAG only: the previous solve's per-leaf arrays. */
let previousSolveArrays: {
  n: number; fidelityBase: Float64Array; continuityBase: Float64Array;
  previousLevel: Int32Array; previousMatches: Uint8Array; external: Uint8Array;
} | null = null;

export interface SubtreeSolveStats {
  /** Delta sets this solve computed. */
  readonly summariesSolved: number;
  /** Delta sets this solve read that an earlier solve computed. */
  readonly summariesReused: number;
  /** The most labels held at once while composing a step, before a prune:
   * at most the ceiling plus one label's expansion. */
  readonly peakTemporaryLabels: number;
  /** True when the subtree engine exceeded the label ceiling and the solve
   * ran again on the packed DAG engine (see kv-unified-pareto.ts). */
  readonly ceilingFallback?: boolean;
}

const ZERO_APPROXIMATION: ApproximationEnvelope = Object.freeze({ token: 0, continuity: 0, fidelity: 0, cache: 0 });
const BROKEN: CacheState = Object.freeze({ intact: false, matchedUnits: 0, cachedTokens: 0, cachedUnits: 0 });
const NO_PENDING: readonly PendingEmission[] = Object.freeze([]);

export class SubtreeMemoSolver {
  private readonly leaves: readonly CanonicalLeaf[];
  private readonly leafIds: readonly ChunkId[];
  private readonly policy: KvUnifiedWelfarePolicy;
  private readonly fidelityBase: Float64Array;
  private readonly continuityBase: Float64Array;
  private readonly previousLevel: Int32Array;
  /** Whether the leaf's representation at `previousLevel` is the receipt's. */
  private readonly previousMatches: Uint8Array;
  private readonly external: Uint8Array;
  private readonly hashA: Uint32Array;
  private readonly hashB: Uint32Array;
  private readonly cacheRelevant: boolean;
  /** Gap-bearing ownership or internal protected holes: intact labels
   * buffer their emissions until the chronological walk passes them, and
   * the intact entry of a subtree is walked, not memoized. */
  private readonly buffered: boolean;
  private readonly markers: ReadonlyMap<number, number>;
  private readonly units: readonly { kind: string; key: string }[];
  /** First sequence of each receipt unit, and how many leading units resolve
   * in this forest; an intact prefix can only reach a span whose preceding
   * units all resolve. */
  private readonly unitFirstSequence: Float64Array;
  private readonly resolvableUnits: number;
  private readonly tBucket: number;
  private readonly kBucket: number;
  private readonly fBucket: number;
  private readonly ceiling: number;
  private readonly solveKey: string;
  private readonly tail: readonly { kind: 'raw' | 'tail'; key: string; tokens: number; extension: boolean; sequence: number }[];
  /** Leaf positions [from, to) per summary object; leaves are contiguous
   * in a chronological forest, and the object is shared across derives. */
  private readonly spans = new WeakMap<CanonicalSummary, [number, number]>();
  private readonly memo: SubtreeMemo | null;
  private readonly started = performance.now();
  private states = 0;
  private created = 1;
  private expanded = 0;
  private dominated = 0;
  private maximum = 1;
  private summariesSolved = 0;
  private summariesReused = 0;
  /** Identifies this solve in the memo entries it computes. */
  private readonly token = {};
  /** The largest label set since the delta computation in progress began. */
  private peak = 0;
  /** Subtree structures for this forest, computed once per summary. */
  private readonly structures = new Map<CanonicalSummary, readonly [number, number]>();
  /** KVU_SUBTREE_DIAG=1: per-level counts of sets computed, their labels,
   * compositions and time, printed at the end of the solve. */
  private readonly diag = typeof process !== 'undefined' && !!process.env?.KVU_SUBTREE_DIAG
    ? new Map<number, { solved: number; reused: number; labels: number; pairs: number; ms: number }>() : null;
  private diagPairs = 0;
  lastStats: SubtreeSolveStats = { summariesSolved: 0, summariesReused: 0, peakTemporaryLabels: 0 };
  /** The most labels held at once while composing, before a prune. */
  private temporaries = 0;

  /** The counters as they stand, for a solve that ended early. */
  get stats(): SubtreeSolveStats {
    return { summariesSolved: this.summariesSolved, summariesReused: this.summariesReused, peakTemporaryLabels: this.temporaries };
  }

  /** Drop the memo entries of summaries no longer in the forest (store
   * surgery, a rebuild that replaced them); otherwise their delta arrays
   * stay until the holder is reset. Run at the end of every solve, and by
   * the Pareto solver when this engine gives up on the ceiling. */
  dropDeparted(): void {
    if (this.memo) for (const id of this.memo.keys()) if (!this.forest.summary(id)) this.memo.delete(id);
  }

  constructor(
    private readonly inputs: PickerInputs,
    private readonly forest: CanonicalSummaryForest,
    private readonly options: ParetoSolveOptions,
    buffered: boolean,
    private readonly approximationBound: (error: ApproximationEnvelope) => number,
    private readonly knownFeasibility: Extract<MinimumTokenResult, { feasible: true }>,
  ) {
    this.policy = normalizePolicy(options.policy);
    this.leaves = forest.orderedLeaves();
    this.leafIds = this.leaves.map((leaf) => leaf.id);
    const chunks = new Map(inputs.chunks.map((chunk) => [chunk.id, chunk]));
    const newest = inputs.chunks.reduce((value, chunk) => Math.max(value, chunk.sequence), 0);
    const n = this.leaves.length;
    this.fidelityBase = new Float64Array(n);
    this.continuityBase = new Float64Array(n);
    this.previousLevel = new Int32Array(n).fill(-1);
    this.previousMatches = new Uint8Array(n);
    this.external = new Uint8Array(n);
    this.hashA = new Uint32Array(n + 1);
    this.hashB = new Uint32Array(n + 1);
    const presentation = options.presentation;
    const previous = presentation
      ? presentedLeavesByIndex(presentation.leaves, forest, options) as readonly (PresentedLeaf | undefined)[]
      : null;
    const currentSeq = presentation?.currentSeq ?? 0;
    let age = 0;
    const view = new DataView(new ArrayBuffer(8));
    const bits = (value: number): [number, number] => {
      view.setFloat64(0, value);
      return [view.getUint32(0), view.getUint32(4)];
    };
    for (let i = n - 1; i >= 0; i--) {
      const leaf = this.leaves[i];
      const midpoint = age + leaf.rawTokens / 2;
      age += leaf.rawTokens;
      const chunk = chunks.get(leaf.id)!;
      this.fidelityBase[i] = fidelityLeafBase(chunk, newest, this.policy);
      const entry = previous?.[i];
      if (entry) {
        this.continuityBase[i] = continuityLeafBase(chunk, entry, currentSeq, midpoint, this.policy);
        this.previousLevel[i] = entry.level;
        const at = leaf.availableLevels.indexOf(entry.level);
        this.previousMatches[i] = at >= 0 && leaf.repHashes[at] === entry.repHash ? 1 : 0;
      }
      this.external[i] = leaf.externallyAccounted ? 1 : 0;
    }
    // Two lanes of a position-mixed hash over everything a subtree's deltas
    // read from a leaf; a span's hash is the xor of its leaves', read in
    // O(1) from the prefix arrays. Identical values at different positions
    // mix differently, so a change never cancels against another.
    for (let i = 0; i < n; i++) {
      const leaf = this.leaves[i];
      const [f0, f1] = bits(this.fidelityBase[i]);
      const [c0, c1] = bits(this.continuityBase[i]);
      const [r0, r1] = bits(leaf.rawTokens);
      // The allowed levels as a list hash, not a bit mask: a mask holds 31
      // levels and the forest accepts any.
      let allowed = leaf.allowedLevels.length;
      for (const level of leaf.allowedLevels) allowed = mix(allowed, level + 1);
      let a = mix(f0 ^ Math.imul(i + 1, 0x9e3779b1), f1 ^ r0);
      a = mix(a, c0 ^ Math.imul(this.previousLevel[i] + 2, 0x85ebca6b));
      a = mix(a, c1 ^ allowed ^ (this.previousMatches[i] << 1 | this.external[i]));
      let b = mix(c1 ^ Math.imul(i + 1, 0xc2b2ae35), f0 ^ r1);
      b = mix(b, f1 ^ Math.imul(allowed, 0x27d4eb2f) ^ (this.previousLevel[i] + 2));
      b = mix(b, c0 ^ (this.previousMatches[i] << 1 | this.external[i]) ^ leaf.availableLevels.length);
      this.hashA[i + 1] = this.hashA[i] ^ a;
      this.hashB[i + 1] = this.hashB[i] ^ b;
    }
    if (this.diag && process.env.KVU_SUBTREE_DIAG_LEAF) {
      for (const i of process.env.KVU_SUBTREE_DIAG_LEAF.split(',').map(Number)) {
        const leaf = this.leaves[i]; const entry = previous?.[i];
        let midpoint = 0; for (let j = n - 1; j > i; j--) midpoint += this.leaves[j].rawTokens; midpoint += leaf.rawTokens / 2;
        console.error(`[kvu-subtree] leaf ${i} ${leaf.id} raw=${leaf.rawTokens} fid=${this.fidelityBase[i]} cont=${this.continuityBase[i]} prev=${entry ? `${entry.level}/${entry.lastChangedSeq}` : '-'} currentSeq=${currentSeq} midpoint=${midpoint.toFixed(0)} banded=${bandedAge(midpoint, this.policy.ageBandSteps).toFixed(0)}`);
      }
    }
    if (this.diag && previousSolveArrays) {
      const o = previousSolveArrays;
      const m = Math.min(o.n, n);
      let f = 0, c = 0, pl = 0, pm = 0, ex = 0;
      for (let i = 0; i < m; i++) {
        if (o.fidelityBase[i] !== this.fidelityBase[i]) f++;
        if (o.continuityBase[i] !== this.continuityBase[i]) c++;
        if (o.previousLevel[i] !== this.previousLevel[i]) pl++;
        if (o.previousMatches[i] !== this.previousMatches[i]) pm++;
        if (o.external[i] !== this.external[i]) ex++;
      }
      console.error(`[kvu-subtree] leaf changes vs previous solve (n=${n}): fidelityBase=${f} continuityBase=${c} previousLevel=${pl} previousMatches=${pm} external=${ex}`);
    }
    if (this.diag) previousSolveArrays = {
      n, fidelityBase: this.fidelityBase, continuityBase: this.continuityBase,
      previousLevel: this.previousLevel, previousMatches: this.previousMatches, external: this.external,
    };
    this.cacheRelevant = options.cache !== undefined && options.currentImmutablePrefixHash !== undefined &&
      options.cache.immutablePrefixHash === options.currentImmutablePrefixHash;
    this.buffered = buffered;
    this.memo = options.reuse ? (options.reuse.subtree ??= new Map()) : null;
    this.markers = new Map((options.cache?.markers ?? []).map((marker) => [marker.unitIndex, marker.offset]));
    this.units = this.cacheRelevant ? options.cache!.layout.units : [];
    this.unitFirstSequence = new Float64Array(this.units.length);
    let resolvable = this.units.length;
    for (let k = 0; k < this.units.length; k++) {
      const unit = this.units[k];
      let first: number | undefined;
      if (unit.kind === 'head') first = Number.NEGATIVE_INFINITY;
      else if (unit.kind === 'tail') first = Number.POSITIVE_INFINITY;
      else if (unit.kind === 'raw') first = forest.leaf(unit.key)?.sequence;
      else first = forest.summary(unit.key)?.firstSequence;
      if (first === undefined) { resolvable = Math.min(resolvable, k); first = Number.POSITIVE_INFINITY; }
      this.unitFirstSequence[k] = first;
    }
    this.resolvableUnits = resolvable;
    this.tBucket = Math.max(0, Math.floor(options.tokenBucketSize ?? 0));
    this.kBucket = Math.max(0, options.continuityBucketSize ?? 0);
    this.fBucket = Math.max(0, options.fidelityBucketSize ?? 0);
    this.ceiling = options.labelCeiling ?? 1_000_000;
    this.tail = tailUnits(inputs).map((unit) => ({
      kind: unit.kind, key: unit.key, tokens: unit.tokens,
      extension: unit.kind === 'raw' && presentation !== undefined && !presentation.leaves.has(unit.key),
      sequence: unit.kind === 'raw' ? forest.leaf(unit.key)?.sequence ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY,
    }));
    const p = this.policy;
    this.solveKey = [
      p.alpha, p.cacheReadPrice, p.cacheWritePrice, p.continuityRecencyHalfLifeTokens, p.continuityRecencyFloor,
      p.continuityStableHalfLife, p.continuityStableFloor, p.ageBandSteps,
      this.tBucket, this.kBucket, this.fBucket, options.maxTokens, this.cacheRelevant ? 1 : 0,
      // Whether a presentation exists decides what new material is, even
      // for a subtree none of whose leaves it covers.
      options.presentation ? 1 : 0,
    ].join(':');
  }

  solve(): ParetoPolicySolveResult {
    const options = this.options;
    const forest = this.forest;
    let labels: Label[] = [{
      tokens: 0, extension: 0, continuity: 0, fidelity: 0,
      cache: this.cacheRelevant ? { intact: true, matchedUnits: 0, cachedTokens: 0, cachedUnits: 0 } : BROKEN,
      pending: NO_PENDING, trace: null, approximation: ZERO_APPROXIMATION,
    }];
    const externalIds = this.leaves.filter((leaf) => leaf.externallyAccounted).map((leaf) => leaf.id);
    if (externalIds.length > 0) labels = [{ ...labels[0], trace: { parent: null, ids: externalIds, level: 0 } }];
    if (this.inputs.headTokens > 0) labels = [this.emit(labels[0], 'head', 'head', this.inputs.headTokens, false)];

    const roots = forest.roots;
    for (let r = 0; r < roots.length;) {
      const root = roots[r];
      if (this.buffered && this.cacheRelevant) labels = labels.map((label) => this.flush(label, root.firstSequence));
      if (root.kind === 'summary') {
        labels = this.combine(labels, forest.summary(root.id)!, undefined, roots[r + 1]?.firstSequence ?? Number.POSITIVE_INFINITY);
        r++;
        continue;
      }
      // Consecutive ownerless roots are one raw run for a broken label (it
      // adds their tokens once, and the grid is applied once after the run,
      // as inside a summary); an intact label still emits them one by one
      // in sequence, flushing before each, as the DAG engines do per root.
      const run: number[] = [];
      while (r < roots.length && roots[r].kind === 'leaf') {
        const leaf = forest.leaf(roots[r].id)!;
        if (!leaf.externallyAccounted) run.push(leaf.index);
        r++;
      }
      if (run.length > 0) labels = this.prune(labels.map((label) => this.rawRun(label, run, true)), options.maxTokens);
    }
    options.onProgress?.({ phase: 'propagated', elapsedMs: performance.now() - this.started, states: this.states, labels: labels.length });

    const evaluator = new TerminalPolicyEvaluator(this.inputs, forest, options);
    const terminal: { trace: FrontierTraceSource; tokens: number }[] = [];
    for (const label of labels) {
      const finished = this.emitTail(label);
      if (finished.tokens <= options.maxTokens) terminal.push({ trace: traceSource(finished.trace), tokens: finished.tokens });
    }
    const feasibility = this.knownFeasibility;
    const roundoff = 32 * Number.EPSILON * this.leaves.length * Math.max(1, options.maxTokens);
    if (!terminal.some((candidate) => {
      if (Math.abs(candidate.tokens - feasibility.floorTokens) > roundoff) return false;
      return sameFrontier(evaluator.candidate(candidate.trace, candidate.tokens).frontier, feasibility.frontier);
    })) {
      const byLevel = new Map<number, ChunkId[]>();
      for (const [id, level] of feasibility.frontier) {
        const ids = byLevel.get(level);
        if (ids) ids.push(id); else byLevel.set(level, [id]);
      }
      let trace: TraceNode | null = null;
      for (const [level, ids] of byLevel) trace = { parent: trace, ids, level };
      terminal.push({ trace: traceSource(trace), tokens: feasibility.floorTokens });
    }
    options.onProgress?.({ phase: 'evaluated', elapsedMs: performance.now() - this.started, states: this.states, labels: terminal.length });
    const stats = { statesVisited: this.states, candidatesGenerated: this.created, maxCandidatesAtState: this.maximum, terminalCandidates: terminal.length };
    // Selective terminal evaluation as the packed engine does it: exact
    // bounds decide the winner and the floors, and the rest is refined lazily.
    const full = options.terminalEvaluation === 'full';
    const scored = full
      ? new ExactKvUnifiedPolicySolver(this.inputs, forest).scorePreparedCandidates(
          terminal.map((candidate) => evaluator.candidate(candidate.trace, candidate.tokens)), options, stats, this.cacheRelevant)
      : scoreBoundedCandidates(
          terminal.map((candidate) => evaluator.estimate(candidate.trace, candidate.tokens)), options, stats, this.cacheRelevant, evaluator.orderedLeafIds);
    this.lastStats = this.stats;
    this.dropDeparted();
    if (this.diag) {
      const rows = [...this.diag].sort((a, b) => a[0] - b[0]).map(([level, d]) =>
        `L${level}: solved=${d.solved} reused=${d.reused} labels=${d.labels} pairs=${d.pairs} ms=${d.ms.toFixed(0)}`);
      console.error(`[kvu-subtree] roots=${forest.roots.length} final=${labels.length} total=${(performance.now() - this.started).toFixed(0)}ms\n  ${rows.join('\n  ')}`);
    }
    if (!scored.feasible) return scored;
    options.onProgress?.({ phase: 'scored', elapsedMs: performance.now() - this.started, states: this.states, labels: terminal.length });
    const approximation = { token: 0, continuity: 0, fidelity: 0, cache: 0 };
    for (const label of labels) {
      approximation.token = Math.max(approximation.token, label.approximation.token);
      approximation.continuity = Math.max(approximation.continuity, label.approximation.continuity);
      approximation.fidelity = Math.max(approximation.fidelity, label.approximation.fidelity);
      approximation.cache = Math.max(approximation.cache, label.approximation.cache);
    }
    const out: Extract<ParetoPolicySolveResult, { feasible: true }> = {
      feasible: true, selected: scored.selected, cacheFloor: scored.cacheFloor,
      continuityFloor: scored.continuityFloor, cacheRelevant: scored.cacheRelevant,
      enumeration: scored.enumeration,
      get candidates() { return scored.candidates; },
      propagation: {
        storageMode: 'objects',
        terminalEvaluationMode: full ? 'full' : 'selective',
        labelsCreated: this.created,
        labelsExpanded: this.expanded,
        labelsDominated: this.dominated,
        states: this.states,
        maxLabelsPerState: this.maximum,
        terminalLabels: terminal.length,
        tokenBucketSize: this.tBucket,
        continuityBucketSize: this.kBucket,
        fidelityBucketSize: this.fBucket,
        approximationBounded: true,
        approximationScoreErrorBound: this.approximationBound(approximation),
        approximationTokenErrorBound: approximation.token,
        approximationContinuityErrorBound: approximation.continuity,
        approximationFidelityErrorBound: approximation.fidelity,
        approximationCacheErrorBound: approximation.cache,
      },
    };
    return scored.bestScoreUnder ? withBestScoreUnder(out, scored.bestScoreUnder, scored.bestUnder) : out;
  }

  // ---- composition ----

  /** Every incoming label taken through `summary`, pruned. A broken label
   * without a hole restriction composes with the memoized broken-entry
   * deltas; an intact label composes with the memoized intact-entry deltas
   * on a chronological forest and is walked directly on a buffered one, as
   * is any label under a restriction. */
  private combine(incoming: readonly Label[], summary: CanonicalSummary, active: ReadonlySet<number> | undefined, flushLimit: number): Label[] {
    this.expanded += incoming.length;
    let out: Label[] = [];
    let broken: readonly Delta[] | null = null;
    for (const label of incoming) {
      if (active) {
        for (const next of this.processSummary(label, summary, active, flushLimit)) out.push(next);
      } else if (label.cache.intact) {
        if (this.buffered) for (const next of this.processSummary(label, summary, undefined, flushLimit)) out.push(next);
        else for (const delta of this.deltasIntact(summary, label.cache.matchedUnits)) out.push(compose(label, delta));
      } else {
        broken ??= this.deltasBroken(summary);
        for (const delta of broken) out.push(compose(label, delta));
      }
      // The product of the incoming labels and the deltas is pruned as it
      // grows, not once at the end: two sets of ten thousand would otherwise
      // be a hundred million labels in memory before the ceiling was asked.
      // Pruning a part and going on gives the same set (a dominated label
      // stays dominated; a covered one stays covered by its representative),
      // and holds the temporaries to the ceiling plus one label's expansion.
      if (out.length > this.ceiling) {
        if (this.diag) this.diagPairs += out.length;
        this.temporaries = Math.max(this.temporaries, out.length);
        out = this.prune(out, this.options.maxTokens);
      }
    }
    if (this.diag) this.diagPairs += out.length;
    this.temporaries = Math.max(this.temporaries, out.length);
    return this.prune(out, this.options.maxTokens);
  }

  private span(summary: CanonicalSummary): [number, number] {
    let span = this.spans.get(summary);
    if (!span) {
      const indices = this.forest.leafIndicesOf(summary);
      let first = indices[0], last = indices[0];
      for (let k = 1; k < indices.length; k++) {
        if (indices[k] < first) first = indices[k];
        if (indices[k] > last) last = indices[k];
      }
      span = [first, last + 1];
      this.spans.set(summary, span);
    }
    return span;
  }

  private entry(summary: CanonicalSummary): MemoEntry {
    const [from, to] = this.span(summary);
    const hashA = this.hashA[to] ^ this.hashA[from];
    const hashB = this.hashB[to] ^ this.hashB[from];
    let entry = this.memo ? this.memo.get(summary.id) : unheld.get(summary);
    // The structure covers the descendants too: a child whose recall cost
    // changed is a new object under a parent that may not be, and the
    // parent's sets were composed from the child's old ones.
    const [structureA, structureB] = this.structure(summary);
    if (entry && entry.summary !== summary) {
      // A new object for this id: the same summary after a full build, or a
      // changed one. Its own level, recall cost and child count are compared
      // exactly; the two hash lanes cover the rest and the descendants.
      const previous = entry.summary;
      if (entry.structureA === structureA && entry.structureB === structureB &&
          previous.level === summary.level && previous.recallTokens === summary.recallTokens &&
          previous.childSummaryIds.length === summary.childSummaryIds.length) entry.summary = summary;
      else entry = undefined;
    }
    if (!entry || entry.structureA !== structureA || entry.structureB !== structureB ||
        entry.solveKey !== this.solveKey || entry.hashA !== hashA || entry.hashB !== hashB) {
      entry = {
        summary, structureA, structureB, solveKey: this.solveKey, hashA, hashB,
        broken: null, intact: null, brokenBy: null, intactBy: null, brokenWork: null, intactWork: null,
      };
      if (this.memo) this.memo.set(summary.id, entry); else unheld.set(summary, entry);
    }
    return entry;
  }

  private structure(summary: CanonicalSummary): readonly [number, number] {
    let value = this.structures.get(summary);
    if (value === undefined) {
      let [a, b] = ownStructure(summary);
      for (const id of summary.childSummaryIds) {
        const child = this.forest.summary(id);
        if (!child) continue;
        const [childA, childB] = this.structure(child);
        a = mix(a, childA);
        b = mixB(b, childB);
      }
      value = [a, b];
      this.structures.set(summary, value);
    }
    return value;
  }

  private deltasBroken(summary: CanonicalSummary): readonly Delta[] {
    const entry = this.entry(summary);
    if (entry.broken) {
      if (this.diag) this.note(summary.level, 0, 1, 0, 0, 0);
      if (entry.brokenBy !== this.token) { this.summariesReused++; entry.brokenBy = this.token; }
      this.charge(entry.brokenWork!);
      return entry.broken;
    }
    this.summariesSolved++;
    const zero: Label = { tokens: 0, extension: 0, continuity: 0, fidelity: 0, cache: BROKEN, pending: NO_PENDING, trace: null, approximation: ZERO_APPROXIMATION };
    const before = this.work();
    const t0 = this.diag ? performance.now() : 0, p0 = this.diagPairs;
    // A broken label's walk never flushes, so the limit is immaterial.
    entry.broken = this.processSummary(zero, summary, undefined, Number.POSITIVE_INFINITY).map((label) => toDelta(label, false));
    if (this.diag) this.note(summary.level, 1, 0, entry.broken.length, this.diagPairs - p0, performance.now() - t0);
    entry.brokenWork = this.workSince(before);
    entry.brokenBy = this.token;
    return entry.broken;
  }

  /** Deltas for a label that enters `summary` with the provider prefix
   * intact at receipt unit `units`, on a chronological forest. The
   * receipt's units over this span are what the subtree's emissions are
   * matched against, so they key the set with the entry unit. */
  private deltasIntact(summary: CanonicalSummary, units: number): readonly Delta[] {
    const entry = this.entry(summary);
    const [, to] = this.span(summary);
    // The span's receipt units: from the entry unit up to the first unit
    // whose first leaf lies past the span (tail units count as past it).
    const lastSequence = this.leaves[to - 1].sequence;
    let end = units;
    while (end < this.units.length && this.unitFirstSequence[end] <= lastSequence) end++;
    const resolvable = Math.min(end, this.resolvableUnits);
    let slice = '';
    for (let k = units; k < resolvable; k++) {
      slice += `${this.units[k].kind}:${this.units[k].key}:${this.markers.get(k + 1) ?? ''}|`;
    }
    if (resolvable < end) slice += '#';
    if (entry.intact && entry.intact.units === units && entry.intact.slice === slice) {
      if (this.diag) this.note(summary.level, 0, 1, 0, 0, 0);
      if (entry.intactBy !== this.token) { this.summariesReused++; entry.intactBy = this.token; }
      this.charge(entry.intactWork!);
      return entry.intact.deltas;
    }
    this.summariesSolved++;
    entry.intactBy = this.token;
    const zero: Label = {
      tokens: 0, extension: 0, continuity: 0, fidelity: 0,
      cache: { intact: true, matchedUnits: units, cachedTokens: Number.NaN, cachedUnits: -1 },
      pending: NO_PENDING, trace: null, approximation: ZERO_APPROXIMATION,
    };
    const before = this.work();
    const t0 = this.diag ? performance.now() : 0, p0 = this.diagPairs;
    const deltas = this.processSummary(zero, summary, undefined, Number.POSITIVE_INFINITY).map((label) => toDelta(label, true, units));
    if (this.diag) this.note(summary.level, 1, 0, deltas.length, this.diagPairs - p0, performance.now() - t0);
    entry.intactWork = this.workSince(before);
    entry.intact = { units, slice, deltas };
    return deltas;
  }

  private note(level: number, solved: number, reused: number, labels: number, pairs: number, ms: number): void {
    const d = this.diag!.get(level) ?? { solved: 0, reused: 0, labels: 0, pairs: 0, ms: 0 };
    d.solved += solved; d.reused += reused; d.labels += labels; d.pairs += pairs; d.ms += ms;
    this.diag!.set(level, d);
  }

  /** A mark before a delta computation. `maximum` carries the peak of the
   * enclosing computation, which resumes when this one ends. */
  private work(): Work {
    const mark = { states: this.states, created: this.created, expanded: this.expanded, dominated: this.dominated, maximum: this.peak };
    this.peak = 0;
    return mark;
  }

  /** The work since `before`, with the peak reached inside it alone, so a
   * reuse replays what this subtree cost and not what an earlier branch of
   * that solve happened to reach. */
  private workSince(before: Work): Work {
    const work = {
      states: this.states - before.states, created: this.created - before.created,
      expanded: this.expanded - before.expanded, dominated: this.dominated - before.dominated, maximum: this.peak,
    };
    this.peak = Math.max(before.maximum, this.peak);
    return work;
  }

  /** A reused set counts as computed again, ceiling included: a set that
   * needed more labels than this solve allows is not an answer for it. */
  private charge(work: Work): void {
    this.states += work.states;
    this.created += work.created;
    this.expanded += work.expanded;
    this.dominated += work.dominated;
    if (work.maximum > this.ceiling) throw new SparseLabelCeilingError(this.ceiling, work.maximum);
    this.peak = Math.max(this.peak, work.maximum);
    this.maximum = Math.max(this.maximum, work.maximum);
  }

  /** Select or expand `summary` from `start` (the DAG engines' select/expand
   * step for one label): the live leaves it may cover are selected, with
   * the holes among them expanded through the children; and the children
   * are expanded from `start`, composed from their memoized deltas where
   * the label allows it. Pruned on the grid from `start`'s origin. */
  private processSummary(start: Label, summary: CanonicalSummary, active: ReadonlySet<number> | undefined, flushLimit: number): Label[] {
    const live: number[] = [];
    const indices = this.forest.leafIndicesOf(summary);
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (!this.external[i] && (!active || active.has(i))) live.push(i);
    }
    const participants: number[] = [];
    const holes: number[] = [];
    for (const i of live) (this.leaves[i].allowedLevels.includes(summary.level) ? participants : holes).push(i);
    let selected: Label[] = [];
    if (participants.length > 0) {
      let fidelity = 0;
      let continuity = 0;
      let firstEmission = Number.POSITIVE_INFINITY;
      for (const i of participants) {
        fidelity += this.fidelityBase[i] * summary.level;
        continuity += this.continuity(i, summary.level);
        if (this.leaves[i].sequence < firstEmission) firstEmission = this.leaves[i].sequence;
      }
      // New material is decided over every leaf the summary owns, as the
      // DAG engines and the terminal evaluator do: an accepted leaf that is
      // a hole here still makes the recall a re-rendering, not new material.
      const extension = this.isExtension(indices);
      const assigned: Label = {
        ...start,
        continuity: start.continuity + continuity,
        fidelity: start.fidelity + fidelity,
        trace: { parent: start.trace, ids: participants.map((i) => this.leafIds[i]), level: summary.level },
      };
      selected = [this.emit(assigned, 'recall', summary.id, summary.recallTokens, extension, firstEmission)];
      if (holes.length > 0) selected = this.processChildren(selected, summary, new Set(holes), flushLimit);
    }
    const expanded = this.processChildren([start], summary, active, flushLimit);
    return this.prune([...selected, ...expanded], this.options.maxTokens);
  }

  private processChildren(incoming: Label[], summary: CanonicalSummary, active: ReadonlySet<number> | undefined, flushLimit: number): Label[] {
    let expanded = incoming;
    const children = this.forest.orderedChildren(summary).filter((child) => {
      if (!active) return true;
      if (child.kind === 'leaf') return active.has(child.index);
      const indices = this.forest.leafIndicesOf(this.forest.summary(child.id)!);
      for (let k = 0; k < indices.length; k++) if (active.has(indices[k])) return true;
      return false;
    });
    for (let c = 0; c < children.length;) {
      const child = children[c];
      if (this.buffered && this.cacheRelevant) expanded = expanded.map((label) =>
        this.flush(label, Math.min(child.firstSequence, flushLimit)));
      if (child.kind === 'summary') {
        // A later ownership sibling can contain chronologically earlier
        // leaves: never flush beyond an unvisited sibling's first sequence.
        const nextLimit = Math.min(flushLimit, children[c + 1]?.firstSequence ?? Number.POSITIVE_INFINITY);
        expanded = this.combine(expanded, this.forest.summary(child.id)!, active, nextLimit);
        c++;
        continue;
      }
      const run: number[] = [];
      while (c < children.length && children[c].kind === 'leaf') {
        const index = (children[c] as { index: number }).index;
        if (!this.external[index]) run.push(index);
        c++;
      }
      const rawAllowed = run.every((i) => this.leaves[i].allowedLevels.includes(0));
      expanded = rawAllowed ? this.prune(expanded.map((label) => this.rawRun(label, run, false)), this.options.maxTokens) : [];
    }
    return expanded;
  }

  // ---- actions ----

  private continuity(i: number, level: number): number {
    const previous = this.previousLevel[i];
    if (previous < 0) return 0;
    if (level === previous && this.previousMatches[i]) return 0;
    return this.continuityBase[i] * Math.max(1, Math.abs(level - previous));
  }

  private isExtension(indices: ArrayLike<number>): boolean {
    if (!this.options.presentation || indices.length === 0) return false;
    for (let k = 0; k < indices.length; k++) if (this.previousLevel[indices[k]] >= 0) return false;
    return true;
  }

  /** `run` rendered raw. `perLeafFlush`: the leaves are roots, which the
   * DAG engines flush before one by one. */
  private rawRun(label: Label, run: readonly number[], perLeafFlush: boolean): Label {
    if (run.length === 0) return label;
    let continuity = 0;
    for (const i of run) continuity += this.continuity(i, 0);
    let next: Label = {
      ...label,
      continuity: label.continuity + continuity,
      trace: { parent: label.trace, ids: run.map((i) => this.leafIds[i]), level: 0 },
    };
    if (next.cache.intact) {
      for (const i of run) {
        if (perLeafFlush && this.buffered) next = this.flush(next, this.leaves[i].sequence);
        next = this.emit(next, 'raw', this.leafIds[i], this.leaves[i].rawTokens, this.isExtension([i]), this.leaves[i].sequence);
      }
      return next;
    }
    let tokens = 0;
    let extension = 0;
    for (const i of run) {
      tokens += this.leaves[i].rawTokens;
      if (this.options.presentation && this.previousLevel[i] < 0) extension += this.leaves[i].rawTokens;
    }
    return { ...next, tokens: next.tokens + tokens, extension: next.extension + extension };
  }

  private emit(label: Label, kind: 'head' | 'raw' | 'recall' | 'tail', key: string, tokens: number, extension: boolean, sequence = Number.POSITIVE_INFINITY): Label {
    const rendered = label.tokens + tokens;
    const extended = label.extension + (extension ? tokens : 0);
    if (!label.cache.intact) return { ...label, tokens: rendered, extension: extended };
    if (this.buffered && (kind === 'raw' || kind === 'recall')) {
      return { ...label, tokens: rendered, extension: extended, pending: [...label.pending, { kind, key, tokens, sequence }] };
    }
    return { ...label, tokens: rendered, extension: extended, cache: this.match(label.cache, kind, key) };
  }

  private match(cache: CacheState, kind: string, key: string): CacheState {
    const previous = this.units[cache.matchedUnits];
    if (previous && previous.kind === kind && previous.key === key) {
      const matched = cache.matchedUnits + 1;
      const marker = this.markers.get(matched);
      return marker !== undefined
        ? { intact: true, matchedUnits: matched, cachedTokens: marker, cachedUnits: matched }
        : { ...cache, matchedUnits: matched };
    }
    return { ...cache, intact: false };
  }

  /** Match the buffered emissions before `beforeSequence` in chronological
   * order; the first mismatch breaks the prefix and drops the rest. */
  private flush(label: Label, beforeSequence: number): Label {
    if (!label.cache.intact || label.pending.length === 0) return label;
    const ordered = [...label.pending].sort((a, b) =>
      a.sequence - b.sequence || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
    let cache = label.cache;
    let consumed = 0;
    while (consumed < ordered.length && ordered[consumed].sequence < beforeSequence) {
      const emission = ordered[consumed++];
      cache = this.match(cache, emission.kind, emission.key);
      if (!cache.intact) return { ...label, cache, pending: NO_PENDING };
    }
    return { ...label, cache, pending: consumed === ordered.length ? NO_PENDING : ordered.slice(consumed) };
  }

  private emitTail(label: Label): Label {
    let finished = label;
    if (!finished.cache.intact) {
      // No unit matching: one sum instead of an object per tail unit.
      let tokens = 0, extension = 0;
      for (const unit of this.tail) { tokens += unit.tokens; if (unit.extension) extension += unit.tokens; }
      return { ...finished, tokens: finished.tokens + tokens, extension: finished.extension + extension };
    }
    for (const unit of this.tail) finished = this.emit(finished, unit.kind, unit.key, unit.tokens, unit.extension, unit.sequence);
    return this.flush(finished, Number.POSITIVE_INFINITY);
  }

  // ---- pruning (the DAG engines' grid, on labels measured from any origin) ----

  private keyFor(label: Label): string | number {
    const t = this.tBucket > 0 ? Math.ceil(label.tokens / this.tBucket) : label.tokens;
    // An unbucketed dimension is a wildcard, as in the packed engine: the
    // labels then meet in one group and exact dominance decides between
    // them, instead of every distinct value keeping its own survivor.
    const k = this.kBucket > 0 ? Math.floor(label.continuity / this.kBucket) : 'c*';
    const f = this.fBucket > 0 ? Math.floor(label.fidelity / this.fBucket) : 'f*';
    if (!this.cacheRelevant) return `${t}:${k}:${f}`;
    if (label.cache.intact) {
      const pending = label.pending.length === 0 ? '' :
        label.pending.map((emission) => `${emission.sequence}/${emission.kind}/${emission.key}`).join(',');
      return `i:${label.cache.matchedUnits}:${label.cache.cachedTokens}:${pending}:${t}:${k}:${f}`;
    }
    // Once a prefix diverges, future cache cost depends on its last matched
    // marker, not on how many unmarked units happened to match after it.
    return `b:${label.cache.cachedUnits}:${label.cache.cachedTokens}:${t}:${k}:${f}`;
  }

  private prune(labels: readonly Label[], maxTokens: number): Label[] {
    this.states++;
    const groups = new Map<string | number, Label | Label[]>();
    for (const label of labels) {
      if (label.tokens > maxTokens) continue;
      const key = this.keyFor(label);
      const current = groups.get(key);
      if (Array.isArray(current)) current.push(label);
      else if (current) groups.set(key, [current, label]);
      else groups.set(key, label);
    }
    const result: Label[] = [];
    const signatures = new Map<Label, string>();
    const signature = (label: Label): string => {
      let value = signatures.get(label);
      if (value === undefined) {
        value = frontierSignature(reconstructFrontier(label.trace), this.leafIds);
        signatures.set(label, value);
      }
      return value;
    };
    const cacheRelevant = this.cacheRelevant;
    const order = (a: Label, b: Label): number =>
      a.fidelity - b.fidelity ||
      a.continuity - b.continuity ||
      a.tokens - b.tokens ||
      (cacheRelevant ? b.extension - a.extension : 0) ||
      signature(a).localeCompare(signature(b));
    for (const pool of groups.values()) {
      if (!Array.isArray(pool)) { result.push(pool); continue; }
      const representatives = this.kBucket > 0 && this.fBucket > 0
        ? bucketRepresentatives(pool, cacheRelevant, order)
        : pool.filter((candidate, index) => !pool.some(
            (other, otherIndex) => otherIndex !== index && dominates(other, candidate, cacheRelevant),
          ));
      const covered = coverApproximationPool(pool, representatives, cacheRelevant);
      this.dominated += pool.length - covered.length;
      for (const label of covered) result.push(label);
    }
    this.created += result.length;
    this.maximum = Math.max(this.maximum, result.length);
    this.peak = Math.max(this.peak, result.length);
    if (result.length > this.ceiling) throw new SparseLabelCeilingError(this.ceiling, result.length);
    if (this.states % 1000 === 0) this.options.onProgress?.({
      phase: 'propagate', elapsedMs: performance.now() - this.started, states: this.states, labels: result.length,
    });
    return result;
  }
}

/** What a delta set reads from a summary besides its leaves and children:
 * level, recall cost, which leaves and children it owns. Leaf changes are
 * the span hash's; a summary object is immutable, so this is kept per
 * object, and the subtree structure composes it with the children's. */
const ownStructures = new WeakMap<CanonicalSummary, readonly [number, number]>();
/** Two independent 32-bit lanes over a summary's own structure. The recall
 * cost's float words enter each lane whole, in different orders, so two
 * costs agree on both lanes only by a 2^-64 accident (one lane with the
 * words xored let a re-priced summary rebind its old sets). */
function ownStructure(summary: CanonicalSummary): readonly [number, number] {
  let value = ownStructures.get(summary);
  if (value !== undefined) return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, summary.recallTokens);
  const hi = view.getUint32(0), lo = view.getUint32(4);
  let a = mix(mix(summary.level + 1, hi), lo);
  let b = mixB(mixB(summary.level + 1, lo), hi);
  a = mix(a, summary.leafIds.length);
  b = mixB(b, summary.leafIds.length);
  for (const id of summary.leafIds) { a = mix(a, hashString(id)); b = mixB(b, hashStringB(id)); }
  for (const id of summary.childSummaryIds) { a = mix(a, hashString(id) ^ 0x5bd1e995); b = mixB(b, hashStringB(id) ^ 0x27d4eb2f); }
  for (const id of summary.directLeafIds) { a = mix(a, hashString(id) ^ 0x1b873593); b = mixB(b, hashStringB(id) ^ 0x165667b1); }
  a = mix(a, hashString(summary.parentId ?? ''));
  b = mixB(b, hashStringB(summary.parentId ?? ''));
  value = [a, b];
  ownStructures.set(summary, value);
  return value;
}

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A second string hash, independent of `hashString` (other seed and prime). */
function hashStringB(value: string): number {
  let h = 0x811c9dc5 ^ 0x5bd1e995;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ (value.charCodeAt(i) + 0x9e37), 0x01000193 ^ 0x3b);
  return h >>> 0;
}

function toDelta(label: Label, intactEntry: boolean, entryUnits = 0): Delta {
  const marker = intactEntry && label.cache.cachedUnits >= 0
    ? { cachedTokens: label.cache.cachedTokens, cachedUnits: label.cache.cachedUnits }
    : null;
  return {
    tokens: label.tokens,
    extension: label.extension,
    continuity: label.continuity,
    fidelity: label.fidelity,
    exitIntact: intactEntry && label.cache.intact,
    units: intactEntry ? label.cache.matchedUnits - entryUnits : 0,
    marker,
    trace: label.trace,
    approximation: label.approximation,
  };
}

function compose(label: Label, delta: Delta): Label {
  let cache = label.cache;
  if (label.cache.intact) {
    cache = {
      intact: delta.exitIntact,
      matchedUnits: label.cache.matchedUnits + delta.units,
      cachedTokens: delta.marker ? delta.marker.cachedTokens : label.cache.cachedTokens,
      cachedUnits: delta.marker ? delta.marker.cachedUnits : label.cache.cachedUnits,
    };
  }
  const a = label.approximation, d = delta.approximation;
  const approximation = a === ZERO_APPROXIMATION ? d : d === ZERO_APPROXIMATION ? a : {
    token: a.token + d.token, continuity: a.continuity + d.continuity, fidelity: a.fidelity + d.fidelity, cache: a.cache + d.cache,
  };
  return {
    tokens: label.tokens + delta.tokens,
    extension: label.extension + delta.extension,
    continuity: label.continuity + delta.continuity,
    fidelity: label.fidelity + delta.fidelity,
    cache,
    pending: label.pending,
    trace: delta.trace ? { parent: label.trace, delta: delta.trace } : label.trace,
    approximation,
  };
}

function visitTrace(trace: TraceNode | null, visit: (ids: readonly ChunkId[], level: number) => void): void {
  const stack: (TraceNode | null)[] = [trace];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if ('delta' in node) {
      stack.push(node.parent, node.delta);
    } else {
      visit(node.ids, node.level);
      stack.push(node.parent);
    }
  }
}

function traceSource(trace: TraceNode | null): FrontierTraceSource {
  return { forEachAssignment: (visit) => visitTrace(trace, visit) };
}

function reconstructFrontier(trace: TraceNode | null): Map<ChunkId, number> {
  const frontier = new Map<ChunkId, number>();
  visitTrace(trace, (ids, level) => { for (const id of ids) frontier.set(id, level); });
  return frontier;
}

function sameFrontier(a: ReadonlyMap<ChunkId, number>, b: ReadonlyMap<ChunkId, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, level] of a) if (b.get(id) !== level) return false;
  return true;
}

function dominates(a: Label, b: Label, cacheRelevant: boolean): boolean {
  if (cacheRelevant && a.extension < b.extension) return false;
  return (
    a.tokens <= b.tokens && a.continuity <= b.continuity && a.fidelity <= b.fidelity &&
    (a.tokens < b.tokens || a.continuity < b.continuity || a.fidelity < b.fidelity ||
      (cacheRelevant && a.extension > b.extension))
  );
}

function bucketRepresentatives(pool: readonly Label[], cacheRelevant: boolean, order: (a: Label, b: Label) => number): Label[] {
  let fidelity = pool[0];
  let continuity = pool[0];
  let tokens = pool[0];
  let extension = pool[0];
  for (let i = 1; i < pool.length; i++) {
    const label = pool[i];
    if (order(label, fidelity) < 0) fidelity = label;
    if ((label.continuity - continuity.continuity || order(label, continuity)) < 0) continuity = label;
    if ((label.tokens - tokens.tokens || order(label, tokens)) < 0) tokens = label;
    if (cacheRelevant && (extension.extension - label.extension || order(label, extension)) < 0) extension = label;
  }
  const result = [fidelity];
  if (continuity !== fidelity) result.push(continuity);
  if (tokens !== fidelity && tokens !== continuity) result.push(tokens);
  if (cacheRelevant && !result.includes(extension)) result.push(extension);
  return result;
}

/** The DAG engines' envelope accounting: a label is covered only by a
 * representative with no more tokens than its own. These labels are
 * measured from the subtree's origin, so the wall is applied again at
 * every ancestor with the prefix added; a representative that crosses it
 * then can only take with it labels that would have crossed too, and the
 * error it carries for them is never owed. The fewest-tokens
 * representative always qualifies, so every label is covered. */
function coverApproximationPool(pool: readonly Label[], representatives: readonly Label[], cacheRelevant: boolean): Label[] {
  const envelopes = representatives.map((label) => ({ ...label.approximation }));
  for (const source of pool) {
    let chosen = 0;
    let chosenCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < representatives.length; i++) {
      const candidate = representatives[i];
      if (candidate.tokens > source.tokens) continue;
      const cost =
        Math.abs(candidate.tokens - source.tokens) +
        Math.max(0, candidate.continuity - source.continuity) +
        Math.max(0, candidate.fidelity - source.fidelity) +
        (cacheRelevant ? Math.max(0, source.extension - candidate.extension) : 0);
      if (cost < chosenCost) { chosen = i; chosenCost = cost; }
    }
    const target = representatives[chosen];
    const envelope = envelopes[chosen];
    envelope.token = Math.max(envelope.token, source.approximation.token + Math.abs(target.tokens - source.tokens));
    envelope.continuity = Math.max(envelope.continuity, source.approximation.continuity + Math.max(0, target.continuity - source.continuity));
    envelope.fidelity = Math.max(envelope.fidelity, source.approximation.fidelity + Math.max(0, target.fidelity - source.fidelity));
    if (cacheRelevant) {
      envelope.cache = Math.max(envelope.cache, source.approximation.cache + Math.max(0, source.extension - target.extension));
    }
  }
  return representatives.map((label, i) => ({ ...label, approximation: envelopes[i] }));
}

function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** The second structure lane's mixer, with its own constants and shifts. */
function mixB(a: number, b: number): number {
  let h = (a ^ Math.imul(b, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
