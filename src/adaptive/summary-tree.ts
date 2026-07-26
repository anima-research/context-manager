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
import type { PickerInputs } from './picker.js';
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
  private readonly leaves = new Map<ChunkId, LeafNode>();
  private readonly nodes = new Map<SummaryId, SummaryNode>();
  private readonly summaries: ReadonlyMap<SummaryId, SummaryEntry>;
  private readonly recallPairTokens: ReadonlyMap<SummaryId, number>;
  private readonly leafSeq = new Map<ChunkId, number>();
  private rootCache: TreeNode[] | null = null;

  constructor(inputs: PickerInputs) {
    this.summaries = inputs.summaries;
    this.recallPairTokens = inputs.recallPairTokens ?? new Map();

    for (const c of inputs.chunks) {
      this.leafSeq.set(c.id, c.sequence);
      this.leaves.set(c.id, {
        kind: 'leaf',
        chunkId: c.id,
        sequence: c.sequence,
        rawTokens: c.rawTokens,
        l1Id: c.l1Id,
      });
    }
    for (const [, s] of this.summaries) {
      this.nodes.set(s.id, this.buildNode(s));
    }
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

  private buildNode(s: SummaryEntry): SummaryNode {
    const leafChunkIds = this.collectLeafIds(s);
    let firstSequence = Infinity;
    let lastSequence = -Infinity;
    for (const id of leafChunkIds) {
      const seq = this.leafSeq.get(id);
      if (seq === undefined) continue;
      if (seq < firstSequence) firstSequence = seq;
      if (seq > lastSequence) lastSequence = seq;
    }
    return {
      kind: 'summary',
      id: s.id,
      level: s.level,
      recallTokens: this.recallPairTokens.get(s.id) ?? s.tokens,
      childIds: [...s.sourceIds],
      childrenAreLeaves: s.sourceLevel === 0,
      leafChunkIds,
      firstSequence: firstSequence === Infinity ? -1 : firstSequence,
      lastSequence: lastSequence === -Infinity ? -1 : lastSequence,
      sourceRange: s.sourceRange,
      parentId: getSummaryParentId(s),
    };
  }

  /** Walk down to leaf chunk ids; sourceLevel 0 => sourceIds are leaves.
   *  Deduplicates leaves and guards against revisiting a summary, so a chunk
   *  reachable via multiple branches is counted once (real chronicles can have
   *  such overlap; double-counting breaks range/contiguity and value math). */
  private collectLeafIds(summary: SummaryEntry): ChunkId[] {
    const out: ChunkId[] = [];
    const seenLeaves = new Set<ChunkId>();
    const seenSummaries = new Set<SummaryId>();
    const visit = (s: SummaryEntry): void => {
      if (seenSummaries.has(s.id)) return;
      seenSummaries.add(s.id);
      if (s.sourceLevel === 0) {
        for (const mid of s.sourceIds) {
          if (!seenLeaves.has(mid)) {
            seenLeaves.add(mid);
            out.push(mid);
          }
        }
      } else {
        for (const sid of s.sourceIds) {
          const child = this.summaries.get(sid);
          if (child) visit(child);
        }
      }
    };
    visit(summary);
    out.sort((a, b) => (this.leafSeq.get(a) ?? 0) - (this.leafSeq.get(b) ?? 0));
    return out;
  }
}

function sequenceOf(n: TreeNode): number {
  return n.kind === 'leaf' ? n.sequence : n.firstSequence;
}
