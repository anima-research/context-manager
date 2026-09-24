import type { PickerInputs } from './picker.js';
import { CanonicalSummaryForest, SparseLabelCeilingError, type MinimumTokenResult } from './kv-unified.js';
import {
  ExactKvUnifiedPolicySolver, continuityLeafLoss, fidelityLeafLoss, frontierSignature, normalizePolicy,
} from './kv-unified-policy.js';
import { TerminalPolicyEvaluator, type FrontierTraceReference } from './kv-unified-terminal.js';
import { scoreBoundedCandidates } from './kv-unified-selective.js';
import { PackedBuckets, PackedLabels, LABEL_STRIDE, LabelField } from './kv-unified-packed-storage.js';
import type { ApproximationEnvelope, ParetoPolicySolveResult, ParetoSolveOptions } from './kv-unified-pareto.js';

interface Action {
  trace: number;
  ids: readonly string[];
  level: number;
  fidelity: number;
  continuity: number;
  tokens: number;
  extension: number;
  key?: string;
  sequence: number;
}

/** The same select/expand/grid algorithm as the object reference engine,
 * using owned numeric handles and reusable bucket metadata. */
export class PackedDagSolver {
  private readonly s = new PackedLabels();
  private readonly leaves;
  private readonly leafIds: readonly string[];
  private readonly chunks;
  private readonly age = new Map<string, number>();
  private readonly newest: number;
  private readonly policy;
  private readonly cacheRelevant: boolean;
  private readonly markers: Map<number, number>;
  private readonly cacheClasses: Map<number, number>;
  private readonly buckets: PackedBuckets;
  private readonly tBucket: number;
  private readonly kBucket: number;
  private readonly fBucket: number;
  private kBins = 0;
  private fBins = 0;
  private gridKeys = 0;
  private readonly numericCache: boolean;
  private readonly started = performance.now();
  private states = 0;
  private created = 1;
  private expanded = 0;
  private dominated = 0;
  private maximum = 1;
  private errorScratch = new Float64Array(16);
  private readonly members: number[] = [];
  private readonly representatives: number[] = [];
  private readonly signatures = new Map<number, string>();

  constructor(private readonly inputs: PickerInputs, private readonly forest: CanonicalSummaryForest,
    private readonly options: ParetoSolveOptions, private readonly buffered: boolean,
    private readonly approximationBound: (error: ApproximationEnvelope) => number,
    private readonly knownFeasibility: Extract<MinimumTokenResult, { feasible: true }>) {
    this.policy = normalizePolicy(options.policy);
    this.leaves = forest.orderedLeaves();
    this.leafIds = this.leaves.map((leaf) => leaf.id);
    this.chunks = new Map(inputs.chunks.map((chunk) => [chunk.id, chunk]));
    this.newest = inputs.chunks.reduce((value, chunk) => Math.max(value, chunk.sequence), 0);
    let age = 0;
    for (let i = this.leaves.length - 1; i >= 0; i--) {
      const leaf = this.leaves[i]; this.age.set(leaf.id, age + leaf.rawTokens / 2); age += leaf.rawTokens;
    }
    this.cacheRelevant = options.cache !== undefined && options.currentImmutablePrefixHash !== undefined &&
      options.cache.immutablePrefixHash === options.currentImmutablePrefixHash;
    this.markers = new Map((options.cache?.markers ?? []).map((marker) => [marker.unitIndex, marker.offset]));
    this.cacheClasses = new Map([...this.markers.keys()].filter((index) => index > 0).sort((a, b) => a - b)
      .map((index, i) => [index, i + 1]));
    this.tBucket = Math.max(0, Math.floor(options.tokenBucketSize ?? 0));
    this.kBucket = Math.max(0, options.continuityBucketSize ?? 0);
    this.fBucket = Math.max(0, options.fidelityBucketSize ?? 0);
    if (this.tBucket > 0 && this.kBucket > 0 && this.fBucket > 0) {
      let maxK = 0, maxF = 0;
      for (const leaf of this.leaves) {
        const level = Math.max(...leaf.availableLevels);
        const previous = options.presentation?.leaves.get(leaf.id)?.level ?? 0;
        maxK += leaf.rawTokens * Math.max(1, previous, Math.abs(level - previous));
        if (!leaf.externallyAccounted) maxF += fidelityLeafLoss(this.chunks.get(leaf.id)!, level, this.newest, this.policy);
      }
      this.kBins = Math.ceil(maxK / this.kBucket) + 2;
      this.fBins = Math.ceil(maxF / this.fBucket) + 2;
      const keys = (Math.ceil(options.maxTokens / this.tBucket) + 2) * this.kBins * this.fBins;
      if (Number.isSafeInteger(keys)) this.gridKeys = keys;
      else this.kBins = this.fBins = 0;
    }
    const cacheKeys = this.gridKeys * (this.cacheClasses.size + 1);
    this.numericCache = this.gridKeys > 0 && Number.isSafeInteger(cacheKeys);
    this.buckets = new PackedBuckets(this.cacheRelevant ? (this.numericCache ? cacheKeys : 0) : this.gridKeys);
  }

  private key(id: number): string | number {
    const s = this.s;
    const t = this.tBucket > 0 ? Math.ceil(s.data[(id) * LABEL_STRIDE + LabelField.Tokens] / this.tBucket) : s.data[(id) * LABEL_STRIDE + LabelField.Tokens];
    const k = this.kBucket > 0 ? Math.floor(s.data[(id) * LABEL_STRIDE + LabelField.Continuity] / this.kBucket) : 'c*';
    const f = this.fBucket > 0 ? Math.floor(s.data[(id) * LABEL_STRIDE + LabelField.Fidelity] / this.fBucket) : 'f*';
    if (this.cacheRelevant && s.data[(id) * LABEL_STRIDE + LabelField.Intact]) return [
      '0', t, 1, s.data[(id) * LABEL_STRIDE + LabelField.Matched], s.data[(id) * LABEL_STRIDE + LabelField.CachedTokens],
      s.pending[id].map((emission) => `${emission.sequence}/${emission.kind}/${emission.key}`).join(','), k, f,
    ].join(':');
    const numeric = this.kBins > 0 && typeof k === 'number' && typeof f === 'number' &&
      k >= 0 && k < this.kBins && f >= 0 && f < this.fBins;
    const grid = numeric ? (t * this.kBins + k) * this.fBins + f : `${t}:${k}:${f}`;
    if (!this.cacheRelevant) return grid;
    const c = this.cacheClasses.get(s.data[(id) * LABEL_STRIDE + LabelField.CachedUnits]) ?? 0;
    return this.numericCache && typeof grid === 'number' ? c * this.gridKeys + grid : `broken:${c}:${grid}`;
  }

  private order(a: number, b: number): number {
    const s = this.s;
    return s.data[(a) * LABEL_STRIDE + LabelField.Fidelity] - s.data[(b) * LABEL_STRIDE + LabelField.Fidelity] || s.data[(a) * LABEL_STRIDE + LabelField.Continuity] - s.data[(b) * LABEL_STRIDE + LabelField.Continuity] || s.data[(a) * LABEL_STRIDE + LabelField.Tokens] - s.data[(b) * LABEL_STRIDE + LabelField.Tokens] ||
      (this.cacheRelevant ? s.data[(b) * LABEL_STRIDE + LabelField.Extension] - s.data[(a) * LABEL_STRIDE + LabelField.Extension] : 0) ||
      this.signature(a).localeCompare(this.signature(b));
  }

  /** Only full metric ties need a frontier. The cursor of a broken cache
   * prefix is no longer priced and must not decide which layout survives. */
  private signature(id: number): string {
    let value = this.signatures.get(id);
    if (value !== undefined) return value;
    const frontier = new Map<string, number>();
    this.s.traces.reference(this.s.finishTrace(id)).forEachAssignment((ids, level) => {
      for (const leafId of ids) frontier.set(leafId, level);
    });
    value = frontierSignature(frontier, this.leafIds);
    this.signatures.set(id, value);
    return value;
  }

  private dominates(a: number, b: number): boolean {
    const s = this.s;
    return (!this.cacheRelevant || s.data[(a) * LABEL_STRIDE + LabelField.Extension] >= s.data[(b) * LABEL_STRIDE + LabelField.Extension]) && s.data[(a) * LABEL_STRIDE + LabelField.Tokens] <= s.data[(b) * LABEL_STRIDE + LabelField.Tokens] &&
      s.data[(a) * LABEL_STRIDE + LabelField.Continuity] <= s.data[(b) * LABEL_STRIDE + LabelField.Continuity] && s.data[(a) * LABEL_STRIDE + LabelField.Fidelity] <= s.data[(b) * LABEL_STRIDE + LabelField.Fidelity] &&
      (s.data[(a) * LABEL_STRIDE + LabelField.Tokens] < s.data[(b) * LABEL_STRIDE + LabelField.Tokens] || s.data[(a) * LABEL_STRIDE + LabelField.Continuity] < s.data[(b) * LABEL_STRIDE + LabelField.Continuity] || s.data[(a) * LABEL_STRIDE + LabelField.Fidelity] < s.data[(b) * LABEL_STRIDE + LabelField.Fidelity] ||
        (this.cacheRelevant && s.data[(a) * LABEL_STRIDE + LabelField.Extension] > s.data[(b) * LABEL_STRIDE + LabelField.Extension]));
  }

  private prune(incoming: number[]): number[] {
    const s = this.s, b = this.buckets;
    this.states++;
    this.signatures.clear();
    b.begin(incoming.length);
    const grid = this.kBucket > 0 && this.fBucket > 0;
    for (let pos = 0; pos < incoming.length; pos++) {
      const id = incoming[pos];
      if (s.data[(id) * LABEL_STRIDE + LabelField.Tokens] > this.options.maxTokens) { s.release(id); continue; }
      const group = b.group(this.key(id));
      b.next[pos] = b.head[group]; b.head[group] = pos;
      if (b.size[group]++ === 0) b.fidelity[group] = b.continuity[group] = b.tokens[group] = b.extension[group] = id;
      else if (grid) {
        if (this.order(id, b.fidelity[group]) < 0) b.fidelity[group] = id;
        if ((s.data[(id) * LABEL_STRIDE + LabelField.Continuity] - s.data[(b.continuity[group]) * LABEL_STRIDE + LabelField.Continuity] || this.order(id, b.continuity[group])) < 0) b.continuity[group] = id;
        if ((s.data[(id) * LABEL_STRIDE + LabelField.Tokens] - s.data[(b.tokens[group]) * LABEL_STRIDE + LabelField.Tokens] || this.order(id, b.tokens[group])) < 0) b.tokens[group] = id;
        if (this.cacheRelevant && (s.data[(b.extension[group]) * LABEL_STRIDE + LabelField.Extension] - s.data[(id) * LABEL_STRIDE + LabelField.Extension] || this.order(id, b.extension[group])) < 0) b.extension[group] = id;
      }
    }
    const result: number[] = [];
    for (let group = 0; group < b.count; group++) {
      if (b.size[group] === 1) { result.push(incoming[b.head[group]]); continue; }
      const kept = this.representatives; kept.length = 0;
      if (grid) {
        const f = b.fidelity[group], k = b.continuity[group], t = b.tokens[group], e = b.extension[group];
        kept.push(f);
        if (k !== f) kept.push(k);
        if (t !== f && t !== k) kept.push(t);
        if (this.cacheRelevant && e !== f && e !== k && e !== t) kept.push(e);
      } else {
        const pool = this.members; pool.length = 0;
        for (let pos = b.head[group]; pos >= 0; pos = b.next[pos]) pool.push(incoming[pos]);
        pool.reverse();
        for (const id of pool) if (!pool.some((other) => other !== id && this.dominates(other, id))) kept.push(id);
      }
      if (this.errorScratch.length < kept.length * 4) this.errorScratch = new Float64Array(kept.length * 8);
      const errors = this.errorScratch;
      for (let i = 0; i < kept.length; i++) {
        const id = kept[i];
        errors[i * 4] = s.data[(id) * LABEL_STRIDE + LabelField.TokenError]; errors[i * 4 + 1] = s.data[(id) * LABEL_STRIDE + LabelField.ContinuityError];
        errors[i * 4 + 2] = s.data[(id) * LABEL_STRIDE + LabelField.FidelityError]; errors[i * 4 + 3] = s.data[(id) * LABEL_STRIDE + LabelField.CacheError];
      }
      // Read every original envelope before writing any representative. The
      // max reductions are order-independent; ties still use F/K/T/E order.
      for (let pos = b.head[group]; pos >= 0; pos = b.next[pos]) {
        const source = incoming[pos];
        let chosen = 0, best = Infinity;
        for (let i = 0; i < kept.length; i++) {
          const target = kept[i];
          const cost = Math.abs(s.data[(target) * LABEL_STRIDE + LabelField.Tokens] - s.data[(source) * LABEL_STRIDE + LabelField.Tokens]) +
            Math.max(0, s.data[(target) * LABEL_STRIDE + LabelField.Continuity] - s.data[(source) * LABEL_STRIDE + LabelField.Continuity]) +
            Math.max(0, s.data[(target) * LABEL_STRIDE + LabelField.Fidelity] - s.data[(source) * LABEL_STRIDE + LabelField.Fidelity]) +
            (this.cacheRelevant ? Math.max(0, s.data[(source) * LABEL_STRIDE + LabelField.Extension] - s.data[(target) * LABEL_STRIDE + LabelField.Extension]) : 0);
          if (cost < best) { best = cost; chosen = i; }
        }
        const target = kept[chosen], at = chosen * 4;
        errors[at] = Math.max(errors[at], s.data[(source) * LABEL_STRIDE + LabelField.TokenError] + Math.abs(s.data[(target) * LABEL_STRIDE + LabelField.Tokens] - s.data[(source) * LABEL_STRIDE + LabelField.Tokens]));
        errors[at + 1] = Math.max(errors[at + 1], s.data[(source) * LABEL_STRIDE + LabelField.ContinuityError] + Math.max(0, s.data[(target) * LABEL_STRIDE + LabelField.Continuity] - s.data[(source) * LABEL_STRIDE + LabelField.Continuity]));
        errors[at + 2] = Math.max(errors[at + 2], s.data[(source) * LABEL_STRIDE + LabelField.FidelityError] + Math.max(0, s.data[(target) * LABEL_STRIDE + LabelField.Fidelity] - s.data[(source) * LABEL_STRIDE + LabelField.Fidelity]));
        if (this.cacheRelevant) errors[at + 3] = Math.max(errors[at + 3], s.data[(source) * LABEL_STRIDE + LabelField.CacheError] + Math.max(0, s.data[(source) * LABEL_STRIDE + LabelField.Extension] - s.data[(target) * LABEL_STRIDE + LabelField.Extension]));
      }
      for (let i = 0; i < kept.length; i++) {
        const id = kept[i];
        s.data[(id) * LABEL_STRIDE + LabelField.TokenError] = errors[i * 4]; s.data[(id) * LABEL_STRIDE + LabelField.ContinuityError] = errors[i * 4 + 1];
        s.data[(id) * LABEL_STRIDE + LabelField.FidelityError] = errors[i * 4 + 2]; s.data[(id) * LABEL_STRIDE + LabelField.CacheError] = errors[i * 4 + 3];
        result.push(id);
      }
      for (let pos = b.head[group]; pos >= 0; pos = b.next[pos]) if (!kept.includes(incoming[pos])) s.release(incoming[pos]);
      this.dominated += b.size[group] - kept.length;
    }
    this.created += result.length;
    this.maximum = Math.max(this.maximum, result.length);
    const ceiling = this.options.labelCeiling ?? 1_000_000;
    if (result.length > ceiling) throw new SparseLabelCeilingError(ceiling, result.length);
    if (this.states % 1000 === 0) this.progress('propagate', result.length);
    return result;
  }

  private progress(phase: string, labels: number): void {
    this.options.onProgress?.({ phase, labels, states: this.states, elapsedMs: performance.now() - this.started });
  }

  private emit(id: number, kind: 'head' | 'raw' | 'recall' | 'tail', key: string,
    tokens: number, extension: boolean, sequence = 0): void {
    const s = this.s;
    s.data[(id) * LABEL_STRIDE + LabelField.Tokens] += tokens;
    if (extension) s.data[(id) * LABEL_STRIDE + LabelField.Extension] += tokens;
    if (this.buffered && s.data[(id) * LABEL_STRIDE + LabelField.Intact] && (kind === 'raw' || kind === 'recall')) {
      s.pending[id] = [...s.pending[id], { kind, key, tokens, sequence }]; return;
    }
    if (s.data[(id) * LABEL_STRIDE + LabelField.Intact]) {
      const previous = this.options.cache?.layout.units[s.data[(id) * LABEL_STRIDE + LabelField.Matched]];
      if (previous?.kind === kind && previous.key === key) {
        s.data[(id) * LABEL_STRIDE + LabelField.Matched]++;
        const marker = this.markers.get(s.data[(id) * LABEL_STRIDE + LabelField.Matched]);
        if (marker !== undefined) { s.data[(id) * LABEL_STRIDE + LabelField.CachedTokens] = marker; s.data[(id) * LABEL_STRIDE + LabelField.CachedUnits] = s.data[(id) * LABEL_STRIDE + LabelField.Matched]; }
      } else s.data[(id) * LABEL_STRIDE + LabelField.Intact] = 0;
    }
  }

  private flush(id: number, before: number): void {
    const s = this.s;
    if (!this.buffered || !s.data[(id) * LABEL_STRIDE + LabelField.Intact] || s.pending[id].length === 0) return;
    const ordered = [...s.pending[id]].sort((a, b) => a.sequence - b.sequence || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
    let consumed = 0;
    while (consumed < ordered.length && ordered[consumed].sequence < before) {
      const emission = ordered[consumed++];
      const previous = this.options.cache?.layout.units[s.data[(id) * LABEL_STRIDE + LabelField.Matched]];
      if (previous?.kind === emission.kind && previous.key === emission.key) {
        s.data[(id) * LABEL_STRIDE + LabelField.Matched]++;
        const marker = this.markers.get(s.data[(id) * LABEL_STRIDE + LabelField.Matched]);
        if (marker !== undefined) { s.data[(id) * LABEL_STRIDE + LabelField.CachedTokens] = marker; s.data[(id) * LABEL_STRIDE + LabelField.CachedUnits] = s.data[(id) * LABEL_STRIDE + LabelField.Matched]; }
      } else { s.data[(id) * LABEL_STRIDE + LabelField.Intact] = 0; s.pending[id] = []; return; }
    }
    s.pending[id] = ordered.slice(consumed);
  }

  private action(ids: readonly string[], level: number, summaryId?: string): Action {
    let fidelity = 0, continuity = 0, tokens = 0, extension = 0, sequence = Infinity;
    const presentation = this.options.presentation;
    for (const id of ids) {
      const chunk = this.chunks.get(id)!;
      sequence = Math.min(sequence, chunk.sequence);
      if (level > 0) fidelity += fidelityLeafLoss(chunk, level, this.newest, this.policy);
      continuity += continuityLeafLoss(chunk, level, level === 0 ? `raw:${id}` : `summary:${summaryId}`,
        presentation?.leaves.get(id), presentation?.currentSeq ?? 0, this.age.get(id)!, this.policy);
      if (level === 0) {
        tokens += chunk.rawTokens;
        if (presentation && !presentation.leaves.has(id)) extension += chunk.rawTokens;
      }
    }
    if (summaryId) {
      const summary = this.forest.summary(summaryId)!;
      tokens = summary.recallTokens;
      if (presentation && summary.leafIds.length > 0 && summary.leafIds.every((id) => !presentation.leaves.has(id))) extension = tokens;
    }
    return { trace: ids.length ? this.s.traces.action(ids, level) : 0, ids, level, fidelity, continuity, tokens, extension, key: summaryId, sequence };
  }

  private apply(id: number, action: Action): void {
    const s = this.s;
    if (!action.trace) return;
    s.assign(id, action.trace, action.fidelity, action.continuity);
    if (!s.data[(id) * LABEL_STRIDE + LabelField.Intact]) { s.data[(id) * LABEL_STRIDE + LabelField.Tokens] += action.tokens; s.data[(id) * LABEL_STRIDE + LabelField.Extension] += action.extension; return; }
    if (action.key) this.emit(id, 'recall', action.key, action.tokens, action.extension > 0, action.sequence);
    else for (const leafId of action.ids) {
      const leaf = this.forest.leaf(leafId)!;
      this.emit(id, 'raw', leafId, leaf.rawTokens,
        this.options.presentation !== undefined && !this.options.presentation.leaves.has(leafId), leaf.sequence);
    }
  }

  private children(summaryId: string, incoming: number[], active: ReadonlySet<string> | undefined, limit: number): number[] {
    const summary = this.forest.summary(summaryId)!;
    const children = [
      ...summary.directLeafIds.map((id) => ({ kind: 'leaf' as const, id, sequence: this.forest.leaf(id)!.sequence })),
      ...summary.childSummaryIds.map((id) => ({ kind: 'summary' as const, id, sequence: this.forest.summary(id)!.firstSequence })),
    ].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)).filter((child) => !active ||
      (child.kind === 'leaf' ? active.has(child.id) : this.forest.summary(child.id)!.leafIds.some((id) => active.has(id))));
    let labels = incoming;
    for (let at = 0; at < children.length;) {
      const child = children[at];
      if (this.cacheRelevant && this.buffered) for (const id of labels) this.flush(id, Math.min(child.sequence, limit));
      if (child.kind === 'summary') {
        labels = this.summary(child.id, labels, active, Math.min(limit, children[at + 1]?.sequence ?? Infinity));
        at++; continue;
      }
      const ids: string[] = [];
      while (at < children.length && children[at].kind === 'leaf') {
        const id = children[at++].id;
        if (!this.forest.leaf(id)!.externallyAccounted) ids.push(id);
      }
      if (ids.some((id) => !this.forest.leaf(id)!.allowedLevels.includes(0))) {
        for (const id of labels) this.s.release(id);
        labels = [];
      } else {
        const action = this.action(ids, 0);
        for (const id of labels) this.apply(id, action);
      }
      labels = this.prune(labels);
    }
    return labels;
  }

  private summary(summaryId: string, incoming: number[], active: ReadonlySet<string> | undefined, limit: number): number[] {
    this.expanded += incoming.length;
    const summary = this.forest.summary(summaryId)!;
    const live = summary.leafIds.filter((id) => (!active || active.has(id)) && !this.forest.leaf(id)!.externallyAccounted);
    const participants = live.filter((id) => this.forest.leaf(id)!.allowedLevels.includes(summary.level));
    const holes = live.filter((id) => !this.forest.leaf(id)!.allowedLevels.includes(summary.level));
    let selected: number[] = [];
    if (participants.length) {
      const action = this.action(participants, summary.level, summaryId);
      selected = incoming.map((id) => { const copy = this.s.clone(id); this.apply(copy, action); return copy; });
      if (holes.length) selected = this.children(summaryId, selected, new Set(holes), limit);
    }
    const expanded = this.children(summaryId, incoming, active, limit);
    return this.prune(selected.concat(expanded));
  }

  solve(): ParetoPolicySolveResult {
    const feasibility = this.knownFeasibility;
    const s = this.s;
    const initial = s.initial(this.cacheRelevant, this.leaves.filter((leaf) => leaf.externallyAccounted).map((leaf) => leaf.id));
    if (this.inputs.headTokens > 0) this.emit(initial, 'head', 'head', this.inputs.headTokens, false);
    let labels = [initial];
    for (let at = 0; at < this.forest.roots.length; at++) {
      const root = this.forest.roots[at];
      if (this.cacheRelevant && this.buffered) for (const id of labels) this.flush(id, root.firstSequence);
      if (root.kind === 'summary') labels = this.summary(root.id, labels, undefined, this.forest.roots[at + 1]?.firstSequence ?? Infinity);
      else {
        const leaf = this.forest.leaf(root.id)!;
        if (!leaf.externallyAccounted) {
          const action = this.action([leaf.id], 0);
          for (const id of labels) this.apply(id, action);
        }
        labels = this.prune(labels);
      }
    }
    this.progress('propagated', labels.length);
    const evaluator = new TerminalPolicyEvaluator(this.inputs, this.forest, this.options);
    const terminal: Array<{ trace: FrontierTraceReference; tokens: number }> = [];
    const error: ApproximationEnvelope = { token: 0, continuity: 0, fidelity: 0, cache: 0 };
    for (const id of labels) {
      error.token = Math.max(error.token, s.data[(id) * LABEL_STRIDE + LabelField.TokenError]); error.continuity = Math.max(error.continuity, s.data[(id) * LABEL_STRIDE + LabelField.ContinuityError]);
      error.fidelity = Math.max(error.fidelity, s.data[(id) * LABEL_STRIDE + LabelField.FidelityError]); error.cache = Math.max(error.cache, s.data[(id) * LABEL_STRIDE + LabelField.CacheError]);
      this.flush(id, Infinity);
      if (this.inputs.tailTokens > 0) this.emit(id, 'tail', 'tail', this.inputs.tailTokens, false);
      if (s.data[(id) * LABEL_STRIDE + LabelField.Tokens] <= this.options.maxTokens) terminal.push({
        trace: s.traces.reference(s.finishTrace(id)), tokens: s.data[(id) * LABEL_STRIDE + LabelField.Tokens],
      });
      s.release(id);
    }
    const roundoff = 32 * Number.EPSILON * this.leaves.length * Math.max(1, this.options.maxTokens);
    if (!terminal.some((candidate) => {
      if (Math.abs(candidate.tokens - feasibility.floorTokens) > roundoff) return false;
      const prepared = evaluator.candidate(candidate.trace, candidate.tokens);
      return [...feasibility.frontier].every(([id, level]) => prepared.frontier.get(id) === level);
    })) {
      const byLevel = new Map<number, string[]>();
      for (const [id, level] of feasibility.frontier) { const ids = byLevel.get(level); if (ids) ids.push(id); else byLevel.set(level, [id]); }
      let trace = 0;
      for (const [level, ids] of byLevel) trace = s.traces.append(trace, s.traces.action(ids, level));
      terminal.push({ trace: s.traces.reference(trace), tokens: feasibility.floorTokens });
    }
    const stats = {
      statesVisited: this.states, candidatesGenerated: this.created, maxCandidatesAtState: this.maximum, terminalCandidates: terminal.length,
    };
    const full = this.options.terminalEvaluation === 'full';
    const candidates = full ? terminal.map((candidate) => evaluator.candidate(candidate.trace, candidate.tokens)) : undefined;
    const bounded = full ? undefined : terminal.map((candidate) => evaluator.estimate(candidate.trace, candidate.tokens));
    this.progress('evaluated', terminal.length);
    const result = full
      ? new ExactKvUnifiedPolicySolver(this.inputs, this.forest).scorePreparedCandidates(candidates!, this.options, stats, this.cacheRelevant)
      : scoreBoundedCandidates(bounded!, this.options, stats, this.cacheRelevant, evaluator.orderedLeafIds);
    this.progress('scored', terminal.length);
    const propagation = {
      labelsCreated: this.created, labelsExpanded: this.expanded, labelsDominated: this.dominated,
      states: this.states, maxLabelsPerState: this.maximum, terminalLabels: terminal.length,
      tokenBucketSize: this.tBucket, continuityBucketSize: this.kBucket, fidelityBucketSize: this.fBucket,
      approximationBounded: true, approximationScoreErrorBound: this.approximationBound(error),
      approximationTokenErrorBound: error.token, approximationContinuityErrorBound: error.continuity,
      approximationFidelityErrorBound: error.fidelity, approximationCacheErrorBound: error.cache,
      storageMode: 'packed' as const, packedLabelSlots: s.slots, packedTraceNodes: s.traces.nodes,
      terminalEvaluationMode: full ? 'full' as const : 'selective' as const,
      exactTerminalEvaluations: evaluator.exactEvaluations,
    };
    // Do not spread result: its candidate-list getter deliberately performs
    // the remaining exact work only when an observer requests that list.
    return {
      feasible: true, selected: result.selected, cacheFloor: result.cacheFloor,
      continuityFloor: result.continuityFloor, cacheRelevant: result.cacheRelevant,
      enumeration: result.enumeration, propagation,
      get candidates() { return result.candidates; },
    };
  }
}
