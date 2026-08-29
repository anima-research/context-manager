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
export { resolveEffectiveConfig } from './config-provenance.js';
export type { ConfigLayer, ConfigResolutionSemantics, EffectiveConfigReport } from './config-provenance.js';

// Errors — cross-package behavioral surface. agent-framework gates its
// OverBudget drain breaker on these errors (AF PR #58, framework.ts
// classifyInferenceError); exporting them from the root gives consumers a
// real `instanceof` instead of stringly-typed `err.name` matching.
export { OverBudgetError, UncoveredDropError } from './adaptive/picker.js';
export type { OverBudgetDiagnostics } from './adaptive/picker.js';

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
  HotContextSettings,
  HotContextSettingsUpdate,
  HotContextSettingsStatus,
  HotConfigurableStrategy,
  AutobiographicalConfig,
  AutobiographicalOptions,
  RecallEnvelopeMode,
  CarrierPolicy,
  SummaryLevel,
  SummaryEntry,
  PhaseType,
  KnowledgeConfig,
  KnowledgeOptions,
  ResettableStrategy,
} from './types/index.js';

export {
  DEFAULT_AUTOBIOGRAPHICAL_CONFIG,
  isResettableStrategy,
  isHotConfigurableStrategy,
} from './types/index.js';
