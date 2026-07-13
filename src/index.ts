// Main class
export { ContextManager } from './context-manager.js';
export type { ContextManagerConfig } from './context-manager.js';

// Phase channel (liveness-watchdog observability hook)
export { phaseChannel, enterPhase, withPhase, withPhaseAsync } from './phase-channel.js';

// Storage
export { MessageStore } from './message-store.js';
export type { MessageStoreEvent, MessageStoreListener, MessageWindow, MessageWindowOptions } from './message-store.js';
export { concatBodyGroups } from './adaptive/render.js';
export { ContextLog } from './context-log.js';
export { BlobManager } from './blob-manager.js';

// Strategies
export { PassthroughStrategy } from './strategies/passthrough.js';
export { AutobiographicalStrategy, type AutobiographicalProgressSnapshot, type Chunk } from './strategies/autobiographical.js';
export { KnowledgeStrategy } from './strategies/knowledge.js';

// Utilities
export { splitMixedToolMessages, stripUnpairedToolBlocks } from './normalize-tool-messages.js';

// Types
export type {
  // Message types
  MessageId,
  Sequence,
  BranchId,
  MessageMetadata,
  StoredMessage,
  BlobReference,
  StoredContentBlock,
  MessageQuery,
  MessageQueryResult,
  // Context types
  SourceRelation,
  ContextEntry,
  TokenBudget,
  PendingWork,
  BranchInfo,
  ContextInjection,
  CompileResult,
  // Strategy types
  MessageStoreView,
  ContextLogView,
  StrategyContext,
  ReadinessState,
  ContextStrategy,
  AutobiographicalConfig,
  AutobiographicalOptions,
  SummaryLevel,
  SummaryEntry,
  PhaseType,
  KnowledgeConfig,
  KnowledgeOptions,
  ResettableStrategy,
} from './types/index.js';

export { DEFAULT_AUTOBIOGRAPHICAL_CONFIG, isResettableStrategy } from './types/index.js';
