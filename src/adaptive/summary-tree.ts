/**
 * SummaryTree — a typed, structural view over the adaptive summary forest.
 *
 * Built from PickerInputs (chunks + summaries + per-summary recall-pair token
 * counts). Provides the navigation a frontier solver needs — ancestor chains,
 * recall-pair token costs, leaf coverage, root/children traversal — with NO
 * rendering or resolution state. Pure and deterministic.
 *
 * Structure mirrors the model the picker already uses:
 *  - `chunk.l1Id` + the `SummaryEntry.parentId` chain define the upward path.
 *  - `SummaryEntry.sourceLevel === 0` means `sourceIds` are leaf (message) ids;
 *    otherwise they are child summary ids.
 *  - A folded node's token cost is its recall-pair size
 *    (`recallPairTokens` ?? `SummaryEntry.tokens`) — matching
 *    the picker's `accountFrontier`.
 *
 * This is the substrate for the V2 best-fit tree-knapsack DP. See
 * `docs/best-fit-frontier-resolution.md` §3, §6, §11.
 */

import type { ChunkId, SummaryId } from './folding-strategy.js';
import type { PickerChunk, PickerInputs } from './picker.js';
import type { SummaryEntry } from '../types/strategy.js';
import { getSummaryParentId } from '../types/strategy.js';

/** A raw chunk (resolution 0) — a leaf of the summary forest. */
export interface LeafNode {
  kind: 'leaf';
  chunkId: ChunkId;
  /** Position in source order (lower = older). */
  sequence: number;
  rawTokens: number;
  /** L1 summary covering this leaf, if any. */
  l1Id?: SummaryId;
}

/** An L_k summary node covering a contiguous range of leaves. */
export interface SummaryNode {
  kind: 'summary';
  id: SummaryId;
  level: number;
  /** Rendered tokens of this node's recall pair (the cost of folding to it). */
  recallTokens: number;
  /** Immediate children: leaf chunk ids (when childrenAreLeaves) or summary ids. */
  childIds: string[];
  /** True when childIds are leaf chunk ids (sourceLevel === 0). */
  childrenAreLeaves: boolean;
  /** All covered leaf chunk ids, recursively, in source order. */
  leafChunkIds: ChunkId[];
  /** Min/max source sequence of covered leaves (−1 if none resolve). */
  firstSequence: number;
  lastSequence: number;
  sourceRange: { first: string; last: string };
  /** Parent summary id, if a higher level has been produced. */
  parentId?: SummaryId;
}

export type TreeNode = LeafNode | SummaryNode;

/** Token cost of rendering a node collapsed: raw for a leaf, recall for a summary. */
export function nodeTokens(node: TreeNode): number {
  return node.kind === 'leaf' ? node.rawTokens : node.recallTokens;
}

export class SummaryTree {
  private readonly leaves: Map<ChunkId, LeafNode> = new Map();
  private readonly nodes: Map<SummaryId, SummaryNode> = new Map();
  private readonly summaries: ReadonlyMap<SummaryId, SummaryEntry>;
  private readonly recallPairTokens: ReadonlyMap<SummaryId, number>;
  private rootCache: TreeNode[] | null = null;
  /** Source ids that no chunk or summary resolved when a node was built. A
   *  node's coverage depends on them: should one arrive later, `derive`
   *  declines instead of keeping nodes computed without it. */
  private readonly unresolved: Set<string>;
  /** The chunks this tree was built from, for `derive`. */
  private readonly sourceChunks: readonly PickerChunk[];

  constructor(inputs: PickerInputs, previous?: SummaryTree, rebuild?: readonly SummaryEntry[]) {
    this.summaries = inputs.summaries;
    this.recallPairTokens = inputs.recallPairTokens ?? new Map();
    this.sourceChunks = inputs.chunks;
    if (previous) {
      // `derive` verified what changed: share the (immutable) summary nodes
      // except the ones listed for rebuilding, and copy the leaf map,
      // patching only what moved, so the previous tree stays a coherent
      // snapshot.
      this.leaves = new Map(previous.leaves);
      this.unresolved = new Set(previous.unresolved);
      for (const c of inputs.chunks) {
        const leaf = this.leaves.get(c.id);
        if (leaf && leaf.rawTokens === c.rawTokens && leaf.sequence === c.sequence && leaf.l1Id === c.l1Id) continue;
        this.leaves.set(c.id, { kind: 'leaf', chunkId: c.id, sequence: c.sequence, rawTokens: c.rawTokens, l1Id: c.l1Id });
      }
      if (!rebuild || rebuild.length === 0) {
        this.nodes = previous.nodes;
        return;
      }
      this.nodes = new Map(previous.nodes);
      const collected = new Map<SummaryId, LeafCollection>();
      for (const s of rebuild) this.nodes.set(s.id, this.buildNode(s, collected));
      return;
    }

    this.unresolved = new Set();
    for (const c of inputs.chunks) {
      this.leaves.set(c.id, {
        kind: 'leaf',
        chunkId: c.id,
        sequence: c.sequence,
        rawTokens: c.rawTokens,
        l1Id: c.l1Id,
      });
    }
    const collected = new Map<SummaryId, LeafCollection>();
    for (const [, s] of this.summaries) {
      this.nodes.set(s.id, this.buildNode(s, collected));
    }
  }

  /**
   * Build the tree for `inputs` from `previous` when no summary changed and
   * every previous leaf is still present with the same sequence and L1 link;
   * new leaves must be ownerless. Chunk order may differ. Returns null when a
   * full build is needed.
   */
  static derive(previous: SummaryTree, inputs: PickerInputs): SummaryTree | null {
    // Entries are compared with the previous tree's own nodes: the strategy
    // updates a child's parent link on the entry object itself when an
    // upper summary arrives. A new summary, or one whose parent link
    // changed, gets a new node; any other difference is a full build.
    if (inputs.summaries.size < previous.nodes.size) return null;
    const recall = inputs.recallPairTokens ?? new Map<SummaryId, number>();
    const rebuild: SummaryEntry[] = [];
    for (const [id, s] of inputs.summaries) {
      const node = previous.nodes.get(id);
      if (!node) {
        if (previous.unresolved.has(id)) return null;
        rebuild.push(s);
        continue;
      }
      if (
        node.level !== s.level || node.childrenAreLeaves !== (s.sourceLevel === 0) ||
        node.recallTokens !== (recall.get(id) ?? s.tokens) ||
        node.sourceRange.first !== s.sourceRange.first || node.sourceRange.last !== s.sourceRange.last ||
        node.childIds.length !== s.sourceIds.length
      ) return null;
      for (let i = 0; i < s.sourceIds.length; i++) if (node.childIds[i] !== s.sourceIds[i]) return null;
      if (node.parentId !== getSummaryParentId(s)) rebuild.push(s);
    }
    if (inputs.summaries.size !== previous.nodes.size + rebuild.filter((s) => !previous.nodes.has(s.id)).length) return null;
    let matched = 0;
    for (const c of inputs.chunks) {
      const leaf = previous.leaves.get(c.id);
      if (leaf) {
        if (leaf.sequence !== c.sequence) return null;
        // A leaf may become owned (its node is replaced); losing or changing
        // an owner is a full build.
        if (leaf.l1Id !== c.l1Id && leaf.l1Id !== undefined) return null;
        matched++;
      } else if (previous.unresolved.has(c.id)) return null;
    }
    if (matched !== previous.leaves.size) return null;
    return new SummaryTree(inputs, previous, rebuild);
  }

  // ---- node access ----

  /** All leaf nodes in source order (oldest first). */
  orderedLeaves(): LeafNode[] {
    return [...this.leaves.values()].sort((a, b) => a.sequence - b.sequence);
  }

  /** All summary nodes (unordered). */
  allSummaries(): SummaryNode[] {
    return [...this.nodes.values()];
  }

  leaf(chunkId: ChunkId): LeafNode | null {
    return this.leaves.get(chunkId) ?? null;
  }

  summary(id: SummaryId): SummaryNode | null {
    return this.nodes.get(id) ?? null;
  }

  /** Recall-pair tokens for a summary, or null if unknown. */
  recallTokens(id: SummaryId): number | null {
    return this.nodes.get(id)?.recallTokens ?? null;
  }

  /** Immediate children of a summary node (leaves or sub-summaries). */
  children(node: SummaryNode): TreeNode[] {
    const out: TreeNode[] = [];
    if (node.childrenAreLeaves) {
      for (const cid of node.childIds) {
        const leaf = this.leaves.get(cid);
        if (leaf) out.push(leaf);
      }
    } else {
      for (const sid of node.childIds) {
        const sub = this.nodes.get(sid);
        if (sub) out.push(sub);
      }
    }
    return out;
  }

  /** All leaf chunk ids under a summary, in source order. */
  leavesUnder(id: SummaryId): ChunkId[] {
    return this.nodes.get(id)?.leafChunkIds ?? [];
  }

  /**
   * The L_level ancestor summary of a chunk, or null if not present. Matches
   * the picker's `accountFrontier` ancestor walk (parentId chain from l1Id).
   */
  ancestorAt(chunkId: ChunkId, level: number): SummaryNode | null {
    if (level <= 0) return null;
    const leaf = this.leaves.get(chunkId);
    if (!leaf || !leaf.l1Id) return null;
    let cur = this.nodes.get(leaf.l1Id);
    while (cur && cur.level < level) {
      if (!cur.parentId) return null;
      cur = this.nodes.get(cur.parentId);
    }
    return cur && cur.level === level ? cur : null;
  }

  /** Highest level k for which a summary covering this chunk exists (0 = none). */
  maxLevel(chunkId: ChunkId): number {
    const leaf = this.leaves.get(chunkId);
    if (!leaf || !leaf.l1Id) return 0;
    let cur = this.nodes.get(leaf.l1Id);
    let max = 0;
    while (cur) {
      max = cur.level;
      if (!cur.parentId) break;
      cur = this.nodes.get(cur.parentId);
    }
    return max;
  }

  /**
   * Forest roots over all chunks: top-level summaries (no parent present in the
   * map) plus any leaf not covered by an L1. Each leaf belongs to exactly one
   * root's subtree. Deterministically ordered by source sequence.
   */
  roots(): TreeNode[] {
    if (this.rootCache) return this.rootCache;
    const out: TreeNode[] = [];
    const covered = new Set<ChunkId>();
    for (const node of this.nodes.values()) {
      const parent = node.parentId ? this.nodes.get(node.parentId) : undefined;
      if (parent) continue; // has a real parent → not a root
      out.push(node);
      for (const lid of node.leafChunkIds) covered.add(lid);
    }
    for (const leaf of this.leaves.values()) {
      if (!covered.has(leaf.chunkId)) out.push(leaf);
    }
    out.sort((a, b) => sequenceOf(a) - sequenceOf(b));
    this.rootCache = out;
    return out;
  }

  // ---- internals ----

  private buildNode(s: SummaryEntry, collected?: Map<SummaryId, LeafCollection>): SummaryNode {
    const leaves = this.collectLeaves(s, collected);
    return {
      kind: 'summary',
      id: s.id,
      level: s.level,
      recallTokens: this.recallPairTokens.get(s.id) ?? s.tokens,
      childIds: [...s.sourceIds],
      childrenAreLeaves: s.sourceLevel === 0,
      leafChunkIds: leaves.sorted,
      firstSequence: leaves.first === Infinity ? -1 : leaves.first,
      lastSequence: leaves.last === -Infinity ? -1 : leaves.last,
      sourceRange: s.sourceRange,
      parentId: getSummaryParentId(s),
    };
  }

  /** Walk down to leaf chunk ids; sourceLevel 0 => sourceIds are leaves.
   *  Deduplicates leaves and guards against revisiting a summary, so a chunk
   *  reachable via multiple branches is counted once (real chronicles can have
   *  such overlap; double-counting breaks range/contiguity and value math).
   *
   *  DEAD IDS ARE DROPPED: sourceIds can reference chunks removed by store
   *  surgery (redaction / excision). A ghost member must not appear in
   *  leafChunkIds — downstream, groupEligible() reads a missing leaf as
   *  cap 0 and the whole group becomes permanently unraisable (one ghost
   *  vetoed 3,637 live members on mythos; specimen
   *  mythos box ~/specimens/mythos-inverted-curve-20260726). A summary's effective
   *  coverage is its LIVE sources — `children()` already applies the same
   *  filter. */
  private collectLeafIds(summary: SummaryEntry): ChunkId[] {
    return this.collectLeaves(summary).sorted;
  }

  /** The walk above, with a per-build memo (`collected`): a child summary
   *  walked earlier is replayed from its record (its live leaves in first-
   *  visit order, minus those already seen; its first/last sequence) when
   *  none of the summaries under it has been visited by this walk, which is
   *  exactly when the walk would have produced the same visit. Otherwise the
   *  child is walked as before. */
  private collectLeaves(summary: SummaryEntry, collected?: Map<SummaryId, LeafCollection>): LeafCollection {
    const kept = collected?.get(summary.id);
    if (kept) return kept;
    const visited: ChunkId[] = [];
    let first = Infinity;
    let last = -Infinity;
    const seenLeaves = new Set<ChunkId>();
    const seenSummaries = new Set<SummaryId>();
    const visit = (s: SummaryEntry): void => {
      if (seenSummaries.has(s.id)) return;
      seenSummaries.add(s.id);
      if (s.sourceLevel === 0) {
        for (const mid of s.sourceIds) {
          const leaf = this.leaves.get(mid);
          if (!leaf) { this.unresolved.add(mid); continue; } // ghost of a surgically removed chunk
          if (!seenLeaves.has(mid)) {
            seenLeaves.add(mid);
            visited.push(mid);
            if (leaf.sequence < first) first = leaf.sequence;
            if (leaf.sequence > last) last = leaf.sequence;
          }
        }
      } else {
        for (const sid of s.sourceIds) {
          const child = this.summaries.get(sid);
          if (!child) { this.unresolved.add(sid); continue; }
          const known = collected?.get(child.id);
          if (known && known.summaries.every((id) => !seenSummaries.has(id))) {
            for (const id of known.summaries) seenSummaries.add(id);
            for (const mid of known.visited) {
              if (seenLeaves.has(mid)) continue;
              seenLeaves.add(mid);
              visited.push(mid);
            }
            // A leaf skipped here was counted when it was first seen.
            if (known.first < first) first = known.first;
            if (known.last > last) last = known.last;
            continue;
          }
          visit(child);
        }
      }
    };
    visit(summary);
    // Sources usually arrive in sequence order already; a stable sort of an
    // ordered list returns it unchanged, so it is only run when needed.
    let ordered = true;
    for (let i = 1, previous = this.leaves.get(visited[0])?.sequence ?? 0; ordered && i < visited.length; i++) {
      const sequence = this.leaves.get(visited[i])?.sequence ?? 0;
      ordered = previous <= sequence;
      previous = sequence;
    }
    const sorted = ordered ? visited : visited.slice().sort(
      (a, b) => (this.leaves.get(a)?.sequence ?? 0) - (this.leaves.get(b)?.sequence ?? 0),
    );
    const result: LeafCollection = { visited, sorted, first, last, summaries: [...seenSummaries] };
    collected?.set(summary.id, result);
    return result;
  }
}

/** One summary's leaf walk: live leaves in first-visit order and sorted by
 *  sequence, the sequence span, and the summaries the walk visited. */
interface LeafCollection {
  visited: ChunkId[];
  sorted: ChunkId[];
  first: number;
  last: number;
  summaries: SummaryId[];
}

function sequenceOf(n: TreeNode): number {
  return n.kind === 'leaf' ? n.sequence : n.firstSequence;
}
