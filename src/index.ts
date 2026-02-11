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
} from './types/index.js';

export { DEFAULT_AUTOBIOGRAPHICAL_CONFIG } from './types/index.js';
