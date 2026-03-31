// Main class
export { ContextManager } from './context-manager.js';
export type { ContextManagerConfig } from './context-manager.js';

// Storage
export { MessageStore } from './message-store.js';
export type { MessageStoreEvent, MessageStoreListener } from './message-store.js';
export { ContextLog } from './context-log.js';
export { BlobManager } from './blob-manager.js';

// Strategies
export { PassthroughStrategy } from './strategies/passthrough.js';
export { AutobiographicalStrategy } from './strategies/autobiographical.js';
export { KnowledgeStrategy } from './strategies/knowledge.js';

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
  SummaryLevel,
  SummaryEntry,
  PhaseType,
  KnowledgeConfig,
  ResettableStrategy,
} from './types/index.js';

export { DEFAULT_AUTOBIOGRAPHICAL_CONFIG, isResettableStrategy } from './types/index.js';
