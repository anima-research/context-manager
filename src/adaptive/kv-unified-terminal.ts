import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import { CanonicalSummaryForest } from './kv-unified.js';
import {
  budgetPenalty, continuityLeafLoss, fidelityLeafLoss, normalizePolicy,
  type ExactPolicySolveOptions, type UnscoredCandidate,
} from './kv-unified-policy.js';
import { tailUnits, type RenderLayout, type RenderedUnit } from './render-offsets.js';
import { nonnegativeSumInterval, type BoundedPolicyCandidate } from './kv-unified-selective.js';

export interface FrontierTrace {
  readonly parent: FrontierTrace | null;
  readonly ids: readonly ChunkId[];
  readonly level: number;
}

export interface FrontierTraceSource {
  forEachAssignment(visit: (ids: readonly ChunkId[], level: number) => void): void;
}

export type FrontierTraceReference = FrontierTrace | FrontierTraceSource | null;

interface CompiledAction {
  readonly fidelity: number;
  readonly continuity: number;
  readonly matches: boolean;
  readonly leaves: number;
  /** Pairs: emitted unit code, earliest assigned leaf index. */
  readonly emissions: Uint32Array;
}

export function visitFrontierTrace(trace: FrontierTraceReference,
  visit: (ids: readonly ChunkId[], level: number) => void): void {
  if (trace && 'forEachAssignment' in trace) trace.forEachAssignment(visit);
  else for (let cursor = trace; cursor; cursor = cursor.parent) visit(cursor.ids, cursor.level);
}

/** Precompute per-leaf terms once, then sum in exactly the oracle's order.
 * Frontier Maps and rendered layouts remain lazy until a caller needs them.
 * This removes billions of repeated powers/hash lookups and keeps only one
 * compact scratch vector instead of thousands of 70k-entry Maps. */
export class TerminalPolicyEvaluator {
  private readonly chunks: PickerInputs['chunks'];
  private readonly ids: readonly string[];
  private readonly index: Map<string, number>;
  private readonly ranges = new WeakMap<readonly string[], Uint32Array>();
  private readonly actions = new WeakMap<readonly string[], Map<number, CompiledAction>>();
  private readonly stride: number;
  private readonly fidelity: Float64Array;
  private readonly continuity: Float64Array;
  private readonly matches: Uint8Array;
  private readonly levels: Uint8Array | Uint32Array;
  private readonly representations: Uint32Array;
  private readonly unitTokens: Float64Array;
  private readonly unitKeys: string[];
  private readonly unitKinds: RenderedUnit['kind'][];
  private readonly unitExtension: Uint8Array;
  private readonly emitted: Uint32Array;
  private readonly firstEmission: Uint32Array;
  private readonly orderedEmissions: Uint32Array;
  private readonly emissionAtLeaf: Uint32Array;
  private readonly previousUnits: Uint32Array;
  private readonly markerUnits: ReadonlySet<number>;
  private readonly headCode: number;
  private readonly tailCode: number;
  private readonly tailCodes: readonly number[];
  private generation = 0;
  private readonly policy;
  private readonly maxTokens: number;
  private evaluations = 0;
  readonly cacheRelevant: boolean;

  constructor(private readonly inputs: PickerInputs, private readonly forest: CanonicalSummaryForest,
    private readonly options: ExactPolicySolveOptions) {
    this.policy = normalizePolicy(options.policy);
    this.maxTokens = options.maxTokens;
    this.chunks = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    this.ids = this.chunks.map((chunk) => chunk.id);
    this.index = new Map(this.chunks.map((chunk, index) => [chunk.id, index]));
    this.stride = 1 + forest.allSummaries().reduce((max, summary) => Math.max(max, summary.level), 0);
    this.levels = this.stride <= 256 ? new Uint8Array(this.chunks.length) : new Uint32Array(this.chunks.length);
    this.fidelity = new Float64Array(this.chunks.length * this.stride);
    this.continuity = new Float64Array(this.fidelity.length);
    this.matches = new Uint8Array(this.fidelity.length);
    this.representations = new Uint32Array(this.fidelity.length);
    const summaries = forest.allSummaries();
    const summaryCode = new Map(summaries.map((summary, i) => [summary.id, this.chunks.length + i + 1]));
    this.headCode = this.chunks.length + summaries.length + 1;
    this.tailCode = this.headCode + 1;
    this.unitTokens = new Float64Array(this.tailCode + 1);
    this.unitKeys = new Array(this.tailCode + 1);
    this.unitKinds = new Array(this.tailCode + 1);
    this.unitExtension = new Uint8Array(this.tailCode + 1);
    this.emitted = new Uint32Array(this.tailCode + 1);
    this.firstEmission = new Uint32Array(this.tailCode + 1);
    this.orderedEmissions = new Uint32Array(this.tailCode + 1);
    this.emissionAtLeaf = new Uint32Array(this.chunks.length);
    const presentation = options.presentation;
    for (const summary of summaries) {
      const code = summaryCode.get(summary.id)!;
      this.unitTokens[code] = summary.recallTokens;
      this.unitKeys[code] = summary.id;
      this.unitKinds[code] = 'recall';
      this.unitExtension[code] = presentation && summary.leafIds.length > 0 &&
        summary.leafIds.every((id) => !presentation.leaves.has(id)) ? 1 : 0;
    }
    this.unitTokens[this.headCode] = inputs.headTokens;
    // Per-message tail (see render-offsets `tailUnits`): tail chunks emit as
    // their own raw codes, in wire order, after the middle; only unattributed
    // tail tokens remain on the opaque tail code.
    this.tailCodes = tailUnits(inputs).flatMap((unit) => unit.chunkId ? [this.index.get(unit.chunkId)! + 1] : []);
    this.unitTokens[this.tailCode] = tailUnits(inputs).find((unit) => unit.kind === 'tail')?.tokens ?? 0;
    this.unitKeys[this.headCode] = this.unitKinds[this.headCode] = 'head';
    this.unitKeys[this.tailCode] = this.unitKinds[this.tailCode] = 'tail';
    this.previousUnits = Uint32Array.from(options.cache?.layout.units ?? [], (unit) =>
      unit.kind === 'head' ? this.headCode : unit.kind === 'tail' ? this.tailCode :
        unit.kind === 'raw' ? (this.index.has(unit.key) ? this.index.get(unit.key)! + 1 : 0) :
          summaryCode.get(unit.key) ?? 0);
    this.markerUnits = new Set(options.cache?.markers.map((marker) => marker.unitIndex));
    this.cacheRelevant = options.cache !== undefined && options.currentImmutablePrefixHash !== undefined &&
      options.cache.immutablePrefixHash === options.currentImmutablePrefixHash;
    const newest = this.chunks.at(-1)?.sequence ?? 0;
    let age = 0;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const chunk = this.chunks[i];
      const midpoint = age + chunk.rawTokens / 2;
      age += chunk.rawTokens;
      const leaf = forest.leaf(chunk.id)!;
      const previous = options.presentation?.leaves.get(chunk.id);
      this.unitTokens[i + 1] = chunk.rawTokens;
      this.unitKeys[i + 1] = chunk.id;
      this.unitKinds[i + 1] = 'raw';
      this.unitExtension[i + 1] = presentation && !previous ? 1 : 0;
      for (const level of leaf.allowedLevels) {
        const at = i * this.stride + level;
        const summary = level === 0 ? undefined : leaf.summaryIds.find((id) => forest.summary(id)!.level === level);
        const hash = level === 0 ? `raw:${chunk.id}` : `summary:${summary}`;
        this.fidelity[at] = leaf.externallyAccounted ? 0 : fidelityLeafLoss(chunk, level, newest, this.policy);
        this.continuity[at] = continuityLeafLoss(chunk, level, hash, previous,
          options.presentation?.currentSeq ?? 0, midpoint, this.policy);
        this.matches[at] = !previous || (previous.level === level && previous.repHash === hash) ? 1 : 0;
        this.representations[at] = leaf.externallyAccounted ? 0 :
          (chunk.pinned || level === 0 ? i + 1 : summaryCode.get(summary!)!);
      }
    }
  }

  get orderedLeafIds(): readonly string[] { return this.ids; }
  get exactEvaluations(): number { return this.evaluations; }

  private compileAction(ids: readonly string[], level: number): CompiledAction {
    let levels = this.actions.get(ids);
    const cached = levels?.get(level);
    if (cached) return cached;
    let fidelity = 0, continuity = 0, matches = true;
    const units = new Map<number, number>();
    for (const id of ids) {
      const index = this.index.get(id)!;
      const at = index * this.stride + level;
      fidelity += this.fidelity[at]; continuity += this.continuity[at];
      matches &&= this.matches[at] === 1;
      const code = this.representations[at];
      if (code) units.set(code, Math.min(units.get(code) ?? Infinity, index));
    }
    const emissions = new Uint32Array(units.size * 2);
    let cursor = 0;
    for (const [code, index] of units) { emissions[cursor++] = code; emissions[cursor++] = index; }
    const result = { fidelity, continuity, matches, leaves: ids.length, emissions };
    if (!levels) { levels = new Map(); this.actions.set(ids, levels); }
    levels.set(level, result);
    return result;
  }

  /** Sum compiled action terms instead of scanning every leaf for every cut.
   * Cache is exact: deduplicate emitted units, sort their first assigned leaf
   * indices, and perform the same chronological offset/extension arithmetic.
   * No cache-prefix estimate from propagation is trusted here. */
  estimate(trace: FrontierTraceReference, renderedTokens: number): BoundedPolicyCandidate {
    let exact: UnscoredCandidate | undefined;
    const refine = () => exact ??= this.candidate(trace, renderedTokens);
    let fidelity = 0, continuity = 0, matches = true, leaves = 0, unitCount = 0;
    const generation = ++this.generation;
    visitFrontierTrace(trace, (ids, level) => {
      const action = this.compileAction(ids, level);
      fidelity += action.fidelity; continuity += action.continuity;
      matches &&= action.matches; leaves += action.leaves;
      if (!this.cacheRelevant) return;
      for (let i = 0; i < action.emissions.length; i += 2) {
        const code = action.emissions[i], index = action.emissions[i + 1];
        if (this.emitted[code] !== generation) {
          this.emitted[code] = generation; this.firstEmission[code] = index;
          this.orderedEmissions[unitCount++] = code;
        } else this.firstEmission[code] = Math.min(this.firstEmission[code], index);
      }
    });
    // Internal solver traces are complete disjoint cuts. Partial diagnostic
    // traces keep the old default-raw behavior by using the exact evaluator.
    if (leaves !== this.ids.length || !Number.isFinite(fidelity) || !Number.isFinite(continuity)) {
      const c = refine();
      return { renderedTokens, budgetPenalty: c.budgetPenalty, cacheChurn: c.cacheChurn,
        fidelity: { lower: c.fidelityLoss, upper: c.fidelityLoss },
        continuity: { lower: c.continuityLoss, upper: c.continuityLoss },
        matchesPresentation: c.matchesPresentation!, exact: refine };
    }
    let cacheChurn = 0;
    if (this.cacheRelevant) {
      // Convert to first-leaf indices so TypedArray's native numeric sort can
      // be used without a JS comparator or per-emission objects.
      for (let i = 0; i < unitCount; i++) {
        const code = this.orderedEmissions[i], index = this.firstEmission[code];
        this.emissionAtLeaf[index] = code; this.orderedEmissions[i] = index;
      }
      const ordered = this.orderedEmissions.subarray(0, unitCount);
      ordered.sort();
      let offset = 0, cached = 0, prefix = 0, extension = 0;
      let intact = true;
      const emit = (code: number) => {
        const tokens = this.unitTokens[code]; offset += tokens;
        if (this.unitExtension[code]) extension += tokens;
        if (intact) {
          if (this.previousUnits[prefix] === code) {
            prefix++;
            if (this.markerUnits.has(prefix)) cached = offset;
          } else intact = false;
        }
      };
      if (this.unitTokens[this.headCode] > 0) emit(this.headCode);
      for (const index of ordered) emit(this.emissionAtLeaf[index]);
      for (const code of this.tailCodes) emit(code);
      if (this.unitTokens[this.tailCode] > 0) emit(this.tailCode);
      cacheChurn = Math.max(0, offset - cached - extension) * Math.max(0, this.policy.cacheWritePrice - this.policy.cacheReadPrice);
    }
    return {
      renderedTokens, budgetPenalty: budgetPenalty(renderedTokens, this.maxTokens, this.policy),
      cacheChurn, fidelity: nonnegativeSumInterval(fidelity, leaves), continuity: nonnegativeSumInterval(continuity, leaves),
      matchesPresentation: matches, exact: refine,
    };
  }

  private fill(trace: FrontierTraceReference): void {
    this.levels.fill(0);
    // Valid cut traces assign each leaf exactly once, so traversal direction
    // is immaterial. Reuse numeric indices for shared summary/raw-run actions.
    visitFrontierTrace(trace, (ids, level) => {
      let ranges = this.ranges.get(ids);
      if (!ranges) {
        const indices = ids.map((id) => this.index.get(id)!).sort((a, b) => a - b);
        const spans: number[] = [];
        for (const index of indices) {
          if (spans.length > 0 && spans[spans.length - 1] === index) spans[spans.length - 1]++;
          else spans.push(index, index + 1);
        }
        ranges = Uint32Array.from(spans);
        this.ranges.set(ids, ranges);
      }
      for (let i = 0; i < ranges.length; i += 2) this.levels.fill(level, ranges[i], ranges[i + 1]);
    });
  }

  candidate(trace: FrontierTraceReference, renderedTokens: number): UnscoredCandidate {
    this.evaluations++;
    this.fill(trace);
    let fidelityLoss = 0;
    let continuityLoss = 0;
    let matchesPresentation = true;
    // The cache walk shares the chronological fidelity pass. Matching markers
    // use CURRENT offsets, since recalibration can change costs without
    // changing representation identities.
    const warm = this.cacheRelevant;
    const generation = ++this.generation;
    let offset = 0;
    let prefixUnits = 0;
    let cachedTokens = 0;
    let intact = true;
    let extensionTokens = 0;
    const emit = (code: number) => {
      const tokens = this.unitTokens[code];
      offset += tokens;
      if (this.unitExtension[code]) extensionTokens += tokens;
      if (intact) {
        if (this.previousUnits[prefixUnits] === code) {
          prefixUnits++;
          if (this.markerUnits.has(prefixUnits)) cachedTokens = offset;
        } else intact = false;
      }
    };
    if (warm && this.unitTokens[this.headCode] > 0) emit(this.headCode);
    // These directions deliberately match the existing oracle's FP sums.
    for (let i = 0, j = this.chunks.length - 1; i < this.chunks.length; i++, j--) {
      const at = i * this.stride + this.levels[i];
      fidelityLoss += this.fidelity[at];
      matchesPresentation &&= this.matches[at] === 1;
      continuityLoss += this.continuity[j * this.stride + this.levels[j]];
      if (warm) {
        const code = this.representations[at];
        if (code !== 0 && this.emitted[code] !== generation) {
          this.emitted[code] = generation;
          emit(code);
        }
      }
    }
    if (warm) for (const code of this.tailCodes) emit(code);
    if (warm && this.unitTokens[this.tailCode] > 0) emit(this.tailCode);
    const cacheChurn = warm ? Math.max(0, offset - cachedTokens - extensionTokens) *
      Math.max(0, this.policy.cacheWritePrice - this.policy.cacheReadPrice) : 0;
    let frontier: Map<string, number> | undefined;
    let layout: RenderLayout | undefined;
    const getFrontier = () => {
      if (!frontier) {
        this.fill(trace);
        frontier = new Map(this.ids.map((id, i) => [id, this.levels[i]]));
      }
      return frontier;
    };
    const getLayout = (): RenderLayout => {
      if (layout) return layout;
      if (!this.cacheRelevant) return layout = { units: [], totalTokens: renderedTokens };
      this.fill(trace);
      const units: RenderedUnit[] = [];
      const generation = ++this.generation;
      let offset = 0;
      const append = (code: number) => {
        const tokens = this.unitTokens[code];
        units.push({ kind: this.unitKinds[code], key: this.unitKeys[code], tokens, offset });
        offset += tokens;
      };
      if (this.unitTokens[this.headCode] > 0) append(this.headCode);
      for (let i = 0; i < this.ids.length; i++) {
        const code = this.representations[i * this.stride + this.levels[i]];
        if (code === 0 || this.emitted[code] === generation) continue;
        this.emitted[code] = generation;
        append(code);
      }
      for (const code of this.tailCodes) append(code);
      if (this.unitTokens[this.tailCode] > 0) append(this.tailCode);
      return layout = { units, totalTokens: offset };
    };
    return {
      get frontier() { return getFrontier(); },
      get layout() { return getLayout(); },
      fidelityLoss, continuityLoss, renderedTokens, cacheChurn, matchesPresentation,
      budgetPenalty: budgetPenalty(renderedTokens, this.maxTokens, this.policy),
    };
  }
}
