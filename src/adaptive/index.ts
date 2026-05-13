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

// Picker
export {
  Picker,
  type PickerInputs,
  type PickerResult,
  type PickerChunk,
} from './picker.js';

// Render helpers
export { concatBodyGroups, placeholderRecallText } from './render.js';

// Lock API
export {
  lockChunk,
  unlockChunk,
  InMemoryLockStore,
  type ChunkLockStore,
} from './lock-api.js';
