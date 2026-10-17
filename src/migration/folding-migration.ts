/**
 * Folding-strategy migration utilities: kv-stable ⇄ kv-unified.
 *
 * A store's folding "flavor" is exactly one state slot —
 * `${ns}/kvunified:presentation-receipt`. Everything else the adaptive path
 * persists (summaries, chunks, pins, locks, calibration, and the
 * `${ns}/autobio:resolutions` frontier) is shared between solvers and stays
 * valid across a switch. These utilities handle the two things a bare config
 * flip does not:
 *
 *  - kv-stable → kv-unified: the strict CanonicalSummaryForest can reject a
 *    store the damage-tolerant SummaryTree happily served for years
 *    (validate), and an empty receipt slot means the first solve has no
 *    continuity baseline — a one-shot presentation jump (toUnified
 *    synthesizes an initial receipt chain from the carried resolutions
 *    frontier instead).
 *
 *  - kv-unified → kv-stable: nothing reads the receipt slot any more, but
 *    nothing clears it either — a later flip back would resurrect a stale
 *    chain as its continuity anchor (toStable clears it).
 *
 * Determinism: every function here is deterministic given the store contents
 * and its explicit inputs. The one non-derivable input — the timestamp a
 * synthesized receipt is "accepted" at — is a required parameter, never
 * read from the clock.
 *
 * NOT read-only: opening a store through ContextManager runs the strategy's
 * standard on-load canonicalization (empty-summary drops, duplicate-id
 * dedupe, dangling-parent repair — see loadPersistedState). Those writes are
 * identical to what any agent restart performs, but they are writes. Run
 * against a copy first; that is what `validate` is for.
 */

import { createHash } from 'node:crypto';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '../context-manager.js';
import { AutobiographicalStrategy } from '../strategies/autobiographical.js';
import type { ChunkRecord } from '../strategies/autobiographical.js';
import type {
  AutobiographicalOptions,
  KvUnifiedConfig,
  SummaryEntry,
} from '../types/strategy.js';
import {
  CanonicalForestError,
  ExactEnumerationLimitError,
  SparseLabelCeilingError,
} from '../adaptive/kv-unified.js';
import type { CanonicalForestIssue } from '../adaptive/kv-unified.js';
import { SummaryTree } from '../adaptive/summary-tree.js';
import type { PickerChunk, PickerInputs } from '../adaptive/picker.js';
import { KvUnifiedReceiptChain } from '../adaptive/kv-unified-receipts.js';
import type { SerializedReceiptChain } from '../adaptive/kv-unified-receipts.js';
import type { PresentedLeaf } from '../adaptive/kv-unified-policy.js';
import type { MessageId, TokenBudget } from '../types/index.js';

// ============================================================================
// Shared plumbing
// ============================================================================

/** Slot id helpers — must stay byte-identical to AutobiographicalStrategy's. */
export const slotIds = {
  summaries: (ns: string) => `${ns}/autobio:summaries`,
  chunks: (ns: string) => `${ns}/autobio:chunks`,
  resolutions: (ns: string) => `${ns}/autobio:resolutions`,
  kvUnifiedReceipt: (ns: string) => `${ns}/kvunified:presentation-receipt`,
} as const;

/**
 * Namespaces that carry autobiographical state in this store, discovered from
 * the registered state ids. A store opened with no explicit namespace uses
 * 'default'.
 */
export function discoverAutobioNamespaces(store: JsStore): string[] {
  const suffix = '/autobio:summaries';
  const out: string[] = [];
  for (const info of store.listStates()) {
    if (info.id.endsWith(suffix)) out.push(info.id.slice(0, -suffix.length));
  }
  return out.sort();
}

export interface StoreFlavor {
  namespace: string;
  hasResolutions: boolean;
  /** Non-null receipt slot content — the store has run (or been migrated to)
   *  kv-unified and not been migrated away. */
  hasReceiptChain: boolean;
  receiptHeadSequence: number | null;
  receiptLeafCount: number | null;
}

/** Read a store's folding flavor without opening a ContextManager (no
 *  on-load repairs; safe on a live copy). */
export function readFlavor(store: JsStore, namespace: string): StoreFlavor {
  const registered = new Set(store.listStates().map((s) => s.id));
  const resolutions = registered.has(slotIds.resolutions(namespace))
    ? store.getStateJson(slotIds.resolutions(namespace))
    : null;
  const receiptRaw = registered.has(slotIds.kvUnifiedReceipt(namespace))
    ? store.getStateJson(slotIds.kvUnifiedReceipt(namespace))
    : null;
  const receipt =
    receiptRaw && typeof receiptRaw === 'object'
      ? (receiptRaw as unknown as SerializedReceiptChain)
      : null;
  return {
    namespace,
    hasResolutions: !!resolutions && typeof resolutions === 'object',
    hasReceiptChain: receipt !== null,
    receiptHeadSequence: receipt?.head?.sequence ?? null,
    receiptLeafCount: receipt ? receipt.leaves.length : null,
  };
}

/**
 * Complete kvUnified configuration used ONLY to drive validation previews.
 * The solve's outcome is irrelevant to validation — only the strict forest
 * construction at its start matters — but the config gate ("live defaults
 * are forbidden") demands a complete object, so here is one, explicitly.
 * Values mirror test/kv-unified-strategy-integration.test.ts.
 */
export const VALIDATION_KV_UNIFIED_CONFIG: Omit<
  KvUnifiedConfig,
  'treeifyNonContiguousSummaries' | 'preserveGapBearingSummaries'
> = {
  policy: {
    alpha: 0.7,
    budgetLowRatio: 0.5,
    budgetHighRatio: 0.9,
    budgetUnderLambda: 10,
    budgetOverLambda: 10,
    cacheLambda: 1,
    cacheScale: 1000,
    cacheReadPrice: 0.1,
    cacheWritePrice: 1.25,
    continuityLambda: 1,
    continuityScale: 1000,
    continuityRecencyHalfLifeTokens: 1000,
    continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10,
    continuityStableFloor: 0.25,
  },
  // Sized for real stores, not the unit-test toys these values started as: a
  // 2.5-week production store blew a 10k label ceiling at 10,471. Coarse
  // buckets + a high ceiling keep the validation solve cheap; and a ceiling
  // overrun is tolerated anyway (see the solver-limit catch in validate).
  tokenBucketSize: 2_000,
  continuityBucketSize: 2_000,
  fidelityBucketSize: 2_000,
  labelCeiling: 500_000,
  adoptEpsilon: 0,
};

// ============================================================================
// validate — can this store's summary forest be canonicalized?
// ============================================================================

export type TreeificationPolicy = 'strict' | 'treeify' | 'preserve-gaps';

export interface PolicyOutcome {
  policy: TreeificationPolicy;
  /** The forest canonicalized under this policy — the thing validate is for. */
  ok: boolean;
  issues: CanonicalForestIssue[];
  /** Set when the forest built but the validation solve then hit a solver
   *  capacity limit (label ceiling / enumeration cap). Irrelevant to the
   *  migration verdict — the real deployment tunes its own solver config —
   *  but reported so an operator knows the preview stopped early. */
  solverLimit?: string;
}

export interface ValidateResult {
  namespace: string;
  /** Issue list from the strict (no-tolerance) forest build. Empty = clean. */
  strictIssues: CanonicalForestIssue[];
  outcomes: PolicyOutcome[];
  /** First policy (in strict → treeify → preserve-gaps order) whose forest
   *  builds. Null = no policy makes this store canonicalizable — repair the
   *  summary state before migrating. */
  recommendation: TreeificationPolicy | null;
}

const POLICY_FLAGS: Record<
  TreeificationPolicy,
  Pick<KvUnifiedConfig, 'treeifyNonContiguousSummaries' | 'preserveGapBearingSummaries'>
> = {
  strict: { treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false },
  treeify: { treeifyNonContiguousSummaries: true, preserveGapBearingSummaries: false },
  'preserve-gaps': { treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: true },
};

/**
 * Dry-run the real kv-unified solve (via previewContext, which commits
 * nothing) under each treeification policy and report which ones the store's
 * summary forest survives. The preview budget is deliberately huge so the
 * early head+tail over-budget check cannot fire before the forest is built.
 */
export async function validateStoreForKvUnified(opts: {
  path: string;
  namespace?: string;
  config?: AutobiographicalOptions;
  budget?: TokenBudget;
}): Promise<ValidateResult> {
  const namespace = opts.namespace ?? 'default';
  const strategy = new AutobiographicalStrategy({
    ...opts.config,
    adaptiveResolution: true,
  });
  const manager = await ContextManager.open({ path: opts.path, namespace, strategy });
  try {
    const budget: TokenBudget = opts.budget ?? {
      maxTokens: 10_000_000,
      reserveForResponse: 0,
    };
    const outcomes: PolicyOutcome[] = [];
    for (const policy of ['strict', 'treeify', 'preserve-gaps'] as const) {
      try {
        manager.previewContext(budget, {
          foldingStrategy: 'kv-unified',
          kvUnified: { ...VALIDATION_KV_UNIFIED_CONFIG, ...POLICY_FLAGS[policy] },
        });
        outcomes.push({ policy, ok: true, issues: [] });
      } catch (err) {
        if (err instanceof CanonicalForestError) {
          outcomes.push({ policy, ok: false, issues: [...err.issues] });
        } else if (
          err instanceof SparseLabelCeilingError ||
          err instanceof ExactEnumerationLimitError
        ) {
          // The forest is constructed at solve start; a capacity limit hit
          // afterwards proves the structure canonicalized. The deployment's
          // own kvUnified config governs the real solve.
          outcomes.push({ policy, ok: true, issues: [], solverLimit: err.message });
        } else {
          throw err;
        }
      }
    }
    const recommendation = outcomes.find((o) => o.ok)?.policy ?? null;
    return {
      namespace,
      strictIssues: outcomes[0].issues,
      outcomes,
      recommendation,
    };
  } finally {
    manager.close();
  }
}

// ============================================================================
// to-unified — synthesize an initial receipt chain from the carried frontier
// ============================================================================

export interface MigrationLeafWarning {
  messageId: MessageId;
  requestedLevel: number;
  usedLevel: number;
  reason: 'no-summary-at-level';
}

export interface SynthesizedPresentation {
  leaves: Map<MessageId, PresentedLeaf>;
  foldedCount: number;
  warnings: MigrationLeafWarning[];
}

/**
 * Pure core of to-unified: reconstruct, per message, the presentation the
 * carried resolutions frontier describes — the same (repHash, level) pairs
 * the kv-unified draft builder would record for it (`raw:{id}` /
 * `summary:{summaryId}`; see selectAdaptive's draft construction).
 *
 * A resolution pointing at a level with no reachable summary ancestor (a
 * kv-stable-era scar) degrades deterministically to the deepest level that
 * IS reachable, and is reported as a warning rather than thrown: the receipt
 * must describe a presentable state, and "what the renderer would actually
 * have shown" is the honest baseline.
 *
 * All leaves get lastChangedSeq 1 — the synthesized chain's first (and only)
 * sequence. A uniform baseline is the only defensible choice: the real
 * change history under kv-stable was never recorded per-leaf.
 */
export function synthesizePresentation(
  messageIds: readonly MessageId[],
  resolutions: ReadonlyMap<MessageId, number>,
  summaries: readonly SummaryEntry[],
  chunkRecords: readonly ChunkRecord[],
): SynthesizedPresentation {
  // L1 coverage: the chunk-record production ledger first, then live L1
  // sourceIds as the coverage authority fallback — the same two-step
  // buildPicker uses (fold-path fallback, 2026-08-04).
  const l1ByMessage = new Map<MessageId, string>();
  for (const record of chunkRecords) {
    if (!record.summaryId) continue;
    for (const mid of record.sourceIds) {
      if (!l1ByMessage.has(mid)) l1ByMessage.set(mid, record.summaryId);
    }
  }
  for (const s of summaries) {
    if (s.level !== 1) continue;
    for (const mid of s.sourceIds) {
      if (!l1ByMessage.has(mid)) l1ByMessage.set(mid, s.id);
    }
  }

  const chunks: PickerChunk[] = messageIds.map((id, i) => ({
    id,
    sequence: i,
    rawTokens: 1,
    currentResolution: resolutions.get(id) ?? 0,
    lockedByAgent: false,
    pinned: false,
    l1Id: l1ByMessage.get(id),
  }));
  const summariesMap = new Map(summaries.map((s) => [s.id, s]));
  const inputs: PickerInputs = {
    chunks,
    summaries: summariesMap,
    headTokens: 0,
    tailTokens: 0,
    headChunkIds: new Set(),
    tailChunkIds: new Set(),
  };
  // SummaryTree (not CanonicalSummaryForest) on purpose: the receipt must
  // describe what the damage-tolerant production renderer served, scars
  // included.
  const tree = new SummaryTree(inputs);

  const leaves = new Map<MessageId, PresentedLeaf>();
  const warnings: MigrationLeafWarning[] = [];
  let foldedCount = 0;
  for (const chunk of chunks) {
    const requested = chunk.currentResolution;
    let level = requested;
    let summaryId: string | undefined;
    while (level > 0) {
      const ancestor = tree.ancestorAt(chunk.id, level);
      if (ancestor) {
        summaryId = ancestor.id;
        break;
      }
      level--;
    }
    if (level !== requested) {
      warnings.push({
        messageId: chunk.id,
        requestedLevel: requested,
        usedLevel: level,
        reason: 'no-summary-at-level',
      });
    }
    if (level > 0) foldedCount++;
    leaves.set(chunk.id, {
      repHash: level === 0 ? `raw:${chunk.id}` : `summary:${summaryId}`,
      level,
      lastChangedSeq: 1,
    });
  }
  return { leaves, foldedCount, warnings };
}

/**
 * Pure: wrap a synthesized presentation in a properly hash-chained,
 * single-receipt KvUnifiedReceiptChain. No cache reference — the provider
 * cache is genuinely cold after a solver switch, and claiming otherwise
 * would mis-price the first solve.
 */
export function buildSyntheticChain(
  presentation: SynthesizedPresentation,
  acceptedAt: number,
): KvUnifiedReceiptChain {
  const layoutFingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        [...presentation.leaves.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, leaf]) => [id, leaf.repHash, leaf.level]),
      ),
    )
    .digest('hex');
  const chain = new KvUnifiedReceiptChain();
  const submissionId = `migration:${layoutFingerprint.slice(0, 16)}`;
  chain.begin({
    submissionId,
    requestHash: 'migration:synthesized-from-resolutions',
    layoutHash: `migration:${layoutFingerprint}`,
    leaves: presentation.leaves,
  });
  chain.accept(submissionId, acceptedAt, null);
  return chain;
}

export interface ToUnifiedResult {
  namespace: string;
  applied: boolean;
  messageCount: number;
  foldedCount: number;
  warnings: MigrationLeafWarning[];
  receiptHeadHash: string;
  /** Present when the store already carried a receipt chain and `overwrite`
   *  was not set: nothing was written. */
  refusedExistingChain?: { headSequence: number | null; leafCount: number };
}

/**
 * Migrate a store toward kv-unified: synthesize the initial receipt chain
 * from the carried resolutions frontier and (with `apply`) persist it to
 * `${ns}/kvunified:presentation-receipt`. The agent's own config must then
 * flip foldingStrategy to 'kv-unified' — this utility prepares the store,
 * it does not touch configs.
 *
 * Refuses to overwrite an existing chain unless `overwrite` is set: a live
 * chain means either the store already runs kv-unified (nothing to migrate)
 * or a stale chain survived a previous flip away (inspect it first —
 * overwriting is the fix, but it should be a decision, not a default).
 */
export async function migrateToUnified(opts: {
  path: string;
  namespace?: string;
  config?: AutobiographicalOptions;
  /** Timestamp recorded as the synthetic receipt's acceptedAt. Required and
   *  explicit — the migration must be reproducible, so no clock reads. */
  acceptedAt: number;
  apply: boolean;
  overwrite?: boolean;
}): Promise<ToUnifiedResult> {
  const namespace = opts.namespace ?? 'default';
  const strategy = new AutobiographicalStrategy({
    ...opts.config,
    adaptiveResolution: true,
  });
  const manager = await ContextManager.open({ path: opts.path, namespace, strategy });
  try {
    const store = manager.getStore();
    const receiptSlot = slotIds.kvUnifiedReceipt(namespace);

    const flavor = readFlavor(store, namespace);
    if (flavor.hasReceiptChain && !opts.overwrite) {
      return {
        namespace,
        applied: false,
        messageCount: 0,
        foldedCount: 0,
        warnings: [],
        receiptHeadHash: '',
        refusedExistingChain: {
          headSequence: flavor.receiptHeadSequence,
          leafCount: flavor.receiptLeafCount ?? 0,
        },
      };
    }

    const messageIds = manager.getAllMessages().map((m) => m.id);
    const resolutionsRaw = store.getStateJson(slotIds.resolutions(namespace));
    const resolutions = new Map<MessageId, number>();
    if (resolutionsRaw && typeof resolutionsRaw === 'object') {
      for (const [k, v] of Object.entries(resolutionsRaw as Record<string, unknown>)) {
        if (typeof v === 'number' && v > 0) resolutions.set(k, v);
      }
    }
    const summariesRaw = store.getStateJson(slotIds.summaries(namespace));
    const summaries = Array.isArray(summariesRaw) ? (summariesRaw as SummaryEntry[]) : [];
    const chunksRaw = store.getStateJson(slotIds.chunks(namespace));
    const chunkRecords = Array.isArray(chunksRaw) ? (chunksRaw as ChunkRecord[]) : [];

    const presentation = synthesizePresentation(messageIds, resolutions, summaries, chunkRecords);
    const chain = buildSyntheticChain(presentation, opts.acceptedAt);

    if (opts.apply) {
      try {
        store.registerState({ id: receiptSlot, strategy: 'snapshot' });
      } catch {
        /* already registered */
      }
      store.setStateJson(receiptSlot, chain.serialize());
    }
    return {
      namespace,
      applied: opts.apply,
      messageCount: messageIds.length,
      foldedCount: presentation.foldedCount,
      warnings: presentation.warnings,
      receiptHeadHash: chain.head?.receiptHash ?? '',
    };
  } finally {
    manager.close();
  }
}

// ============================================================================
// to-stable — clear the receipt slot so a later flip back can't resurrect it
// ============================================================================

export interface ToStableResult {
  namespace: string;
  applied: boolean;
  /** What was (or would be) cleared. Null = the slot was already empty and
   *  there is nothing to do. */
  cleared: { headSequence: number | null; leafCount: number } | null;
}

/**
 * Migrate a store toward kv-stable (or any non-kv-unified solver): clear the
 * receipt chain. The shared resolutions slot already carries the frontier
 * kv-stable will seed from, so this is the whole job. The chronicle is
 * append-only — the cleared chain remains recoverable from state history.
 *
 * Deliberately does NOT open a ContextManager: no strategy state is needed,
 * so no on-load repairs run. This operation is read-only until `apply`.
 */
export function migrateToStable(opts: {
  store: JsStore;
  namespace?: string;
  apply: boolean;
}): ToStableResult {
  const namespace = opts.namespace ?? 'default';
  const flavor = readFlavor(opts.store, namespace);
  if (!flavor.hasReceiptChain) {
    return { namespace, applied: false, cleared: null };
  }
  if (opts.apply) {
    opts.store.setStateJson(slotIds.kvUnifiedReceipt(namespace), null);
  }
  return {
    namespace,
    applied: opts.apply,
    cleared: {
      headSequence: flavor.receiptHeadSequence,
      leafCount: flavor.receiptLeafCount ?? 0,
    },
  };
}
