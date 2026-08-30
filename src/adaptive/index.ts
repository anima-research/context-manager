/**
 * Adaptive-resolution context management subsystem.
 *
 * See `docs/adaptive-resolution-design.md` for the architectural overview.
 *
 * Status: wired into `AutobiographicalStrategy` (`selectAdaptive`) and in
 * production — deployed agents run the kv-stable solver from this directory
 * (design §13). Also exercised standalone via `test/adaptive/` and the
 * replay harness (`kv-replay`).
 */

// Chunker
export {
  chunkMessage,
  DEFAULT_CHUNKER_OPTIONS,
  type ChunkerOptions,
  type Shard,
  type ShardingResult,
} from './chunker.js';

// Folding solver interface
export type {
  FoldingSolver,
  FoldingSolution,
  FoldingBudget,
  ProduceRequest,
  ChunkId,
  ChunkRange,
  SummaryId,
} from './folding-strategy.js';

// Concrete strategies
export { FlatProfileStrategy } from './strategies/flat-profile.js';
export { OldestFirstStrategy } from './strategies/oldest-first.js';
export { KvStableStrategy, type KvStableOptions } from './strategies/kv-stable.js';

// Summary tree + rendered-unit accounting (shared substrate)
export {
  SummaryTree,
  nodeTokens,
  type TreeNode,
  type LeafNode,
  type SummaryNode,
} from './summary-tree.js';
export {
  CanonicalSummaryForest,
  CanonicalForestError,
  type CanonicalConstraintKind,
  type CanonicalLeafConstraint,
  type CanonicalForestOptions,
  type CanonicalForestIssueCode,
  type CanonicalForestIssue,
  type CanonicalLeaf,
  type CanonicalSummary,
  type CanonicalRoot,
  type ConstraintConflict,
  type MinimumTokenCertificate,
  type MinimumTokenResult,
  type CanonicalSelectAction,
  type CanonicalDecisionNode,
  type CanonicalDecisionDag,
  type ExactCutCandidate,
  type ExactCutEnumerationStats,
  type ExactCutEnumeration,
  ExactEnumerationLimitError,
  SparseLabelCeilingError,
  type SparseLabelStats,
  type SparseLabelResult,
} from './kv-unified.js';
export {
  ExactKvUnifiedPolicySolver,
  KvUnifiedPolicyError,
  DEFAULT_KV_UNIFIED_WELFARE_POLICY,
  type PresentedLeaf,
  type AcceptedPresentationReference,
  type ProviderCacheReference,
  type KvUnifiedWelfarePolicy,
  type ExactPolicySolveOptions,
  type ExactPolicyCandidate,
  type ExactPolicySolveResult,
} from './kv-unified-policy.js';
export {
  ParetoKvUnifiedPolicySolver,
  type ParetoPropagationStats,
  type ParetoPolicySolveResult,
} from './kv-unified-pareto.js';
export {
  renderLayout,
  kvCost,
  earliestDivergenceIndex,
  type RenderLayout,
  type RenderedUnit,
  type Frontier,
} from './render-offsets.js';

// KV-cache simulation + session replay (provider-cache stability measurement)
export {
  placeMarkers,
  evaluateCacheHit,
  CacheStore,
  MAX_CACHE_MARKERS,
  type CacheMarker,
  type CacheHit,
  type CacheStoreOptions,
  type CacheReadResult,
} from './kv-cache-sim.js';
export {
  replaySession,
  type ReplayOptions,
  type ReplayStep,
  type ReplayResult,
} from './kv-replay.js';
export {
  replayControlled,
  planControlledFrontier,
  foldDepthCap,
  PRICE,
  MAX_FOLD_LEVEL,
  type ControlOptions,
  type ControlStep,
  type ControlResult,
  type ControlPlanParams,
  type ControlPlan,
} from './kv-control.js';

// Picker
export {
  Picker,
  OverBudgetError,
  UncoveredDropError,
  accountFrontier,
  type OverBudgetDiagnostics,
  type PickerInputs,
  type PickerResult,
  type PickerChunk,
} from './picker.js';

// Render helpers
export { concatBodyGroups, placeholderRecallText } from './render.js';

// Chunk locking is exposed as a method on `AutobiographicalStrategy`
// (`lockChunk(id)` / `unlockChunk(id)`); there is no standalone lock API at
// the adaptive layer. The picker honors `PickerChunk.lockedByAgent`.
