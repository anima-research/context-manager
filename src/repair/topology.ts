/**
 * General-purpose repair planner for crossed summary ownership.
 *
 * A summary is crossed when its leaves are not contiguous among owned
 * messages (chunk-record members ∪ chunk-linked L1 sources) in store order:
 * another live representation sits inside its span. The load-time audit
 * (`topologyPolicy`) refuses such a store. Known causes: issue #122 (the head
 * ratchet minted late L1s over opening messages that merged with the
 * frontier by chunk-record order), issue #95 (demand-path merges folded across
 * an unlanded neighbour), restore/branch interleavings, hand surgery.
 *
 * The plan is structural and regenerates nothing:
 * - level ≥ 2: the summary keeps the run of children carrying the most
 *   leaves and detaches the rest (`lossless`, the default: fragments become
 *   roots and keep their prose; an ancestor left with a hole is repaired the
 *   same way on the next pass, so the pyramid unravels around the fragment).
 *   In `compact` mode a summary whose holes are owned, one level down, by
 *   roots adopts them instead (the #95 shape), and detached fragments are
 *   re-homed under an adjacent summary at the same level; the pyramid keeps
 *   its depth, but the adopting prose never covered the moved content.
 *   Regenerating the affected merges with the summarizer is the path that is
 *   both compact and faithful; this planner does not make model calls.
 * - level 1: the L1 keeps its largest contiguous run; the other messages are
 *   released from it and its chunk record, so the chunker re-owns them.
 * - a parent left with fewer than two sources is dissolved (its child becomes
 *   a root; the grandparent shrinks and may dissolve in turn).
 * - touched ancestors get their `sourceRange` recomputed; kv-stable
 *   resolutions deeper than the leaf's remaining chain are clamped.
 * - `releaseHead`: detached L1s (and uncompressed records) that form a prefix
 *   of the store's owned messages are removed with their records, so the head
 *   window takes those messages back verbatim (CM ≥ #123 anchors the head to
 *   coverage; the extension is bounded at 2× `headWindowTokens`).
 *
 * Pure: takes and returns plain state; the caller writes it.
 */

export interface RepairSummary {
  id: string;
  level: number;
  sourceLevel?: number;
  sourceIds: string[];
  sourceRange: { first: string; last: string };
  mergedInto?: string;
  parentId?: string;
  [key: string]: unknown;
}
export interface RepairRecord {
  id: string;
  sourceIds: string[];
  compressed: boolean;
  summaryId?: string;
  [key: string]: unknown;
}
export interface RepairInputs {
  summaries: RepairSummary[];
  records: RepairRecord[];
  /** Store listing in store order (ids only are used). */
  messages: ReadonlyArray<{ id: string }>;
  resolutions?: Record<string, number> | null;
}
export interface RepairOptions {
  /** Remove detached opening L1s / uncompressed prefix records so the head takes the messages back. */
  releaseHead?: boolean;
  /**
   * `lossless` (default): only detach; fragments become roots and keep their
   * prose, but every ancestor whose span they sit inside is detached in turn
   * (the pyramid unravels there — more tokens until the merge ladder folds
   * it again; `depthLostLeaves` counts the leaves that lose a fold level).
   * `compact`: also adopt unparented hole owners and re-home fragments under
   * adjacent summaries, which keeps the pyramid's depth at the price of
   * prose that does not cover the moved content (`proseGapLeaves`).
   */
  mode?: 'lossless' | 'compact';
  maxIterations?: number;
}
export interface Crossed {
  id: string;
  level: number;
  leafCount: number;
  holes: number;
  span: { first: string; last: string };
}
export interface RepairPlan {
  iterations: number;
  before: Crossed[];
  /** Roots taken into a crossed summary whose hole they owned (prose does not cover them). */
  adopted: Array<{ id: string; level: number; into: string; leaves: number }>;
  detached: Array<{ id: string; level: number; from: string; leaves: number }>;
  /** Detached fragments placed under an adjacent sibling so no ancestor is left with a hole. */
  rehomed: Array<{ id: string; from: string; into: string; leaves: number }>;
  splitL1: Array<{ id: string; kept: number; released: string[] }>;
  dissolved: Array<{ id: string; level: number; child: string }>;
  released: Array<{ record: string; summaryId?: string; leaves: string[] }>;
  rangeChanges: Array<{ id: string; from: { first: string; last: string }; to: { first: string; last: string } }>;
  resolutionsClamped: number;
  resolutionsCleared: number;
  /** Leaves now under a summary whose prose never covered them (adopted + re-homed). */
  proseGapLeaves: number;
  /** Leaves whose deepest available fold level dropped (ancestors unravelled). */
  depthLostLeaves: number;
  /** Crossed summaries the plan could not resolve (empty on success). */
  remaining: Crossed[];
  result: { summaries: RepairSummary[]; records: RepairRecord[]; resolutions: Record<string, number> };
}

interface View {
  byId: Map<string, RepairSummary>;
  liveL1: Set<string>;
  position: Map<string, number>;
  byPosition: string[];
  leaves: (s: RepairSummary) => string[];
}

const parentOf = (s: RepairSummary): string | undefined => s.mergedInto ?? s.parentId;
const setParent = (s: RepairSummary, id: string | undefined): void => {
  if (id === undefined) { delete s.mergedInto; delete s.parentId; return; }
  if ('parentId' in s && s.mergedInto === undefined) s.parentId = id; else s.mergedInto = id;
};

function view(summaries: RepairSummary[], records: RepairRecord[], storeOrder: Map<string, number>): View {
  const byId = new Map(summaries.map((s) => [s.id, s] as const));
  const liveL1 = new Set<string>();
  for (const r of records) if (r.summaryId && byId.has(r.summaryId)) liveL1.add(r.summaryId);
  if (liveL1.size === 0) for (const s of summaries) if (s.level === 1) liveL1.add(s.id);
  const owned = new Set<string>();
  for (const r of records) for (const id of r.sourceIds) owned.add(id);
  for (const id of liveL1) for (const leaf of byId.get(id)!.sourceIds) owned.add(leaf);
  const ordered = [...owned].filter((id) => storeOrder.has(id)).sort((a, b) => storeOrder.get(a)! - storeOrder.get(b)!);
  const position = new Map(ordered.map((id, i) => [id, i] as const));
  const cache = new Map<string, string[]>();
  const leaves = (s: RepairSummary): string[] => {
    const hit = cache.get(s.id);
    if (hit) return hit;
    let out: string[];
    if (s.level === 1) out = liveL1.has(s.id) ? [...s.sourceIds] : [];
    else {
      out = [];
      for (const childId of s.sourceIds) { const c = byId.get(childId); if (c && c.id !== s.id) out.push(...leaves(c)); }
    }
    cache.set(s.id, out);
    return out;
  };
  return { byId, liveL1, position, byPosition: ordered, leaves };
}

function positions(v: View, s: RepairSummary): number[] {
  const out: number[] = [];
  for (const id of v.leaves(s)) { const p = v.position.get(id); if (p !== undefined) out.push(p); }
  return [...new Set(out)].sort((a, b) => a - b);
}

function crossedOf(v: View, summaries: RepairSummary[]): Crossed[] {
  const out: Crossed[] = [];
  for (const s of summaries) {
    const ps = positions(v, s);
    if (ps.length < 2) continue;
    const holes = ps[ps.length - 1] - ps[0] + 1 - ps.length;
    if (holes > 0) out.push({ id: s.id, level: s.level, leafCount: ps.length, holes, span: { first: v.byPosition[ps[0]], last: v.byPosition[ps[ps.length - 1]] } });
  }
  return out;
}

/** Split sorted positions into maximal runs of consecutive integers. */
function runsOf(ps: number[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  for (const p of ps) {
    if (run.length && p !== run[run.length - 1] + 1) { runs.push(run); run = []; }
    run.push(p);
  }
  if (run.length) runs.push(run);
  return runs;
}

export function planTopologyRepair(inputs: RepairInputs, options: RepairOptions = {}): RepairPlan {
  const summaries: RepairSummary[] = structuredClone(inputs.summaries);
  let records: RepairRecord[] = structuredClone(inputs.records);
  const resolutions: Record<string, number> = { ...(inputs.resolutions ?? {}) };
  const storeOrder = new Map(inputs.messages.map((m, i) => [String(m.id), i] as const));
  const plan: RepairPlan = {
    iterations: 0, before: [], adopted: [], detached: [], rehomed: [], splitL1: [], dissolved: [], released: [], rangeChanges: [],
    resolutionsClamped: 0, resolutionsCleared: 0, proseGapLeaves: 0, depthLostLeaves: 0, remaining: [], result: { summaries, records, resolutions },
  };
  const depthBefore = leafDepths(view(inputs.summaries as RepairSummary[], inputs.records as RepairRecord[], storeOrder));
  const originalRange = new Map(summaries.map((s) => [s.id, { ...s.sourceRange }] as const));
  const touched = new Set<string>();
  const detachedIds = new Set<string>();
  const compact = (options.mode ?? 'lossless') === 'compact';
  const maxIterations = options.maxIterations ?? 32;

  let v = view(summaries, records, storeOrder);
  plan.before = crossedOf(v, summaries);
  const alive = (): RepairSummary[] => summaries.filter((s) => v.byId.has(s.id));
  const remove = (id: string): void => {
    const at = summaries.findIndex((x) => x.id === id);
    if (at >= 0) summaries.splice(at, 1);
    v.byId.delete(id);
  };
  /** For every owned position, the summary that owns it at each level (via the live L1's chain). */
  const ownerAtLevel = (): Map<number, Map<number, string>> => {
    const out = new Map<number, Map<number, string>>();
    for (const l1Id of v.liveL1) {
      const chain: RepairSummary[] = [];
      let cur = v.byId.get(l1Id); const trail = new Set<string>();
      while (cur && !trail.has(cur.id)) { trail.add(cur.id); chain.push(cur); const p = parentOf(cur); cur = p ? v.byId.get(p) : undefined; }
      for (const leaf of v.byId.get(l1Id)!.sourceIds) {
        const p = v.position.get(leaf);
        if (p === undefined) continue;
        for (const a of chain) { let m = out.get(a.level); if (!m) { m = new Map(); out.set(a.level, m); } m.set(p, a.id); }
      }
    }
    return out;
  };
  const insertChild = (parent: RepairSummary, childId: string): void => {
    parent.sourceIds.push(childId);
    const child = v.byId.get(childId)!;
    setParent(child, parent.id);
    const key = (id: string): number => { const c = v.byId.get(id); const ps = c ? positions(v, c) : []; return ps.length ? ps[0] : Number.MAX_SAFE_INTEGER; };
    parent.sourceIds.sort((a, b) => key(a) - key(b));
    touched.add(parent.id);
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    v = view(summaries, records, storeOrder);
    const crossed = crossedOf(v, alive());
    if (crossed.length === 0) break;
    plan.iterations = iteration;
    const level = Math.min(...crossed.map((c) => c.level));
    for (const c of crossed.filter((x) => x.level === level)) {
      v = view(summaries, records, storeOrder);
      const s = v.byId.get(c.id);
      if (!s) continue;
      const ps = positions(v, s);
      if (ps.length < 2 || ps[ps.length - 1] - ps[0] + 1 === ps.length) continue; // fixed by an earlier move this pass
      if (level === 1) {
        // Keep the largest contiguous run of messages; release the rest.
        const runs = runsOf(ps).sort((a, b) => b.length - a.length || a[0] - b[0]);
        const keep = new Set(runs[0].map((p) => v.byPosition[p]));
        const released = s.sourceIds.filter((id) => v.position.has(id) && !keep.has(id));
        s.sourceIds = s.sourceIds.filter((id) => !released.includes(id));
        for (const r of records) if (r.summaryId === s.id) r.sourceIds = r.sourceIds.filter((id) => !released.includes(id));
        for (const id of released) if (id in resolutions) { delete resolutions[id]; plan.resolutionsCleared++; }
        plan.splitL1.push({ id: s.id, kept: s.sourceIds.length, released });
        touched.add(s.id);
        continue;
      }
      // Children grouped into runs by their leaf spans; the run carrying the
      // most leaves stays, the others are fragments.
      const spans = s.sourceIds.map((childId) => {
        const child = v.byId.get(childId);
        const cps = child ? positions(v, child) : [];
        return { childId, min: cps[0], max: cps[cps.length - 1], count: cps.length };
      });
      const placed = spans.filter((x) => x.count > 0).sort((a, b) => a.min - b.min);
      const groups: Array<typeof placed> = [];
      let group: typeof placed = [];
      let end = -Infinity;
      for (const x of placed) {
        if (group.length && x.min !== end + 1) { groups.push(group); group = []; }
        group.push(x);
        end = Math.max(end, x.max);
      }
      if (group.length) groups.push(group);
      groups.sort((a, b) => b.reduce((n, x) => n + x.count, 0) - a.reduce((n, x) => n + x.count, 0) || a[0].min - b[0].min);
      const keep = new Set(groups[0].map((x) => x.childId));
      const fragments = placed.filter((x) => !keep.has(x.childId));
      const fragmentLeaves = fragments.reduce((n, x) => n + x.count, 0);
      const homeFor = (x: { min: number; max: number }, exclude: Set<string>): RepairSummary | undefined => {
        let best: RepairSummary | undefined;
        const grand = parentOf(s);
        for (const t of alive()) {
          if (t.level !== level || exclude.has(t.id)) continue;
          const tp = positions(v, t);
          if (tp.length === 0) continue;
          if (tp[tp.length - 1] + 1 !== x.min && x.max + 1 !== tp[0]) continue;
          if (!best || (grand !== undefined && parentOf(t) === grand && parentOf(best) !== grand)) best = t;
        }
        return best;
      };
      // Adoption: every hole is owned, one level down, by a root that is not
      // under this summary. The pyramid keeps its depth; the adopting
      // summary's prose does not cover the adopted content. Re-homing a
      // fragment costs the same kind of gap at its new home, so the two are
      // compared by leaves moved — unless some fragment has no home, in which
      // case detaching would unravel every ancestor and adoption wins.
      if (compact) {
        const owners = ownerAtLevel().get(level - 1) ?? new Map<number, string>();
        const have = new Set(ps);
        const candidates = new Set<string>();
        let adoptable = true;
        for (let p = ps[0]; p <= ps[ps.length - 1]; p++) {
          if (have.has(p)) continue;
          const owner = owners.get(p);
          const o = owner ? v.byId.get(owner) : undefined;
          if (!o || parentOf(o) !== undefined || o.id === s.id) { adoptable = false; break; }
          candidates.add(o.id);
        }
        if (adoptable && candidates.size > 0) {
          let adoptedLeaves = 0;
          for (const id of candidates) adoptedLeaves += positions(v, v.byId.get(id)!).length;
          const exclude = new Set([s.id]);
          const allHomeable = fragments.every((x) => homeFor(x, exclude) !== undefined);
          if (adoptedLeaves <= fragmentLeaves || !allHomeable) {
            for (const id of candidates) {
              const o = v.byId.get(id)!;
              insertChild(s, id);
              plan.adopted.push({ id, level: o.level, into: s.id, leaves: positions(v, o).length });
            }
            continue;
          }
        }
      }
      // Detach the fragments, then re-home each under an adjacent summary at
      // this level (preferring the same parent), repeating while progress is
      // made: a fragment becomes homeable once its neighbour fragment is.
      for (const x of fragments) {
        const child = v.byId.get(x.childId)!;
        s.sourceIds = s.sourceIds.filter((id) => id !== x.childId);
        setParent(child, undefined);
        detachedIds.add(child.id);
        plan.detached.push({ id: child.id, level: child.level, from: s.id, leaves: x.count });
      }
      touched.add(s.id);
      let pending = compact ? [...fragments] : [];
      let progress = true;
      while (pending.length && progress) {
        progress = false;
        for (const x of [...pending]) {
          v = view(summaries, records, storeOrder);
          const best = homeFor(x, new Set([s.id]));
          if (!best) continue;
          insertChild(best, x.childId);
          detachedIds.delete(x.childId);
          plan.rehomed.push({ id: x.childId, from: s.id, into: best.id, leaves: x.count });
          pending = pending.filter((y) => y !== x);
          progress = true;
        }
      }
    }
    // Dissolve parents left with a single source, upward.
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of alive()) {
        if (s.level < 2 || s.sourceIds.length >= 2) continue;
        const [childId] = s.sourceIds;
        const child = childId ? v.byId.get(childId) : undefined;
        if (child) setParent(child, undefined);
        const parent = parentOf(s);
        if (parent) {
          const p = v.byId.get(parent);
          if (p) { p.sourceIds = p.sourceIds.filter((id) => id !== s.id); touched.add(p.id); }
        }
        remove(s.id);
        plan.dissolved.push({ id: s.id, level: s.level, child: childId ?? '' });
        changed = true;
      }
    }
  }

  if (options.releaseHead) {
    // Records that form a prefix of the store's owned messages and are either
    // uncompressed or linked to an L1 this plan detached: release them, so
    // the head window takes the messages back.
    v = view(summaries, records, storeOrder);
    const recordOf = new Map<string, RepairRecord>();
    for (const r of records) for (const id of r.sourceIds) recordOf.set(id, r);
    const movedIds = new Set([...detachedIds, ...plan.rehomed.map((r) => r.id)]);
    const release = new Set<RepairRecord>();
    for (const id of v.byPosition) {
      const r = recordOf.get(id);
      if (!r) break; // an L1-only owner (legacy) ends the prefix
      const releasable = !r.compressed || (r.summaryId !== undefined && movedIds.has(r.summaryId));
      if (!releasable) break;
      release.add(r);
    }
    for (const r of release) {
      plan.released.push({ record: r.id, ...(r.summaryId ? { summaryId: r.summaryId } : {}), leaves: [...r.sourceIds] });
      for (const id of r.sourceIds) if (id in resolutions) { delete resolutions[id]; plan.resolutionsCleared++; }
      if (r.summaryId) {
        const s = v.byId.get(r.summaryId);
        const parent = s ? parentOf(s) : undefined;
        if (parent) { const p = v.byId.get(parent); if (p) { p.sourceIds = p.sourceIds.filter((id) => id !== r.summaryId); touched.add(p.id); } }
        remove(r.summaryId);
        plan.rehomed = plan.rehomed.filter((x) => x.id !== r.summaryId);
      }
    }
    records = records.filter((r) => !release.has(r));
    // A parent emptied to a single source by the release dissolves like any other.
    let changed = release.size > 0;
    while (changed) {
      changed = false;
      for (const s of alive()) {
        if (s.level < 2 || s.sourceIds.length >= 2) continue;
        const [childId] = s.sourceIds;
        const child = childId ? v.byId.get(childId) : undefined;
        if (child) setParent(child, undefined);
        const parent = parentOf(s);
        if (parent) { const p = v.byId.get(parent); if (p) { p.sourceIds = p.sourceIds.filter((id) => id !== s.id); touched.add(p.id); } }
        remove(s.id);
        plan.dissolved.push({ id: s.id, level: s.level, child: childId ?? '' });
        changed = true;
      }
    }
  }

  // Recompute sourceRange for touched summaries and their ancestors.
  v = view(summaries, records, storeOrder);
  const span = (s: RepairSummary): { first: string; last: string } | null => {
    const ps = positions(v, s);
    return ps.length ? { first: v.byPosition[ps[0]], last: v.byPosition[ps[ps.length - 1]] } : null;
  };
  const queue = [...touched];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = v.byId.get(id);
    if (!s) continue;
    const to = span(s);
    const from = originalRange.get(id) ?? s.sourceRange;
    if (to && (to.first !== from.first || to.last !== from.last)) { s.sourceRange = to; plan.rangeChanges.push({ id, from, to }); }
    const parent = parentOf(s);
    if (parent) queue.push(parent);
  }

  // Clamp kv-stable resolutions to the leaf's remaining chain depth.
  const depthOfL1 = new Map<string, number>();
  for (const id of v.liveL1) {
    let depth = 1; let cur = v.byId.get(id); const trail = new Set<string>();
    while (cur && parentOf(cur) && !trail.has(cur.id)) { trail.add(cur.id); cur = v.byId.get(parentOf(cur)!); if (cur) depth++; }
    depthOfL1.set(id, depth);
  }
  const l1OfLeaf = new Map<string, string>();
  for (const id of v.liveL1) for (const leaf of v.byId.get(id)!.sourceIds) l1OfLeaf.set(leaf, id);
  for (const [leaf, level] of Object.entries(resolutions)) {
    const l1 = l1OfLeaf.get(leaf);
    const deepest = l1 ? depthOfL1.get(l1)! : 0;
    if (typeof level === 'number' && level > deepest) { if (deepest === 0) delete resolutions[leaf]; else resolutions[leaf] = deepest; plan.resolutionsClamped++; }
  }

  v = view(summaries, records, storeOrder);
  const depthAfter = leafDepths(v);
  for (const [leaf, d] of depthBefore) { const a = depthAfter.get(leaf) ?? 0; if (a < d) plan.depthLostLeaves++; }
  plan.proseGapLeaves = plan.adopted.reduce((n, a) => n + a.leaves, 0) + plan.rehomed.reduce((n, r) => n + r.leaves, 0);
  plan.remaining = crossedOf(v, alive());
  plan.result = { summaries, records, resolutions };
  return plan;
}

/** Deepest fold level available to each owned leaf (its live L1's chain length). */
function leafDepths(v: View): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of v.liveL1) {
    let depth = 1; let cur = v.byId.get(id); const trail = new Set<string>();
    while (cur && parentOf(cur) && !trail.has(cur.id)) { trail.add(cur.id); cur = v.byId.get(parentOf(cur)!); if (cur) depth++; }
    for (const leaf of v.byId.get(id)!.sourceIds) out.set(leaf, depth);
  }
  return out;
}
