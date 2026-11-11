import type { ContextStrategy } from './strategy.js';

/** Opaque load identity, scoped to this strategy/store/namespace/branch, not its message head. */
export interface CompressionQuarantineBinding {
  namespace: string;
  branch: string;
  loadId: string;
}

export interface CompressionQuarantineRecordView {
  key: string;
  /** Actual native event/claim identity; null for synthetic legacy lineage. */
  generation: string | null;
  selectable: boolean;
  chunkSourceHash: string;
  familyKey: string | null;
  canonicalRequestHash: string | null;
  frontierHash: string | null;
  created: number | null;
  recordedModel: string | null;
  /** No historical category/provider/credential is inferred from a model or aggregate. */
  recordedProvider: null;
  recordedCategory: null;
  sourceIds: string[] | null;
  sourceIdsComplete: boolean;
  membership: 'recorded' | 'loaded-chunk' | 'unknown';
  /** Exact source-id hash matches a currently loaded chunk; not an eligibility verdict. */
  loadedChunkMatch: boolean;
  profile: {
    accountingVersion: number | null;
    fallbackLimit: number | null;
    contextBudgetTokens: number | null;
    sourceOnlyFallbackEnabled: boolean | null;
  };
  outcomes: { outcome: string; stopReason: string | null; requestHash: string | null }[];
  outcomesComplete: boolean;
  sameSourceRecords: number;
  siblingKeys: string[];
  siblingKeysComplete: boolean;
}

export type CompressionQuarantineInspection = {
  status: 'ok';
  binding: CompressionQuarantineBinding;
  configuredModel: string | null;
  configuredProvider: null;
  configuredCredentialAlias: null;
  records: CompressionQuarantineRecordView[];
  totalRecords: number;
  /** Completeness of this selection (an exact-key query is not a full list). */
  complete: boolean;
} | { status: 'branchUnavailable' | 'unreadable' | 'invalidSelection' };

export interface CompressionQuarantineReleaseSelection {
  key: string;
  expectedGeneration: string;
  expectedBinding: CompressionQuarantineBinding;
}

export type CompressionQuarantineReleaseResult = {
  status: 'released';
  key: string;
  generation: string;
  /** Records, not chunks, queue ownership, coverage, or debt. */
  remainingRecords: number;
} | { status: 'stale' | 'not-held' | 'unsupported' | 'unreadable' | 'branchUnavailable' | 'invalidSelection' };

/** Optional capability on the already loaded strategy. Never fall back to legacy clear-all. */
export interface KeyedCompressionQuarantineStrategy extends ContextStrategy {
  inspectCompressionRefusalQuarantine(options?: { key?: string; limit?: number }): CompressionQuarantineInspection;
  /** Write failures throw: the caller must treat the result as uncertain, not retry automatically. */
  releaseCompressionRefusalQuarantine(selection: CompressionQuarantineReleaseSelection): Promise<CompressionQuarantineReleaseResult>;
}

export function isKeyedCompressionQuarantineStrategy(strategy: unknown): strategy is KeyedCompressionQuarantineStrategy {
  const candidate = strategy as Partial<KeyedCompressionQuarantineStrategy>;
  return candidate !== null && typeof candidate === 'object' && typeof candidate.inspectCompressionRefusalQuarantine === 'function' &&
    typeof candidate.releaseCompressionRefusalQuarantine === 'function';
}
