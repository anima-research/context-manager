import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs } from './picker.js';
import { CanonicalSummaryForest, type CanonicalLeaf } from './kv-unified.js';
import {
  budgetPenalty, continuityLeafBase, fidelityLeafBase, normalizePolicy,
  type ExactPolicySolveOptions, type UnscoredCandidate,
  type PresentedLeaf,
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

/** A complete cut given as the level per leaf in `orderedLeafIds` order. */
export interface FrontierLevels {
  readonly levels: ArrayLike<number>;
}

/** The per-slot facts that depend only on a leaf and its receipt entry:
 * whether the slot matches the accepted presentation, which unit it emits,
 * and the representation distance its continuity loss is scaled by. Kept per
 * forest ownership across compiles; a leaf whose objects did not change
 * keeps its slots. Unit codes are relative to `chunkCount` (summary codes
 * follow the leaf codes), so a longer leaf list shifts them. */
interface EvaluatorStructure {
  readonly stride: number;
  readonly summaryCount: number;
  /** Summary ids in code order (`allSummaries()` at build), so a structure
   *  taken from a lineage parent can translate its summary codes. */
  readonly summaryIds: readonly string[];
  chunkCount: number;
  leaves: (CanonicalLeaf | undefined)[];
  previous: (PresentedLeaf | undefined)[];
  matches: Uint8Array;
  representations: Uint32Array;
  /** 0 when the slot carries no continuity loss, else max(1, |level - previous.level|). */
  distance: Float64Array;
  previousUnits?: { layout: RenderLayout; units: Uint32Array };
}

const structures = new WeakMap<object, EvaluatorStructure>();

const presentedByScope = new WeakMap<object, {
  presentation: ReadonlyMap<string, PresentedLeaf>; ownership: object;
  leaves: readonly CanonicalLeaf[]; previous: (PresentedLeaf | undefined)[];
}>();

/** The accepted presentation's entry per leaf position of `forest`, looked
 * up once per solve (`scope` is the solve's options object) and shared by
 * the certificate and the evaluators of that solve. A later solve reads the
 * map again, so a caller that mutates its map between solves is seen. The
 * array is not to be mutated. */
export function presentedLeavesByIndex(
  presentation: ReadonlyMap<string, PresentedLeaf>,
  forest: CanonicalSummaryForest,
  scope: object,
): readonly (PresentedLeaf | undefined)[] {
  const leaves = forest.orderedLeaves();
  const known = presentedByScope.get(scope);
  if (known && known.presentation === presentation && known.ownership === forest.ownership && known.leaves.length === leaves.length) {
    let same = true;
    for (let i = 0; same && i < leaves.length; i++) {
      const a = known.leaves[i], b = leaves[i];
      same = a === b || a.id === b.id;
    }
    if (same) return known.previous;
  }
  const previous: (PresentedLeaf | undefined)[] = new Array(leaves.length);
  for (let i = 0; i < leaves.length; i++) previous[i] = presentation.get(leaves[i].id);
  presentedByScope.set(scope, { presentation, ownership: forest.ownership, leaves, previous });
  return previous;
}

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
  private readonly chunks: readonly PickerInputs['chunks'][number][];
  private readonly ids: readonly string[];
  /** Position of a leaf id in `chunks`, undefined for an unknown id. */
  private readonly leafIndex: (id: string) => number | undefined;
  private readonly ranges = new WeakMap<readonly string[], Uint32Array>();
  private readonly actions = new WeakMap<readonly string[], {
    readonly level: number;
    readonly action: CompiledAction;
    otherLevels?: Map<number, CompiledAction>;
  }>();
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
    // A forest built from these inputs holds their chunks in this same order
    // (sequence, then id), parallel to its leaves and their `index`.
    const fromForest = forest.builtFrom(inputs);
    const leaves = forest.orderedLeaves();
    this.chunks = fromForest ? forest.orderedChunks()
      : [...inputs.chunks].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    this.ids = this.chunks.map((chunk) => chunk.id);
    if (fromForest) {
      this.leafIndex = (id) => forest.leaf(id)?.index;
    } else {
      const index = new Map(this.chunks.map((chunk, i) => [chunk.id, i]));
      this.leafIndex = (id) => index.get(id);
    }
    const summaries = forest.allSummaries();
    this.stride = 1 + summaries.reduce((max, summary) => Math.max(max, summary.level), 0);
    this.levels = this.stride <= 256 ? new Uint8Array(this.chunks.length) : new Uint32Array(this.chunks.length);
    this.fidelity = new Float64Array(this.chunks.length * this.stride);
    this.continuity = new Float64Array(this.fidelity.length);
    this.matches = new Uint8Array(this.fidelity.length);
    this.representations = new Uint32Array(this.fidelity.length);
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
    const tail = tailUnits(inputs);
    this.tailCodes = tail.flatMap((unit) => unit.chunkId ? [this.leafIndex(unit.chunkId)! + 1] : []);
    this.unitTokens[this.tailCode] = tail.find((unit) => unit.kind === 'tail')?.tokens ?? 0;
    this.unitKeys[this.headCode] = this.unitKinds[this.headCode] = 'head';
    this.unitKeys[this.tailCode] = this.unitKinds[this.tailCode] = 'tail';
    // The slots that depend only on leaf and receipt objects come from the
    // structure kept for this forest's ownership; each evaluator works on its
    // own copy, so an older evaluator's layout stays readable.
    const n = this.chunks.length;
    let structure = fromForest ? structures.get(forest.ownership) : undefined;
    // A forest extended from a previous ownership (summaries added or
    // re-parented) reads the parent's structure: leaf slots are by position,
    // and the leaves the extension rebuilt are new objects that the loop
    // below recomputes. Summary codes follow the sorted summary list, which
    // the extension may have grown or reordered, so every code is translated
    // once through a table keyed by the parent's code order.
    let remap: Uint32Array | null = null;
    if (!structure && fromForest && forest.lineage) {
      const parent = structures.get(forest.lineage.parent);
      if (parent && parent.stride === this.stride) {
        const table = new Uint32Array(parent.chunkCount + parent.summaryCount + 3);
        let complete = true;
        for (let code = 1; code <= parent.chunkCount; code++) table[code] = code;
        for (let k = 0; complete && k < parent.summaryCount; k++) {
          const code = summaryCode.get(parent.summaryIds[k]);
          if (code === undefined) complete = false;
          else table[parent.chunkCount + k + 1] = code;
        }
        table[parent.chunkCount + parent.summaryCount + 1] = this.headCode;
        table[parent.chunkCount + parent.summaryCount + 2] = this.tailCode;
        if (complete) { structure = parent; remap = table; }
      }
    }
    if (structure && remap === null && (structure.stride !== this.stride || structure.summaryCount !== summaries.length)) structure = undefined;
    const leafCount = structure?.leaves.length ?? 0;
    const shift = structure ? n - structure.chunkCount : 0;
    // Raw codes are positions. The kept layout translation is reused only
    // when every position the structure knows still holds the same leaf id:
    // a sibling forest of this ownership may have appended other leaves, and
    // a structure longer than this forest names positions it does not have.
    let aligned = structure !== undefined && leafCount <= n;
    for (let i = 0; aligned && i < leafCount; i++) aligned = structure!.leaves[i]?.id === this.ids[i];
    if (structure && leafCount >= n) {
      this.matches = structure.matches.slice(0, n * this.stride);
      this.representations = structure.representations.slice(0, n * this.stride);
      const codes = this.representations;
      if (remap) {
        for (let at = 0; at < codes.length; at++) codes[at] = remap[codes[at]];
      } else if (shift !== 0) {
        for (let at = 0; at < codes.length; at++) if (codes[at] > leafCount) codes[at] += shift;
      }
    } else if (structure) {
      this.matches.set(structure.matches);
      this.representations.set(structure.representations);
      const codes = this.representations;
      if (remap) {
        for (let at = 0, end = leafCount * this.stride; at < end; at++) codes[at] = remap[codes[at]];
      } else if (shift !== 0) {
        for (let at = 0, end = leafCount * this.stride; at < end; at++) if (codes[at] > leafCount) codes[at] += shift;
      }
    }
    const distance = new Float64Array(this.fidelity.length);
    if (structure) distance.set(structure.distance.subarray(0, Math.min(structure.distance.length, distance.length)));
    const known = structure?.leaves ?? [];
    const knownPrevious = structure?.previous ?? [];
    const layout = options.cache?.layout;
    const keptUnits = structure?.previousUnits;
    if (layout && keptUnits && keptUnits.layout === layout && aligned) {
      const table = remap;
      this.previousUnits = table ? keptUnits.units.map((code) => table[code])
        : shift === 0 ? keptUnits.units : keptUnits.units.map((code) => code > leafCount ? code + shift : code);
    } else {
      this.previousUnits = Uint32Array.from(layout?.units ?? [], (unit) => {
        if (unit.kind === 'head') return this.headCode;
        if (unit.kind === 'tail') return this.tailCode;
        if (unit.kind !== 'raw') return summaryCode.get(unit.key) ?? 0;
        const at = this.leafIndex(unit.key);
        return at === undefined ? 0 : at + 1;
      });
    }
    this.markerUnits = new Set(options.cache?.markers.map((marker) => marker.unitIndex));
    this.cacheRelevant = options.cache !== undefined && options.currentImmutablePrefixHash !== undefined &&
      options.cache.immutablePrefixHash === options.currentImmutablePrefixHash;
    const newest = this.chunks.at(-1)?.sequence ?? 0;
    const currentSeq = presentation?.currentSeq ?? 0;
    const nextLeaves: (CanonicalLeaf | undefined)[] = new Array(n);
    const nextPrevious: (PresentedLeaf | undefined)[] = new Array(n);
    const previousAt = presentation && fromForest ? presentedLeavesByIndex(presentation.leaves, forest, options) : null;
    let age = 0;
    for (let i = n - 1; i >= 0; i--) {
      const chunk = this.chunks[i];
      const midpoint = age + chunk.rawTokens / 2;
      age += chunk.rawTokens;
      const leaf = fromForest ? leaves[i] : forest.leaf(chunk.id)!;
      const previous = previousAt ? previousAt[i] : presentation?.leaves.get(chunk.id);
      this.unitTokens[i + 1] = chunk.rawTokens;
      this.unitKeys[i + 1] = chunk.id;
      this.unitKinds[i + 1] = 'raw';
      this.unitExtension[i + 1] = presentation && !previous ? 1 : 0;
      nextLeaves[i] = leaf;
      nextPrevious[i] = previous;
      // The level-independent factors once per leaf; the per-level loss is
      // the same product as the policy functions, in the same order.
      const fidelityBase = leaf.externallyAccounted ? 0 : fidelityLeafBase(chunk, newest, this.policy);
      const continuityBase = previous ? continuityLeafBase(chunk, previous, currentSeq, midpoint, this.policy) : 0;
      if (known[i] === leaf && knownPrevious[i] === previous) {
        for (const level of leaf.allowedLevels) {
          const at = i * this.stride + level;
          this.fidelity[at] = leaf.externallyAccounted ? 0 : fidelityBase * level;
          const d = distance[at];
          this.continuity[at] = d === 0 ? 0 : continuityBase * d;
        }
        continue;
      }
      for (const level of leaf.allowedLevels) {
        const at = i * this.stride + level;
        const slot = leaf.availableLevels.indexOf(level);
        const summary = slot > 0 ? leaf.summaryIds[slot - 1] : undefined;
        const hash = leaf.repHashes[slot];
        this.fidelity[at] = leaf.externallyAccounted ? 0 : fidelityBase * level;
        const d = !previous || (hash === previous.repHash && level === previous.level) ? 0
          : Math.max(1, Math.abs(level - previous.level));
        distance[at] = d;
        this.continuity[at] = d === 0 ? 0 : continuityBase * d;
        this.matches[at] = !previous || (previous.level === level && previous.repHash === hash) ? 1 : 0;
        this.representations[at] = leaf.externallyAccounted ? 0 :
          (chunk.pinned || level === 0 ? i + 1 : summaryCode.get(summary!)!);
      }
    }
    if (fromForest) {
      structures.set(forest.ownership, {
        stride: this.stride, summaryCount: summaries.length, summaryIds: summaries.map((summary) => summary.id), chunkCount: n,
        leaves: nextLeaves, previous: nextPrevious,
        matches: this.matches, representations: this.representations, distance,
        previousUnits: layout ? { layout, units: this.previousUnits } : undefined,
      });
    }
  }

  get orderedLeafIds(): readonly string[] { return this.ids; }
  get exactEvaluations(): number { return this.evaluations; }

  private compileAction(ids: readonly string[], level: number): CompiledAction {
    const entry = this.actions.get(ids);
    // Packed action arrays normally have one level. Keep that result directly;
    // diagnostic traces that reuse an array at other levels retain exact keys.
    const cached = entry && (entry.level === level || Object.is(entry.level, level))
      ? entry.action : entry?.otherLevels?.get(level);
    if (cached) return cached;
    let fidelity = 0, continuity = 0, matches = true;
    const units = new Map<number, number>();
    for (const id of ids) {
      const index = this.leafIndex(id)!;
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
    if (!entry) this.actions.set(ids, { level, action: result });
    else (entry.otherLevels ??= new Map()).set(level, result);
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

  private fill(trace: FrontierTraceReference | FrontierLevels): void {
    if (trace && 'levels' in trace) {
      if (trace.levels.length !== this.levels.length) {
        throw new Error(`kv-unified levels vector has ${trace.levels.length} entries for ${this.levels.length} leaves`);
      }
      this.levels.set(trace.levels);
      return;
    }
    this.levels.fill(0);
    // Valid cut traces assign each leaf exactly once, so traversal direction
    // is immaterial. Reuse numeric indices for shared summary/raw-run actions.
    visitFrontierTrace(trace, (ids, level) => {
      let ranges = this.ranges.get(ids);
      if (!ranges) {
        const indices = ids.map((id) => this.leafIndex(id)!).sort((a, b) => a - b);
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

  candidate(trace: FrontierTraceReference | FrontierLevels, renderedTokens: number): UnscoredCandidate {
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
    let levels: Uint8Array | Uint32Array | undefined;
    const getLevels = () => {
      if (!levels) {
        this.fill(trace);
        levels = this.levels.slice();
      }
      return levels;
    };
    const candidate: UnscoredCandidate = {
      get frontier() { return getFrontier(); },
      get layout() { return getLayout(); },
      fidelityLoss, continuityLoss, renderedTokens, cacheChurn, matchesPresentation,
      budgetPenalty: budgetPenalty(renderedTokens, this.maxTokens, this.policy),
    };
    // Non-enumerable, like the solver's bound hook: results are compared
    // structurally in diagnostics and tests.
    Object.defineProperty(candidate, 'levels', { get: getLevels, enumerable: false });
    Object.defineProperty(candidate, 'leafIds', { value: this.ids, enumerable: false });
    return candidate;
  }
}
