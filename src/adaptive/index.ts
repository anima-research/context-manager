/**
 * Adaptive-resolution context management subsystem.
 *
 * See `docs/adaptive-resolution-design.md` for the architectural overview.
 *
 * Status: V1 implementation, not yet wired into `AutobiographicalStrategy`.
 * Modules in this directory are exercised via the test harness in
 * `test/adaptive/` and will be integrated into the strategy in a follow-up
 * once the design is validated against real workloads.
 */

// Chunker
export {
  chunkMessage,
  DEFAULT_CHUNKER_OPTIONS,
  type ChunkerOptions,
  type Shard,
  type ShardingResult,
} from './chunker.js';

// Folding strategy interface
export type {
  FoldingStrategy,
  FoldingState,
  FoldingBudget,
  FoldOp,
  ChunkView,
  ChunkId,
  ChunkRange,
  SummaryId,
} from './folding-strategy.js';

// Concrete strategies
export { FlatProfileStrategy } from './strategies/flat-profile.js';
export { OldestFirstStrategy } from './strategies/oldest-first.js';
export { BestFitStrategy, type BestFitOptions } from './strategies/best-fit.js';

// V2 best-fit frontier solver (see docs/best-fit-frontier-resolution.md)
export {
  SummaryTree,
  nodeTokens,
  type TreeNode,
  type LeafNode,
  type SummaryNode,
} from './summary-tree.js';
export {
  renderLayout,
  kvCost,
  earliestDivergenceIndex,
  type RenderLayout,
  type RenderedUnit,
  type Frontier,
} from './render-offsets.js';
export { ValueFunction, type ValueParams } from './value-function.js';
export { solveFrontier, type SolveParams, type SolveResult } from './best-fit-solver.js';
export {
  solveStableFrontier,
  type StableSolveParams,
  type StableSolveResult,
} from './stable-frontier.js';

// Picker
export {
  Picker,
  OverBudgetError,
  type PickerInputs,
  type PickerResult,
  type PickerChunk,
} from './picker.js';

// Render helpers
export { concatBodyGroups, placeholderRecallText } from './render.js';

// Chunk locking is exposed as a method on `AutobiographicalStrategy`
// (`lockChunk(id)` / `unlockChunk(id)`); there is no standalone lock API at
// the adaptive layer. The picker honors `PickerChunk.lockedByAgent`.
