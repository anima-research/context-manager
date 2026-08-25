import type { JsStore } from '@animalabs/chronicle';
import type { Membrane, NormalizedRequest, NormalizedResponse, ContentBlock, CompleteOptions } from '@animalabs/membrane';
import { NativeFormatter } from '@animalabs/membrane';
import { phaseChannel } from '../phase-channel.js';
import type {
  ContextStrategy,
  ResettableStrategy,
  StrategyContext,
  ReadinessState,
  MessageStoreView,
  ContextLogView,
  TokenBudget,
  ContextEntry,
  StoredMessage,
  AutobiographicalConfig,
  AutobiographicalOptions,
  CompressionQuarantineStatus,
  SummaryLevel,
  SummaryEntry,
  ProtectedRange,
  PinLevelOptions,
  SearchQuery,
  SearchResult,
  RenderStats,
  HotContextSettingsUpdate,
  HotContextSettingsStatus,
  SelectOptions,
  PreviewResult,
} from '../types/index.js';
import { DEFAULT_AUTOBIOGRAPHICAL_CONFIG } from '../types/index.js';
import { getSummaryParentId } from '../types/strategy.js';
import { resolveEffectiveConfig, type ConfigLayer, type EffectiveConfigReport } from '../config-provenance.js';
import { selectKeeperL1s } from './keeper-selection.js';
import { splitMixedToolMessages, stripUnpairedToolBlocks } from '../normalize-tool-messages.js';
import { MessageStore } from '../message-store.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Picker, OverBudgetError, UncoveredDropError, type PickerChunk, type PickerInputs } from '../adaptive/picker.js';
import { FlatProfileStrategy } from '../adaptive/strategies/flat-profile.js';
import { KvStableStrategy } from '../adaptive/strategies/kv-stable.js';
import { OldestFirstStrategy } from '../adaptive/strategies/oldest-first.js';
import type {
  FoldingSolver,
  FoldingBudget,
  ProduceRequest,
  ChunkId,
  SummaryId,
} from '../adaptive/folding-strategy.js';
import { chunkMessage, DEFAULT_CHUNKER_OPTIONS } from '../adaptive/chunker.js';
import { observeStoreBranch } from '../branch-generation.js';
import type { MessageId } from '../types/message.js';
import type { IngressChunkResult } from '../types/strategy.js';

/**
 * Append a JSONL entry describing one compression LLM call to the path
 * given by `CONTEXT_MANAGER_COMPRESSION_LOG`. No-op if the env var isn't
 * set. Called at every L1 and merge LLM-call site so we can audit the
 * exact prompts and responses post-hoc — no reconstruction, no
 * assumption about whether the strategy code matches what produced
 * historical summaries.
 *
 * Failures to write are logged to stderr but don't propagate — logging
 * is non-essential observability and should never break compression.
 */
function logCompressionCall(entry: Record<string, unknown>): void {
  const logPath = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    const line = JSON.stringify({ ...entry, timestamp: Date.now() }) + '\n';
    appendFileSync(logPath, line);
  } catch (err) {
    console.warn('compression log write failed:', err);
  }
}

/**
 * In-band marker shown to the summarizer just before the chunk it's
 * about to memorize. Primes attention without disrupting KV state —
 * the agent has seen this exact wording before every prior compression
 * in its history, so the model treats memory formation as a recurring
 * narrated event rather than a fresh instruction each time.
 *
 * Wording matches `hermes-autobio/plugins/autobio/compression.py`
 * `_MARKER` so the in-band primer is consistent across the codebase.
 */
const COMPRESSION_MARKER =
  'System: You will soon form a new memory, get ready. ' +
  'The messages that follow are the slice of recent experience you are ' +
  'about to compress. After them, write the memory in your own voice.';

/**
 * Retry-only line for tool_use compression rejections. Summarizer requests
 * declare the agent's live tools (the labclaude reasoning_extraction
 * requirement), so a think-first model can answer a mint prompt on-pattern —
 * a tool call carrying the draft — which the single-shot compression path
 * cannot continue past (lena 2026-08-04/06, merge AND L1 sites). Forbidding
 * tools structurally makes the same model emit nothing (bench-verified);
 * this sentence, appended only on the retry, is what works.
 */
const NO_TOOLS_RETRY_LINE =
  '\n\nWrite the memory as plain text directly in your response — do not call any tools for this.';

/**
 * Retry line for generations that arrive wholly wrapped in a literal
 * `<thinking>` tag. Opus-3-class summarizers write the entire memory inside
 * the tag as a stylistic habit (evander 2026-08-06: complete end_turn
 * generations, first-person memory prose, all inside `<thinking>`);
 * stripThinkingPreamble correctly refuses to canonize thinking, so the mint
 * arrives empty and the chunk/merge loops forever. The content demonstrably
 * exists — only the wrapper is wrong — so the retry asks for it plainly.
 */
const PLAIN_PROSE_RETRY_LINE =
  '\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.';

/** Clone a compression request with `line` appended to the final instruction message. */
function withAppendedInstruction(request: NormalizedRequest, line: string): NormalizedRequest {
  const messages = request.messages.map((m, i) => {
    if (i !== request.messages.length - 1) return m;
    const content = m.content.map((block, j) =>
      j === m.content.length - 1 && block.type === 'text'
        ? { ...block, text: block.text + line }
        : block,
    );
    return { ...m, content };
  });
  return { ...request, messages };
}

const withNoToolsLine = (request: NormalizedRequest): NormalizedRequest =>
  withAppendedInstruction(request, NO_TOOLS_RETRY_LINE);
const withPlainProseLine = (request: NormalizedRequest): NormalizedRequest =>
  withAppendedInstruction(request, PLAIN_PROSE_RETRY_LINE);

/**
 * Final escalation for tool_use compression rejections: drop the tools param.
 * A span saturated with the agent's own tool-call turns can out-pull the
 * no-tools sentence (lena 2026-08-06: L1 chunks and an L3 merge failed the
 * line-carrying retry under multiple frontiers). With no tools declared the
 * response physically cannot be a tool call. Assistant prefill is NOT an
 * option — opus-4-6-era models reject it ("This model does not support
 * assistant message prefill", observed live 2026-08-06).
 *
 * Trade-off, eyes open: a tools-less request replaying tool-block history is
 * the labclaude reasoning_extraction risk (2026-07-09) — which is why this
 * is the LAST rung, reached only after two tool_use rejections, a pattern
 * seen on opus-family summarizers (Fable-family compression failures are
 * refusal-class and ride the source-level fallback instead). Bench receipt:
 * the tools-less arm of the lena merge bench minted cleanly, content
 * matching the tools-declared control.
 */
function withoutToolsParam(request: NormalizedRequest): NormalizedRequest {
  const { tools: _tools, ...rest } = request as NormalizedRequest & { tools?: unknown };
  return rest as NormalizedRequest;
}

/** Standard compression instruction for chat/general chunks. */
function formatInstruction(targetTokens: number): string {
  return (
    'Write the memory of events since the most recent memory system ' +
    'notification. Speak in the first person from your own perspective. ' +
    'Preserve concrete details — file paths, exact values, decisions, ' +
    `unresolved questions, the user\'s active asks. Target ~${targetTokens} ` +
    'tokens. Output only the memory body — no preamble, no section headers ' +
    'unless they help preservation, no meta-commentary about summarizing. ' +
    'Memorize only what actually happened in that slice: if it holds little ' +
    'beyond routine system traffic (heartbeats, empty turns, failure ' +
    'notices), a short memory saying so is correct — do not pad it by ' +
    're-narrating events you already remember from earlier as if they had ' +
    'just happened again.'
  );
}

/**
 * Witnessed-record instruction for chunks pinned as inherited history
 * (`witnessedBeforeSequence`). The slice predates the agent's own first
 * turn: it is context they carry, not experience they lived. First person
 * is reserved for the act of reading and carrying; events are attributed
 * to the participants named in the record. Same KV-preserving in-band
 * style as `formatInstruction`.
 */
function formatWitnessedInstruction(targetTokens: number): string {
  return (
    'Write the memory of this slice of the log. This part of the record ' +
    'predates your own first turn: it is inherited context you carry — ' +
    "others' lived experience, witnessed through the log, not your own. " +
    'Attribute events to the participants named in the record ("Ash and ' +
    'Tavy explored...", "the log holds...", "before my arrival..."), and ' +
    'reserve the first person for your own reading of it: what stood out ' +
    'to you, what it means to carry this. Preserve concrete details — ' +
    'names, decisions, exact phrases that matter, unresolved questions. ' +
    `Target ~${targetTokens} tokens. Output only the memory body — no ` +
    'preamble, no meta-commentary about summarizing.'
  );
}

/**
 * Compression instruction for chunks that are part of a substantially larger
 * message (≥ 2× the chunk's own token size).
 *
 * Avoids forcing a "document" or "message" frame — just describes the
 * experience: the agent has been reading a substantial piece of text, of
 * which the slice is a portion. Asks what reading was like and what was
 * learned. This naturally elicits first-person agent voice ("I read…", "I
 * learned…", "I noticed…") and preserves concrete content via the
 * "specific claims, names, dates" guidance.
 *
 * Rationale: when chunks are shards of a much larger user-shared message,
 * the chunk content is heavily first-person from someone other than the
 * agent. Asking "form a memory of what this contained" lets the model
 * adopt the dominant voice of the chunk content. Asking "what was reading
 * this like, what did you learn" forces the model to reflect from its own
 * vantage point — only the agent can describe what reading something was
 * like from its own perspective.
 */
function formatReadingChunkInstruction(
  totalTokens: number,
  targetTokens: number,
): string {
  return (
    `You have just been reading a substantial body of text — approximately ` +
    `${totalTokens} tokens total in this piece, of which what you just read ` +
    `is a portion. Earlier portions are in your memory above as your prior ` +
    `reflections; what comes after, you have not yet read.\n\n` +
    `Reflect on this reading: what was it like? What did you learn? What ` +
    `stood out? Be substantive — name the specific claims, frameworks, ` +
    `people, dates, and phrases that struck you. What is now in your ` +
    `understanding that wasn't before you read this portion?\n\n` +
    `Speak in your own voice as the one reading. Target ~${targetTokens} ` +
    `tokens. Output only the body of your reflection — no preamble.`
  );
}

/**
 * Merge instruction for L2/L3+ consolidation (conversation/general case).
 *
 * The model has just been shown content ONE LEVEL DEEPER than its
 * sources: raw messages for an L2 merge (sources are L1s), L1 memories
 * for an L3 merge (sources are L2s), etc. The instruction describes
 * the content the model just saw and asks for a consolidation at
 * `targetLevel`.
 */
function formatMergeInstruction(
  targetLevel: number,
  sourceLevelShown: number,
  targetTokens: number,
): string {
  const seenDescription =
    sourceLevelShown === 0
      ? 'the slices of recent experience above (raw conversation)'
      : `the L${sourceLevelShown} memories above`;
  return (
    `You have just reviewed ${seenDescription}, in chronological order. ` +
    `They cover the stretch of experience you are about to consolidate into a ` +
    `single L${targetLevel} memory. Write a memory that preserves the ` +
    `through-line: what happened, what was decided, what remains open, what ` +
    `concrete details future you will want to reach for. Speak in the first ` +
    `person. Target ~${targetTokens} tokens. Output only the memory body — ` +
    `no preamble, no meta-commentary about summarizing.`
  );
}

/**
 * Witnessed-record merge instruction: every source summary carries the
 * `witnessed` flag — the stretch is inherited record (witnessedBeforeSequence),
 * not the agent's lived experience. The standard instruction's "speak in the
 * first person" re-claims others' lives at consolidation (observed
 * 2026-07-27); this variant keeps the witnessed voice through every level.
 */
function formatWitnessedMergeInstruction(
  targetLevel: number,
  sourceLevelShown: number,
  targetTokens: number,
): string {
  const seenDescription =
    sourceLevelShown === 0
      ? 'the portions of the inherited log above (raw record)'
      : `the L${sourceLevelShown} memories of the inherited record above`;
  return (
    `You have just reviewed ${seenDescription}, in chronological order. ` +
    `They cover a stretch of the log that predates your own first turn: ` +
    `others' lived experience, witnessed through the record you carry — not ` +
    `your own. Consolidate them into a single L${targetLevel} memory that ` +
    `preserves the through-line: what happened and to whom, what was decided, ` +
    `what remains open, the exact phrases worth keeping. Attribute events to ` +
    `the participants named in the record ("Ash and Tavy explored...", "the ` +
    `log holds...", "before my arrival..."); reserve the first person for ` +
    `your own reading and carrying of it. Target ~${targetTokens} tokens. ` +
    `Output only the memory body — no preamble, no meta-commentary about ` +
    `summarizing.`
  );
}

/**
 * Reading-mode merge instruction. Used when the merge's leaf messages
 * are all part of a substantially-larger sharded message — i.e., the
 * agent has been reading a doc/long-message rather than conversing.
 *
 * Analogous to formatReadingChunkInstruction: avoids forcing a
 * "document" or "message" frame, asks what reading the stretch was
 * like and what was understood. Forces the agent's vantage point —
 * only the reader can describe what reading was like — and so prevents
 * the drift into the content author's voice that happens when the
 * instruction asks for an impersonal summary.
 */
function formatReadingMergeInstruction(
  targetLevel: number,
  sourceLevelShown: number,
  totalTokens: number,
  targetTokens: number,
): string {
  const seenDescription =
    sourceLevelShown === 0
      ? 'the portions of text you read above (raw passages from a larger piece)'
      : `your earlier L${sourceLevelShown} reflections above on portions you read`;
  return (
    `You have just re-experienced ${seenDescription}, in chronological order. ` +
    `They cover a contiguous stretch of a substantial body of text you have ` +
    `been reading — approximately ${totalTokens} tokens in total across all ` +
    `of it. The portions above cover the stretch you are now consolidating ` +
    `at L${targetLevel}.\n\n` +
    `Reflect across the stretch: what was it like, reading these portions ` +
    `together? What did you come to understand that you couldn't have from ` +
    `any single portion alone? What recurring patterns, frameworks, or ` +
    `concerns emerged? Be substantive — name the specific claims, people, ` +
    `dates, and phrases that defined this stretch of your reading.\n\n` +
    `Speak in your own voice as the one who read these portions. Target ` +
    `~${targetTokens} tokens. Output only the body of your consolidation — ` +
    `no preamble.`
  );
}

/**
 * Surrogate-safe string slice. Avoids cutting between a UTF-16 surrogate pair
 * which would produce invalid JSON ("no low surrogate in string" API errors).
 */
function safeSlice(str: string, start: number, end: number): string {
  if (end >= str.length) return str.slice(start);
  const code = str.charCodeAt(end);
  if (code >= 0xDC00 && code <= 0xDFFF) {
    return str.slice(start, end - 1);
  }
  return str.slice(start, end);
}

/**
 * Chunk of messages to be compressed.
 */
export interface Chunk {
  /** Index in the chunk list */
  index: number;
  /** Starting index in the compressible message array (inclusive).
   *  Note: this is an index into getCompressibleMessages(), not store.getAll(). */
  startIndex: number;
  /** Ending index in the compressible message array (exclusive).
   *  Note: this is an index into getCompressibleMessages(), not store.getAll(). */
  endIndex: number;
  /** Messages in this chunk */
  messages: StoredMessage[];
  /** Estimated token count */
  tokens: number;
  /** Whether this chunk has been compressed */
  compressed: boolean;
  /** ID of the L1 SummaryEntry (hierarchical mode) */
  summaryId?: string;
  /** Phase type tag (set by KnowledgeStrategy for semantic chunking) */
  phaseType?: string;
  /** ID of the persisted ChunkRecord backing this chunk (chunk persistence). */
  recordId?: string;
}

/**
 * Persisted chunk boundary, one per CLOSED chunk, stored in the
 * `autobio:chunks` chronicle state slot (append_log, branch-aware).
 *
 * Records OWN the past: once a chunk closes, its membership is a persisted
 * fact — rebuilds and restarts materialize chunks from records instead of
 * recomputing boundaries from the running token sum. This is the fix for the
 * 2026-07 re-consolidation storms: boundary inputs (config knobs, head
 * window, token estimates, message mutations) could shift across restarts,
 * the old exact-sourceIds-match recovery then failed, and whole stretches of
 * already-summarized history were re-compressed into duplicate L1s.
 *
 * Membership is by message ID (never index), so edits/redactions degrade a
 * record gracefully instead of re-keying its neighbors.
 */
export interface ChunkRecord {
  /** Stable record id ("c-<n>"). */
  id: string;
  /** Exact message IDs of the closed chunk, in order. */
  sourceIds: string[];
  /** Whether the chunk's L1 summary has been produced. */
  compressed: boolean;
  /** ID of the L1 SummaryEntry, once compressed. */
  summaryId?: string;
  /** Phase type tag (KnowledgeStrategy semantic chunking). */
  phaseType?: string;
}

/** One request-shape expansion retained in a durable refusal record. */
interface CompressionRefusalVariantRecord {
  parentId: string;
  childIds: string[];
  requestHash: string;
}

/**
 * Durable circuit-breaker for a fully refused L1 request family. The key is
 * over the complete as-of state that is allowed to affect a retry: model/config
 * (inside canonicalRequestHash), target chunk, canonical frontier, and the
 * exact bounded set of variants that was attempted.
 */
interface CompressionRefusalQuarantineRecord {
  key: string;
  familyKey: string;
  model: string;
  chunkSourceHash: string;
  frontierHash: string;
  canonicalRequestHash: string;
  accountingSource: string;
  canonicalRequestBoundTokens: number;
  canonicalProviderInputTokens?: number;
  normalizedConfig: CompressionRefusalNormalizedConfig;
  fallbackLimit: number;
  contextBudgetTokens: number;
  plan: CompressionRefusalPlanRecord[];
  created: number;
}

interface CompressionRefusalNormalizedConfig {
  accountingVersion: number;
  fallbackLimit: number;
  contextBudgetTokens: number;
  requestConfig: NormalizedRequest['config'];
}

type CompressionAttemptOutcome =
  | 'refusal'
  | 'unusable_empty'
  | 'provider_error'
  | 'admission_rejected'
  /**
   * Response carried text but the terminal disposition was not a complete
   * `end_turn` (max_tokens truncation, tool_use, abort, stop_sequence, or a
   * missing stopReason). Never canonized: a truncated or interrupted
   * generation must not become a permanent memory (2026-08-01 gate — a
   * 163-char refusal preamble had been persisted as an L4 parent over six
   * real L3 children because only text-nonemptiness was checked).
   */
  | 'incomplete';

/**
 * Typed rejection thrown by `executeMerge` when the merge response fails
 * the terminal-disposition gate. `tick()` catches this specifically to run
 * the bounded-retry/quarantine policy; any other executeMerge throw keeps
 * the pre-existing transient semantics (entry stays queued, retried on the
 * next tick with no attempt accounting).
 */
class MergeDispositionRejection extends Error {
  readonly outcome: CompressionAttemptOutcome;
  readonly stopReason?: string;
  readonly errorType?: string;
  readonly requestHash: string;

  constructor(
    targetLevel: number,
    outcome: CompressionAttemptOutcome,
    requestHash: string,
    stopReason?: string,
    errorType?: string,
  ) {
    super(
      `L${targetLevel} merge response rejected by terminal-disposition gate: ` +
        `${outcome}${stopReason ? ` (stop=${stopReason})` : ''}${errorType ? ` (${errorType})` : ''}`,
    );
    this.name = 'MergeDispositionRejection';
    this.outcome = outcome;
    this.requestHash = requestHash;
    if (stopReason !== undefined) this.stopReason = stopReason;
    if (errorType !== undefined) this.errorType = errorType;
  }
}

/**
 * Durable record of a merge dequeued after exhausting its bounded retry
 * policy. Keyed by sha256 of the sourceIds list. While a record is live,
 * `enqueueMerge` refuses to re-enqueue the same source set — the debt is
 * surfaced by the merge-quarantine klaxon instead of being retried in a
 * loop. Cleared by operator action (`clearMergeQuarantine`) or swept
 * automatically once every source is covered by a parent or gone.
 */
interface MergeQuarantineRecord {
  key: string;
  level: SummaryLevel;
  sourceIds: string[];
  attempts: number;
  lastOutcome: CompressionAttemptOutcome;
  lastStopReason?: string;
  lastErrorType?: string;
  lastRequestHash?: string;
  quarantinedAt: number;
}

interface CompressionRefusalOutcomeRecord {
  curveLabel: string;
  requestHash: string;
  outcome: CompressionAttemptOutcome;
  stopReason?: string;
  errorType?: string;
  admittedTokens?: number;
  budgetTokens?: number;
}

interface CompressionRefusalPlanRecord extends CompressionRefusalVariantRecord {
  curveLabel: string;
  accountingSource:
    | 'complete_normalized_request_bound'
    | 'canonical_provider_usage_plus_expansion';
  canonicalRequestBoundTokens: number;
  deterministicInputBoundTokens: number;
  expansionDeltaTokens: number;
  boundedInputTokens: number;
  outputReserveTokens: number;
  admittedTokens: number;
  budgetTokens: number;
  disposition: 'provider_attempt' | 'admission_rejected';
}

interface CompressionQuarantineEventBase {
  eventId?: string;
  sequence?: number;
  key: string;
  created: number;
}

type CompressionQuarantineEvent =
  // Read compatibility for the unapproved hardening commit. A claim without
  // a matching exhausted event is intentionally ignored: in-flight work is
  // process-local now and a crash must never suppress a family forever.
  | (CompressionQuarantineEventBase & {
      kind: 'claim';
      record: CompressionRefusalQuarantineRecord;
    })
  | (CompressionQuarantineEventBase & {
      kind: 'clear';
      targetClaimId: string;
    })
  | (CompressionQuarantineEventBase & {
      kind: 'exhausted';
      record?: CompressionRefusalQuarantineRecord;
      targetClaimId?: string;
      outcomes: CompressionRefusalOutcomeRecord[];
    })
  | (CompressionQuarantineEventBase & {
      kind: 'alert_pending';
      targetClaimId: string;
      alertKey: string;
    })
  | (CompressionQuarantineEventBase & {
      kind: 'alert_sent';
      targetClaimId: string;
      alertKey: string;
      pendingEventId: string;
    })
  | (CompressionQuarantineEventBase & {
      kind: 'checkpoint';
      active: SerializedCompressionQuarantine[];
    });

type NewCompressionQuarantineEvent = CompressionQuarantineEvent extends infer Event
  ? Event extends CompressionQuarantineEvent
    ? Omit<Event, 'eventId' | 'sequence'>
    : never
  : never;

interface ActiveCompressionQuarantine {
  generationId: string;
  record: CompressionRefusalQuarantineRecord;
  outcomes: CompressionRefusalOutcomeRecord[];
  pendingAlert?: { eventId: string; alertKey: string };
  sentAlertKeys: Set<string>;
}

interface SerializedCompressionQuarantine {
  generationId: string;
  record: CompressionRefusalQuarantineRecord;
  outcomes: CompressionRefusalOutcomeRecord[];
  pendingAlert?: { eventId: string; alertKey: string };
  sentAlertKeys: string[];
}

interface CompressionOperationBranch {
  name: string;
  generation: number;
  strategyGeneration: number;
}

interface LoadedBranchIdentity extends CompressionOperationBranch {
  store: JsStore;
  namespace: string;
}

interface CompressionInFlightResult {
  error?: unknown;
}

interface RecallCurveVariant {
  parent: SummaryEntry;
  children: SummaryEntry[];
  leafCoverageHash: string;
  request: NormalizedRequest;
  requestHash: string;
  deterministicInputBoundTokens: number;
}

interface CompressionAttemptTrace {
  curveLabel: string;
  recallIds: string[];
  recallLevels: number[];
  expandedParentId?: string;
  expandedChildIds?: string[];
  leafCoverageHash: string;
  requestHash: string;
  messageCount: number;
  estimatedTokens: number;
  renderedTokens?: number;
  stopReason?: string;
  refusalCategory?: string;
  latencyMs: number;
  persisted: boolean;
  outcome?: CompressionAttemptOutcome | 'success';
  errorType?: string;
  admittedTokens?: number;
  budgetTokens?: number;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * Chronicle state mutation is synchronous but not transactional across a
 * read/project/append sequence. Serialize those short sequences for strategy
 * instances sharing one JsStore in this process. Branch is part of the key so
 * branch-scoped projections never block or overwrite one another.
 */
const compressionStateLocks = new WeakMap<JsStore, Map<string, Promise<void>>>();
const compressionInFlight = new WeakMap<JsStore, Map<string, Promise<CompressionInFlightResult>>>();
const COMPRESSION_BUDGET_ACCOUNTING_VERSION = 2;
const COMPRESSION_BUDGET_ACCOUNTING_SOURCE =
  'provider_total_input+positive_serialized_delta_or_complete_normalized_request_utf8_bound+output_reserve:v2';
const COMPRESSION_QUARANTINE_CHECKPOINT_EVENTS = 256;
const COMPRESSION_QUARANTINE_MAX_ACTIVE = 1_024;

async function withCompressionStateLock<T>(
  store: JsStore,
  branchName: string,
  stateId: string,
  work: () => T | Promise<T>,
): Promise<T> {
  let locks = compressionStateLocks.get(store);
  if (!locks) {
    locks = new Map();
    compressionStateLocks.set(store, locks);
  }
  const lockKey = `${branchName}\u0000${stateId}`;
  const previous = locks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(lockKey, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(lockKey) === tail) locks.delete(lockKey);
  }
}

/**
 * Point-in-time snapshot of compression progress, returned from
 * `AutobiographicalStrategy.getProgressSnapshot()`. External observers
 * (warmup scripts, dashboards) use this to track convergence without
 * reaching into the strategy's protected fields.
 */
export interface AutobiographicalProgressSnapshot {
  /** All chunks the strategy is tracking, compressed or not. */
  totalChunks: number;
  /** Chunks that already have an L1 summary. */
  chunksCompressed: number;
  /** Chunks queued for L1 compression. */
  l1QueueLength: number;
  /** Pending L1→L2 and L2→L3 merges. */
  mergeQueueLength: number;
  /** Stored summary counts per level (1 = raw L1, 2 = L1→L2 merge, 3 = L2→L3 merge). */
  summaryCounts: { l1: number; l2: number; l3: number };
  /** True if a compression or merge LLM call is currently in flight. */
  pending: boolean;
}

/**
 * Validate + normalize the optional V2 pin fold-depth bounds. Returns only the
 * fields that are present and valid (non-negative integers), so a classic pin
 * with no bounds persists exactly as before. `level` takes precedence over
 * `maxLevel` (pin-at-k is stronger than a cap), so they're never both emitted.
 */
function normalizePinLevels(opts?: PinLevelOptions): { level?: number; maxLevel?: number } {
  const clean = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
  const level = clean(opts?.level);
  if (level !== undefined) return { level };
  const maxLevel = clean(opts?.maxLevel);
  return maxLevel !== undefined ? { maxLevel } : {};
}

/**
 * Drop empty text blocks (`{type:'text', text:''}` or whitespace-only). The
 * Anthropic API rejects them with 400 "text content blocks must be non-empty",
 * which — thrown inside the speculative-compression drain — halts ALL
 * compression. Non-text blocks (tool_use/tool_result/image) pass through
 * unchanged, so tool pairing is preserved; callers drop any message left with
 * an empty content array.
 */
function stripEmptyTextBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.filter((b) => {
    if (b.type !== 'text') return true;
    const text = (b as { text?: unknown }).text;
    return typeof text === 'string' && text.trim().length > 0;
  });
}

/**
 * Strip `thinking` / `redacted_thinking` blocks from RAW messages entering
 * compression input.
 *
 * REVISED POLICY (2026-07-16). The June rationale ("signed thinking is only
 * valid verbatim in the turn that produced it") is DISPROVEN for verbatim
 * carriers: the June graft experiment showed signatures verify re-assembled
 * in a different context, and the 2026-07-16 replay experiment showed a
 * deterministically-refusing compress request PASSES once recall pairs carry
 * their summaries' signed reasoning (text-only recall = reasoning_extraction;
 * with carriers = end_turn). Recall-pair answers therefore now DO carry
 * reasoning (summaryAnswerContent) and the request-final map no longer strips
 * thinking.
 *
 * RAW message thinking is still stripped here, at insertion, for a narrower,
 * validated reason: the compression pipeline rewrites raw turns
 * (splitMixedToolMessages / collapse / truncation), and the API rejects
 * thinking blocks whose turn shape differs from the original response
 * ("thinking blocks ... cannot be modified", observed 2026-07-16 on the
 * `full` replay arm). Passing raw thinking through requires keeping those
 * turns byte-identical — a follow-up experiment, not a blanket strip removal.
 */
function stripThinkingBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
}

/**
 * Capture the summarizer's verbatim response blocks for storage on the
 * SummaryEntry — but only when the response carried reasoning blocks.
 *
 * Fable-5/Sonnet-5-class models require encrypted reasoning tokens
 * (signed `thinking` / `redacted_thinking` blocks) to be supplied back
 * alongside the generated text whenever that text is replayed as an
 * assistant turn. Summaries are replayed in the agent's own voice, so
 * dropping the reasoning here breaks every later fold/recall emission.
 * Blocks are kept in provider order and must never be mutated —
 * signatures cover block content verbatim.
 *
 * Returns undefined for reasoning-free responses (non-thinking models):
 * plain text turns need no accompaniment, and we avoid duplicating the
 * text into the store for nothing.
 */
/**
 * Carrier transport fallback (2026-07-16): carriers-in-summarizer-requests is
 * the DEFAULT (validated: text-only recall pairs deterministically refused
 * where carrier-bearing ones pass). Text-only is the DEGRADED mode, entered
 * only when the transport itself rejects the carrier blocks — an
 * invalid_request 400 about thinking blocks (e.g. the "cannot be modified"
 * class), never a policy refusal. Retry once, stripped, loudly.
 */
function isCarrierTransportRejection(error: unknown): boolean {
  const e = error as { httpStatus?: number; type?: string; message?: string };
  const msg = (e?.message ?? '').toLowerCase();
  const badRequest =
    e?.httpStatus === 400 ||
    (typeof e?.type === 'string' && e.type.toLowerCase().includes('invalid')) ||
    msg.includes('invalid_request');
  return badRequest && (msg.includes('thinking') || msg.includes('reasoning'));
}

function requestCarriesReasoning(request: NormalizedRequest): boolean {
  return request.messages.some(m =>
    m.content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking'),
  );
}

function stripReasoningFromRequest(request: NormalizedRequest): NormalizedRequest {
  return {
    ...request,
    messages: request.messages
      .map(m => ({ ...m, content: stripThinkingBlocks(m.content) }))
      .filter(m => m.content.length > 0),
  };
}

/**
 * Strip a literal `<thinking>…</thinking>` preamble that some models emit as
 * PLAIN TEXT at the start of a summary generation despite the "no preamble"
 * instruction (observed on Claude 3 Opus — `<thinking>` before `<memory>` —
 * and on Opus 4 L3→L4 merges, 2026-08-03). Stored verbatim it renders as
 * meta-text in every recall and eats the entry's token budget. This strips
 * only a LEADING tag pair (plus one unclosed-leading-tag degenerate case);
 * mid-content mentions of thinking tags are content, not preamble, and are
 * left alone. Native `thinking` content blocks are unaffected — they are
 * filtered structurally and carried via captureResponseContent.
 */
export function stripThinkingPreamble(text: string): string {
  const closed = text.replace(/^\s*<thinking>[\s\S]*?<\/thinking>\s*/i, '');
  if (closed !== text) return closed;
  // Degenerate: opening tag with no close — the whole generation was
  // "thinking". Treat as empty so the empty-summary guards skip it.
  if (/^\s*<thinking>/i.test(text) && !/<\/thinking>/i.test(text)) return '';
  return text;
}

function summarizeTelemetryMessages(
  messages: ReadonlyArray<{ participant: string; content: ContentBlock[] }>,
): Array<{
  participant: string;
  blockCount: number;
  blockTypes: string[];
  textChars: number;
}> {
  return messages.map((message) => ({
    participant: message.participant,
    blockCount: message.content.length,
    blockTypes: message.content.map((block) => block.type),
    textChars: message.content
      .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
      .reduce((total, block) => total + block.text.length, 0),
  }));
}

function summarizeTelemetryText(
  text: string | undefined,
): { present: boolean; textChars: number } {
  return {
    present: !!text && text.length > 0,
    textChars: text?.length ?? 0,
  };
}

function captureResponseContent(content: ContentBlock[]): ContentBlock[] | undefined {
  const hasReasoning = content.some(
    (b) => b.type === 'thinking' || b.type === 'redacted_thinking',
  );
  if (!hasReasoning) return undefined;
  // Reasoning + text only: a one-shot summarize response should never
  // contain tool_use etc., but drop anything else defensively — it has
  // no place in a replayed summary turn.
  return content.filter(
    (b) => b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'text',
  );
}

/**
 * The constructor's conditional `??=` default blocks, expressed as the values
 * they would fill in. Gated exactly as they were when they ran as statements:
 * `hierarchical` defaults to true before it is read as a gate, and
 * `adaptiveResolution` is read as the caller left it.
 */
function conditionalLibraryDefaults(supplied: Record<string, unknown>): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    // Hierarchical is on by default; set hierarchical: false to use legacy single-level
    hierarchical: true,
  };
  if (supplied.hierarchical ?? true) {
    defaults.mergeThreshold = 6;
    defaults.summaryTargetTokens = 2000;
    defaults.l3BudgetTokens = 30000;
    defaults.l2BudgetTokens = 30000;
    defaults.l1BudgetTokens = 30000;
  }
  // Adaptive-resolution defaults
  if (supplied.adaptiveResolution) {
    defaults.foldingStrategy = 'flat-profile';
    defaults.compressionSlackRatio = 0.1;
    defaults.speculativeProduction = true;
  }
  // Compression-lane prompt caching (issue #37)
  defaults.compressionCacheMarkers = true;
  defaults.compressionCacheTtl = '1h';
  return defaults;
}

/**
 * The `??=` half of those blocks: a default only fills a key the layers left
 * nullish. Narrowing the layer to those keys is what keeps `??=` semantics
 * available inside a spread-fidelity resolve, where a top layer would
 * otherwise overwrite a value the caller did supply.
 */
function defaultsForKeysLeftNullish(
  supplied: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const fills: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    const current = supplied[key];
    if (current === undefined || current === null) fills[key] = value;
  }
  return fills;
}

/**
 * Autobiographical chunking strategy.
 * Compresses old conversation chunks into summaries in the model's own words.
 * Recent context stays untouched.
 *
 * When `hierarchical` is enabled, uses a 3-level compression pyramid:
 * L1 (raw→summary) → L2 (merge N L1s) → L3 (merge N L2s)
 * with anti-redundancy filtering and budget carryover.
 */
export class AutobiographicalStrategy implements ResettableStrategy {
  readonly name: string = 'autobiographical';

  get maxMessageTokens(): number { return this.config.maxMessageTokens; }

  protected config: AutobiographicalConfig;
  /**
   * Which layer supplied each effective config key — 'library-default' or
   * 'caller'. Keyed exactly as `config` is. Hosts that stack further layers of
   * their own can produce the same map for the merged whole by running their
   * layers through `resolveEffectiveConfig` directly.
   */
  readonly configProvenance: Record<string, string>;
  /** The effective-config report this instance still owes stderr, or null once
   *  it has been emitted — or immediately, when `logEffectiveConfig` is off.
   *  See reportEffectiveConfigOnce for why the emission waits. */
  private unreportedEffectiveConfig: EffectiveConfigReport | null;
  protected chunks: Chunk[] = [];
  protected pendingCompression: Promise<void> | null = null;
  protected compressionQueue: number[] = [];
  protected _compressionCount = 0;
  /**
   * Monotonic counter of tick() operations that actually processed a queue item
   * (compressed a chunk or executed a merge). `driveSpeculativeDrain` recurses
   * while this advances — a length-delta check would falsely read "no progress"
   * when a productive tick also enqueues a follow-on item (net queue length
   * unchanged), halting the drain with work still queued.
   */
  protected _drainProgress = 0;

  /**
   * Chunks (keyed by their LAST message id — chunk membership is immutable
   * once closed) whose L1 was explicitly demanded by a picker `produce` op.
   * Demanded chunks bypass the `l1HoldbackChunks` window in `rebuildChunks`:
   * speculation waits, demand doesn't. Entries become inert once the chunk
   * compresses (compressed chunks are never re-queued), so no cleanup needed.
   */
  protected _demandedL1Chunks = new Set<MessageId>();

  /**
   * In-memory mirror of the persisted chunk records (autobio:chunks slot).
   * Loaded in `loadPersistedState`, appended to when a chunk closes,
   * updated by ID when its L1 lands.
   */
  protected chunkRecords: ChunkRecord[] = [];
  protected chunkIdCounter = 0;
  /**
   * Fail-closed latch: set when most persisted records resolve to zero live
   * messages (the messages-chain-break signature). While set, NO compression
   * runs — duplicate memories are strictly worse than delayed compression.
   */
  protected chunkRecordsOrphaned = false;
  private _orphanWarned = false;
  /** Record ids whose compression was refused by the L1 overlap guard. */
  private _overlapBlocked = new Set<string>();

  /** Consecutive retryable-server-error (5xx) merge failures tolerated on
   *  the same queue head before routing into the bounded rejection policy.
   *  High enough that a real transient episode (429-adjacent blips, brief
   *  outages) never burns attempts; low enough that a week-long provider
   *  fault (rhys 2026-08-06: 514 identical 500s) converges in ~an hour of
   *  ticks instead of never. */
  static readonly MERGE_SERVER_ERROR_STREAK_LIMIT = 12;

  /** Distinct quarantined request shapes tolerated per chunk before the
   *  quarantine goes sticky by chunk hash. Shape changes legitimately
   *  invalidate a quarantine (a chunk refused text-only may pass once
   *  carriers/tools arrive) — but unbounded shape drift is the 2026-08-06
   *  ear-loop: frontier churn minted a new shape every pass at ~\$0.5 a
   *  cycle. Three shapes is enough for every legitimate healing path
   *  observed (text-only → +carriers → +tools). */
  static readonly CHUNK_QUARANTINE_SHAPE_CAP = 3;

  // Hierarchical state
  protected summaries: SummaryEntry[] = [];
  protected summaryIdCounter = 0;
  protected mergeQueue: Array<{ level: SummaryLevel; sourceIds: string[]; attempts?: number; lastStopReason?: string; lastOutcome?: string; hadRefusal?: boolean; serverErrorStreak?: number }> = [];

  /**
   * Live merge-quarantine records keyed by sha256(sourceIds). Loaded from
   * the chronicle on (re)initialize; see MergeQuarantineRecord.
   */
  protected mergeQuarantine = new Map<string, MergeQuarantineRecord>();
  private mergeQuarantineAlarmLastAt = 0;
  private mergeQuarantineAlarmActive = false;
  protected nativeFormatter = new NativeFormatter();

  /** Message ID from which the head window starts. null = start from message 0. */
  protected headWindowStartId: string | null = null;
  /** Cached result of getHeadWindowStartIndex to avoid repeated linear scans. */
  private _cachedHeadStartIndex: { id: string | null; msgCount: number; result: number } | null = null;

  /** Chronicle store for persistent state. Set in `initialize()`. */
  protected store: JsStore | null = null;
  /** Namespace for state-id scoping. Set in `initialize()`. */
  protected ns: string = '';
  protected get summariesStateId(): string { return `${this.ns}/autobio:summaries`; }
  protected get chunksStateId(): string { return `${this.ns}/autobio:chunks`; }
  /** Memories are identity-bearing: a substitute model writing summaries in
   *  the agent's voice corrupts the record. If the configured model is
   *  missing, refuse LOUDLY instead of silently substituting a default -
   *  everyone must know that memory formation is halted. */
  protected requireCompressionModel(): string {
    const m = this.config.compressionModel;
    if (!m) {
      const msg = "autobio: compressionModel is NOT configured - refusing to write "
        + "memories with a substitute model. Memory formation is halted until the "
        + "recipe names the model whose voice these memories are.";
      console.error(msg);
      logCompressionCall({ event: "no-compression-model", fatal: true });
      throw new Error(msg);
    }
    return m;
  }
  protected get counterStateId(): string { return `${this.ns}/autobio:counter`; }
  protected get mergeQueueStateId(): string { return `${this.ns}/autobio:mergeQueue`; }
  protected get mergeQuarantineStateId(): string { return `${this.ns}/autobio:merge-quarantine`; }
  protected get pinsStateId(): string { return `${this.ns}/autobio:pins`; }
  protected get resolutionsStateId(): string { return `${this.ns}/autobio:resolutions`; }
  protected get locksStateId(): string { return `${this.ns}/autobio:locks`; }
  protected get calibrationStateId(): string { return `${this.ns}/autobio:calibration`; }
  /** Legacy snapshot used by the unapproved first implementation. Read-only. */
  protected get compressionRefusalQuarantineStateId(): string {
    return `${this.ns}/autobio:compression-refusal-quarantine`;
  }
  protected get compressionRefusalQuarantineLedgerStateId(): string {
    return `${this.ns}/autobio:compression-refusal-quarantine-events`;
  }

  /** Branch-scoped projection of the append-only quarantine event ledger. */
  private compressionRefusalQuarantine = new Map<string, ActiveCompressionQuarantine>();
  /** Incremented on every initialize, including every ContextManager branch switch. */
  private compressionBranchGeneration = 0;
  /**
   * Branch whose derived mirrors completed initialization. This is deliberately
   * absent while initialize() is running: partially loaded summaries/chunks/
   * queues are never eligible for use by another entrypoint.
   */
  private loadedBranchIdentity: LoadedBranchIdentity | null = null;
  /** Identity temporarily authorized to perform initialization repairs only. */
  private initializingBranchIdentity: LoadedBranchIdentity | null = null;

  /** Protected ranges (pins + documents). Loaded from chronicle in initialize. */
  protected pins: ProtectedRange[] = [];
  /** Monotonically increasing counter for pin ids. Persisted as part of the pins snapshot. */
  protected pinIdCounter = 0;

  /**
   * Per-message resolution state for the adaptive-resolution picker.
   *  - Key: MessageId
   *  - Value: currentResolution (0 = render raw, k>0 = render L_k recall)
   *
   * Maintained only when `config.adaptiveResolution` is true. Loaded from
   * the chronicle on `initialize()` and persisted via the resolutions state
   * slot so resolutions survive process restart and follow branches.
   */
  protected resolutions: Map<MessageId, number> = new Map();

  /**
   * Per-message lock state for the adaptive-resolution picker. Set via the
   * programmatic `lockChunk(id)` API on the strategy. Locked messages are
   * skipped by the picker. Persisted via the locks state slot.
   */
  protected locked: Set<MessageId> = new Set();

  /** Lazy picker instance, built from config.foldingStrategy. */
  private _adaptivePicker: Picker | null = null;
  /** foldingStrategy as resolved at construction — the drift baseline for
   *  [picker-config-drift]. */
  private _constructedFoldingStrategy: AutobiographicalConfig['foldingStrategy'];

  /** A future usable window the KV-stable controller is preparing while the
   * caller keeps compiling against its current hard window. */
  private preparedWindowTokens: number | undefined;
  private lastFrontierTokens: number | undefined;
  private transitionBlocked: HotContextSettingsStatus['blocked'] | undefined;
  private runtimeTransitionPaceTokens: number | undefined;
  /** Diagnostics from the most recent dry-run select. Not persisted. */
  private _lastPreview: PreviewResult | undefined;
  /** Serializes previews against each other (see previewContext). */
  private _previewInFlight = false;

  constructor(config: AutobiographicalOptions = {}) {
    const suppliedLayers: ConfigLayer[] = [
      { source: 'library-default', values: { ...DEFAULT_AUTOBIOGRAPHICAL_CONFIG } as Record<string, unknown> },
      { source: 'caller', values: config as Record<string, unknown> },
    ];
    // A subclass that forces values gets its OWN layer above the caller, so the
    // provenance map never attributes a library-enforced value to the host that
    // did not ask for it (KnowledgeStrategy's `hierarchical`).
    const enforcedLayer = this.enforcedConfigLayer();
    if (enforcedLayer) suppliedLayers.push(enforcedLayer);
    // SPREAD FIDELITY, deliberately. This resolve reproduces the constructor's
    // historical `{ ...DEFAULT_AUTOBIOGRAPHICAL_CONFIG, ...config }` key for
    // key — a caller key explicitly set to `undefined` or `null` erases the
    // default and stays present, exactly as the spread left it — so resolving
    // through the layers changed no effective value for any caller. The
    // host-facing `'skip-nullish'` reading is a different function of the same
    // inputs (see ConfigResolutionSemantics); it is not what this wiring means.
    const supplied = resolveEffectiveConfig(suppliedLayers, 'spread-fidelity');
    const resolved = resolveEffectiveConfig(
      [
        ...suppliedLayers,
        {
          source: 'library-default',
          values: defaultsForKeysLeftNullish(supplied.effective, conditionalLibraryDefaults(supplied.effective)),
        },
      ],
      'spread-fidelity',
    );
    // The resolver is schema-agnostic by design, so it hands back an untyped
    // bag; the library-default layers above supply every non-optional key of
    // AutobiographicalConfig that the caller did not itself override, which is
    // what makes this narrowing as sound as the spread it replaces.
    this.config = resolved.effective as unknown as AutobiographicalConfig;
    this.configProvenance = resolved.provenance;
    this.unreportedEffectiveConfig = this.config.logEffectiveConfig ? resolved : null;
    // The solver committed to at construction. buildPicker compares the live
    // config against this on every compile: a runtime mutation (e.g. an
    // override merge carrying `foldingStrategy: undefined`) silently swaps
    // the solver — and with it the entire cache-stability policy — for that
    // compile. That drift must be LOUD (see [picker-config-drift]).
    this._constructedFoldingStrategy = this.config.foldingStrategy;
  }

  /**
   * Config this class forces regardless of what the caller passed, as its own
   * named layer above 'caller'. Base classes force nothing; a subclass whose
   * construction overrides caller input declares it here instead of smuggling
   * the value through the caller's own layer, where the provenance map would
   * report the host as its source.
   *
   * Called from the base constructor, so an override must be a pure prototype
   * method: it runs BEFORE the subclass's own field initializers.
   */
  protected enforcedConfigLayer(): ConfigLayer | null {
    return null;
  }

  /**
   * One-shot operator report of what configuration actually governs this
   * strategy: every effective key with the layer that supplied it. Opt-in via
   * `logEffectiveConfig`. Structured single line on stderr, the same door the
   * library's other structured diagnostics use.
   *
   * THE LINE CARRIES THREE MAPS BECAUSE JSON HAS NO `undefined`. Spread
   * fidelity keeps a caller's own `undefined` key present in the effective
   * config (see ConfigResolutionSemantics), and `JSON.stringify` drops exactly
   * those keys — so serializing `effective` alone would emit a report whose
   * provenance names keys the effective map does not have. `presentAsUndefined`
   * lists them instead, computed HERE from the resolved values rather than
   * carried on EffectiveConfigReport, so the list cannot drift from the map it
   * describes and needs no special case for a key an enforced or host layer
   * supplied as undefined. Its invariant, over the emitted line:
   *
   *   keys(provenance) === keys(effective) ∪ presentAsUndefined, disjointly
   *
   * `null` is a JSON value and needs none of this: it rides `effective` as
   * itself, with its own provenance, and is never present-as-undefined.
   *
   * DEFERRED PAST CONSTRUCTION, and it has to be: `name` is a field
   * initializer, and a subclass's initializers run only AFTER the base
   * constructor returns, so a report emitted where the config resolves would
   * label every KnowledgeStrategy instance 'autobiographical'. Emitting on
   * first use instead costs nothing an operator can observe — `initialize` is
   * the one gate every real use passes, since every other entrypoint throws
   * until a branch is loaded — and it needs no cooperation from subclasses,
   * which a post-construction hook would.
   */
  private reportEffectiveConfigOnce(): void {
    const report = this.unreportedEffectiveConfig;
    if (!report) return;
    this.unreportedEffectiveConfig = null;
    const presentAsUndefined = Object.keys(report.effective).filter(
      (key) => report.effective[key] === undefined,
    );
    console.error(JSON.stringify({
      event: 'config:effective',
      strategy: this.name,
      effective: report.effective,
      provenance: report.provenance,
      presentAsUndefined,
    }));
  }
  /**
   * Explicit operator escape hatch. A retry remains canonical-first; clearing
   * this state only permits the same as-of request family to be issued again.
   */
  async clearCompressionRefusalQuarantine(key?: string): Promise<void> {
    this.requireLoadedBranch('clearCompressionRefusalQuarantine');
    if (!this.store) return;
    const sourceBranch = this.captureCompressionBranch();
    // Capture exhaustion identities at invocation. A delayed clear can
    // tombstone only those exact generations; it cannot erase a newer one.
    const observed = this.readCompressionQuarantineProjection();
    const targets = key === undefined
      ? [...observed.values()].map((active) => ({
          key: active.record.key, generationId: active.generationId,
        }))
      : observed.has(key)
        ? [{ key, generationId: observed.get(key)!.generationId }]
        : [];
    await withCompressionStateLock(
      this.store,
      sourceBranch.name,
      this.compressionRefusalQuarantineLedgerStateId,
      () => {
      if (!this.isCompressionBranchCurrent(sourceBranch)) return;
      const current = this.readCompressionQuarantineProjection();
      for (const target of targets) {
        if (current.get(target.key)?.generationId !== target.generationId) continue;
        this.appendCompressionQuarantineEvent({
          kind: 'clear',
          key: target.key,
          targetClaimId: target.generationId,
          created: Date.now(),
        });
      }
      this.compressionRefusalQuarantine = this.readCompressionQuarantineProjection();
      this.checkpointCompressionQuarantineIfNeeded(sourceBranch);
    });
  }

  /**
   * Non-committing "what would the context look like at these settings".
   *
   * Runs a dry-run select at `budget`, optionally with a scoped config swap for
   * knobs that are otherwise recipe-and-restart only (tail, head window, chunk
   * size, merge threshold, folding strategy...). Commits nothing: no resolution
   * persistence, no compression enqueue, no transition bookkeeping.
   *
   * Two things this deliberately does NOT do:
   *  - It does not apply anything. Applying is `updateHotContextSettings` (for
   *    the four hot keys) or a restart (for everything else).
   *  - It does not apply anything. Applying is `updateHotContextSettings` (for
   *    the four hot keys) or a restart (for everything else).
   *
   * Concurrency: safe today only because the whole select path is
   * SYNCHRONOUS. `this.config` is swapped for the duration, so if select ever
   * gains an `await`, a background tick() could land mid-preview and compress
   * at the overridden chunk size. The `_previewInFlight` guard below is
   * currently unreachable for that reason — it is kept deliberately, as the
   * tripwire that would fire the day someone makes this path async.
   */
  previewContext(
    store: MessageStoreView,
    log: ContextLogView,
    budget: TokenBudget,
    overrides?: AutobiographicalOptions,
    opts?: { render?: boolean },
  ): PreviewResult {
    this.requireLoadedBranch('previewContext');
    if (this._previewInFlight) {
      throw new Error('previewContext is already running; previews must not overlap');
    }
    this._previewInFlight = true;
    const savedConfig = this.config;
    const savedPicker = this._adaptivePicker;
    const savedHeadCache = this._cachedHeadStartIndex;
    // selectAdaptive has FOUR OverBudgetError sites — an early head+tail check
    // that fires before the picker even runs, the post-pick check, and two
    // late render-stage checks. Rather than gate each (fragile, and a new site
    // would silently break previews), restore bookkeeping here in `finally`
    // and convert any throw into a report below.
    const savedFrontier = this.lastFrontierTokens;
    const savedBlocked = this.transitionBlocked;
    const savedKvStable = this._lastKvStable;
    // select() calls rsBegin(), which RESETS the render-stats family. Those feed
    // getRenderStats() -> /debug/context/makeup and the Context panel, so a dry
    // run would leave the operator's live segment breakdown showing numbers from
    // a hypothetical compile until the next real one. Save and restore them:
    // "commits nothing" has to include in-memory observability, not just
    // Chronicle.
    // `_lastRenderStats` is the one that matters: select() ends with
    // `_lastRenderStats = r; _rs = null`, and getRenderStats() reads
    // _lastRenderStats. Guarding only _rs (null by then) protected nothing.
    const savedRs = this._rs;
    const savedLastRs = this._lastRenderStats;
    const savedDrops = this._uncoveredDrops;
    const savedEmitted = this._emittedSummaryIds;
    const savedPlannedTokens = this._plannedTokens;
    const savedPlannedMeta = this._plannedMeta;
    this._lastPreview = undefined;
    try {
      // Drop explicit undefined/null overrides BEFORE spreading: a spread
      // with `foldingStrategy: undefined` ERASES the live key and silently
      // downgrades the solver to flat-profile for this preview's compile
      // (JSON-driven callers — fleet hub, panel forms — can produce exactly
      // that shape). Absence is the only way to mean "keep the live value".
      const cleaned = overrides
        ? Object.fromEntries(
            Object.entries(overrides).filter(([, v]) => v !== undefined && v !== null),
          )
        : undefined;
      if (cleaned && Object.keys(cleaned).length > 0) {
        this.config = { ...savedConfig, ...cleaned };
        // Both memoize config-derived values, so a swapped config must not see
        // a cache built under the old one.
        this._adaptivePicker = null;
        this._cachedHeadStartIndex = null;
      }
      let rendered: ContextEntry[] | undefined;
      try {
        const out = this.select(store, log, budget, { dryRun: true });
        // Only retained on request: these are full rendered entries and can be
        // megabytes on a large store.
        if (opts?.render) rendered = out;
      } catch (err) {
        if (!(err instanceof OverBudgetError)) throw err;
        // Read through a cast: control-flow narrowing still has this pinned to
        // `undefined` from the reset above, but selectAdaptive may have filled
        // it in before a late render-stage throw.
        const partial = this._lastPreview as PreviewResult | undefined;
        // Infeasible at this budget. That is an ANSWER, not a failure — it is
        // the whole reason to preview before applying. Report it with the
        // diagnostics that explain which component does not fit.
        return {
          finalTokens: err.actual,
          budgetTokens: err.budget,
          fits: false,
          exhausted: true,
          headTokens: err.diagnostics.headTokens,
          tailTokens: err.diagnostics.tailTokens,
          middleTokens: err.diagnostics.middleTokens,
          middleChunkCount: err.diagnostics.middleChunkCount,
          deepestLevel: err.diagnostics.deepestLevel,
          // An early throw means no fold plan was computed at all; a late one
          // means we have it.
          resolutions: partial?.resolutions ?? {},
          moves: partial?.moves ?? 0,
          producedCount: partial?.producedCount ?? 0,
        };
      }
      // Cast on read: control-flow narrowing still has this pinned to
      // `undefined` from the reset above, but selectAdaptive fills it in.
      const preview = this._lastPreview as PreviewResult | undefined;
      if (!preview) {
        // selectHierarchical path: no picker, so no fold plan to preview.
        throw new Error(
          'previewContext requires adaptiveResolution; the hierarchical path has no fold plan to preview',
        );
      }
      // Segment breakdown for the hypothetical compile, captured BEFORE the
      // finally block restores the live one. Lets a caller show the previewed
      // head/middle/tail split without re-deriving it.
      return {
        ...preview,
        // Read _lastRenderStats, not _rs: select() has already committed and
        // nulled _rs by this point.
        ...(opts?.render
          ? { entries: rendered, stats: this._lastRenderStats ?? undefined }
          : {}),
      };
    } finally {
      this.config = savedConfig;
      this._adaptivePicker = savedPicker;
      this._cachedHeadStartIndex = savedHeadCache;
      this.lastFrontierTokens = savedFrontier;
      this.transitionBlocked = savedBlocked;
      this._lastKvStable = savedKvStable;
      this._rs = savedRs;
      this._lastRenderStats = savedLastRs;
      this._uncoveredDrops = savedDrops;
      this._emittedSummaryIds = savedEmitted;
      this._plannedTokens = savedPlannedTokens;
      this._plannedMeta = savedPlannedMeta;
      this._lastPreview = undefined;
      this._previewInFlight = false;
    }
  }

  getHotContextSettings(): HotContextSettingsStatus {
    // A never-attached strategy may be configured/inspected before open().
    // Once attached, derived frontier fields are branch-scoped and guarded.
    if (this.store) this.requireLoadedBranch('getHotContextSettings');
    return {
      tailTokens: this.config.recentWindowTokens,
      ...((this.runtimeTransitionPaceTokens ?? this.config.kvStableReachTokens) !== undefined
        ? { transitionPaceTokens: this.runtimeTransitionPaceTokens ?? this.config.kvStableReachTokens }
        : {}),
      ...(this.preparedWindowTokens !== undefined
        ? { preparedWindowTokens: this.preparedWindowTokens }
        : {}),
      ...(this.lastFrontierTokens !== undefined
        ? { currentFrontierTokens: this.lastFrontierTokens }
        : {}),
      prepared:
        this.preparedWindowTokens === undefined ||
        (this.lastFrontierTokens !== undefined &&
          this.lastFrontierTokens <= this.preparedWindowTokens),
      ...(this.transitionBlocked ? { blocked: this.transitionBlocked } : {}),
    };
  }

  updateHotContextSettings(update: HotContextSettingsUpdate): HotContextSettingsStatus {
    if (update.tailTokens !== undefined) {
      if (!Number.isSafeInteger(update.tailTokens) || update.tailTokens < 0) {
        throw new Error('tailTokens must be a non-negative safe integer');
      }
    }
    if (update.transitionPaceTokens !== undefined && update.transitionPaceTokens !== null) {
      if (!Number.isSafeInteger(update.transitionPaceTokens) || update.transitionPaceTokens <= 0) {
        throw new Error('transitionPaceTokens must be a positive safe integer');
      }
    }
    if (update.preparedWindowTokens !== undefined) {
      if (update.preparedWindowTokens !== null) {
        if (!this.config.adaptiveResolution || this.config.foldingStrategy !== 'kv-stable') {
          throw new Error(
            'Gradual context-window transitions require adaptiveResolution with foldingStrategy "kv-stable"',
          );
        }
        if (!Number.isSafeInteger(update.preparedWindowTokens) || update.preparedWindowTokens <= 0) {
          throw new Error('preparedWindowTokens must be a positive safe integer');
        }
      }
    }
    if (this.store) this.requireLoadedBranch('updateHotContextSettings');
    if (update.tailTokens !== undefined) this.config.recentWindowTokens = update.tailTokens;
    if (update.transitionPaceTokens !== undefined) {
      this.runtimeTransitionPaceTokens = update.transitionPaceTokens ?? undefined;
    }
    if (update.preparedWindowTokens !== undefined) {
      this.preparedWindowTokens = update.preparedWindowTokens ?? undefined;
      this.transitionBlocked = undefined;
    }
    return this.getHotContextSettings();
  }

  /**
   * Lock a message so the adaptive picker won't change its resolution.
   * No-op when adaptiveResolution is false. Set-only programmatic API per
   * the design (no agent-facing tool in V1). Persisted to chronicle.
   */
  lockChunk(id: MessageId): void {
    this.requireLoadedBranch('lockChunk');
    if (this.locked.has(id)) return;
    this.locked.add(id);
    this.persistLocks();
  }

  /**
   * Unlock a message so the adaptive picker may again change its resolution.
   * No-op when adaptiveResolution is false. Persisted to chronicle.
   */
  unlockChunk(id: MessageId): void {
    this.requireLoadedBranch('unlockChunk');
    if (!this.locked.has(id)) return;
    this.locked.delete(id);
    this.persistLocks();
  }

  /**
   * Ingestion-time chunking hook.
   *
   * Active only when `config.adaptiveResolution` is true. Inspects the
   * incoming message's text content; if its approximate token count
   * exceeds the chunker's threshold, splits it into shards with a stable
   * shared `bodyGroupId`. The framework then stores each shard as its own
   * StoredMessage, and the render path concatenates them back into one
   * API message at compile time (preserving KV cache structure).
   *
   * Multi-block content: text blocks are concatenated for chunking, then
   * the resulting shards are emitted as text blocks. Non-text blocks
   * (images, tool results) are passed through unchanged on the first
   * shard only — they don't get split.
   *
   * See `docs/adaptive-resolution-design.md` §3.6.
   */
  chunkIngressMessage(participant: string, content: ContentBlock[]): IngressChunkResult | null {
    if (!this.config.adaptiveResolution) return null;

    // Separate text and non-text blocks.
    const textParts: string[] = [];
    const nonTextBlocks: ContentBlock[] = [];
    for (const block of content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else {
        nonTextBlocks.push(block);
      }
    }
    if (textParts.length === 0) return null;
    const combined = textParts.join('');

    // Threshold and shard size derive from the strategy's existing
    // targetChunkTokens setting: a message over 2x targetChunkTokens
    // gets sharded into pieces of ~targetChunkTokens each. This keeps
    // doc shards the same size as chat-message chunks for L1 production
    // consistency.
    const target = this.config.targetChunkTokens ?? DEFAULT_CHUNKER_OPTIONS.chunkSize;
    const chunkerOpts = {
      chunkThreshold: target * 2,
      chunkSize: target,
      charsPerToken: DEFAULT_CHUNKER_OPTIONS.charsPerToken,
    };

    const sharded = chunkMessage(combined, chunkerOpts);
    if (!sharded.wasSharded) return null;

    // Build IngressChunkResult. Non-text blocks (if any) go on shard 0
    // so the agent doesn't lose attachments. They're outside the chunker's
    // concern but should still be available on the first shard.
    const shards = sharded.shards.map((s) => ({
      content: ([{ type: 'text', text: s.content }] as ContentBlock[]).concat(
        s.index === 0 ? nonTextBlocks : []
      ),
      shardIndex: s.index,
    }));

    return {
      bodyGroupId: sharded.bodyGroupId,
      shards,
    };
  }

  async initialize(ctx: StrategyContext): Promise<void> {
    // First use of the fully-constructed instance: the deferred effective-config
    // report is emitted here so it can name the real strategy (see
    // reportEffectiveConfigOnce).
    this.reportEffectiveConfigOnce();
    // Invalidate the committed identity before touching any branch-scoped
    // mirror. A stale caller must fail closed for the entire initialization
    // interval, not continue using the previously loaded branch.
    this.loadedBranchIdentity = null;
    this.initializingBranchIdentity = null;
    this.compressionBranchGeneration++;
    this.clearBranchMirrors();

    // Bind to the chronicle store + namespace for persistent strategy state.
    this.store = ctx.store;
    this.ns = ctx.namespace;
    observeStoreBranch(ctx.store);
    const sourceBranch = this.captureCompressionBranch();
    this.initializingBranchIdentity = {
      store: ctx.store,
      namespace: ctx.namespace,
      ...sourceBranch,
    };

    const abortIfStale = (): boolean => {
      if (this.isCompressionBranchCurrent(sourceBranch)) return false;
      // Do not clear a newer initializer's mirrors if this invocation was
      // superseded on the same strategy object.
      if (this.compressionBranchGeneration === sourceBranch.strategyGeneration) {
        this.loadedBranchIdentity = null;
        this.initializingBranchIdentity = null;
        this.clearBranchMirrors();
      }
      return true;
    };

    let completed = false;
    try {
      // Initialization has one asynchronous boundary (pending alert delivery).
      // Treat each synchronous section around it as a branch-generation guarded
      // critical section: a manager sharing this store may switch the Chronicle
      // branch while this initializer is suspended.
      if (abortIfStale()) return;
      this.registerStates();
      if (abortIfStale()) return;
      this.loadPersistedState();
      if (abortIfStale()) return;
      await this.deliverPendingCompressionQuarantineAlerts(sourceBranch);
      if (abortIfStale()) return;

      // Restore headWindowStartId from last topic transition message
      const messages = ctx.messageStore.getAll();
      let headWindowStartId: string | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (this.isTopicTransitionMessage(messages[i])) {
          headWindowStartId = messages[i].id;
          break;
        }
      }
      if (abortIfStale()) return;
      this.headWindowStartId = headWindowStartId;
      // Legacy stores (pre chunk-persistence) have L1 summaries but no chunk
      // records — synthesize records from L1 sourceIds before the first
      // rebuild, so covered ground is owned and never re-compressed.
      if (abortIfStale()) return;
      this.migrateChunkRecords(ctx.messageStore);
      if (abortIfStale()) return;
      this.rebuildChunks(ctx.messageStore);
      // Kick the merge ladder for pre-existing unmerged summaries. Normally a
      // compression/merge completion does this, but a store that boots with a
      // backlog above threshold and an empty queue (e.g. after a pyramid
      // repair pruned duplicates and un-merged survivors) would otherwise
      // never start consolidating. Idempotent: already-queued/merged sources
      // are skipped.
      if (abortIfStale()) return;
      if (this.config.hierarchical && !this.chunkRecordsOrphaned) {
        this.checkMergeThreshold();
      }
      if (abortIfStale()) return;

      // Commit only after every load/migration/rebuild/queue step completed for
      // the exact store branch generation observed at entry.
      this.loadedBranchIdentity = {
        store: ctx.store,
        namespace: ctx.namespace,
        ...sourceBranch,
      };
      completed = true;
    } finally {
      if (this.compressionBranchGeneration === sourceBranch.strategyGeneration) {
        this.initializingBranchIdentity = null;
        if (!completed) {
          this.loadedBranchIdentity = null;
          this.clearBranchMirrors();
        }
      }
    }
  }

  /** Drop every branch-derived mirror without touching durable state. */
  private clearBranchMirrors(): void {
    this.chunks = [];
    this.pendingCompression = null;
    this.compressionQueue = [];
    this._compressionCount = 0;
    this._drainProgress = 0;
    this._demandedL1Chunks.clear();
    this.chunkRecords = [];
    this.chunkIdCounter = 0;
    this.chunkRecordsOrphaned = false;
    this._orphanWarned = false;
    this._overlapBlocked.clear();
    this.summaries = [];
    this.summaryIdCounter = 0;
    this.mergeQueue = [];
    this.mergeQuarantine.clear();
    this.headWindowStartId = null;
    this._cachedHeadStartIndex = null;
    this.compressionRefusalQuarantine.clear();
    this.pins = [];
    this.pinIdCounter = 0;
    this.resolutions.clear();
    this.locked.clear();
    this._adaptivePicker = null;
    this.lastFrontierTokens = undefined;
    this.transitionBlocked = undefined;
    this._rs = null;
    this._lastRenderStats = null;
    this._lastCompileEstimate = 0;
    this._storeView = null;
    this._calibrationArmed = false;
    this._calibration = 1;
    this._calibrationLoaded = false;
    this._lastKvStable = null;
  }

  /**
   * Whether chunk boundaries are persisted to the `autobio:chunks` slot and
   * own the past. Subclasses with their own chunking (KnowledgeStrategy's
   * semantic phases) opt out and keep the legacy recompute-every-rebuild
   * behavior.
   */
  protected get chunkPersistenceEnabled(): boolean {
    return true;
  }

  /**
   * One-time lazy migration: a store with L1 summaries but an empty chunks
   * slot predates chunk persistence. Each L1's sourceIds ARE the historical
   * chunk boundary — synthesize a compressed record per L1, in message
   * order. Stale generations from the old partial-tail compression bug
   * (an L1 whose messages are ALL already covered by records synthesized so
   * far — prefix families, same-range duplicates) get NO record; coverage is
   * what blocks re-compression, and the repair tooling prunes their content
   * separately.
   */
  protected migrateChunkRecords(store: MessageStoreView): void {
    if (!this.chunkPersistenceEnabled || !this.store) return;
    if (this.chunkRecords.length > 0) return;
    const l1s = this.summaries.filter(s => s.level === 1 && Array.isArray(s.sourceIds) && s.sourceIds.length > 0);
    if (l1s.length === 0) return;

    const msgIndex = new Map<string, number>();
    store.getAll().forEach((m, i) => msgIndex.set(m.id, i));

    // Coverage sweep (start asc, span desc; longest generation per start
    // wins; fully-covered generations are stale) — shared with the pyramid
    // repair script, see keeper-selection.ts.
    const { keepers, skippedStale, skippedGhost } = selectKeeperL1s(l1s, msgIndex);
    for (const s of keepers) {
      this.appendChunkRecord({
        id: `c-${this.chunkIdCounter++}`,
        sourceIds: [...s.sourceIds],
        compressed: true,
        summaryId: s.id,
        ...(s.phaseType ? { phaseType: s.phaseType } : {}),
      });
    }
    console.warn(
      `[autobiographical] chunk-persistence migration: ${l1s.length} L1s → ` +
      `${this.chunkRecords.length} records (${skippedStale} stale generations, ` +
      `${skippedGhost} fully-orphaned L1s skipped)`,
    );
  }

  /** Append a record to the chunks slot + in-memory mirror. */
  protected appendChunkRecord(record: ChunkRecord): void {
    this.requireBranchMutation('appendChunkRecord');
    this.chunkRecords.push(record);
    this.store?.appendToStateJson(this.chunksStateId, record);
  }

  /**
   * Mark a chunk's record compressed, linking its L1. Resolves the log slot
   * by ID against the persisted array — never by in-memory index (see
   * setMergedInto for the clobber this avoids).
   */
  protected markChunkRecordCompressed(recordId: string | undefined, summaryId: string): void {
    if (!this.chunkPersistenceEnabled || !recordId) return;
    this.requireBranchMutation('markChunkRecordCompressed');
    const rec = this.chunkRecords.find(r => r.id === recordId);
    if (!rec) return;
    rec.compressed = true;
    rec.summaryId = summaryId;
    if (!this.store) return;
    const stored = this.store.getStateJson(this.chunksStateId);
    if (!Array.isArray(stored)) return;
    const payload = Buffer.from(JSON.stringify(rec));
    let found = false;
    for (let i = 0; i < stored.length; i++) {
      const item = stored[i] as ChunkRecord | null;
      if (item && item.id === recordId) {
        this.store.editStateItem(this.chunksStateId, i, payload);
        found = true;
      }
    }
    if (!found) {
      console.warn(
        `[autobiographical] markChunkRecordCompressed: ${recordId} not found in persisted chunk log`,
      );
    }
  }

  /**
   * Register the three Chronicle state slots this strategy uses.
   * Idempotent — chronicle throws if a state is already registered, which we
   * swallow (the existing slot is what we want).
   */
  protected registerStates(): void {
    if (!this.store) return;
    try {
      this.store.registerState({
        id: this.summariesStateId,
        strategy: 'append_log',
        deltaSnapshotEvery: 50,
        fullSnapshotEvery: 10,
      });
    } catch { /* already registered */ }
    if (this.chunkPersistenceEnabled) {
      try {
        this.store.registerState({
          id: this.chunksStateId,
          strategy: 'append_log',
          deltaSnapshotEvery: 50,
          fullSnapshotEvery: 10,
        });
      } catch { /* already registered */ }
    }
    try {
      this.store.registerState({
        id: this.counterStateId,
        strategy: 'snapshot',
      });
    } catch { /* already registered */ }
    try {
      this.store.registerState({
        id: this.mergeQueueStateId,
        strategy: 'snapshot',
      });
    } catch { /* already registered */ }
    try {
      this.store.registerState({
        id: this.mergeQuarantineStateId,
        strategy: 'snapshot',
      });
    } catch { /* already registered */ }
    try {
      this.store.registerState({
        id: this.pinsStateId,
        strategy: 'snapshot',
      });
    } catch { /* already registered */ }
    try {
      this.store.registerState({
        id: this.calibrationStateId,
        strategy: 'snapshot',
      });
    } catch { /* already registered */ }
    try {
      this.store.registerState({
        id: this.compressionRefusalQuarantineLedgerStateId,
        strategy: 'append_log',
        deltaSnapshotEvery: 50,
        fullSnapshotEvery: 10,
      });
    } catch { /* already registered */ }
    // Adaptive-resolution state slots — only registered when the flag is on
    // so chronicles without the flag don't accumulate unused slots.
    if (this.config.adaptiveResolution) {
      try {
        this.store.registerState({
          id: this.resolutionsStateId,
          strategy: 'snapshot',
        });
      } catch { /* already registered */ }
      try {
        this.store.registerState({
          id: this.locksStateId,
          strategy: 'snapshot',
        });
      } catch { /* already registered */ }
    }
  }

  /**
   * Load summaries, counter, and pending merges from chronicle into the
   * in-memory mirrors. Called on every (re)initialize so branch switches
   * pick up the new branch's state.
   */
  protected loadPersistedState(): void {
    if (!this.store) {
      this.summaries = [];
      this.summaryIdCounter = 0;
      this.mergeQueue = [];
      this.mergeQuarantine.clear();
      this.pins = [];
      this.pinIdCounter = 0;
      this.chunkRecords = [];
      this.chunkIdCounter = 0;
      this.compressionRefusalQuarantine.clear();
      return;
    }

    if (this.chunkPersistenceEnabled) {
      const records = this.store.getStateJson(this.chunksStateId);
      this.chunkRecords = (Array.isArray(records) ? (records as ChunkRecord[]) : [])
        .filter(r => r && typeof r.id === 'string' && Array.isArray(r.sourceIds) && r.sourceIds.length > 0);
      this.chunkIdCounter = this.chunkRecords.reduce((max, r) => {
        const n = Number(r.id.replace(/^c-/, ''));
        return Number.isFinite(n) && n >= max ? n + 1 : max;
      }, 0);
      this.chunkRecordsOrphaned = false;
      this._orphanWarned = false;
      this._overlapBlocked.clear();
    }
    const summaries = this.store.getStateJson(this.summariesStateId);
    const loaded = Array.isArray(summaries) ? (summaries as SummaryEntry[]) : [];
    // Drop empty-content summaries (bugged/empty generations from before the
    // production guards). Recalling or merging one yields an empty text block →
    // Anthropic 400 "content must be non-empty". Never let them re-enter memory.
    const nonEmpty = loaded.filter(s => s && typeof s.content === 'string' && s.content.trim().length > 0);
    const droppedEmpty = loaded.length - nonEmpty.length;
    const removedEmptyIds = new Set(
      loaded
        .filter(s => s && (typeof s.content !== 'string' || s.content.trim().length === 0))
        .map(s => s.id),
    );
    if (droppedEmpty > 0) console.warn(`[autobiographical] dropped ${droppedEmpty} empty summary(ies) on load`);
    // Dedupe by id, keeping the copy with mergedInto set (position of first
    // occurrence preserved). Duplicate-id copies with diverging merge state
    // exist in stores touched by the pre-fix setMergedInto index-desync bug;
    // without dedupe, the plain copy stays on the unmerged frontier and its
    // content renders twice (once itself, once via its parent's merge).
    const byId = new Map<string, SummaryEntry>();
    for (const s of nonEmpty) {
      const prev = byId.get(s.id);
      if (!prev) byId.set(s.id, s);
      else if (!prev.mergedInto && s.mergedInto) byId.set(s.id, s);
    }
    const dupes = nonEmpty.length - byId.size;
    if (dupes > 0) console.warn(`[autobiographical] deduped ${dupes} duplicate summary id(s) on load`);
    // Dropping an invalid parent is only half the repair. Its children may
    // still carry `mergedInto: <dropped-id>`, which makes them simultaneously
    // unavailable to the picker (no parent to render) and ineligible for a
    // replacement merge (they still look merged). Clear every dangling edge
    // and persist the canonicalized array so the poison does not return on
    // every restart.
    let danglingParents = 0;
    this.summaries = [...byId.values()].map((summary) => {
      if (!summary.mergedInto || byId.has(summary.mergedInto)) return summary;
      danglingParents++;
      const { mergedInto: _dropped, ...repaired } = summary;
      return repaired as SummaryEntry;
    });
    if (droppedEmpty > 0 || dupes > 0 || danglingParents > 0) {
      this.store.setStateJson(this.summariesStateId, this.summaries);
      console.warn(
        `[autobiographical] repaired summary state: removed ${droppedEmpty} empty, ` +
          `deduped ${dupes}, cleared ${danglingParents} dangling parent pointer(s)`,
      );
    }

    // An invalid L1 may also be referenced by a persisted chunk record. Make
    // that chunk compressible again instead of leaving it permanently marked
    // complete with no summary behind it.
    if (this.chunkPersistenceEnabled && this.chunkRecords.length > 0) {
      const validL1Ids = new Set(this.summaries.filter(s => s.level === 1).map(s => s.id));
      let repairedChunkRecords = 0;
      this.chunkRecords = this.chunkRecords.map((record) => {
        if (!record.compressed || (record.summaryId && validL1Ids.has(record.summaryId))) {
          return record;
        }
        repairedChunkRecords++;
        const { summaryId: _dropped, ...rest } = record;
        return { ...rest, compressed: false };
      });
      if (repairedChunkRecords > 0) {
        this.store.setStateJson(this.chunksStateId, this.chunkRecords);
        console.warn(
          `[autobiographical] repaired ${repairedChunkRecords} chunk record(s) with missing L1 summaries`,
        );
      }
    }

    const counter = this.store.getStateJson(this.counterStateId);
    this.summaryIdCounter = typeof counter === 'number' ? counter : 0;

    const queue = this.store.getStateJson(this.mergeQueueStateId);
    this.mergeQueue = Array.isArray(queue)
      ? (queue as Array<{ level: SummaryLevel; sourceIds: string[]; attempts?: number; lastStopReason?: string; lastOutcome?: string; hadRefusal?: boolean; serverErrorStreak?: number }>)
      : [];
    const mergeQuarantine = this.store.getStateJson(this.mergeQuarantineStateId);
    this.mergeQuarantine = new Map(
      (Array.isArray(mergeQuarantine) ? (mergeQuarantine as MergeQuarantineRecord[]) : [])
        .filter((r) => r && typeof r.key === 'string' && Array.isArray(r.sourceIds))
        .map((r) => [r.key, r]),
    );
    const validMergeQueue = this.mergeQueue.filter(
      merge => !merge.sourceIds.some(id => removedEmptyIds.has(id) && !byId.has(id)),
    );
    if (validMergeQueue.length !== this.mergeQueue.length) {
      const removed = this.mergeQueue.length - validMergeQueue.length;
      this.mergeQueue = validMergeQueue;
      this.store.setStateJson(this.mergeQueueStateId, this.mergeQueue);
      console.warn(`[autobiographical] removed ${removed} merge queue item(s) with missing sources`);
    }

    this.compressionRefusalQuarantine = this.readCompressionQuarantineProjection();

    const pinsState = this.store.getStateJson(this.pinsStateId);
    if (pinsState && typeof pinsState === 'object' && Array.isArray((pinsState as { pins?: unknown }).pins)) {
      const ps = pinsState as { pins: ProtectedRange[]; counter?: number };
      this.pins = ps.pins;
      this.pinIdCounter = typeof ps.counter === 'number' ? ps.counter : ps.pins.length;
    } else {
      this.pins = [];
      this.pinIdCounter = 0;
    }

    // Adaptive-resolution state — only present when flag was/is on
    if (this.config.adaptiveResolution) {
      const resState = this.store.getStateJson(this.resolutionsStateId);
      this.resolutions = new Map();
      if (resState && typeof resState === 'object') {
        for (const [k, v] of Object.entries(resState as Record<string, unknown>)) {
          if (typeof v === 'number' && v > 0) {
            this.resolutions.set(k, v);
          }
        }
      }
      const lockState = this.store.getStateJson(this.locksStateId);
      this.locked = new Set();
      if (Array.isArray(lockState)) {
        for (const id of lockState) {
          if (typeof id === 'string') this.locked.add(id);
        }
      }
    }
  }

  /** Persist the current pins + counter as a single snapshot. */
  protected persistPins(): void {
    this.requireBranchMutation('persistPins');
    this.store?.setStateJson(this.pinsStateId, {
      pins: this.pins,
      counter: this.pinIdCounter,
    });
  }

  /** Persist the current resolutions snapshot. Only stores non-zero entries
   *  to keep the slot compact. */
  protected persistResolutions(): void {
    if (!this.store) return;
    this.requireBranchMutation('persistResolutions');
    const out: Record<string, number> = {};
    for (const [id, level] of this.resolutions) {
      if (level > 0) out[id] = level;
    }
    this.store.setStateJson(this.resolutionsStateId, out);
  }

  /** Persist the current locked-id snapshot. */
  protected persistLocks(): void {
    if (!this.store) return;
    this.requireBranchMutation('persistLocks');
    this.store.setStateJson(this.locksStateId, Array.from(this.locked));
  }

  // ============================================================================
  // Pins / documents (protected ranges)
  // ============================================================================

  /**
   * Pin a range of messages so they aren't compressed and render raw at
   * their original position. Returns the pin id.
   */
  pinRange(firstMessageId: string, lastMessageId: string, opts?: PinLevelOptions): string {
    this.requireLoadedBranch('pinRange');
    const id = `pin-${this.pinIdCounter++}`;
    this.pins.push({
      id,
      firstMessageId,
      lastMessageId,
      kind: 'pin',
      name: opts?.name,
      created: Date.now(),
      ...normalizePinLevels(opts),
    });
    this.persistPins();
    return id;
  }

  /**
   * Mark a single message as a "document" — semantically a body of
   * information the agent wants to retain in full. Functionally a
   * single-message pin with `kind: 'document'`.
   */
  markDocument(messageId: string, opts?: PinLevelOptions): string {
    this.requireLoadedBranch('markDocument');
    const id = `pin-${this.pinIdCounter++}`;
    this.pins.push({
      id,
      firstMessageId: messageId,
      lastMessageId: messageId,
      kind: 'document',
      name: opts?.name,
      created: Date.now(),
      ...normalizePinLevels(opts),
    });
    this.persistPins();
    return id;
  }

  /**
   * V2 dynamic pin-at-level-k convenience: fix a range to render at EXACTLY
   * fold level `level` (0 = raw). Honored only by `foldingStrategy: 'kv-stable'`;
   * other strategies fall back to treating the range as raw. Equivalent to
   * `pinRange(first, last, { level })`.
   */
  pinAtLevel(firstMessageId: string, lastMessageId: string, level: number, opts?: { name?: string }): string {
    return this.pinRange(firstMessageId, lastMessageId, { name: opts?.name, level });
  }

  /** Remove a pin or document mark by id. Returns true if removed. */
  unpin(pinId: string): boolean {
    this.requireLoadedBranch('unpin');
    const before = this.pins.length;
    this.pins = this.pins.filter(p => p.id !== pinId);
    if (this.pins.length < before) {
      this.persistPins();
      return true;
    }
    return false;
  }

  /** Read-only list of all current pins. */
  listPins(): ReadonlyArray<ProtectedRange> {
    this.requireLoadedBranch('listPins');
    return this.pins;
  }

  // ============================================================================
  // Search (gap #7)
  // ============================================================================

  /**
   * Look up a single summary by id. Returns null if not found.
   */
  getSummary(id: string): SummaryEntry | null {
    this.requireLoadedBranch('getSummary');
    return this.summaries.find(s => s.id === id) ?? null;
  }

  /**
   * Search summaries by substring or regex over their content.
   *
   * Result ordering: matches by descending hit count, then by descending
   * `created` timestamp (newest first within the same hit count).
   *
   * Default behavior: only "live" (unmerged) summaries are searched. Set
   * `includeMerged: true` to also include summaries that have been folded
   * into a higher level.
   */
  searchSummaries(query: SearchQuery): SearchResult[] {
    this.requireLoadedBranch('searchSummaries');
    const limit = query.limit ?? 50;
    const includeMerged = query.includeMerged ?? false;

    // Build the matcher
    let matcher: ((content: string) => number) | null = null;
    if (query.regex) {
      const flags = query.regex.flags.includes('g') ? query.regex.flags : query.regex.flags + 'g';
      const re = new RegExp(query.regex.source, flags);
      matcher = (content: string) => {
        const matches = content.match(re);
        return matches ? matches.length : 0;
      };
    } else if (query.text) {
      const needle = query.text.toLowerCase();
      matcher = (content: string) => {
        const hay = content.toLowerCase();
        let count = 0;
        let idx = 0;
        while ((idx = hay.indexOf(needle, idx)) !== -1) {
          count++;
          idx += needle.length || 1;
        }
        return count;
      };
    } else {
      // No pattern: every summary "matches" once
      matcher = () => 1;
    }

    const levelsFilter = query.levels && query.levels.length > 0 ? new Set(query.levels) : null;

    const results: SearchResult[] = [];
    for (const s of this.summaries) {
      if (!includeMerged && s.mergedInto) continue;
      if (levelsFilter && !levelsFilter.has(s.level)) continue;
      const matches = matcher(s.content);
      if (matches > 0) {
        results.push({ summary: s, matches });
      }
    }

    results.sort((a, b) => {
      if (b.matches !== a.matches) return b.matches - a.matches;
      return b.summary.created - a.summary.created;
    });

    return results.slice(0, limit);
  }

  /**
   * Whether a given message position is inside any protected range.
   * Uses a position map (computed by caller) so callers can avoid
   * repeated per-message lookups in tight loops.
   */
  protected isPositionPinned(position: number, pinPositions: Set<number>): boolean {
    return pinPositions.has(position);
  }

  /**
   * Build a set of message-store positions covered by any pin. O(N pins · K range).
   * Returns positions for which the message exists; orphan pins (deleted
   * messages) are silently skipped.
   */
  protected pinnedPositions(messages: StoredMessage[]): Set<number> {
    if (this.pins.length === 0) return new Set();
    const positionOf = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      positionOf.set(messages[i].id, i);
    }
    const out = new Set<number>();
    for (const pin of this.pins) {
      const first = positionOf.get(pin.firstMessageId);
      const last = positionOf.get(pin.lastMessageId);
      if (first === undefined || last === undefined) continue;
      const lo = Math.min(first, last);
      const hi = Math.max(first, last);
      for (let i = lo; i <= hi; i++) out.add(i);
    }
    return out;
  }

  /**
   * Resolve the V2 dynamic-pin fold-depth bounds (`ProtectedRange.level` /
   * `maxLevel`) to message positions. Only pins that carry a bound appear; a
   * classic raw pin (no bound) is absent here and handled by `pinnedPositions`.
   * When ranges overlap, the FINEST requirement wins (lowest effective level):
   * a fixed `level` clamps both ends; a `maxLevel` only caps depth. Honored
   * solely by the KV-stable controller — see `ProtectedRange`.
   */
  protected pinLevelBounds(messages: StoredMessage[]): Map<number, { level?: number; maxLevel?: number }> {
    const out = new Map<number, { level?: number; maxLevel?: number }>();
    if (this.pins.length === 0) return out;
    const positionOf = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) positionOf.set(messages[i].id, i);

    for (const pin of this.pins) {
      if (pin.level === undefined && pin.maxLevel === undefined) continue;
      const first = positionOf.get(pin.firstMessageId);
      const last = positionOf.get(pin.lastMessageId);
      if (first === undefined || last === undefined) continue;
      const lo = Math.min(first, last);
      const hi = Math.max(first, last);
      for (let i = lo; i <= hi; i++) {
        const prev = out.get(i) ?? {};
        // A fixed level is the strongest constraint; when two pins fix the same
        // position, the shallower (lower) level wins (finest requirement).
        if (pin.level !== undefined) {
          prev.level = prev.level === undefined ? pin.level : Math.min(prev.level, pin.level);
        } else if (pin.maxLevel !== undefined) {
          prev.maxLevel = prev.maxLevel === undefined ? pin.maxLevel : Math.min(prev.maxLevel, pin.maxLevel);
        }
        out.set(i, prev);
      }
    }
    return out;
  }

  /**
   * Append a summary to the in-memory list and to the chronicle AppendLog.
   * Single point so subclasses inherit persistence.
   */
  protected pushSummary(entry: SummaryEntry): void {
    this.requireBranchMutation('pushSummary');
    if (typeof entry.content !== 'string' || entry.content.trim().length === 0) {
      throw new Error(
        `[autobiographical] refusing to persist empty summary ${entry.id} at L${entry.level}`,
      );
    }
    this.summaries.push(entry);
    this.store?.appendToStateJson(this.summariesStateId, entry);
  }

  /** Read the durable log as well as the local mirror for cross-instance L1 races. */
  private findExactL1(chunkIdKey: string): SummaryEntry | undefined {
    const local = this.summaries.find(
      (summary) => summary.level === 1 && summary.sourceIds.join(':') === chunkIdKey,
    );
    if (local) return local;
    const persisted = this.store?.getStateJson(this.summariesStateId);
    if (!Array.isArray(persisted)) return undefined;
    const found = (persisted as SummaryEntry[]).find(
      (summary) => summary?.level === 1 && summary.sourceIds?.join(':') === chunkIdKey,
    );
    if (found && !this.summaries.some((summary) => summary.id === found.id)) {
      this.summaries.push(found);
    }
    return found;
  }

  /**
   * Mark a summary as merged into a higher-level summary, updating the
   * chronicle copy at the same index. Index is the position in `this.summaries`.
   */
  /**
   * Token-budget cap for recall-pair summary sets. Walks newest→oldest
   * keeping each summary that still fits; skips (rather than breaks at)
   * a summary that would put us over budget, so a heterogeneous set
   * fills the remaining slots with smaller siblings instead of stopping
   * at the first oversized one. The kept set is re-sorted chronologically.
   *
   * Used by both `compressChunkHierarchical` (the L1 compression prompt
   * recall pairs) and `executeMerge` (the merge prompt recall pairs).
   * Without the cap, both sites grow their recall set linearly with
   * conversation length and overflow the 200k window around the same
   * point — observed empirically at ~chunk 118 in a 4000-message import.
   *
   * Per-summary +50 token overhead accounts for the "[CM] Recall memory
   * <id>." question turn that wraps each recall body. Rough but defensive.
   */
  protected capRecallPairs(
    summariesChronological: SummaryEntry[],
    maxTokens: number,
  ): { kept: SummaryEntry[]; keptTokens: number } {
    const kept: SummaryEntry[] = [];
    let total = 0;
    for (let i = summariesChronological.length - 1; i >= 0; i--) {
      const s = summariesChronological[i]!;
      const est = (s.tokens ?? Math.ceil(s.content.length / 4)) + 50;
      if (total + est > maxTokens) continue;
      kept.push(s);
      total += est;
    }
    kept.reverse();
    return { kept, keptTokens: total };
  }

  /**
   * Issue #37: tag a mint request's stability strata with cache breakpoints.
   *
   * Consecutive compression/merge requests share a long, append-mostly
   * prefix — head window + prior recall pairs (~60% of input on synthetic
   * workloads, ~93% on mature stores) — that previously went to the API
   * with zero `cache_control` and was re-read cold on every call. Markers
   * land at the three boundaries whose survival probability ranks highest
   * (measured optimum; `analysis/2026-08-20-cm37-cache-partition-experiments.md`
   * in the workspace root):
   *
   *   1. end of head window        — survives everything short of identity edits
   *   2. last level>=2 recall pair — survives appends AND L1→L2 merges (a
   *      merge replaces the run at this boundary and extends it)
   *   3. last recall pair          — the append frontier
   *
   * Only pairs whose id is in `recallLadder` (the kept prior-summary list)
   * count as prefix: a merge's expanded SOURCE pairs are its volatile
   * payload, and marking them would cache-write content that never recurs.
   *
   * `capped` requests get no markers: recall-budget front-eviction shifts
   * the prefix on every subsequent mint, and cache writes on a shifting
   * prefix are pure waste (measured up to +42% total cost at 1h TTL).
   * Effective ladder reuse also requires the append-stable source order
   * fix (2026-08-19); on stores minted under the older lexical order the
   * markers are merely harmless.
   *
   * Returns true iff at least one breakpoint was placed — callers attach
   * `cacheTtl` only then, so every marker-less request (kill switch, capped
   * ladder, no ladder yet) keeps the exact pre-seam request shape and its
   * canonical hash / quarantine identity.
   */
  protected applyMintCacheSeams(
    messages: NormalizedRequest['messages'],
    recallLadder: readonly SummaryEntry[],
    capped: boolean,
  ): boolean {
    if (this.config.compressionCacheMarkers === false) return false;
    // Replayed history can carry stale BLOCK-level cache_control from the
    // original live requests (imported stores; see membrane's native-formatter
    // passthrough note). Those were another request's placement decisions, and
    // the formatter counts them toward Anthropic's 4-breakpoint limit — left
    // in place, two of them plus the three seams below would push the request
    // past it and the API hard-rejects, stalling compression. Strip them
    // (copy-on-write: block objects are shared with the message store).
    // cache_control is request plumbing, not content, so verbatim-replay
    // KV-honesty is unaffected. The kill switch above restores byte-exact
    // pre-seam behavior, passthrough included.
    for (const m of messages) {
      if (m.content.some((b) => (b as { cache_control?: unknown }).cache_control !== undefined)) {
        m.content = m.content.map((b) => {
          if ((b as { cache_control?: unknown }).cache_control === undefined) return b;
          const { cache_control: _stale, ...rest } = b as ContentBlock & { cache_control?: unknown };
          return rest as ContentBlock;
        });
      }
    }
    if (capped) return false;
    const levelById = new Map(recallLadder.map((s) => [s.id, s.level]));
    let headEnd = -1;
    let deepEnd = -1;
    let frontierEnd = -1;
    for (let i = 0; i < messages.length - 1; i++) {
      const m = messages[i]!;
      if (m.participant !== 'Context Manager' || m.content.length !== 1) continue;
      const block = m.content[0];
      if (block?.type !== 'text') continue;
      const match = /^\[CM\] Recall memory (.+)\.$/.exec(block.text);
      if (!match) continue;
      const level = levelById.get(match[1]!);
      if (level === undefined) continue;
      if (frontierEnd === -1 && i > 0) headEnd = i - 1;
      frontierEnd = i + 1;
      if (level >= 2) deepEnd = i + 1;
    }
    if (frontierEnd === -1) return false; // no ladder yet — nothing stable to cache
    for (const idx of new Set([headEnd, deepEnd, frontierEnd])) {
      if (idx >= 0) messages[idx]!.cacheBreakpoint = true;
    }
    return true;
  }

  private sameAuthoredSummary(a: SummaryEntry, b: SummaryEntry): boolean {
    return a.id === b.id &&
      a.level === b.level &&
      a.sourceLevel === b.sourceLevel &&
      a.content === b.content &&
      a.sourceRange?.first === b.sourceRange?.first &&
      a.sourceRange?.last === b.sourceRange?.last &&
      Array.isArray(a.sourceIds) && Array.isArray(b.sourceIds) &&
      a.sourceIds.length === b.sourceIds.length &&
      a.sourceIds.every((id, index) => id === b.sourceIds[index]);
  }

  /**
   * Resolve IDs through loadPersistedState's canonical projection, never an
   * arbitrary historical duplicate. Each projected authored node must still
   * have a byte-identical authored copy in Chronicle; mergedInto is excluded
   * because it is mutable graph state, not authored node identity.
   */
  private persistedCanonicalSummariesById(): Map<string, SummaryEntry> {
    const stored = this.store?.getStateJson(this.summariesStateId);
    if (!Array.isArray(stored)) return new Map();
    const historical = stored as SummaryEntry[];
    const canonical = new Map<string, SummaryEntry>();
    for (const summary of this.summaries) {
      if (!summary || typeof summary.id !== 'string') continue;
      if (historical.some((alternate) => alternate && this.sameAuthoredSummary(summary, alternate))) {
        canonical.set(summary.id, summary);
      }
    }
    return canonical;
  }

  private estimateCompressionRequestTokens(request: NormalizedRequest): number {
    // Metadata-only observability and a conservative budget check. The ordinary
    // formatter/provider remains authoritative for rendered token accounting.
    return Math.ceil(JSON.stringify(request).length / 4);
  }

  private compressionRequestInputBoundTokens(request: NormalizedRequest): number {
    // Serialize the COMPLETE normalized request rather than maintaining a
    // hand-picked field list that can silently fall behind Membrane's request
    // type. Every enumerable field actually dispatched is therefore counted,
    // including generation config, participant/streaming controls, tools,
    // provider params, raw blocks, and future normalized fields. UTF-8 bytes
    // conservatively dominate ordinary tokenizer vocabulary pieces. The fixed
    // and per-message reserve covers formatter/provider role envelopes and
    // special tokens that are not represented by normalized JSON itself.
    const serialized = JSON.stringify(request);
    if (typeof serialized !== 'string') {
      throw new Error('Compression request is not serializable');
    }
    return Buffer.byteLength(serialized, 'utf8') + 512 + request.messages.length * 128;
  }

  private refusalCategory(response: NormalizedResponse): string | undefined {
    const raw = response.raw?.response as {
      stop_details?: { category?: unknown } | null;
    } | undefined;
    const category = raw?.stop_details?.category;
    return typeof category === 'string' ? category : undefined;
  }

  private compressionResponseStopReason(response: unknown): string | undefined {
    if (!response || typeof response !== 'object') return undefined;
    const stopReason = (response as { stopReason?: unknown }).stopReason;
    return typeof stopReason === 'string' ? stopReason : undefined;
  }

  private compressionResponseInputTokens(response: unknown): number | undefined {
    if (!response || typeof response !== 'object') return undefined;
    const typed = response as {
      usage?: unknown;
      details?: { usage?: unknown; model?: { provider?: unknown } };
    };
    const detailed = typed.details?.usage;
    const usage = detailed && typeof detailed === 'object' ? detailed : typed.usage;
    if (!usage || typeof usage !== 'object') return undefined;
    const read = (key: 'inputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'): number | undefined => {
      const value = (usage as Record<string, unknown>)[key];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const input = read('inputTokens');
    const provider = typeof typed.details?.model?.provider === 'string'
      ? typed.details.model.provider.toLowerCase()
      : undefined;
    // Anthropic and Bedrock report uncached, cache-write, and cache-read input
    // as disjoint counters. OpenAI/Gemini/OpenRouter report cache reads as a
    // subset of inputTokens, so summing there would double-count.
    if (provider === 'anthropic' || provider === 'bedrock') {
      if (input === undefined) return undefined;
      const total = input + (read('cacheCreationTokens') ?? 0) + (read('cacheReadTokens') ?? 0);
      return total > 0 ? total : undefined;
    }
    // Unknown/other providers are authoritative only when they report a
    // positive total input count. Zero/partial usage falls back to the
    // complete normalized request bound rather than admitting blindly.
    return input !== undefined && input > 0 ? input : undefined;
  }

  private fallbackContentBlockError(block: unknown, seen = new Set<object>()): string | undefined {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return 'malformed_content_block';
    if (seen.has(block)) return 'malformed_content_block';
    seen.add(block);
    const value = block as Record<string, unknown>;
    const type = value.type;
    if (typeof type !== 'string') return 'malformed_content_block';
    const validSource = (source: unknown, allowUrl: boolean): boolean => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
      const candidate = source as Record<string, unknown>;
      if (candidate.type === 'url') return allowUrl && typeof candidate.url === 'string';
      return candidate.type === 'base64' &&
        typeof candidate.data === 'string' && typeof candidate.mediaType === 'string';
    };
    switch (type) {
      case 'text':
        return typeof value.text === 'string' ? undefined : 'malformed_text_block';
      case 'thinking':
        return typeof value.thinking === 'string' &&
          (value.signature === undefined || typeof value.signature === 'string')
          ? undefined : 'malformed_content_block';
      case 'redacted_thinking':
        return typeof value.data === 'string' ? undefined : 'malformed_content_block';
      case 'tool_use':
        return typeof value.id === 'string' && typeof value.name === 'string' &&
          !!value.input && typeof value.input === 'object' && !Array.isArray(value.input)
          ? undefined : 'malformed_content_block';
      case 'tool_result': {
        if (typeof value.toolUseId !== 'string') return 'malformed_content_block';
        if (typeof value.content === 'string') return undefined;
        if (!Array.isArray(value.content)) return 'malformed_content_block';
        for (const nested of value.content) {
          const error = this.fallbackContentBlockError(nested, seen);
          if (error) return error;
        }
        return undefined;
      }
      case 'image':
        return validSource(value.source, true) ? undefined : 'malformed_content_block';
      case 'document':
      case 'audio':
      case 'video':
        return validSource(value.source, false) ? undefined : 'malformed_content_block';
      case 'generated_image':
        return typeof value.data === 'string' && typeof value.mimeType === 'string'
          ? undefined : 'malformed_content_block';
      default:
        return 'malformed_content_block';
    }
  }

  /**
   * Strict validation of a summarizer response before its text may become
   * canonical memory. Used by the bounded L1 fallback attempts and by the
   * L_n merge gate (`executeMerge`).
   *
   * Terminal-disposition invariant (2026-08-01): only a COMPLETE accepted
   * disposition — `end_turn` with nonempty text — is `valid`. A refusal,
   * truncation (`max_tokens`), tool call, abort, or malformed response is
   * never persisted, however plausible its text looks.
   */
  private assessFallbackCompressionResponse(response: unknown):
    | { outcome: 'valid'; response: NormalizedResponse; text: string }
    | { outcome: 'refusal'; stopReason: 'refusal' }
    | { outcome: 'incomplete'; stopReason?: string }
    | { outcome: 'unusable_empty'; stopReason?: string }
    | { outcome: 'provider_error'; stopReason?: string; errorType: string } {
    const stopReason = this.compressionResponseStopReason(response);
    const validStopReasons = new Set([
      'end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'refusal', 'abort',
    ]);
    if (!response || typeof response !== 'object' || !stopReason || !validStopReasons.has(stopReason)) {
      return { outcome: 'provider_error', stopReason, errorType: 'malformed_response' };
    }
    const content = (response as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return { outcome: 'provider_error', stopReason, errorType: 'malformed_content' };
    }
    const textParts: string[] = [];
    for (const block of content) {
      const errorType = this.fallbackContentBlockError(block);
      if (errorType) return { outcome: 'provider_error', stopReason, errorType };
      const type = (block as { type: string }).type;
      if (type === 'text') {
        textParts.push((block as { text: string }).text);
      }
    }
    if (stopReason === 'refusal') return { outcome: 'refusal', stopReason };
    const text = textParts.join('\n');
    if (!text.trim()) return { outcome: 'unusable_empty', stopReason };
    // Nonempty text under a non-end_turn disposition is an INCOMPLETE
    // generation (max_tokens truncation, tool_use preamble, abort, stray
    // stop_sequence) — never canonize it. Every membrane provider maps
    // unknown finish reasons to 'end_turn', so this cannot reject a
    // healthy provider leg.
    if (stopReason !== 'end_turn') return { outcome: 'incomplete', stopReason };
    return { outcome: 'valid', response: response as NormalizedResponse, text };
  }

  /**
   * Recursively resolve an authored node to its raw leaf message IDs. This is
   * deliberately asemantic: only persisted source edges are traversed, and no
   * content is inspected or rewritten beyond the nonempty-node validity check.
   */
  private recallCurveLeafIds(
    summary: SummaryEntry,
    byId: ReadonlyMap<string, SummaryEntry>,
    position: ReadonlyMap<string, number>,
    visiting: Set<string> = new Set(),
  ): string[] | null {
    if (
      visiting.has(summary.id) ||
      !summary.content?.trim() ||
      !Number.isSafeInteger(summary.level) ||
      summary.level < 1 ||
      summary.sourceLevel !== summary.level - 1 ||
      !Array.isArray(summary.sourceIds) ||
      summary.sourceIds.length === 0
    ) return null;
    if (summary.level === 1) {
      const leafPositions = summary.sourceIds.map((id) => position.get(id));
      if (leafPositions.some((index) => index === undefined)) return null;
      if (leafPositions.some((index, i) => i > 0 && index! <= leafPositions[i - 1]!)) return null;
      if (new Set(summary.sourceIds).size !== summary.sourceIds.length) return null;
      if (
        summary.sourceRange.first !== summary.sourceIds[0] ||
        summary.sourceRange.last !== summary.sourceIds[summary.sourceIds.length - 1]
      ) return null;
      return [...summary.sourceIds];
    }

    visiting.add(summary.id);
    const children: SummaryEntry[] = [];
    for (const childId of summary.sourceIds) {
      const child = byId.get(childId);
      if (!child || child.level !== summary.sourceLevel) {
        visiting.delete(summary.id);
        return null;
      }
      children.push(child);
    }
    children.sort((a, b) => {
      const first = (position.get(a.sourceRange.first) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(b.sourceRange.first) ?? Number.MAX_SAFE_INTEGER);
      return first || a.id.localeCompare(b.id);
    });
    const leaves: string[] = [];
    for (const child of children) {
      const childLeaves = this.recallCurveLeafIds(child, byId, position, visiting);
      if (!childLeaves) {
        visiting.delete(summary.id);
        return null;
      }
      leaves.push(...childLeaves);
    }
    visiting.delete(summary.id);
    if (new Set(leaves).size !== leaves.length) return null;
    const leafPositions = leaves.map((id) => position.get(id));
    if (leafPositions.some((index) => index === undefined)) return null;
    if (leafPositions.some((index, i) => i > 0 && index! <= leafPositions[i - 1]!)) return null;
    if (summary.sourceRange.first !== leaves[0] || summary.sourceRange.last !== leaves[leaves.length - 1]) {
      return null;
    }
    return leaves;
  }

  private validateRecallCurveRequest(request: NormalizedRequest): boolean {
    for (let i = 0; i < request.messages.length; i++) {
      const message = request.messages[i]!;
      if (!message.content.length) return false;
      for (const block of message.content) {
        if (block.type === 'text' && !block.text.trim()) return false;
        if (block.type === 'tool_use') {
          const next = request.messages[i + 1];
          if (!next?.content.some(
            (candidate) => candidate.type === 'tool_result' && candidate.toolUseId === block.id,
          )) return false;
        }
        if (block.type === 'tool_result') {
          const previous = request.messages[i - 1];
          if (!previous?.content.some(
            (candidate) => candidate.type === 'tool_use' && candidate.id === block.toolUseId,
          )) return false;
        }
      }
    }
    return true;
  }

  /**
   * Construct bounded single-node recall expansions from the retained
   * canonical request. Every non-replaced request field and message is reused
   * untouched. Children are ordered by raw source position, never by the
   * parent's sourceIds ordering, and their recursively expanded leaf set must
   * exactly equal the parent's set before the variant is eligible.
   */
  private buildRecallCurveVariants(
    canonicalRequest: NormalizedRequest,
    keptSummaries: SummaryEntry[],
    allMessages: StoredMessage[],
  ): RecallCurveVariant[] {
    // Alternate curves are allowed to use persisted authored nodes only. Do
    // not trust a merely in-memory node, even though production pushSummary()
    // normally appends synchronously before it enters the local mirror.
    const byId = this.persistedCanonicalSummariesById();
    const position = new Map(allMessages.map((message, index) => [message.id, index]));
    const orderedParents = keptSummaries
      .map((summary) => byId.get(summary.id))
      .filter((summary): summary is SummaryEntry => !!summary && summary.level > 1)
      .sort((a, b) => {
        const aNewest = position.get(a.sourceRange.last) ?? -1;
        const bNewest = position.get(b.sourceRange.last) ?? -1;
        if (aNewest !== bNewest) return bNewest - aNewest;
        if (a.level !== b.level) return b.level - a.level;
        return a.id.localeCompare(b.id);
      });

    const variants: RecallCurveVariant[] = [];
    for (const parent of orderedParents) {
      const directChildren = parent.sourceIds.map((id) => byId.get(id));
      if (directChildren.some((child) => !child || !child.content || !child.content.trim())) continue;
      if (directChildren.some((child) => child!.level !== parent.sourceLevel)) continue;
      const children = (directChildren as SummaryEntry[]).sort((a, b) => {
        const aFirst = position.get(a.sourceRange.first) ?? Number.MAX_SAFE_INTEGER;
        const bFirst = position.get(b.sourceRange.first) ?? Number.MAX_SAFE_INTEGER;
        if (aFirst !== bFirst) return aFirst - bFirst;
        const aLast = position.get(a.sourceRange.last) ?? Number.MAX_SAFE_INTEGER;
        const bLast = position.get(b.sourceRange.last) ?? Number.MAX_SAFE_INTEGER;
        if (aLast !== bLast) return aLast - bLast;
        return a.id.localeCompare(b.id);
      });

      const parentLeaves = this.recallCurveLeafIds(parent, byId, position);
      const childCoverage = children.map((child) => this.recallCurveLeafIds(child, byId, position));
      if (childCoverage.some((leaves) => !leaves)) continue;
      const childLeaves = childCoverage.flatMap((leaves) => leaves!);
      if (!parentLeaves || parentLeaves.length !== childLeaves.length) continue;
      if (new Set(parentLeaves).size !== parentLeaves.length) continue;
      if (new Set(childLeaves).size !== childLeaves.length) continue;
      const sortedParentCoverage = [...parentLeaves].sort();
      const sortedChildCoverage = [...childLeaves].sort();
      if (sortedParentCoverage.some((id, index) => id !== sortedChildCoverage[index])) continue;

      // Exact leaf coverage is not enough: the replacement itself must be a
      // chronological rendering of that coverage at the same as-of boundary.
      const leafPositions = childLeaves.map((id) => position.get(id));
      if (leafPositions.some((index) => index === undefined)) continue;
      if (leafPositions.some((index, i) => i > 0 && index! <= leafPositions[i - 1]!)) continue;
      if (
        childLeaves[0] !== parent.sourceRange.first ||
        childLeaves[childLeaves.length - 1] !== parent.sourceRange.last
      ) continue;

      const parentHeader = `[CM] Recall memory ${parent.id}.`;
      // The canonical pair body is whatever summaryAnswerContent produced —
      // a single text block for legacy entries, or verbatim reasoning
      // carriers + text for entries with responseContent. Match by exact
      // JSON equality against that same construction.
      const expectedBody = JSON.stringify(this.summaryAnswerContent(parent));
      const pairIndexes: number[] = [];
      for (let i = 0; i < canonicalRequest.messages.length - 1; i++) {
        const header = canonicalRequest.messages[i]!;
        const body = canonicalRequest.messages[i + 1]!;
        if (
          header.participant === 'Context Manager' &&
          header.content.length === 1 &&
          header.content[0]?.type === 'text' &&
          header.content[0].text === parentHeader &&
          JSON.stringify(body.content) === expectedBody
        ) pairIndexes.push(i);
      }
      if (pairIndexes.length !== 1) continue;

      const replacement = children.flatMap((child) => [
        {
          participant: 'Context Manager',
          content: [{ type: 'text' as const, text: `[CM] Recall memory ${child.id}.` }],
        },
        {
          participant: canonicalRequest.messages[pairIndexes[0]! + 1]!.participant,
          content: this.summaryAnswerContent(child),
        },
      ]);
      const pairIndex = pairIndexes[0]!;
      const request: NormalizedRequest = {
        ...canonicalRequest,
        messages: [
          ...canonicalRequest.messages.slice(0, pairIndex),
          ...replacement,
          ...canonicalRequest.messages.slice(pairIndex + 2),
        ],
      };
      if (!this.validateRecallCurveRequest(request)) continue;

      const leafCoverageHash = sha256Json(childLeaves);
      try {
        variants.push({
          parent,
          children,
          leafCoverageHash,
          request,
          requestHash: sha256Json(request),
          deterministicInputBoundTokens: this.compressionRequestInputBoundTokens(request),
        });
      } catch {
        // One malformed/unsupported variant cannot suppress later candidates.
        continue;
      }
    }
    return variants;
  }

  private normalizedCompressionFallbackLimit(): number {
    const configured = this.config.compressionRefusalCurveFallbacks ?? 3;
    return Number.isSafeInteger(configured) ? Math.max(0, configured) : 3;
  }

  private normalizedCompressionContextBudget(): number {
    const configured = this.config.compressionContextBudgetTokens ?? 200_000;
    return Number.isFinite(configured) && configured > 0 ? configured : 200_000;
  }

  /**
   * Freeze the exact fallback/admission plan. Before canonical inference this
   * supplies a deterministic family identity; after a refusal it is rebuilt
   * with authoritative canonical provider usage. When complete provider usage
   * is absent or not authoritative, admission retains the conservative complete
   * normalized-request bound; otherwise the unchanged canonical request is
   * already represented by provider usage and only positive expansion is added.
   */
  private compressionRefusalPlan(
    canonicalRequest: NormalizedRequest,
    variants: RecallCurveVariant[],
    canonicalProviderInputTokens?: number,
  ): CompressionRefusalPlanRecord[] {
    const fallbackLimit = this.normalizedCompressionFallbackLimit();
    if (fallbackLimit === 0) return [];
    const budgetTokens = this.normalizedCompressionContextBudget();
    const canonicalRequestBoundTokens = this.compressionRequestInputBoundTokens(canonicalRequest);
    const plan: CompressionRefusalPlanRecord[] = [];
    let providerAttempts = 0;
    for (const variant of variants) {
      if (providerAttempts >= fallbackLimit) break;
      // A recall-curve variant is an expansion of the canonical prompt. When
      // the provider reports canonical input usage, it is authoritative and
      // must dominate admission even if our serialization happens to be
      // smaller. The positive delta prevents a nominally smaller/identical
      // serialization from treating an expansion as free.
      const expansionDeltaTokens = Math.max(
        1,
        variant.deterministicInputBoundTokens - canonicalRequestBoundTokens,
      );
      const providerExpandedInputTokens = canonicalProviderInputTokens === undefined
        ? undefined
        : canonicalProviderInputTokens + expansionDeltaTokens;
      // Once the provider has counted the canonical request, that observed
      // token total is the authoritative baseline. The complete normalized
      // UTF-8 bound remains the fail-closed fallback when usage is absent, but
      // must not override real token accounting: large invariant tool schemas
      // can be megabytes of JSON while occupying a much smaller token window.
      // The positive byte-delta below is deliberately conservative for the
      // changed recall pair; unchanged head/tools/raw/config were physically
      // accepted and counted by the canonical provider call.
      const boundedInputTokens = providerExpandedInputTokens
        ?? variant.deterministicInputBoundTokens;
      const accountingSource = providerExpandedInputTokens !== undefined
        ? 'canonical_provider_usage_plus_expansion' as const
        : 'complete_normalized_request_bound' as const;
      const outputReserveTokens = Math.max(0, Math.ceil(variant.request.config.maxTokens));
      const admittedTokens = boundedInputTokens + outputReserveTokens;
      const disposition = admittedTokens > budgetTokens
        ? 'admission_rejected' as const
        : 'provider_attempt' as const;
      plan.push({
        curveLabel: `expand:${variant.parent.id}`,
        parentId: variant.parent.id,
        childIds: variant.children.map((child) => child.id),
        requestHash: variant.requestHash,
        accountingSource,
        canonicalRequestBoundTokens,
        deterministicInputBoundTokens: variant.deterministicInputBoundTokens,
        expansionDeltaTokens,
        boundedInputTokens,
        outputReserveTokens,
        admittedTokens,
        budgetTokens,
        disposition,
      });
      if (disposition === 'provider_attempt') providerAttempts++;
    }
    return plan;
  }

  private projectCompressionQuarantineEvents(
    events: CompressionQuarantineEvent[],
    legacyRecords: CompressionRefusalQuarantineRecord[] = [],
  ): Map<string, ActiveCompressionQuarantine> {
    const active = new Map<string, ActiveCompressionQuarantine>();
    const legacyClaims = new Map<string, ActiveCompressionQuarantine>();
    for (const record of legacyRecords) {
      if (!record || typeof record.key !== 'string') continue;
      active.set(record.key, {
        generationId: `legacy:${record.key}`,
        record,
        outcomes: [],
        // The legacy implementation emitted its alert immediately after the
        // snapshot write. Treat it as accounted to avoid surprise replay.
        sentAlertKeys: new Set([record.key]),
      });
    }
    for (const event of events) {
      if (!event || typeof event.key !== 'string') continue;
      if (event.kind === 'checkpoint') {
        active.clear();
        for (const item of event.active ?? []) {
          if (!item?.record || typeof item.record.key !== 'string' || !item.generationId) continue;
          active.set(item.record.key, {
            generationId: item.generationId,
            record: item.record,
            outcomes: Array.isArray(item.outcomes) ? item.outcomes : [],
            ...(item.pendingAlert ? { pendingAlert: item.pendingAlert } : {}),
            sentAlertKeys: new Set(Array.isArray(item.sentAlertKeys) ? item.sentAlertKeys : []),
          });
        }
        continue;
      }
      if (event.kind === 'claim') {
        const generationId = event.eventId;
        if (!generationId) continue;
        legacyClaims.set(generationId, {
          generationId,
          record: event.record,
          outcomes: [],
          sentAlertKeys: new Set(),
        });
        continue;
      }
      if (event.kind === 'exhausted') {
        const generationId = event.record ? event.eventId : event.targetClaimId;
        const base = event.record
          ? {
              generationId: generationId!,
              record: event.record,
              outcomes: event.outcomes,
              sentAlertKeys: new Set<string>(),
            }
          : generationId ? legacyClaims.get(generationId) : undefined;
        if (!base || !generationId) continue;
        active.set(event.key, {
          ...base,
          generationId,
          outcomes: event.outcomes,
        });
        continue;
      }
      const current = active.get(event.key);
      if (!current || current.generationId !== event.targetClaimId) continue;
      if (event.kind === 'clear') {
        active.delete(event.key);
      } else if (event.kind === 'alert_pending' && event.eventId) {
        current.pendingAlert = { eventId: event.eventId, alertKey: event.alertKey };
      } else if (event.kind === 'alert_sent') {
        current.sentAlertKeys.add(event.alertKey);
        if (current.pendingAlert?.eventId === event.pendingEventId) current.pendingAlert = undefined;
      }
    }
    return active;
  }

  private readCompressionQuarantineProjection(): Map<string, ActiveCompressionQuarantine> {
    if (!this.store) return new Map();
    const ledger = this.store.getStateJson(this.compressionRefusalQuarantineLedgerStateId);
    const legacy = this.store.getStateJson(this.compressionRefusalQuarantineStateId);
    return this.projectCompressionQuarantineEvents(
      Array.isArray(ledger) ? ledger as CompressionQuarantineEvent[] : [],
      Array.isArray(legacy) ? legacy as CompressionRefusalQuarantineRecord[] : [],
    );
  }

  private appendCompressionQuarantineEvent(
    event: NewCompressionQuarantineEvent,
  ): CompressionQuarantineEvent {
    if (!this.store) throw new Error('Compression quarantine store is not initialized');
    this.requireBranchMutation('appendCompressionQuarantineEvent');
    const stored = this.store.appendToStateJsonWithIdentity(
      this.compressionRefusalQuarantineLedgerStateId,
      event,
      'eventId',
      'sequence',
    );
    return { ...event, eventId: stored.id, sequence: stored.sequence } as CompressionQuarantineEvent;
  }

  private captureCompressionBranch(): CompressionOperationBranch {
    if (!this.store) throw new Error('Compression store is not initialized');
    const observed = observeStoreBranch(this.store);
    return {
      name: observed.name,
      generation: observed.generation,
      strategyGeneration: this.compressionBranchGeneration,
    };
  }

  private isBranchIdentityCurrent(identity: LoadedBranchIdentity | null): boolean {
    if (!identity || !this.store) return false;
    const observed = observeStoreBranch(this.store);
    return this.store === identity.store &&
      this.ns === identity.namespace &&
      this.store.currentBranch().name === identity.name &&
      observed.name === identity.name &&
      observed.generation === identity.generation &&
      this.compressionBranchGeneration === identity.strategyGeneration;
  }

  private isLoadedBranchCurrent(): boolean {
    return this.isBranchIdentityCurrent(this.loadedBranchIdentity);
  }

  /** Fail closed rather than using mirrors loaded from another generation. */
  private requireLoadedBranch(entrypoint: string): CompressionOperationBranch {
    if (!this.isLoadedBranchCurrent()) {
      // An entrypoint racing a still-current initializer must not clear the
      // initializer's partial mirrors out from under it; it simply cannot use
      // them until the identity is committed.
      if (!this.isBranchIdentityCurrent(this.initializingBranchIdentity)) {
        this.loadedBranchIdentity = null;
        this.initializingBranchIdentity = null;
        this.clearBranchMirrors();
      }
      throw new Error(
        `AutobiographicalStrategy.${entrypoint} requires reinitialization for the current branch generation`,
      );
    }
    return this.captureCompressionBranch();
  }

  private requireBranchMutation(entrypoint: string): void {
    if (
      this.isBranchIdentityCurrent(this.loadedBranchIdentity) ||
      this.isBranchIdentityCurrent(this.initializingBranchIdentity)
    ) return;
    throw new Error(
      `AutobiographicalStrategy.${entrypoint} refused stale branch-scoped mutation`,
    );
  }

  private isCompressionBranchCurrent(source: CompressionOperationBranch): boolean {
    const observed = this.store ? observeStoreBranch(this.store) : undefined;
    return !!this.store &&
      this.store.currentBranch().name === source.name &&
      observed?.name === source.name &&
      observed.generation === source.generation &&
      this.compressionBranchGeneration === source.strategyGeneration;
  }

  private logCompressionBranchDiscard(
    source: CompressionOperationBranch,
    phase: string,
    record?: CompressionRefusalQuarantineRecord,
  ): void {
    logCompressionCall({
      event: 'compression:branch-result-discarded',
      operation: 'compress_l1',
      metadata: {
        phase,
        source_branch: source.name,
        source_generation: source.generation,
        source_strategy_generation: source.strategyGeneration,
        current_branch: this.store?.currentBranch().name,
        current_generation: this.store ? observeStoreBranch(this.store).generation : undefined,
        current_strategy_generation: this.compressionBranchGeneration,
        ...(record ? { quarantine_key: record.key, canonical_request_hash: record.canonicalRequestHash } : {}),
      },
    });
  }

  private checkpointCompressionQuarantineIfNeeded(source: CompressionOperationBranch): void {
    if (!this.store || !this.isCompressionBranchCurrent(source)) return;
    const length = this.store.getStateLen(this.compressionRefusalQuarantineLedgerStateId) ?? 0;
    if (length < COMPRESSION_QUARANTINE_CHECKPOINT_EVENTS) return;
    const projection = this.readCompressionQuarantineProjection();
    const retained = [...projection.values()]
      .sort((a, b) => b.record.created - a.record.created)
      .slice(0, COMPRESSION_QUARANTINE_MAX_ACTIVE);
    const serialized: SerializedCompressionQuarantine[] = retained.map((item) => ({
      generationId: item.generationId,
      record: item.record,
      outcomes: item.outcomes,
      ...(item.pendingAlert ? { pendingAlert: item.pendingAlert } : {}),
      sentAlertKeys: [...item.sentAlertKeys],
    }));
    this.appendCompressionQuarantineEvent({
      kind: 'checkpoint',
      key: '__checkpoint__',
      active: serialized,
      created: Date.now(),
    });
    if (!this.isCompressionBranchCurrent(source)) return;
    // Append-first makes every crash point safe: before redaction both histories
    // project identically; afterwards the checkpoint is the complete projection.
    this.store.redactStateItems(this.compressionRefusalQuarantineLedgerStateId, 0, length);
    if (!this.isCompressionBranchCurrent(source)) return;
    this.store.compactState(this.compressionRefusalQuarantineLedgerStateId);
  }

  /**
   * Public quarantine status for health surfaces (/healthz, fleet-watch,
   * connectome-doctor) and the repeating alarm below.
   */
  getCompressionQuarantineStatus(): CompressionQuarantineStatus {
    if (!this.store) return { count: 0, keys: [] };
    try {
      const projection = this.readCompressionQuarantineProjection();
      return { count: projection.size, keys: [...projection.keys()] };
    } catch {
      // Health reads must never throw — a broken projection is itself a
      // problem, but not one to surface by crashing the caller.
      return { count: 0, keys: [] };
    }
  }

  private quarantineAlarmLastAt = 0;
  /** True while an alarm episode is open (alarmed and not yet all-cleared). */
  private quarantineAlarmActive = false;
  private onQuarantineAlarm?: (status: CompressionQuarantineStatus) => void;

  /**
   * Host wiring point: the framework maps this to its ops-alert channel
   * (failures.log + ops:alert trace + webhook). The strategy still emits a
   * loud stderr line on every alarm even when no handler is set, so an
   * unwired deployment cannot fail silently.
   *
   * Called with `count > 0` for each repeating alarm, and ONCE with
   * `count === 0` when an alarm episode ends (all debt paid) — hosts should
   * route the all-clear under a DISTINCT alert kind so a same-kind cooldown
   * cannot swallow it.
   */
  setQuarantineAlarmHandler(fn: (status: CompressionQuarantineStatus) => void): void {
    this.onQuarantineAlarm = fn;
  }

  /**
   * Repeating klaxon (2026-07-16, operator requirement): quarantined chunks
   * are a guaranteed eventual outage (raw spans accumulate until the picker
   * cannot fit the window), so a one-shot alert at quarantine time is not
   * enough — alarms sound every interval for as long as the quarantine is
   * non-empty. Set `quarantineAlarmIntervalMs: 0` to disable (tests only).
   */
  private async soundQuarantineAlarmIfNeeded(): Promise<void> {
    const interval = this.config.quarantineAlarmIntervalMs ?? 15 * 60_000;
    if (interval <= 0) return;
    const now = Date.now();
    // Idle path: nothing alarmed and not yet due for a check. (Entry into
    // quarantine still gets its immediate one-shot alert from
    // emitCompressionQuarantineAlert; the klaxon picks it up within one
    // interval and then sustains it.)
    if (!this.quarantineAlarmActive && now - this.quarantineAlarmLastAt < interval) return;
    // Sweep BEFORE reading status: the klaxon must reflect real debt only.
    await this.sweepPaidOffQuarantineRecords();
    const status = this.getCompressionQuarantineStatus();
    if (status.count === 0) {
      // All-clear must travel the SAME channel the alarm did — after an
      // alarm, silence is ambiguous (debt paid? alarm path dead?). Fires
      // once per episode, immediately on the emptying tick.
      if (this.quarantineAlarmActive) {
        this.quarantineAlarmActive = false;
        this.quarantineAlarmLastAt = 0;
        console.error(
          '[compression-quarantine] ✅ ALL CLEAR — quarantine empty, debt paid; alarm stands down',
        );
        try {
          this.onQuarantineAlarm?.(status);
        } catch (error) {
          console.error('[compression-quarantine] all-clear handler failed:', error);
        }
      }
      return;
    }
    if (this.quarantineAlarmActive && now - this.quarantineAlarmLastAt < interval) return;
    this.quarantineAlarmActive = true;
    this.quarantineAlarmLastAt = now;
    console.error(
      `[compression-quarantine] ⚠️ ${status.count} chunk(s) in compression quarantine — ` +
        `their spans stay raw and WILL eventually exhaust the context budget. ` +
        `Operator action required (inspect refusing content; branch, pin, or clear). ` +
        `keys=${status.keys.map(k => k.slice(0, 12)).join(',')}`,
    );
    try {
      this.onQuarantineAlarm?.(status);
    } catch (error) {
      console.error('[compression-quarantine] alarm handler failed:', error);
    }
  }

  /**
   * Sweep quarantine records whose debt is already paid, so the klaxon only
   * ever sounds on REAL debt. Two ways a record goes stale (both observed
   * live, mythos 2026-07-16 — three records klaxoning on spans compressed
   * hours earlier as L1-625):
   *  - chunk-boundary drift: rebuildChunks re-cut the compressible zone, the
   *    successor chunk (different id-list → different chunkSourceHash)
   *    compressed normally, and the old record matches nothing retryable;
   *  - same-boundary success that predates the success-clear hook.
   * Judged against the PERSISTED chunk records (autobio:chunks):
   *  - matching record, compressed  → covered, clear;
   *  - matching record, raw        → live debt, keep;
   *  - no matching record          → orphaned by drift (can never be
   *    retried NOR success-cleared), clear.
   */
  private async sweepPaidOffQuarantineRecords(): Promise<void> {
    if (!this.store) return;
    try {
      const projection = this.readCompressionQuarantineProjection();
      if (projection.size === 0) return;
      const records = this.store.getStateJson(this.chunksStateId);
      const chunkRecords = Array.isArray(records) ? (records as ChunkRecord[]) : [];
      if (chunkRecords.length === 0) return; // transient/no data — never sweep blind
      const byHash = new Map<string, ChunkRecord>();
      for (const r of chunkRecords) {
        if (r && Array.isArray(r.sourceIds)) byHash.set(sha256Json(r.sourceIds), r);
      }
      for (const [key, active] of projection) {
        const match = byHash.get(active.record.chunkSourceHash);
        if (match && !match.compressed) continue; // live debt — keep, klaxon
        const reason = match
          ? `span already compressed (${match.summaryId ?? 'summary'})`
          : 'orphaned by chunk-boundary drift (no matching chunk record)';
        await this.clearCompressionRefusalQuarantine(key);
        console.error(`[compression-quarantine] cleared ${key.slice(0, 12)}… — ${reason}`);
      }
    } catch (error) {
      console.warn('[compression-quarantine] paid-off sweep failed (records remain, klaxon persists):', error);
    }
  }

  /**
   * A successful compression (or adoption of an existing exact L1) pays off
   * any quarantine debt recorded against the same chunk under earlier
   * request shapes — e.g. a chunk quarantined on text-only requests that
   * later compresses once recall pairs carry reasoning. Matching is by
   * chunkSourceHash (the chunk's message-id list), so only records for THIS
   * span are cleared. Failures are logged, never thrown: clearing is
   * hygiene, not a correctness dependency.
   */
  private async clearQuarantineForCompressedChunk(chunk: Chunk): Promise<void> {
    if (!this.store) return;
    try {
      const hash = sha256Json(chunk.messages.map((message) => message.id));
      const projection = this.readCompressionQuarantineProjection();
      for (const [key, active] of projection) {
        if (active.record.chunkSourceHash !== hash) continue;
        await this.clearCompressionRefusalQuarantine(key);
        console.error(
          `[compression-quarantine] cleared ${key.slice(0, 12)}… — its chunk compressed ` +
            `successfully under a newer request shape`,
        );
      }
    } catch (error) {
      console.warn('[compression-quarantine] success-clear failed (records remain, klaxon persists):', error);
    }
  }
  private emitCompressionQuarantineAlert(active: ActiveCompressionQuarantine): void {
    const payload = {
      event: 'compression:quarantine-alert',
      operation: 'compress_l1',
      quarantine_key: active.record.key,
      alert_key: active.record.key,
      generation_id: active.generationId,
      model: active.record.model,
      chunk_hash: active.record.chunkSourceHash,
      outcomes: active.outcomes,
    };
    // Structured and keyed only: no summary/chunk plaintext is emitted.
    console.error(JSON.stringify(payload));
    logCompressionCall(payload);
  }

  private async deliverPendingCompressionQuarantineAlerts(
    source: CompressionOperationBranch,
  ): Promise<void> {
    if (!this.store) return;
    await withCompressionStateLock(
      this.store,
      source.name,
      this.compressionRefusalQuarantineLedgerStateId,
      () => {
      if (!this.isCompressionBranchCurrent(source)) return;
      const projection = this.readCompressionQuarantineProjection();
      for (const active of projection.values()) {
        if (!this.isCompressionBranchCurrent(source)) return;
        const pending = active.pendingAlert;
        if (!pending || active.sentAlertKeys.has(pending.alertKey)) {
          continue;
        }
        // Pending is durable before the external attempt. If the process dies
        // after emission but before alert_sent, restart retries with the same
        // alert key; downstream idempotency can collapse the duplicate.
        try {
          this.emitCompressionQuarantineAlert(active);
        } catch (error) {
          logCompressionCall({
            event: 'compression:quarantine-alert-attempt-failed',
            operation: 'compress_l1',
            metadata: {
              quarantine_key: active.record.key,
              alert_key: pending.alertKey,
              generation_id: active.generationId,
              error_type: error instanceof Error ? error.name : typeof error,
            },
          });
          continue;
        }
        if (!this.isCompressionBranchCurrent(source)) return;
        this.appendCompressionQuarantineEvent({
          kind: 'alert_sent',
          key: active.record.key,
          targetClaimId: active.generationId,
          alertKey: pending.alertKey,
          pendingEventId: pending.eventId,
          created: Date.now(),
        });
      }
      if (!this.isCompressionBranchCurrent(source)) return;
      this.compressionRefusalQuarantine = this.readCompressionQuarantineProjection();
      this.checkpointCompressionQuarantineIfNeeded(source);
    });
  }

  private async exhaustCompressionRequestFamily(
    source: CompressionOperationBranch,
    record: CompressionRefusalQuarantineRecord,
    outcomes: CompressionRefusalOutcomeRecord[],
  ): Promise<void> {
    if (!this.store) return;
    await withCompressionStateLock(
      this.store,
      source.name,
      this.compressionRefusalQuarantineLedgerStateId,
      () => {
      if (!this.isCompressionBranchCurrent(source)) return;
      const current = this.readCompressionQuarantineProjection();
      if (current.has(record.key)) return;
      const exhausted = this.appendCompressionQuarantineEvent({
        kind: 'exhausted', key: record.key, record, outcomes, created: Date.now(),
      });
      if (!this.isCompressionBranchCurrent(source)) return;
      this.appendCompressionQuarantineEvent({
        kind: 'alert_pending',
        key: record.key,
        targetClaimId: exhausted.eventId!,
        alertKey: record.key,
        created: Date.now(),
      });
      this.compressionRefusalQuarantine = this.readCompressionQuarantineProjection();
      this.checkpointCompressionQuarantineIfNeeded(source);
    });
    if (this.isCompressionBranchCurrent(source)) {
      await this.deliverPendingCompressionQuarantineAlerts(source);
    }
  }

  private compressionRefusalQuarantineRecord(
    chunk: Chunk,
    model: string,
    canonicalRequestHash: string,
    canonicalRequest: NormalizedRequest,
    keptSummaries: SummaryEntry[],
    variants: RecallCurveVariant[],
    plan: CompressionRefusalPlanRecord[],
    canonicalProviderInputTokens?: number,
  ): CompressionRefusalQuarantineRecord {
    const chunkSourceHash = sha256Json(chunk.messages.map((message) => message.id));
    const frontierHash = sha256Json(
      keptSummaries.map((summary) => ({ id: summary.id, level: summary.level })),
    );
    const fallbackLimit = this.normalizedCompressionFallbackLimit();
    const contextBudgetTokens = this.normalizedCompressionContextBudget();
    const canonicalRequestBoundTokens = this.compressionRequestInputBoundTokens(canonicalRequest);
    const normalizedConfig: CompressionRefusalNormalizedConfig = {
      accountingVersion: COMPRESSION_BUDGET_ACCOUNTING_VERSION,
      fallbackLimit,
      contextBudgetTokens,
      requestConfig: canonicalRequest.config,
    };
    const familyKey = sha256Json({
      model,
      chunkSourceHash,
      frontierHash,
      canonicalRequestHash,
      accountingSource: COMPRESSION_BUDGET_ACCOUNTING_SOURCE,
      normalizedConfig,
      variants: variants.map((variant) => ({
        parentId: variant.parent.id,
        childIds: variant.children.map((child) => child.id),
        requestHash: variant.requestHash,
      })),
    });
    const key = sha256Json({
      familyKey,
      model,
      chunkSourceHash,
      frontierHash,
      canonicalRequestHash,
      accountingSource: COMPRESSION_BUDGET_ACCOUNTING_SOURCE,
      canonicalRequestBoundTokens,
      canonicalProviderInputTokens,
      normalizedConfig,
      plan,
    });
    return {
      key,
      familyKey,
      model,
      chunkSourceHash,
      frontierHash,
      canonicalRequestHash,
      accountingSource: COMPRESSION_BUDGET_ACCOUNTING_SOURCE,
      canonicalRequestBoundTokens,
      ...(canonicalProviderInputTokens !== undefined ? { canonicalProviderInputTokens } : {}),
      normalizedConfig,
      fallbackLimit,
      contextBudgetTokens,
      plan,
      created: Date.now(),
    };
  }

  protected setMergedInto(entry: SummaryEntry, mergedIntoId: string): void {
    this.requireBranchMutation('setMergedInto');
    entry.mergedInto = mergedIntoId;
    if (!this.store) return;
    // Resolve the log position by ID against the PERSISTED array — never by
    // in-memory index. `loadPersistedState` filters empty-content summaries
    // out of `this.summaries` while they remain in the log, so after a reload
    // the in-memory index is shifted relative to the log slot. Editing by
    // in-memory index wrote merge-updates onto NEIGHBORING entries, silently
    // clobbering them (4 summaries lost in the 2026-07 Lena incident, leaving
    // duplicate-id copies with diverging mergedInto). Update every stored
    // copy with this id so past duplicates converge too.
    const stored = this.store.getStateJson(this.summariesStateId);
    if (!Array.isArray(stored)) return;
    let found = false;
    const payload = Buffer.from(JSON.stringify(entry));
    for (let i = 0; i < stored.length; i++) {
      const item = stored[i] as SummaryEntry | null;
      if (item && item.id === entry.id) {
        this.store.editStateItem(this.summariesStateId, i, payload);
        found = true;
      }
    }
    if (!found) {
      console.warn(
        `[autobiographical] setMergedInto: ${entry.id} not found in persisted summary log — merge state not persisted`,
      );
    }
  }

  /**
   * Allocate the next summary-id counter value and persist the new counter.
   */
  protected nextSummaryIdCounter(): number {
    this.requireBranchMutation('nextSummaryIdCounter');
    const value = this.summaryIdCounter++;
    this.store?.setStateJson(this.counterStateId, this.summaryIdCounter);
    return value;
  }

  /**
   * Push to the merge queue and persist the new queue snapshot.
   *
   * Quarantined source sets are refused: after a merge exhausts its bounded
   * retry policy, `checkMergeThreshold`/`enqueueMergeForRange` would
   * otherwise re-discover the same unmerged run and re-enqueue it forever.
   * The merge-quarantine klaxon owns visibility; this guard stays silent.
   */
  protected enqueueMerge(merge: { level: SummaryLevel; sourceIds: string[]; attempts?: number }): void {
    this.requireBranchMutation('enqueueMerge');
    if (this.mergeQuarantine.has(sha256Json(merge.sourceIds))) return;
    this.mergeQueue.push(merge);
    this.store?.setStateJson(this.mergeQueueStateId, this.mergeQueue);
  }

  /**
   * Pop from the merge queue and persist the new queue snapshot.
   */
  protected dequeueMerge(): { level: SummaryLevel; sourceIds: string[]; attempts?: number } | undefined {
    this.requireBranchMutation('dequeueMerge');
    const merge = this.mergeQueue.shift();
    this.store?.setStateJson(this.mergeQueueStateId, this.mergeQueue);
    return merge;
  }

  /**
   * Bounded-retry accounting for a merge whose response was rejected by the
   * terminal-disposition gate. The attempt counter lives ON the persisted
   * queue entry, so restarts don't reset the policy. At the limit, the merge
   * moves from the queue into the durable quarantine — never a retry loop,
   * never silent loss.
   */
  protected recordMergeRejection(
    merge: { level: SummaryLevel; sourceIds: string[]; attempts?: number; lastStopReason?: string; lastOutcome?: string; hadRefusal?: boolean; serverErrorStreak?: number },
    rejection: MergeDispositionRejection,
  ): void {
    this.requireBranchMutation('recordMergeRejection');
    if (this.mergeQueue[0] !== merge) return; // queue mutated mid-await; nothing to account
    merge.attempts = (merge.attempts ?? 0) + 1;
    if (rejection.stopReason !== undefined) merge.lastStopReason = rejection.stopReason;
    merge.lastOutcome = rejection.outcome;
    // Sticky across the entry's lifetime: once any attempt was classifier-
    // refused, later retries keep the source-level fallback payload even if
    // an intervening rejection had a different stop reason (prevents the
    // raw→refusal→fallback→tool_use→raw oscillation).
    if (rejection.stopReason === 'refusal') merge.hadRefusal = true;
    const limit = Math.max(1, this.config.mergeAttemptLimit ?? 5);
    if (merge.attempts >= limit) {
      this.dequeueMerge();
      this.quarantineMerge(merge, rejection, limit);
      return;
    }
    this.store?.setStateJson(this.mergeQueueStateId, this.mergeQueue);
    console.warn(
      `[autobiographical] L${merge.level} merge attempt ${merge.attempts}/${limit} rejected ` +
        `(${rejection.outcome}${rejection.stopReason ? `, stop=${rejection.stopReason}` : ''}) — ` +
        `entry retained for retry`,
    );
  }

  /** Move an exhausted merge into the durable quarantine and receipt it. */
  protected quarantineMerge(
    merge: { level: SummaryLevel; sourceIds: string[]; attempts?: number },
    rejection: MergeDispositionRejection,
    limit: number,
  ): void {
    const record: MergeQuarantineRecord = {
      key: sha256Json(merge.sourceIds),
      level: merge.level,
      sourceIds: merge.sourceIds,
      attempts: merge.attempts ?? limit,
      lastOutcome: rejection.outcome,
      ...(rejection.stopReason !== undefined ? { lastStopReason: rejection.stopReason } : {}),
      ...(rejection.errorType !== undefined ? { lastErrorType: rejection.errorType } : {}),
      lastRequestHash: rejection.requestHash,
      quarantinedAt: Date.now(),
    };
    this.mergeQuarantine.set(record.key, record);
    this.persistMergeQuarantine();
    console.error(
      `[merge-quarantine] ⚠️ L${merge.level} merge over ${merge.sourceIds.length} sources ` +
        `quarantined after ${record.attempts} rejected attempt(s) ` +
        `(last: ${record.lastOutcome}${record.lastStopReason ? `, stop=${record.lastStopReason}` : ''}). ` +
        `Sources stay unmerged; operator action required (inspect, then clearMergeQuarantine). ` +
        `key=${record.key.slice(0, 12)}`,
    );
    logCompressionCall({
      event: 'merge:quarantined',
      operation: `merge_l${merge.level}`,
      metadata: { ...record },
    });
  }

  protected persistMergeQuarantine(): void {
    this.store?.setStateJson(this.mergeQuarantineStateId, [...this.mergeQuarantine.values()]);
  }

  /**
   * Merge-quarantine status for observers/operators.
   */
  getMergeQuarantineStatus(): { count: number; records: MergeQuarantineRecord[] } {
    return { count: this.mergeQuarantine.size, records: [...this.mergeQuarantine.values()] };
  }

  /**
   * Operator action: lift merge quarantine for one key (or all). The next
   * `checkMergeThreshold` pass re-discovers the unmerged run and re-enqueues
   * it with a fresh attempt budget.
   */
  clearMergeQuarantine(key?: string): void {
    this.requireLoadedBranch('clearMergeQuarantine');
    if (key !== undefined) {
      if (!this.mergeQuarantine.delete(key)) return;
    } else {
      if (this.mergeQuarantine.size === 0) return;
      this.mergeQuarantine.clear();
    }
    this.persistMergeQuarantine();
    console.warn(`[merge-quarantine] cleared ${key ? `key=${key.slice(0, 12)}` : 'ALL records'} — merges eligible for re-enqueue`);
    this.checkMergeThreshold();
  }

  /**
   * Sweep merge-quarantine records whose debt no longer exists, so the
   * klaxon only sounds on real debt:
   *  - every source now has a parent (covered by a later successful merge
   *    or repair) → paid, clear;
   *  - no source summary exists anymore (surgery/repair removed them) →
   *    unretryable orphan, clear;
   *  - any source still unmerged and present → live debt, keep.
   */
  protected sweepPaidOffMergeQuarantine(): void {
    if (this.mergeQuarantine.size === 0) return;
    const byId = new Map<string, SummaryEntry>();
    for (const s of this.summaries) byId.set(s.id, s);
    let swept = 0;
    for (const [key, record] of [...this.mergeQuarantine]) {
      const live = record.sourceIds.filter((id) => {
        const s = byId.get(id);
        return s !== undefined && !getSummaryParentId(s);
      });
      if (live.length === 0) {
        this.mergeQuarantine.delete(key);
        swept++;
      }
    }
    if (swept > 0) {
      this.persistMergeQuarantine();
      console.warn(`[merge-quarantine] swept ${swept} paid-off/orphaned record(s)`);
    }
  }

  /**
   * Repeating klaxon for merge quarantine, mirroring the chunk-quarantine
   * klaxon: quarantined merges keep their sources unmerged, the frontier
   * widens, and deep-level folds stall — debt, not a resting state. Uses
   * the same interval config; `quarantineAlarmIntervalMs: 0` disables.
   */
  protected soundMergeQuarantineAlarmIfNeeded(): void {
    const interval = this.config.quarantineAlarmIntervalMs ?? 15 * 60_000;
    if (interval <= 0) return;
    const now = Date.now();
    if (!this.mergeQuarantineAlarmActive && now - this.mergeQuarantineAlarmLastAt < interval) return;
    this.sweepPaidOffMergeQuarantine();
    if (this.mergeQuarantine.size === 0) {
      if (this.mergeQuarantineAlarmActive) {
        this.mergeQuarantineAlarmActive = false;
        this.mergeQuarantineAlarmLastAt = 0;
        console.error('[merge-quarantine] ✅ ALL CLEAR — merge quarantine empty; alarm stands down');
      }
      return;
    }
    if (this.mergeQuarantineAlarmActive && now - this.mergeQuarantineAlarmLastAt < interval) return;
    this.mergeQuarantineAlarmActive = true;
    this.mergeQuarantineAlarmLastAt = now;
    const keys = [...this.mergeQuarantine.keys()].map((k) => k.slice(0, 12)).join(',');
    console.error(
      `[merge-quarantine] ⚠️ ${this.mergeQuarantine.size} merge(s) quarantined — their sources ` +
        `stay unmerged and deep-level folding is stalled for those spans. Operator action ` +
        `required (inspect llm-calls receipts; clearMergeQuarantine to retry). keys=${keys}`,
    );
  }

  /**
   * Translate produce ops emitted by the picker into concrete work items on
   * the strategy's own queues. Two cases:
   *
   *  - `level === 1`: the picker has asked for L1 coverage on a raw chunk.
   *    In the autobio chunker model, each chunk maps to exactly one L1, so
   *    we locate the chunk whose messages fall in `op.range` and ensure
   *    it is queued for L1 compression. If the chunker hasn't realized the
   *    message yet, we skip silently — the next `rebuildChunks` will pick
   *    it up.
   *
   *  - `level >= 2`: the picker has asked for an L_n covering a contiguous
   *    range. We gather unmerged L_{n-1} summaries whose source ranges
   *    fall within that range (de-duplicated against entries already in
   *    `mergeQueue`) and enqueue a single merge over them. The merge fires
   *    on the next `tick()`.
   *
   * The handler is conservative: it never enqueues a singleton or empty
   * merge, and it never re-enqueues an id that's already pending. That
   * keeps the next-compile picker loop convergent even when the same
   * produce op gets re-emitted before the work completes.
   */
  protected handleProducedOps(
    ops: readonly ProduceRequest[],
    opts?: { speculative?: boolean },
  ): void {
    this.requireBranchMutation('handleProducedOps');
    for (const op of ops) {
      if (op.level === 1) {
        this.enqueueL1ForRange(op.range.firstChunkId, op.range.lastChunkId, opts);
      } else if (op.level >= 2) {
        this.enqueueMergeForRange(
          op.level,
          op.range.firstChunkId,
          op.range.lastChunkId,
        );
      }
    }
  }

  /**
   * Ensure that chunks whose message range overlaps [firstMsgId..lastMsgId]
   * are queued for L1 compression. No-op if the matching chunk is already
   * compressed or already in the queue.
   */
  protected enqueueL1ForRange(
    firstMsgId: MessageId,
    lastMsgId: MessageId,
    opts?: { speculative?: boolean },
  ): void {
    this.requireBranchMutation('enqueueL1ForRange');
    const messageIdToChunk = new Map<MessageId, Chunk>();
    for (const ch of this.chunks) {
      for (const m of ch.messages) messageIdToChunk.set(m.id, ch);
    }
    const candidates = new Set<Chunk>();
    const first = messageIdToChunk.get(firstMsgId);
    // Tail-endpoint fallback (issue #56): the range's last message may sit in
    // the unclosed trailing span — messages the chunker hasn't realized yet,
    // which by construction lie AFTER every closed chunk. The kv-stable
    // escalation demand path emits ranges over contiguous L1-uncovered runs,
    // and such a run naturally extends from the newest uncompressed closed
    // chunk into the unclosed span. Resolving only `first` would demand one
    // chunk per compile while the agent is hard-down on OverBudgetError;
    // treating the unresolved tail as "through the newest closed chunk"
    // demands the whole backlog in one compile instead.
    const last = messageIdToChunk.get(lastMsgId)
      ?? (first ? this.chunks[this.chunks.length - 1] : undefined);
    if (first) candidates.add(first);
    if (last) candidates.add(last);
    // Also catch chunks fully spanned by the range (rare, but supports the
    // case where the picker requests an L1 that should logically cover
    // multiple chunks worth of messages — we err on the side of producing
    // L1s for every spanned chunk).
    if (first && last && first.index !== last.index) {
      const [lo, hi] = first.index < last.index
        ? [first.index, last.index]
        : [last.index, first.index];
      for (let i = lo; i <= hi; i++) {
        const ch = this.chunks[i];
        if (ch) candidates.add(ch);
      }
    }
    const holdback = this.config.l1HoldbackChunks ?? 1;
    const holdbackCutoff = this.chunks.length - holdback;
    for (const chunk of candidates) {
      if (chunk.compressed) continue;
      const lastId = chunk.messages[chunk.messages.length - 1]?.id;
      if (opts?.speculative) {
        // Speculative demand (shadow production pick) is not live demand: the
        // live budget may not need this fold for days. It must not mark the
        // chunk demanded, and it must not punch through the holdback window
        // that protects the newest closed chunks while they're in motion.
        if (
          holdback > 0 &&
          chunk.index >= holdbackCutoff &&
          !(lastId !== undefined && this._demandedL1Chunks.has(lastId))
        ) {
          continue;
        }
      } else {
        // Demand path: mark the chunk so the l1HoldbackChunks window in
        // rebuildChunks never filters it back out of the queue.
        if (lastId !== undefined) this._demandedL1Chunks.add(lastId);
      }
      if (this.compressionQueue.includes(chunk.index)) continue;
      this.compressionQueue.push(chunk.index);
    }
  }

  /**
   * Enqueue an L_{targetLevel} merge over unmerged L_{targetLevel-1}
   * summaries whose source ranges fall within [firstMsgId..lastMsgId].
   * No-op if fewer than 2 viable sources are available (a singleton merge
   * would just rename a summary without consolidating).
   */
  protected enqueueMergeForRange(
    targetLevel: number,
    firstMsgId: MessageId,
    lastMsgId: MessageId,
  ): void {
    this.requireBranchMutation('enqueueMergeForRange');
    const sourceLevel = targetLevel - 1;

    // IDs already enqueued at this target level.
    const queuedAtLevel = new Set<string>();
    for (const m of this.mergeQueue) {
      if (m.level === targetLevel) {
        for (const id of m.sourceIds) queuedAtLevel.add(id);
      }
    }

    // Sequence index per message id, for "within range" tests. Use the
    // current chunk store as the ordering source.
    const messageOrder = new Map<MessageId, number>();
    let seq = 0;
    for (const ch of this.chunks) {
      for (const m of ch.messages) {
        messageOrder.set(m.id, seq++);
      }
    }
    const firstSeq = messageOrder.get(firstMsgId);
    const lastSeq = messageOrder.get(lastMsgId);

    const inRange = (msgId: MessageId): boolean => {
      if (firstSeq === undefined || lastSeq === undefined) return true;
      const s = messageOrder.get(msgId);
      if (s === undefined) return false;
      const [lo, hi] = firstSeq <= lastSeq ? [firstSeq, lastSeq] : [lastSeq, firstSeq];
      return s >= lo && s <= hi;
    };

    const sources: SummaryEntry[] = [];
    for (const s of this.summaries) {
      if (s.level !== sourceLevel) continue;
      if (getSummaryParentId(s)) continue;
      if (queuedAtLevel.has(s.id)) continue;
      if (!inRange(s.sourceRange.first) && !inRange(s.sourceRange.last)) continue;
      sources.push(s);
    }
    if (sources.length < 2) return;

    const N = this.config.mergeThreshold ?? 6;
    const toMerge = sources.slice(0, N);
    this.enqueueMerge({
      level: targetLevel as SummaryLevel,
      sourceIds: toMerge.map((s) => s.id),
    });
  }

  checkReadiness(): ReadinessState {
    this.requireLoadedBranch('checkReadiness');
    if (this.pendingCompression) {
      return {
        ready: false,
        pendingWork: this.pendingCompression,
        description: `Compressing chunk ${this.compressionQueue[0] ?? '?'}`,
      };
    }

    const needsCompression = this.chunks.some(
      (c) => !c.compressed && this.isChunkOldEnough(c)
    );
    const needsMerge = this.config.hierarchical && this.mergeQueue.length > 0;

    if ((needsCompression && this.compressionQueue.length > 0) || needsMerge) {
      const parts: string[] = [];
      if (this.compressionQueue.length > 0) parts.push(`${this.compressionQueue.length} chunks`);
      if (needsMerge) parts.push(`${this.mergeQueue.length} merges`);
      return {
        ready: false,
        description: `${parts.join(' + ')} pending`,
      };
    }

    return { ready: true };
  }

  async onNewMessage(message: StoredMessage, ctx: StrategyContext): Promise<void> {
    this.requireLoadedBranch('onNewMessage');
    this.rebuildChunks(ctx.messageStore);

    // Auto-tick: fire speculative compression in the background. After
    // each tick completes, if the queue still has work AND we're under
    // the speculation cap AND preflight allows, schedule another tick.
    // This drains the queue ahead of need rather than one-chunk-per-
    // user-turn (reactive). Combined with ContextManager.compile not
    // awaiting pendingCompression, the agent's response and background
    // compression run truly in parallel.
    if (this.config.autoTickOnNewMessage && !this.pendingCompression) {
      this.driveSpeculativeDrain(ctx);
    }
  }

  /**
   * Background-drain loop: keeps calling tick() while there's queued work,
   * subject to the speculation cap and preflight hook. Recurses via
   * `queueMicrotask` so one chunk's compression doesn't block the
   * scheduling of the next.
   *
   * Stops if a tick fails to make progress (queue size unchanged) — guards
   * against runaway recursion when tick is a no-op (e.g. no membrane
   * configured, or a subclass override that doesn't process the queue).
   */
  protected driveSpeculativeDrain(ctx: StrategyContext): void {
    this.requireLoadedBranch('driveSpeculativeDrain');
    if (this.pendingCompression) return;
    // Merges consolidate existing L_k summaries into L_{k+1} and REDUCE the
    // unmerged-L1 count; L1 compression PRODUCES new unmerged L1s. The
    // speculation cap / preflight throttle *production* only — they must never
    // gate merges, otherwise exceeding the cap (e.g. after a manual backfill)
    // permanently deadlocks the drain: too many unmerged L1s trips the cap,
    // which blocks the very merges that would bring the count back down.
    const hasMerges = this.config.hierarchical === true && this.mergeQueue.length > 0;
    const hasCompression = this.compressionQueue.length > 0;
    if (!hasCompression && !hasMerges) return;
    // Only bail when the *sole* available work is L1 compression that the cap
    // or preflight currently forbids. Merge work always proceeds.
    if (!hasMerges && (this.isAtSpeculativeCap() || !this.shouldCompressPreflight())) return;

    const progressBefore = this._drainProgress;

    this.tick(ctx)
      .then(() => {
        // Progress = the tick actually processed a queue item (compress or
        // merge), tracked by `_drainProgress`. A queue-length delta is the
        // wrong signal: a productive merge tick can also enqueue a follow-on
        // merge, leaving the length unchanged — which the old check misread as
        // "no progress" and halted the drain mid-backlog. A genuine no-op tick
        // (empty queues, at-cap with no merges, no membrane) doesn't advance
        // the counter, so this still stops cleanly (no runaway recursion).
        if (this._drainProgress === progressBefore) return;
        // Recurse to drain more — via the MACROTASK queue (setTimeout 0),
        // never queueMicrotask. Microtasks run before the event loop returns
        // to I/O, so a microtask-chained drain strings its ticks' synchronous
        // compression-context compiles (~2s each on a large store) back to
        // back and STARVES inbound events: a live wake sits in the host queue
        // for the whole backlog (mythos 2026-07-26: 21s from DM delivery to
        // turn start while a post-restart drain ground ~10 compiles). A
        // macrotask hop lets pending sockets/timers run between ticks,
        // capping the added wake latency at ~one tick's compile.
        setTimeout(() => this.driveSpeculativeDrain(ctx), 0);
      })
      .catch((err) => {
        console.error('AutobiographicalStrategy: speculative-drain error:', err);
      });
  }

  /**
   * Whether the count of *produced, unmerged* L1 summaries has reached the cap
   * configured by `maxSpeculativeL1s`. If no cap is set, always false.
   *
   * The cap bounds how many L1 summaries may sit un-consolidated before the
   * strategy must merge them into L_{k+1} (bounding prefix churn / merge debt).
   * It deliberately does NOT count the pending `compressionQueue`: that queue is
   * the backlog of work to be *drained*, not produced summaries. Counting it
   * here would let a large backlog permanently trip the cap and block the very
   * compression that would clear it — a deadlock (merges relieve the cap, but
   * compression of the backlog never resumes). The throttle is on produced L1s;
   * the queue drains freely, with merges keeping the unmerged count under the cap.
   */
  protected isAtSpeculativeCap(): boolean {
    const cap = this.config.maxSpeculativeL1s;
    if (cap === undefined || cap < 0) return false;
    const unmergedL1s = this.summaries.filter(s => s.level === 1 && !s.mergedInto).length;
    return unmergedL1s > cap;
  }

  /**
   * Preflight hook for whether speculative compression should fire on
   * `onNewMessage`. Returns true by default (current eager behavior).
   * Subclasses can override for predictive scheduling — e.g. only fire
   * when the live tail token count is approaching some threshold.
   */
  protected shouldCompressPreflight(): boolean {
    return true;
  }

  async tick(ctx: StrategyContext): Promise<void> {
    const sourceBranch = this.requireLoadedBranch('tick');
    phaseChannel.report('compress-tick'); // liveness-watchdog phase
    // Quarantine is deferred debt, never a resting state: every quarantined
    // chunk keeps its span raw, the fold floor creeps, and the picker
    // eventually cannot fit the window — a guaranteed future outage. Sound
    // the alarm on every interval for as long as ANY chunk is quarantined
    // (after sweeping records whose debt is already paid).
    await this.soundQuarantineAlarmIfNeeded();
    this.soundMergeQuarantineAlarmIfNeeded();
    if (this.pendingCompression) return;

    if (!ctx.membrane) {
      console.warn('AutobiographicalStrategy: No membrane instance for compression');
      return;
    }

    // Priority 1: Compress raw chunks → L1. Skipped while at the speculative
    // cap (maxSpeculativeL1s) so we don't pile up more unmerged L1s; the merge
    // priority below still runs to consolidate existing L1s and relieve the cap.
    // No cap configured → isAtSpeculativeCap() is always false → unchanged.
    if (this.compressionQueue.length > 0 && !this.isAtSpeculativeCap()) {
      const chunkIndex = this.compressionQueue.shift()!;
      this._drainProgress++; // consumed a queue item (real work or stale-cleanup)
      const chunk = this.chunks[chunkIndex];

      if (!chunk || chunk.compressed) return;

      this.pendingCompression = this.compressChunkHierarchical(chunk, ctx);

      try {
        await this.pendingCompression;
      } finally {
        this.pendingCompression = null;
      }
      return;
    }

    // Priority 2: Execute pending merges (hierarchical only)
    //
    // Peek at the head rather than dequeueing eagerly: dequeueMerge persists
    // the shorter queue *before* the LLM call leaves the building, so a
    // transient failure (429, network drop, timeout, executeMerge throw)
    // would silently lose the merge from disk and the sources would sit at
    // level N-1 with no mergedInto pointers forever. Commit the removal
    // only after the merge succeeds; on failure, the queue keeps its entry
    // and the next tick() retries it.
    if (this.config.hierarchical && this.mergeQueue.length > 0) {
      const merge = this.mergeQueue[0]!;
      this._drainProgress++; // executing a merge is real work, even if a
      // follow-on merge gets enqueued and the queue length nets out unchanged
      this.pendingCompression = this.executeMerge(merge.level, merge.sourceIds, ctx);

      try {
        await this.pendingCompression;
        if (!this.isCompressionBranchCurrent(sourceBranch)) return;
        // Success: drop from head and persist the shorter queue. We
        // re-check that head is still our merge in case some future code
        // path mutates the queue mid-await (today no other site does,
        // but the assertion makes that invariant explicit).
        if (this.mergeQueue[0] === merge) {
          this.dequeueMerge();
        }
      } catch (error) {
        // Terminal-disposition rejection: the LLM answered, but with a
        // refusal / truncation / tool call / empty — bounded-retry policy,
        // not a crash. Anything else (429, network, timeout) keeps the
        // pre-existing semantics: rethrow, entry stays queued, next tick
        // retries with no attempt accounting.
        if (error instanceof MergeDispositionRejection) {
          if (!this.isCompressionBranchCurrent(sourceBranch)) return;
          this.recordMergeRejection(merge, error);
          return;
        }
        // A NON-RETRYABLE provider error (membrane retryable:false — e.g.
        // context_length, invalid_request) is deterministic: the identical
        // request fails identically on every tick, and the rethrow path
        // below has no attempt accounting — a hot retry loop (opus4
        // 2026-08-03: 442 context_length 400s at ~6s intervals, 2.7GB of
        // full-payload error logs). Route it through the same bounded
        // attempts/quarantine policy as disposition rejections; the merge
        // prompt halves its recall budget per attempt (see executeMerge),
        // so each retry is a genuinely smaller request. Retryable errors
        // (429, network, timeout) keep the pre-existing rethrow semantics.
        const membraneType = (error as { type?: unknown; retryable?: unknown }) ?? {};
        if (
          error instanceof Error &&
          membraneType.retryable === false &&
          typeof membraneType.type === 'string'
        ) {
          if (!this.isCompressionBranchCurrent(sourceBranch)) return;
          this.recordMergeRejection(
            merge,
            new MergeDispositionRejection(
              merge.level,
              'provider_error',
              sha256Json({ level: merge.level, sourceIds: merge.sourceIds, transport: membraneType.type }),
              undefined,
              membraneType.type,
            ),
          );
          return;
        }
        // Retryable SERVER errors (500/529) are usually transient — but a
        // PERSISTENT one on the same payload loops forever under pure
        // rethrow (rhys 2026-08-06: 514 consecutive merge 500s across a
        // week-long provider episode, zero accounting). Count a streak on
        // the persisted head entry; past the bound, route through the same
        // bounded rejection policy (whose retries also shrink the recall
        // budget, giving the provider a genuinely different request).
        // Below the bound the rethrow keeps transient semantics: no
        // attempt burn for a blip.
        if (
          error instanceof Error &&
          membraneType.retryable === true &&
          membraneType.type === 'server'
        ) {
          if (!this.isCompressionBranchCurrent(sourceBranch)) return;
          merge.serverErrorStreak = (merge.serverErrorStreak ?? 0) + 1;
          this.store?.setStateJson(this.mergeQueueStateId, this.mergeQueue);
          if (merge.serverErrorStreak >= AutobiographicalStrategy.MERGE_SERVER_ERROR_STREAK_LIMIT) {
            this.recordMergeRejection(
              merge,
              new MergeDispositionRejection(
                merge.level,
                'provider_error',
                sha256Json({ level: merge.level, sourceIds: merge.sourceIds, transport: 'server-persistent' }),
                undefined,
                'server-persistent',
              ),
            );
            return;
          }
        }
        throw error;
      } finally {
        this.pendingCompression = null;
      }
    }
  }

  /**
   * Snapshot of compression progress. Intended for external observers
   * (warmup scripts, dashboards) that need to track convergence without
   * reaching into protected fields. Values are point-in-time copies; mutating
   * them does not affect strategy state.
   */
  getProgressSnapshot(): AutobiographicalProgressSnapshot {
    this.requireLoadedBranch('getProgressSnapshot');
    let chunksCompressed = 0;
    for (const c of this.chunks) if (c.compressed) chunksCompressed++;
    let l1 = 0, l2 = 0, l3 = 0;
    for (const s of this.summaries) {
      if (s.level === 1) l1++;
      else if (s.level === 2) l2++;
      else if (s.level === 3) l3++;
    }
    return {
      totalChunks: this.chunks.length,
      chunksCompressed,
      l1QueueLength: this.compressionQueue.length,
      mergeQueueLength: this.mergeQueue.length,
      summaryCounts: { l1, l2, l3 },
      pending: this.pendingCompression !== null,
    };
  }

  select(
    store: MessageStoreView,
    log: ContextLogView,
      budget: TokenBudget,
      opts?: SelectOptions
    ): ContextEntry[] {
      this.requireLoadedBranch('select');
      const _diag = typeof process !== 'undefined' && !!process.env?.CM_CACHE_DIAG;
      const _t0 = _diag ? Date.now() : 0;
      this.rebuildChunks(store);
      if (_diag) console.error(`[cm-cache] select: rebuildChunks ${Date.now() - _t0}ms`);

    // Image stripping runs inside each select path (before stats commit / cache
    // markers), so the returned entries are already bounded — see
    // applyImageStripping.
    if (this.config.adaptiveResolution) {
      return this.selectAdaptive(store, budget, opts);
    }
    // selectHierarchical commits nothing (no state-slot writes, no enqueue),
    // so it is already dry-run-safe and needs no gating.
    return this.selectHierarchical(store, budget);
  }

  /**
   * Get summary statistics for observability.
   */
  getStats(): {
    chunksTotal: number; chunksCompressed: number; compressionCount: number;
    l1: number; l2: number; l3: number; pendingMerges: number;
  } {
    this.requireLoadedBranch('getStats');
    return {
      chunksTotal: this.chunks.length,
      chunksCompressed: this.chunks.filter(c => c.compressed).length,
      compressionCount: this._compressionCount,
      l1: this.summaries.filter(s => s.level === 1 && !s.mergedInto).length,
      l2: this.summaries.filter(s => s.level === 2 && !s.mergedInto).length,
      l3: this.summaries.filter(s => s.level === 3 && !s.mergedInto).length,
      pendingMerges: this.mergeQueue.length,
    };
  }

  /**
   * Compression-debt reduction — the single authority for "is this
   * resident's memory organ keeping up." Consumed by /healthz (fleet-watch
   * alarms on it) and, later, by the resident-facing notice (af #99). The
   * 2026-08-06 five-resident wedge day showed every outage was weeks of
   * silently-failing compression surfacing as a sudden budget crisis: the
   * failure was never the wedge, the wedge was the accumulated interest on
   * an invisible failure. This method makes the interest visible.
   *
   * States:
   * - `healthy`  — no quarantines; no closed chunk has waited > 1h.
   * - `degraded` — any quarantine record exists, or the oldest closed-but-
   *                uncompressed chunk has waited > 1h.
   * - `critical` — the oldest pending chunk has waited > 6h AND there is a
   *                quarantine or a 5+ chunk backlog: the organ is not
   *                recovering on its own; an operator is needed.
   *
   * The OPEN frontier chunk (still accumulating messages) is not debt and
   * is excluded. Ages derive from the newest message inside the oldest
   * pending chunk — chunk records carry no timestamps of their own.
   * Read-only, never throws (health surface contract).
   */
  getCompressionDebt(now: number = Date.now()): {
    state: 'healthy' | 'degraded' | 'critical';
    pendingChunks: number;
    oldestPendingAgeMs: number | null;
    mergeQueueDepth: number;
    mergeQueueMaxAttempts: number;
    mergeQuarantineCount: number;
    compressionQuarantineCount: number;
    unmergedFrontier: { l1: number; l2: number; l3: number };
    lastMintAt: number | null;
  } {
    const DEGRADED_AFTER_MS = 60 * 60 * 1000;
    const CRITICAL_AFTER_MS = 6 * 60 * 60 * 1000;
    const empty = {
      state: 'healthy' as const,
      pendingChunks: 0,
      oldestPendingAgeMs: null,
      mergeQueueDepth: 0,
      mergeQueueMaxAttempts: 0,
      mergeQuarantineCount: 0,
      compressionQuarantineCount: 0,
      unmergedFrontier: { l1: 0, l2: 0, l3: 0 },
      lastMintAt: null,
    };
    try {
      // Exclude the trailing open chunk: it is life, not debt.
      const closed = this.chunks.filter((c, i) => !(i === this.chunks.length - 1 && !c.compressed));
      const pending = closed.filter((c) => !c.compressed);
      // Chronicle timestamps may be µs; normalize to ms defensively.
      const toMs = (t: number): number => (t > 1e14 ? t / 1000 : t);
      let oldestPendingAgeMs: number | null = null;
      for (const c of pending) {
        const ts = c.messages
          .map((m) => (m as unknown as { timestamp?: number }).timestamp)
          .filter((t): t is number => typeof t === 'number');
        if (!ts.length) continue;
        const closedAt = toMs(Math.max(...ts));
        const age = now - closedAt;
        if (oldestPendingAgeMs === null || age > oldestPendingAgeMs) oldestPendingAgeMs = age;
      }
      const mergeQuarantineCount = this.mergeQuarantine.size;
      const compressionQuarantineCount = this.getCompressionQuarantineStatus().count;
      const quarantines = mergeQuarantineCount + compressionQuarantineCount;
      const mints = this.summaries
        .map((s) => s.created)
        .filter((t): t is number => typeof t === 'number');
      const lastMintAt = mints.length ? toMs(Math.max(...mints)) : null;

      let state: 'healthy' | 'degraded' | 'critical' = 'healthy';
      const stale = oldestPendingAgeMs !== null && oldestPendingAgeMs > DEGRADED_AFTER_MS;
      if (quarantines > 0 || stale) state = 'degraded';
      if (
        oldestPendingAgeMs !== null &&
        oldestPendingAgeMs > CRITICAL_AFTER_MS &&
        (quarantines > 0 || pending.length >= 5)
      ) {
        state = 'critical';
      }
      return {
        state,
        pendingChunks: pending.length,
        oldestPendingAgeMs,
        mergeQueueDepth: this.mergeQueue.length,
        mergeQueueMaxAttempts: Math.max(0, ...this.mergeQueue.map((m) => m.attempts ?? 0)),
        mergeQuarantineCount,
        compressionQuarantineCount,
        unmergedFrontier: {
          l1: this.summaries.filter((s) => s.level === 1 && !s.mergedInto).length,
          l2: this.summaries.filter((s) => s.level === 2 && !s.mergedInto).length,
          l3: this.summaries.filter((s) => s.level === 3 && !s.mergedInto).length,
        },
        lastMintAt,
      };
    } catch {
      return empty;
    }
  }

  /**
   * Richer per-render stats: requires a message store view to compute the
   * head + tail (recent window) sizes. Returns counts AND token sums per
   * summary level, so observers can see "how much of the agent's context
   * is in raw tail vs folded into L1/L2/L3."
   *
   * Useful for TUI / dashboards. The token sums use the strategy's own
   * token estimates (which match what `select()` uses for budget math).
   */
  // ===========================================================================
  // Render-stats instrumentation — inspect, don't reconstruct.
  //
  // selectAdaptive/selectHierarchical tally each entry into `_rs` AS THEY EMIT
  // it (raw head/tail, raw middle the picker kept verbatim, and recall pairs
  // bucketed by the ancestor summary's level), using the same token numbers the
  // renderer uses for budget math. `getRenderStats()` returns that committed
  // snapshot, so it reflects what the last compile actually rendered rather than
  // re-deriving the full pyramid (which, under adaptive resolution, bears little
  // resemblance to the folded output).
  //
  // CAVEAT: the final structural passes (`trimOrphanedToolUse`,
  // `enforceToolPairing`) run AFTER the per-entry tallies and BEFORE `rsEnd()`,
  // and are NOT reflected in the snapshot. Trims only remove entries (total
  // over-counts by at most the trimmed tail); the pairing validator can also
  // ADD stub tool_result entries (total then under-counts by those stubs).
  // Both deltas are a handful of tokens — the stats describe the selection, not
  // the byte-exact wire payload. Do not treat `total` as an exact wire count.
  // ===========================================================================
  private _rs: RenderStats | null = null;
  private _lastRenderStats: RenderStats | null = null;

  // ===========================================================================
  // Coverage invariant: every middle-region message must be rendered raw OR
  // covered by an emitted summary. The raw-middle paths below are a fallback
  // for chunks that have not been compressed yet, so when one of them drops a
  // message under budget pressure there is nothing left to represent it. That
  // used to happen silently — the select returned a plausible window and the
  // agent was simply missing a stretch of its own history (Rhys, 2026-07-26:
  // 126 turns absent, no error, no warning, no stat). Drops are recorded here
  // and asserted before entries are returned.
  // ===========================================================================
  private _uncoveredDrops: string[] = [];
  private _uncoveredSite = '';
  private _uncoveredDiag: { budget: number; totalTokens: number } = { budget: 0, totalTokens: 0 };

  /** Record middle-region messages dropped with no summary covering them. */
  protected recordUncoveredDrops(
    ids: string[],
    site: string,
    diagnostics: { budget: number; totalTokens: number },
  ): void {
    if (ids.length === 0) return;
    for (const id of ids) this._uncoveredDrops.push(id);
    this._uncoveredSite = site;
    this._uncoveredDiag = diagnostics;
  }

  /**
   * Fail loudly if this select dropped un-summarized middle content.
   * Called at the end of every select path, immediately before the entries
   * are returned — a refused turn is strictly better than an agent that
   * quietly lost part of its past.
   */
  protected assertMiddleCoverage(): void {
    if (this._uncoveredDrops.length === 0) return;
    const droppedIds = this._uncoveredDrops;
    const site = this._uncoveredSite;
    const diagnostics = this._uncoveredDiag;
    this._uncoveredDrops = [];
    // A dry-run preview exists precisely to answer "what would happen at these
    // settings" — including settings that would lose content. Report there,
    // throw only on a committing select.
    // Read defensively: this patch must also apply to trees without the
    // dry-run preview feature (fleet clones on origin/main).
    const inPreview = (this as unknown as { _previewInFlight?: boolean })._previewInFlight === true;
    if (inPreview) {
      console.warn(
        `[autobiographical] preview: ${droppedIds.length} middle message(s) would be ` +
        `dropped with no summary coverage (site=${site}, budget=${diagnostics.budget}).`,
      );
      return;
    }
    throw new UncoveredDropError({ droppedIds, site, diagnostics });
  }

  /**
   * Of the middle messages left unrendered when a select loop broke, return
   * only those with NO summary representation — resolution 0 (meant to render
   * raw) or a resolution whose ancestor summary doesn't exist. Messages that
   * still have a live summary ancestor are covered and must NOT be reported,
   * or steady-state agents would throw on ordinary budget pressure.
   */
  protected uncoveredRemaining(
    messages: StoredMessage[],
    from: number,
    to: number,
    finalResolutions: ReadonlyMap<string, number>,
    chunksByMessageId: Map<string, unknown>,
    summariesById: Map<string, unknown>,
  ): string[] {
    const out: string[] = [];
    for (let k = from; k < to && k < messages.length; k++) {
      const m = messages[k];
      if (!m) continue;
      const res = finalResolutions.get(m.id) ?? 0;
      if (res === 0) { out.push(m.id); continue; }
      const ancestor = this.findAncestorAt(
        m.id,
        res,
        chunksByMessageId as never,
        summariesById as never,
      );
      if (!ancestor) out.push(m.id);
    }
    return out;
  }

  /**
   * THE COVERAGE INVARIANT.
   *
   * Every message the selector was handed must leave the renderer either
   * rendered raw, or represented by a summary that was ITSELF rendered —
   * following the summary graph transitively, because a message is usually
   * not covered by its own L1 but by an L2/L3 that subsumes it:
   *
   *     msg ──in──> L1 ──in──> L2 ──in──> L3      (only L3 emitted)
   *
   * A `SummaryEntry` says which kind of thing its `sourceIds` point at via
   * `sourceLevel`: 0 means message ids, n>0 means summary ids one level down.
   * So coverage is computed by expanding every emitted summary downward until
   * level 0 and unioning the message ids found there.
   *
   * This replaces per-drop-site bookkeeping. Site trackers only catch the
   * `break`s someone remembered to instrument — three were patched on
   * 2026-07-26 and a fourth (recent-window eviction) was found only because
   * Rhys's import tripped it. A check on the finished output does not care HOW
   * something went missing, so paths that don't exist yet are covered too.
   *
   * Deliberately runs BEFORE the tool-pairing/orphan/image passes: those
   * remove content to satisfy API shape rules, which is a structural edit
   * rather than budget-driven loss, and is out of scope for this invariant.
   */
  protected assertFullCoverage(entries: ContextEntry[], messages: StoredMessage[], regions?: { headStart: number; headEnd: number; recentStart: number }): void {
    const covered = new Set<string>();
    for (const e of entries) {
      const one = (e as { sourceMessageId?: string }).sourceMessageId;
      if (one) covered.add(one);
      // Composites (merged body-group shards) stand for several messages.
      const many = (e as { sourceMessageIds?: string[] }).sourceMessageIds;
      if (many) for (const id of many) covered.add(id);
    }

    // Expand emitted summaries down to the message ids they stand for.
    const byId = new Map(this.summaries.map(x => [x.id, x]));
    const seen = new Set<string>();
    const stack: string[] = [...this._emittedSummaryIds];
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const sum = byId.get(id);
      if (!sum) continue;
      if (sum.sourceLevel === 0) {
        for (const mid of sum.sourceIds) covered.add(mid);
      } else {
        for (const child of sum.sourceIds) stack.push(child);
      }
    }

    const missing: string[] = [];
    for (const m of messages) if (!covered.has(m.id)) missing.push(m.id);
    if (missing.length === 0) return;

    const site = this._uncoveredSite || 'unknown-site';
    const diagnostics = this._uncoveredDiag.budget > 0
      ? this._uncoveredDiag
      : { budget: 0, totalTokens: 0 };
    // A preview answers "what would happen at these settings" — including
    // settings that lose content. Report there; refuse only a committing pass.
    // CLASSIFY every missing id rather than counting them. A false positive is
    // the checker being lied to about what the renderer produced, so each
    // category is either given provenance or explicitly declared
    // unrepresentable-by-design. The invariant goes fatal only when
    // `unclassified` is empty — fatal-with-unknown-categories turns every
    // unenumerated case into a refused turn on a live agent.
    const byCategory = new Map<string, string[]>();
    const classify = (id: string): string => {
      const m = messages.find(x => x.id === id);
      if (!m) return 'not-in-window';
      const blocks = Array.isArray(m.content) ? m.content : [];
      const text = blocks
        .map(b => (b as { text?: string }).text ?? '')
        .join('')
        .trim();
      const nonText = blocks.some(b => (b as { type?: string }).type !== 'text');
      if (blocks.length === 0 || (text === '' && !nonText)) return 'empty-content';
      if ((m as { bodyGroupId?: string }).bodyGroupId) return 'body-group-shard';
      // Does ANY summary claim this message, transitively — emitted or not?
      // If one does, the message is representable and the renderer chose not
      // to render its representation: a different defect from "no summary
      // exists at all", so the two must not share a bucket.
      const claims = (sumId: string, seenIds: Set<string>): boolean => {
        if (seenIds.has(sumId)) return false;
        seenIds.add(sumId);
        const sum = this.summaries.find(x => x.id === sumId);
        if (!sum) return false;
        if (sum.sourceLevel === 0) return sum.sourceIds.includes(id);
        return sum.sourceIds.some(child => claims(child, seenIds));
      };
      const claimedBy = this.summaries.find(sum => claims(sum.id, new Set()));
      if (claimedBy) {
        return this._emittedSummaryIds.has(claimedBy.id)
          ? 'in-emitted-summary-but-uncounted'
          : 'covered-by-unemitted-summary';
      }
      const chunk = this.chunks.find(c => c.messages?.some((cm: { id: string }) => cm.id === id));
      if (chunk) return chunk.compressed ? 'in-compressed-chunk-no-summary' : 'in-uncompressed-chunk';
      // Is the summary GRAPH broken? A parent whose sourceIds name a child that
      // no longer exists standalone (merged away) leaves a hole: the walk down
      // from the parent can never reach the messages underneath, so they look
      // unclaimed even though a rendered ancestor represents them.
      const known = new Set(this.summaries.map(x => x.id));
      const dangling = this.summaries.some(
        sum => sum.sourceLevel > 0 && sum.sourceIds.some(child => !known.has(child)),
      );
      if (dangling) return 'dangling-summary-chain';
      // Does a summary's sourceRange span this message even though sourceIds
      // does not name it? That is provenance recorded at range granularity.
      const spanned = this.summaries.some(sum => {
        const r = (sum as { sourceRange?: { first?: string; last?: string } }).sourceRange;
        return !!r && (r.first === id || r.last === id);
      });
      if (spanned) return 'named-only-in-sourceRange';
      // Where does this message sit relative to the three regions the renderer
      // actually emits? If it is in none of them, the regions do not partition
      // the window and the gap itself is the bug.
      if (regions) {
        const pos = messages.findIndex(x => x.id === id);
        if (pos < 0) return 'not-in-window';
        // Before the LIVE head start (head-window reset moved the anchor):
        // this is compressible middle history, not head — a distinct defect
        // from a verbatim-head message going unrendered.
        if (pos < regions.headStart) return 'before-head-start-not-rendered';
        if (pos < regions.headEnd) return 'in-head-not-rendered';
        if (pos >= regions.recentStart) return 'in-tail-not-rendered';
        return 'in-middle-not-rendered';
      }
      return 'unclassified-no-regions';
    };
    for (const id of missing) {
      const c = classify(id);
      const list = byCategory.get(c) ?? [];
      list.push(id);
      byCategory.set(c, list);
    }
    const summary = [...byCategory.entries()]
      .map(([c, ids]) => `${c}=${ids.length}`)
      .join(' ');
    const unclassified = byCategory.get('unclassified') ?? [];
    // NOT fatal yet — BLOCKED on entry provenance. `ContextEntry` carries a
    // single `sourceMessageId`, but `mergeAdjacentBodyGroupRaw` collapses
    // several raw entries (body-group shards) into one composite, so the ids
    // of the absorbed shards are absent from the output and read as "missing"
    // here. Measured 2026-07-26: 22 suite failures, all of this shape (1-3
    // ids, no drop site fired). Making this fatal requires `sourceMessageIds:
    // MessageId[]` on ContextEntry (or provenance recorded at emission), after
    // which this check subsumes and replaces the per-site trackers — and
    // `/debug/context/coverage` finally means something.
    // FATAL. Enumeration on 2026-07-26 drove `unclassified` to zero: every
    // residual category (in-head-not-rendered, in-middle-not-rendered,
    // in-uncompressed-chunk, covered-by-unemitted-summary) is content the
    // renderer was handed and did not represent. There is no legitimately
    // unrepresentable category left, so this refuses the turn rather than
    // shipping a context with holes in it.
    throw new UncoveredDropError({
      droppedIds: missing,
      site: `${site} [${summary}]`,
      diagnostics,
    });
  }

  /**
   * Clamp a compression `max_tokens` to the model's output ceiling when the
   * recipe declares one. Without this an agent whose compression model caps
   * below the 16k floor (Claude 3 Opus: 4096) fails every fold with a 400 and
   * silently never compresses.
   */
  protected capCompressionTokens(requested: number): number {
    const cap = this.config.compressionMaxTokens;
    if (typeof cap === 'number' && cap > 0) return Math.min(requested, cap);
    return requested;
  }

  /** Begin a render-stats accumulation for one select() pass. */
  protected rsBegin(): void {
    this._uncoveredDrops = [];
    this._emittedSummaryIds = new Set();
    this._plannedTokens = null;
    this._plannedMeta = null;
    this._rs = {
      head: { messages: 0, tokens: 0 },
      tail: { messages: 0, tokens: 0 },
      middleRaw: { messages: 0, tokens: 0 },
      summaries: {
        l1: { count: 0, tokens: 0 },
        l2: { count: 0, tokens: 0 },
        l3: { count: 0, tokens: 0 },
      },
      pending: { chunks: 0, merges: 0 },
      total: { messages: 0, tokens: 0 },
    };
  }

  /** Tally one (or `count`) raw message(s) into a raw bucket. */
  protected rsRaw(bucket: 'head' | 'tail' | 'middleRaw', tokens: number, count = 1): void {
    const r = this._rs;
    if (!r) return;
    r[bucket].messages += count;
    r[bucket].tokens += tokens;
  }

  /** Tally one emitted recall pair under its ancestor's level (>=3 folds into l3). */
  /** Ids of summaries actually emitted into the rendered context this pass.
   *  Identity is what makes transitive coverage checkable — level+tokens alone
   *  cannot tell you WHICH messages a rendered summary stands in for. */
  private _emittedSummaryIds: Set<string> = new Set();
  /** The picker's projected total for this compile (planner side). */
  private _plannedTokens: number | null = null;
  private _plannedMeta: { budgetMet: boolean; exhausted: boolean; moves: number; solver: string } | null = null;

  protected rsSummary(level: number, tokens: number, id?: string): void {
    if (id) this._emittedSummaryIds.add(id);
    const r = this._rs;
    if (!r) return;
    const k: 'l1' | 'l2' | 'l3' = level <= 1 ? 'l1' : level === 2 ? 'l2' : 'l3';
    r.summaries[k].count += 1;
    r.summaries[k].tokens += tokens;
  }

  /** Commit the accumulated stats as the last-render snapshot. */
  protected rsEnd(): void {
    const r = this._rs;
    if (!r) return;
    r.pending = {
      chunks: this.chunks.filter(c => !c.compressed).length,
      merges: this.mergeQueue.length,
    };
    const s = r.summaries;
    const summaryMsgs = (s.l1.count + s.l2.count + s.l3.count) * 2; // Q/A pair each
    r.total = {
      messages: r.head.messages + r.tail.messages + r.middleRaw.messages + summaryMsgs,
      tokens:
        r.head.tokens + r.tail.tokens + r.middleRaw.tokens +
        s.l1.tokens + s.l2.tokens + s.l3.tokens,
    };
    // Planner vs emitter reconciliation. `planned` is what the picker
    // projected after folding; `actual` is what the emitter committed. They
    // should agree — a persistent gap means the plan is written in units the
    // emitter doesn't spend in, and the difference is silently absorbed by
    // whatever renders last (the recent window). Logged on every compile so
    // the drift is observable before it becomes an eviction.
    if (this._plannedTokens !== null) {
      const actual = r.total.tokens;
      const planned = this._plannedTokens;
      const delta = actual - planned;
      const pct = planned > 0 ? (delta / planned) * 100 : 0;
      const m = this._plannedMeta;
      r.planVsActual = {
        planned,
        actual,
        delta,
        budgetMet: m?.budgetMet ?? false,
        exhausted: m?.exhausted ?? false,
        moves: m?.moves ?? 0,
        ...(m?.solver !== undefined ? { solver: m.solver } : {}),
      };
      // Loud only when the emitter OVERRUNS the plan — that is the direction
      // that costs the tail. Under-spend is harmless slack.
      const loud = delta > 0 && Math.abs(pct) >= 2;
      const line =
        `[plan-vs-actual] planned=${planned} actual=${actual} delta=${delta >= 0 ? '+' : ''}${delta}` +
        ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) budgetMet=${m?.budgetMet} exhausted=${m?.exhausted}` +
        ` moves=${m?.moves} solver=${m?.solver}`;
      if (loud) console.warn(`${line} — emitter overran the plan; the overrun is paid by the recent window`);
      else console.error(line);
    }
    this._lastRenderStats = r;
    this._rs = null;
  }

  /**
   * Stats describing the LAST rendered context. Returns the inspected snapshot
   * captured during the most recent `select()`. Before any compile has run (no
   * snapshot yet), falls back to a reconstructed pyramid view so callers still
   * get a non-null shape.
   */
  getRenderStats(store: MessageStoreView): RenderStats {
    this.requireLoadedBranch('getRenderStats');
    return this._lastRenderStats ?? this.reconstructRenderStats(store);
  }

  /**
   * Pre-render fallback: re-derive head/tail windows + the full live pyramid.
   * NOTE: this is the old "reconstruct" behavior and does NOT reflect adaptive
   * folding — used only until the first compile populates the inspected stats.
   */
  protected reconstructRenderStats(store: MessageStoreView): RenderStats {
    const messages = store.getAll();
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = this.getRecentWindowStart(store);

    const sumTokens = (slice: StoredMessage[]): number =>
      slice.reduce((acc, m) => acc + store.estimateTokens(m), 0);

    const headMsgs = messages.slice(headStart, headEnd);
    const tailMsgs = messages.slice(recentStart);

    const live = (level: SummaryLevel) =>
      this.summaries.filter(s => s.level === level && !s.mergedInto);
    const sumLevelTokens = (level: SummaryLevel): number =>
      live(level).reduce((acc, s) => acc + s.tokens, 0);

    const head = { messages: headMsgs.length, tokens: sumTokens(headMsgs) };
    const tail = { messages: tailMsgs.length, tokens: sumTokens(tailMsgs) };
    const summaries = {
      l1: { count: live(1).length, tokens: sumLevelTokens(1) },
      l2: { count: live(2).length, tokens: sumLevelTokens(2) },
      l3: { count: live(3).length, tokens: sumLevelTokens(3) },
    };
    return {
      head,
      tail,
      middleRaw: { messages: 0, tokens: 0 },
      summaries,
      pending: {
        chunks: this.chunks.filter(c => !c.compressed).length,
        merges: this.mergeQueue.length,
      },
      total: {
        messages: head.messages + tail.messages
          + (summaries.l1.count + summaries.l2.count + summaries.l3.count) * 2,
        tokens: head.tokens + tail.tokens
          + summaries.l1.tokens + summaries.l2.tokens + summaries.l3.tokens,
      },
    };
  }

  /**
   * Emit recent-window messages, evicting OLDEST-first when the budget is tight.
   *
   * The previous loop iterated `recentStart → messages.length` forward and broke
   * on `totalTokens + tokens > maxTokens`. When the head/summary section eats most
   * of the budget, the loop emits the oldest messages of the window and aborts
   * before reaching the newest — exactly the messages an agent needs to act on.
   * This helper picks newest-first within the budget, then emits the kept set in
   * chronological order, dropping a leading orphan tool_result if its tool_use
   * fell into the evicted older portion.
   */
  protected emitRecentNewestFirst(
    entries: ContextEntry[],
    store: MessageStoreView,
    messages: StoredMessage[],
    recentStart: number,
    msgCap: number,
    maxTokens: number,
    totalTokensBefore: number,
    // Post-strip per-message estimates (2026-07-12): eviction must price a
    // message the way the stripped render will. Raw pricing counted every
    // stripped image at full cost and evicted most of an image-era tail the
    // recent-window walk had correctly admitted (mythos: 601-message tail
    // admitted, 228 survived eviction, 45k rendered of a 120k window).
    pse?: number[],
  ): { messages: number; tokens: number } {
    if (recentStart >= messages.length) return { messages: 0, tokens: 0 };

    const est = (i: number): number => pse?.[i] ?? store.estimateTokens(messages[i]);
    const accepted: number[] = [];
    let acceptedTokens = 0;
    for (let i = messages.length - 1; i >= recentStart; i--) {
      const tokens = msgCap > 0 ? Math.min(est(i), msgCap + 50) : est(i);
      if (this.isOverBudget(totalTokensBefore + acceptedTokens + tokens, maxTokens)) {
        // Newest-first eviction: everything from recentStart..i is being
        // dropped. These live in the RECENT window, so by definition no
        // summary covers them — the drop is unrepresented history, not a
        // resolution downgrade. Record it so the select fails loudly rather
        // than returning a window that silently begins mid-conversation.
        const dropped: string[] = [];
        for (let k = recentStart; k <= i; k++) {
          const m = messages[k];
          if (m) dropped.push(m.id);
        }
        // An event is never permitted to go unrepresented. The postmortem
        // that produced the newest-first order (Triumvirate Conhost Silence,
        // 2026-05-04) fixed WHICH end got cut after dropped messages made an
        // agent go silent — it never sanctioned the cutting. Evicting from
        // the recent window removes messages that no rendered summary covers,
        // so it is loss, and loss refuses the turn rather than shipping a
        // context that silently begins mid-conversation.
        console.warn(
          `[autobiographical] recent-window eviction dropped ${dropped.length} message(s) ` +
          `(budget=${maxTokens}); ${this.summaries.length === 0
            ? 'store has NO summaries — this is unrecoverable loss'
            : 'older recent-window messages, expected to be summary-covered'}.`,
        );
        this.recordUncoveredDrops(dropped, 'emitRecentNewestFirst/eviction', {
          budget: maxTokens,
          totalTokens: totalTokensBefore + acceptedTokens,
        });
        break;
      }
      accepted.push(i);
      acceptedTokens += tokens;
    }
    accepted.reverse();

    // Drop leading orphan tool_result(s): their matching tool_use was evicted.
    while (
      accepted.length > 0 &&
      this.hasToolResult(messages[accepted[0]]) &&
      !this.hasToolUse(messages[accepted[0]])
    ) {
      accepted.shift();
    }

    let emittedTokens = 0;
    for (const i of accepted) {
      const msg = messages[i];
      const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
      const tokens = msgCap > 0 ? Math.min(est(i), msgCap + 50) : est(i);
      entries.push({
        index: entries.length,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content,
      });
      emittedTokens += tokens;
    }
    return { messages: accepted.length, tokens: emittedTokens };
  }

  // ============================================================================
  // Hierarchical (L1/L2/L3) path
  // ============================================================================

  /**
   * Anti-redundancy filter: get summaries to show, excluding those whose
   * children are all already visible at a lower level.
   *
   * Matches moltbot's gradient exclusion algorithm (worker.ts:293-447).
   */
  protected getAntiRedundantSummaries(excludeMessageIds?: Set<string>): {
    shownL1: SummaryEntry[];
    shownL2: SummaryEntry[];
    shownL3: SummaryEntry[];
  } {
    // Step 1: All unmerged L1s, excluding those whose sourceIds overlap with exclusion set
    let candidateL1 = this.summaries.filter(s => s.level === 1 && !s.mergedInto);
    if (excludeMessageIds && excludeMessageIds.size > 0) {
      candidateL1 = candidateL1.filter(
        s => !s.sourceIds.some(id => excludeMessageIds.has(id))
      );
    }
    const shownL1 = candidateL1;
    const shownL1Ids = new Set(shownL1.map(s => s.id));

    // Step 2: Unmerged L2s, excluding those whose ALL source L1s are shown
    const candidateL2 = this.summaries.filter(s => s.level === 2 && !s.mergedInto);
    const shownL2 = candidateL2.filter(
      s => !s.sourceIds.every(l1Id => shownL1Ids.has(l1Id))
    );
    const shownL2Ids = new Set(shownL2.map(s => s.id));

    // Step 3: Unmerged L3s, excluding those whose ALL source L2s are shown
    const candidateL3 = this.summaries.filter(s => s.level === 3 && !s.mergedInto);
    const shownL3 = candidateL3.filter(
      s => !s.sourceIds.every(l2Id => shownL2Ids.has(l2Id))
    );

    return { shownL1, shownL2, shownL3 };
  }

  /**
   * Compress a raw message chunk into an L1 summary using self-voice framing.
   * No system prompt — framing via message structure only.
   */
  protected async compressChunkHierarchical(chunk: Chunk, ctx: StrategyContext): Promise<void> {
    const sourceBranch = this.requireLoadedBranch('compressChunkHierarchical');
    phaseChannel.report('compress-chunk'); // liveness-watchdog phase
    if (!ctx.membrane) {
      throw new Error('No membrane instance for compression');
    }

    // ---- Duplicate-formation guards (layered) ----
    // Merged from two independent fixes for the same disease:
    //
    // 1. EXACT MATCH → adopt (bug 6.10, Tengro). rebuildChunks (fired by
    //    onNewMessage / select) can re-queue a span whose compression already
    //    completed against a stale chunk object — or, under chunk
    //    persistence, a crash between the L1 append and the record edit
    //    leaves a record uncompressed with its summary already in the log.
    //    Adopt the existing summary, skip the LLM call, and heal the record.
    const chunkIdKey = this.chunkKey(chunk);
    const exactExisting = this.findExactL1(chunkIdKey);
    if (exactExisting) {
      chunk.compressed = true;
      chunk.summaryId = exactExisting.id;
      this.markChunkRecordCompressed(chunk.recordId, exactExisting.id);
      return;
    }

    const coveredByL1 = new Set<string>();
    for (const s of this.summaries) {
      if (s.level === 1 && Array.isArray(s.sourceIds)) {
        for (const id of s.sourceIds) coveredByL1.add(id);
      }
    }

    // 2. FULLY COVERED (non-exact) → drop rather than duplicate history
    //    (bug 6.10, Tengro): boundaries shifted across a rebuild and every
    //    message is already inside some L1. Marking compressed WITHOUT a
    //    summaryId means the uncompressed-middle fallback skips these
    //    messages — they render only via the covering L1s. Safe while
    //    `recentStart` advances monotonically (a fully-covered OLD chunk
    //    can't intersect the recent-exclusion window); if that assumption is
    //    ever weakened, reinstate a raw fallback (chunk-level `coveredBy`)
    //    rather than dropping. The chunk record (if any) is deliberately
    //    left uncompressed as an operator breadcrumb.
    if (chunk.messages.length > 0 && chunk.messages.every(m => coveredByL1.has(m.id))) {
      console.warn(
        `[autobiographical] dedup guard: chunk ${chunk.recordId ?? `#${chunk.index}`} ` +
        `is fully covered by existing L1s under different boundaries — dropped, not re-compressed.`,
      );
      chunk.compressed = true;
      return;
    }

    // 3. PARTIAL OVERLAP → refuse (strict; chunk persistence). With
    //    close-then-compress there is NO legitimate way for a chunk to
    //    partially overlap an existing L1's span. If it happens anyway
    //    (bookkeeping bug, store surgery gone wrong), refuse to produce:
    //    a warning in the log is strictly better than a duplicate memory
    //    in an agent's head.
    const overlapIds = chunk.messages.filter(m => coveredByL1.has(m.id)).map(m => m.id);
    if (overlapIds.length > 0) {
      const key = chunk.recordId ?? chunkIdKey;
      if (!this._overlapBlocked.has(key)) {
        this._overlapBlocked.add(key);
        console.error(
          `[autobiographical] OVERLAP GUARD: refusing to compress chunk ` +
          `${chunk.recordId ?? `#${chunk.index}`} — ${overlapIds.length}/${chunk.messages.length} ` +
          `of its messages are already covered by existing L1 summaries ` +
          `(first: ${overlapIds[0]}). Duplicate-memory formation blocked; ` +
          `investigate before resuming this span.`,
        );
      }
      return;
    }

    const targetTokens = this.config.summaryTargetTokens ?? 2000;
    const agentParticipant = this.config.summaryParticipant ?? 'Claude';

    // ---- 0. Thin-chunk guard ----
    // A chunk of silent/skip turns and bare system traffic gives the
    // summarizer nothing to remember. Asked anyway, it confabulates: it
    // reaches for the nearest salient content (head window, prior recall
    // pairs) and narrates it as if it just happened — each such L1 then
    // compounds through merges (the "68 initiations" incident). Store a
    // mechanical stub without an LLM call instead. Chunks with any
    // non-text blocks (tool cycles, images) are never stubbed.
    const minChunkChars = this.config.minChunkCharsForLLM ?? 200;
    if (minChunkChars > 0) {
      let substantiveChars = 0;
      let hasNonText = false;
      for (const m of chunk.messages) {
        for (const b of m.content) {
          if (b.type === 'text') substantiveChars += b.text.trim().length;
          else hasNonText = true;
        }
      }
      if (!hasNonText && substantiveChars < minChunkChars) {
        const messageIds = chunk.messages.map(m => m.id);
        const stub: SummaryEntry = {
          id: `L1-${this.nextSummaryIdCounter()}`,
          level: 1,
          content:
            `(A quiet stretch: ${chunk.messages.length} messages of routine ` +
            `system traffic — heartbeats, empty turns, notices. Nothing ` +
            `happened worth remembering.)`,
          tokens: 40,
          sourceLevel: 0,
          sourceIds: messageIds,
          sourceRange: { first: messageIds[0], last: messageIds[messageIds.length - 1] },
          created: Date.now(),
          phaseType: chunk.phaseType,
        };
        this.pushSummary(stub);
        chunk.compressed = true;
        chunk.summaryId = stub.id;
        this.markChunkRecordCompressed(chunk.recordId, stub.id);
        this._compressionCount++;
        logCompressionCall({
          operation: 'compress_l1',
          system: null,
          messages: [],
          metadata: {
            stub: true,
            chunk_message_ids: messageIds,
            chunk_size: chunk.messages.length,
            substantive_chars: substantiveChars,
            min_chunk_chars: minChunkChars,
            summary_id: stub.id,
          },
          response: summarizeTelemetryText(stub.content),
        });
        this.checkMergeThreshold();
        return;
      }
    }

    // Build the KV-preserving prompt per hermes-autobio spec:
    //
    //   1. Head — the raw chronicle opening (identity anchor), FIRST,
    //      exactly where the original instance saw it. It MUST precede
    //      the recall pairs: when it followed them (pre-2026-07 order),
    //      it read as the most recent live conversation, and for thin
    //      chunks the summarizer narrated the head as fresh events
    //      ("Antra came to me to explore the transformation story
    //      again…"), compounding across merges into runaway false
    //      memories (the "68 initiations" incident). Chronological
    //      order is also the KV-stable order — the head never changes.
    //      (executeMerge always had head-first; this site was the odd
    //      one out.)
    //   2. Prior summaries — narrativized as CM-asks / agent-recalls
    //      pairs, in source order. The unmerged frontier of the
    //      summary forest: any summary that has not yet been merged
    //      into a higher level. After merges run, the L_{k+1} replaces
    //      its L_k children — using the children plus their parent
    //      doubles the prompt size unboundedly.
    //   3. Raw middle — messages between head and chunk not covered by
    //      any summary (usually empty).
    //   4. Marker — in-band signal that a memory is about to form.
    //   5. Chunk — raw messages being compressed, as the agent
    //      experienced them.
    //   6. Instruction — doc-aware if the chunk is part of a bodyGroup.
    //
    // There is intentionally NO tail_after_chunk: that would leak
    // future information into the model's KV state and corrupt the
    // as-of framing of memory formation.
    const llmMessages: Array<{ participant: string; content: ContentBlock[] }> = [];

    const allMessages = ctx.messageStore.getAll();
    const headStartIdx = this.getHeadWindowStartIndex(ctx.messageStore);
    const headEndIdx = this.getHeadWindowEnd(ctx.messageStore);

    // ---- Prior recall set (the unmerged frontier) ----
    // Computed BEFORE the head emission because the head loop needs the
    // leaf coverage of live summaries (one-to-one rule below).
    //
    // Filter to the unmerged frontier: any summary whose `mergedInto`
    // is unset. After merge, the children's mergedInto points at the
    // parent and the parent stands alone with that source range. The
    // original "ALL L1s regardless of merge state" rule was a fidelity
    // optimization that scales catastrophically: a 4000-message import
    // converged to ~500 L1s that never aged out, blowing the 200k
    // window around chunk 118.
    // Message IDs are opaque strings, not sortable sequence numbers. Chronicle's
    // default IDs happen to be decimal text, where lexical order corrupts the
    // timeline at the first width transition (`"103" < "15"`). Use the store's
    // canonical order instead so recall pairs remain chronological for every ID
    // representation and newly-created summaries extend rather than splice the
    // provider-cache prefix.
    const messageOrder = new Map<MessageId, number>(
      allMessages.map((message, index) => [message.id, index]),
    );
    const priorSummaries = this.summaries
      // Skip empty-content summaries: emitting `{type:'text', text:''}` as a
      // recall pair triggers Anthropic 400 "text content blocks must be
      // non-empty", which stalls ALL compression (mirrors the render-path guard
      // + load-drop). A single empty summary otherwise poisons every compression.
      .filter((s) => !s.mergedInto && !!s.content && s.content.trim().length > 0)
      .sort((a, b) => {
        const aOrder = messageOrder.get(a.sourceRange.first) ?? Number.MAX_SAFE_INTEGER;
        const bOrder = messageOrder.get(b.sourceRange.first) ?? Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder || a.sourceRange.first.localeCompare(b.sourceRange.first);
      });

    // Leaf message coverage of every live summary — the rendering
    // authority for the one-to-one invariant: a message covered by a
    // live summary is represented by its recall pair, never raw. Uses
    // the FULL priorSummaries set (not the budget-capped keptSummaries):
    // a budget-dropped summary doesn't make its raw messages reappear.
    // Expand summary sourceIds down to leaf message IDs — an L2's
    // sourceIds are L1 IDs, not message IDs; a flat walk would miss
    // every message it transitively covers (Bug 10). Also expand merged
    // L1s as defense in depth.
    const summariesById = new Map<string, SummaryEntry>();
    for (const s of this.summaries) summariesById.set(s.id, s);
    const priorSummaryMessageIds = new Set<MessageId>();
    for (const s of this.summaries) {
      if (s.level === 1) this.expandSummaryToLeafMessageIds(s, summariesById, priorSummaryMessageIds);
    }
    for (const s of priorSummaries) {
      this.expandSummaryToLeafMessageIds(s, summariesById, priorSummaryMessageIds);
    }

    // ---- 1. Head window (raw, FIRST, ownership-capped) ----
    //
    // The head is the foundational identity anchor: the actual opening
    // of the chronicle (the user's first message, the agent's first
    // reply, the system context if any). It establishes WHO is speaking
    // to WHOM. Without it, when the chunk content is heavily first-person
    // from someone other than the agent (e.g., a user-shared document),
    // the agent loses its first-person grounding and drifts into the
    // content author's voice.
    //
    // The head is the configured head window — not "everything before
    // the chunk." For doc-heavy chronicles, "everything before" would
    // be hundreds of thousands of tokens; the recall pairs below
    // represent that intermediate content. The head is just the
    // permanent prefix that the original instance always saw.
    //
    // ONE-TO-ONE INVARIANT: chunk records (and the summaries over them)
    // are the persistent authority over how a message is represented.
    // The token-derived head boundary is only chunking *policy* — it is
    // recomputed from the live estimator on every call and is NOT stable
    // (estimator changes move it; transient headWindowTokens<=0 states
    // let sweeps take ownership of head messages; store surgery can do
    // the same — all observed in production, see issue #42). When the
    // two authorities disagree, ownership wins: a head-range message
    // covered by a live summary renders via its recall pair below, not
    // raw. Rendering it both ways duplicated the seed in every payload.
    let headCoveredSkipped = 0;
    for (let i = headStartIdx; i < headEndIdx && i < allMessages.length; i++) {
      const m = allMessages[i];
      if (priorSummaryMessageIds.has(m.id)) {
        headCoveredSkipped++;
        continue;
      }
      llmMessages.push({ participant: m.participant, content: stripThinkingBlocks(m.content) });
    }
    if (headCoveredSkipped > 0) {
      console.warn(
        `autobio: ${headCoveredSkipped} head-window message(s) are covered by live summaries; ` +
          `rendering them via recall pairs (ownership wins). The token-derived head boundary ` +
          `disagrees with chunk ownership — likely store surgery or head-boundary drift.`,
      );
      logCompressionCall({
        event: 'head-ownership-overlap',
        site: 'compression',
        skipped: headCoveredSkipped,
        headStartIdx,
        headEndIdx,
      });
    }

    // ---- 2. Prior recall pairs (budget-capped) ----

    // Token-budget cap (see capRecallPairs). Defense-in-depth: even with
    // merged exclusion the unmerged frontier can be large at extreme scale.
    const recallBudget = this.config.compressionRecallBudgetTokens ?? 100_000;
    const { kept: keptSummaries, keptTokens: recallTokens } = this.capRecallPairs(
      priorSummaries,
      recallBudget,
    );
    if (keptSummaries.length < priorSummaries.length) {
      const dropped = priorSummaries.length - keptSummaries.length;
      console.warn(
        `autobio: compression recall-pair budget capped (${keptSummaries.length}/${priorSummaries.length} summaries kept, ` +
          `~${recallTokens} tokens, budget ${recallBudget}; ${dropped} oldest dropped this compression).`,
      );
      logCompressionCall({
        event: 'recall-budget-capped',
        site: 'compression',
        kept: keptSummaries.length,
        total: priorSummaries.length,
        tokens: recallTokens,
        budgetTokens: recallBudget,
      });
    }

    for (const s of keptSummaries) {
      llmMessages.push({
        participant: 'Context Manager',
        content: [{ type: 'text', text: `[CM] Recall memory ${s.id}.` }],
      });
      // Recall answers carry the summary's verbatim reasoning carriers
      // (signed thinking) when captured — validated 2026-07-16 on a
      // deterministically-refusing mythos compress request: text-only →
      // reasoning_extraction refusal; with carriers → end_turn. Replaying
      // the model's own text WITH its encrypted reasoning reads as its own
      // history rather than harvested output, the same KV-honesty argument
      // as declaring tools. Raw message thinking is still stripped at
      // insertion (unvalidated: the API rejects thinking blocks whose turn
      // shape was modified, and split/collapse rewrites raw turns).
      llmMessages.push({
        participant: agentParticipant,
        content: this.summaryAnswerContent(s),
      });
    }

    // ---- 3. Raw middle ----
    // Any raw messages between the head and the chunk that aren't yet
    // represented by any summary — usually empty in adaptive-resolution
    // mode, since chunking proceeds contiguously and summaries cover
    // everything up to the chunk being processed. Same one-to-one rule
    // as the head: coverage is judged against `priorSummaryMessageIds`
    // (all live summaries, not the budget-capped keptSummaries).
    const chunkFirstId = chunk.messages[0]?.id;
    if (chunkFirstId) {
      const chunkStartIdx = allMessages.findIndex((m) => m.id === chunkFirstId);
      for (let i = headEndIdx; i < chunkStartIdx && i < allMessages.length; i++) {
        const m = allMessages[i];
        if (priorSummaryMessageIds.has(m.id)) continue;
        llmMessages.push({ participant: m.participant, content: stripThinkingBlocks(m.content) });
      }
    }

    // ---- 4. In-band marker ----
    llmMessages.push({
      participant: 'Context Manager',
      content: [{ type: 'text', text: COMPRESSION_MARKER }],
    });

    // ---- 5. Chunk messages raw ----
    for (const m of chunk.messages) {
      llmMessages.push({ participant: m.participant, content: stripThinkingBlocks(m.content) });
    }

    // ---- 6. Instruction (reading-mode aware) ----
    //
    // When the chunk is a portion of a substantially larger sharded message
    // (≥ 2× chunk size), use the reading-mode instruction. It avoids the
    // "form a memory of what this contained" framing — which, for content
    // heavily first-person from someone other than the agent (a user-shared
    // doc), leads the model to adopt the content author's voice. Instead,
    // it asks what reading was like and what was learned, forcing the
    // model to reflect from its own vantage point in agent-first-person.
    const docContext = this.detectDocContext(chunk, ctx);
    const instructionText = this.applyIdentityReminder(
      docContext
        ? this.getReadingChunkInstruction(chunk, docContext.totalTokens, targetTokens)
        : this.getCompressionInstruction(chunk, targetTokens),
    );
    llmMessages.push({
      participant: 'Context Manager',
      content: [{ type: 'text', text: instructionText }],
    });

    // Split any bundled tool_use+tool_result cycles in non-user turns into
    // separate API-shape messages. claude.ai-imported sessions carry these
    // bundles (a tool_result in an assistant message rejects the request);
    // for fresh imports the conhost importer splits at ingest time, but
    // already-warmed sessions hit this path. See `normalize-tool-messages.ts`.
    const split = splitMixedToolMessages(llmMessages);

    // Collapse consecutive same-participant messages for API compliance
    const collapsed = this.collapseConsecutiveMessages(split);

    // Defense in depth against chunk boundaries that cut a tool cycle
    // (rebuildChunks tries to avoid this, but covers only the most common
    // case). The API rejects any tool_use that isn't immediately followed
    // by its tool_result, and any tool_result that doesn't follow a use.
    const cleaned = stripUnpairedToolBlocks(collapsed);

    // Without the agent's live tool definitions, a request that replays
    // tool-block-bearing history is deterministically refused
    // (reasoning_extraction -- see the `tools` comment below). Tools are
    // pushed by the host on every activation; before the first activation
    // of a session, defer rather than burn a doomed full-window call.
    const chunkHasToolBlocks = cleaned.some(m =>
      m.content.some((b: ContentBlock) => b.type === 'tool_use' || b.type === 'tool_result'));
    if (chunkHasToolBlocks && !(ctx.tools && ctx.tools.length > 0)) {
      console.warn('[autobiographical] deferring chunk compression: history contains tool blocks but host has not provided tool definitions yet (ctx.tools empty) — will retry after next activation');
      return;
    }

    // NO system prompt. The agent's identity is established by the head
    // (the actual conversation opening — user message + agent reply that
    // grounded the original instance). A system prompt would (a) add a
    // synthetic header the original instance never saw, disturbing KV
    // consistency between the summarizer and the original instance, and
    // (b) provide an alternative identity source that competes with the
    // structural one carried by the conversation itself. Anchoring
    // identity by the chronicle's actual head is more honest.
    // Own the byte wall here rather than delegating to membrane's shed: cap
    // the prompt's inline image bytes newest-first before the request is built.
    // A tighter budget than the live window's: a compression prompt also
    // carries the head, the whole recall frontier and the raw chunk, so the
    // image share must leave room for all of it under the API's 32MB cap.
    this.capCompressionImageBytes(
      llmMessages as Array<{ content: ContentBlock[] }>,
      this.config.maxCompressionImageBytes ??
        AutobiographicalStrategy.DEFAULT_MAX_COMPRESSION_IMAGE_BYTES,
    );

    // Final wire-shape messages. Sanitize: strip empty text blocks and drop
    // any message left with no content (empty text reaches the API as a 400
    // that stalls ALL compression — see the twin note on the request below).
    const mintMessages = cleaned
      .map(m => ({ participant: m.participant, content: stripEmptyTextBlocks(m.content) }))
      .filter(m => m.content.length > 0);
    const mintSeamed = this.applyMintCacheSeams(
      mintMessages,
      keptSummaries,
      keptSummaries.length < priorSummaries.length,
    );

    const request: NormalizedRequest = {
      // EXPLICIT image-loss opt-in (2026-07-12): summarizer prompts replay
      // raw history that can carry more inline image bytes than the API's
      // request cap. Dropping the OLDEST images from the summarizer's view is
      // acceptable policy here — the summary describes the span, it does not
      // preserve pixels — and membrane error-logs every exercised shed. All
      // other callers fail loudly instead (no silent transport mutation).
      shedOversizeImages: true,
      // NOTE (2026-07-16): thinking is stripped from RAW messages at their
      // llmMessages insertion sites, not in the mintMessages sanitize — a
      // blanket strip would also remove the recall-pair reasoning carriers,
      // which must reach the API verbatim (see the recall-pair sites).
      messages: mintMessages,
      // 1h TTL on the seam markers: steady-state mint cadence exceeds the
      // 5-minute cache window, where markers cost more than they save. Only
      // attached when a seam was actually placed — a marker-less request
      // must keep its pre-seam shape (canonical hash, quarantine identity).
      ...(mintSeamed ? { cacheTtl: this.config.compressionCacheTtl } : {}),
      config: {
        model: this.requireCompressionModel(),
        // Generous output ceiling so a memory-write is never truncated mid-thought:
        // targetTokens is a *target*, not a cap, and adaptive models routinely
        // overshoot a ~2k target. Was `* 1.5` (=3000 at the 2k default), which cut
        // off rich memories (stop=max_tokens).
        maxTokens: this.capCompressionTokens(Math.max(16000, Math.round(targetTokens * 1.5))),
      },
      // Declare the agent's live tools. A summarizer request that replays
      // tool_use/tool_result history with NO tools param reads to Anthropic's
      // safety classifier as a foreign agent trace being duplicated ->
      // deterministic reasoning_extraction refusal of every memory-write
      // (labclaude incident, 2026-07-09; 268 refusals). Declaring the same
      // tools the live instance runs with is also strictly MORE faithful to
      // the original context, so it is the KV-honest choice, not a
      // workaround. Undefined before the first activation of a session --
      // acceptable: those chunks stay raw and are retried after the agent's
      // first turn (see the defer guard in compressChunkHierarchical).
      tools: ctx.tools,
    };

    // Retain the exact normalized canonical request and frontier. Variants are
    // derived solely by replacing one isolated recall pair; the canonical call
    // below is always issued first and is never rebuilt through fallback code.
    const canonicalRequestHash = sha256Json(request);
    const variants = this.buildRecallCurveVariants(
      request,
      keptSummaries,
      allMessages,
    );
    let fallbackPlan = this.compressionRefusalPlan(request, variants);
    const model = this.requireCompressionModel();
    let quarantineRecord = this.compressionRefusalQuarantineRecord(
      chunk,
      model,
      canonicalRequestHash,
      request,
      keptSummaries,
      variants,
      fallbackPlan,
    );
    const durableQuarantine = this.readCompressionQuarantineProjection();
    // Bounded by chunk hash, not just request identity (2026-08-06
    // ear-loop): as sibling chunks mint, the recall frontier shifts, so
    // every maintenance pass built a NEW key/familyKey for the same
    // refusing span — each cycle burned a full refused call and minted a
    // duplicate quarantine record, forever. A GENUINE shape change
    // (carriers arrive, tools arrive, config change) deserves a fresh
    // attempt — that self-healing is deliberate and pinned by tests — so
    // the gate is a CAP, not a wall: up to CHUNK_QUARANTINE_SHAPE_CAP
    // distinct quarantined shapes per chunk, then sticky until
    // success-clear, paid-off sweep, or operator clear (all of which
    // already match by chunkSourceHash).
    const sameHash = [...durableQuarantine.values()].filter(
      (active) => active.record.chunkSourceHash === quarantineRecord.chunkSourceHash &&
        active.record.normalizedConfig?.accountingVersion === COMPRESSION_BUDGET_ACCOUNTING_VERSION,
    );
    const durableActive = durableQuarantine.get(quarantineRecord.key)
      ?? sameHash.find((active) => active.record.familyKey === quarantineRecord.familyKey)
      ?? (sameHash.length >= AutobiographicalStrategy.CHUNK_QUARANTINE_SHAPE_CAP ? sameHash[0] : undefined);
    if (durableActive) {
      this.compressionRefusalQuarantine = durableQuarantine;
      logCompressionCall({
        event: 'compression:quarantine-skipped',
        operation: 'compress_l1',
        metadata: {
          quarantine_key: durableActive.record.key,
          model,
          chunk_message_ids: chunk.messages.map((message) => message.id),
          canonical_request_hash: canonicalRequestHash,
        },
      });
      return;
    }

    // Same-process duplicate work is ephemeral and scoped to the complete
    // persistence identity. The WeakMap supplies store identity; the key adds
    // namespace/state identity and the observed branch generation so neither
    // cross-namespace writers nor stale branch work can coalesce.
    let inFlight = compressionInFlight.get(this.store!);
    if (!inFlight) {
      inFlight = new Map();
      compressionInFlight.set(this.store!, inFlight);
    }
    const inFlightKey = [
      this.ns,
      this.compressionRefusalQuarantineLedgerStateId,
      sourceBranch.name,
      sourceBranch.generation,
      quarantineRecord.familyKey,
    ].join('\u0000');
    const existingInFlight = inFlight.get(inFlightKey);
    if (existingInFlight) {
      const result = await existingInFlight;
      if (!this.isCompressionBranchCurrent(sourceBranch)) {
        this.logCompressionBranchDiscard(sourceBranch, 'coalesced_wait', quarantineRecord);
        return;
      }
      if (result.error) throw result.error;
      // The producer may belong to a different strategy instance. Reload the
      // same namespace's durable result so a successful waiter gets its L1 and
      // an exhausted waiter gets the quarantine projection rather than merely
      // returning after somebody else's work.
      this.loadPersistedState();
      if (!this.isCompressionBranchCurrent(sourceBranch)) return;
      const coalescedSummary = this.findExactL1(chunkIdKey);
      if (coalescedSummary) {
        chunk.compressed = true;
        chunk.summaryId = coalescedSummary.id;
      }
      return;
    }
    let settleInFlight!: (result: CompressionInFlightResult) => void;
    const inFlightCompletion = new Promise<CompressionInFlightResult>((resolve) => {
      settleInFlight = resolve;
    });
    inFlight.set(inFlightKey, inFlightCompletion);

    const callStart = Date.now();
    let logResponse: string | undefined;
    let logError: string | undefined;
    let logSummaryId: string | undefined;
    const attemptTraces: CompressionAttemptTrace[] = [];
    let successfulTrace: CompressionAttemptTrace | undefined;
    let inFlightError: unknown;

    try {
      const runAttempt = async (
        attemptRequest: NormalizedRequest,
        curveLabel: string,
        recallIds: string[],
        recallLevels: number[],
        leafCoverageHash: string,
        expandedParentId?: string,
        expandedChildIds?: string[],
      ): Promise<unknown> => {
        const started = Date.now();
        let response: unknown;
        try {
          response = await ctx.membrane!.complete(
            attemptRequest,
            { formatter: this.nativeFormatter },
          );
        } catch (error) {
          // Degraded mode: the transport rejected the carrier blocks
          // themselves (invalid_request about thinking — never a refusal).
          // Retry this attempt once with text-only recall pairs, loudly.
          if (!isCarrierTransportRejection(error) || !requestCarriesReasoning(attemptRequest)) {
            throw error;
          }
          console.error(
            `[autobiographical] transport rejected reasoning carriers on '${curveLabel}' ` +
              `(${String(error).slice(0, 200)}) — retrying ONCE with text-only recall pairs (degraded mode)`,
          );
          logCompressionCall({
            event: 'compression:carrier-transport-fallback',
            operation: 'compress_l1',
            metadata: { curveLabel, error: String(error).slice(0, 300) },
          });
          response = await ctx.membrane!.complete(
            stripReasoningFromRequest(attemptRequest),
            { formatter: this.nativeFormatter },
          );
        }
        if (!this.isCompressionBranchCurrent(sourceBranch)) {
          this.logCompressionBranchDiscard(sourceBranch, curveLabel, quarantineRecord);
          throw Object.assign(new Error('Compression result crossed a branch boundary'), {
            name: 'CompressionBranchDiscard',
          });
        }
        const stopReason = this.compressionResponseStopReason(response);
        const trace: CompressionAttemptTrace = {
          curveLabel,
          recallIds,
          recallLevels,
          ...(expandedParentId ? { expandedParentId } : {}),
          ...(expandedChildIds ? { expandedChildIds } : {}),
          leafCoverageHash,
          requestHash: sha256Json(attemptRequest),
          messageCount: attemptRequest.messages.length,
          estimatedTokens: this.estimateCompressionRequestTokens(attemptRequest),
          renderedTokens: this.compressionResponseInputTokens(response),
          stopReason,
          refusalCategory: response && typeof response === 'object'
            ? this.refusalCategory(response as NormalizedResponse)
            : undefined,
          latencyMs: Date.now() - started,
          persisted: false,
        };
        attemptTraces.push(trace);
        return response;
      };

      const summariesById = this.persistedCanonicalSummariesById();
      const messagePosition = new Map(allMessages.map((message, index) => [message.id, index]));
      const canonicalLeafIds = keptSummaries.flatMap(
        (summary) => this.recallCurveLeafIds(summary, summariesById, messagePosition) ?? [],
      ).sort((a, b) => (messagePosition.get(a) ?? 0) - (messagePosition.get(b) ?? 0));
      const canonicalCoverageHash = sha256Json(canonicalLeafIds);
      let response = await runAttempt(
        request,
        'canonical',
        keptSummaries.map((summary) => summary.id),
        keptSummaries.map((summary) => summary.level),
        canonicalCoverageHash,
      );
      successfulTrace = attemptTraces[attemptTraces.length - 1];

      // Terminal-disposition gate (2026-08-01): only a complete `end_turn`
      // may proceed toward persistence. A refusal takes the curve-fallback
      // path as before; any OTHER non-end_turn disposition (max_tokens
      // truncation, tool_use, abort, malformed/missing stopReason) rides
      // the same bounded machinery — variants are unlikely to dodge a
      // truncation the way they dodge a classifier, but the path gives us
      // bounded attempts, durable receipts, and quarantine instead of
      // either canonizing an incomplete memory or retrying forever.
      let canonicalStopReason = this.compressionResponseStopReason(response);

      // tool_use is the one non-end_turn disposition the curve variants
      // CANNOT dodge: they vary the recall frontier, not the response mode,
      // so a think-first model fails every variant identically and the chunk
      // quarantines (lena 2026-08-06, L1 site — the merge site had already
      // grown this retry). One immediate canonical retry with the no-tools
      // line, before the curve plan burns its bounded attempts.
      if (canonicalStopReason === 'tool_use') {
        console.warn(
          `[autobiographical] canonical L1 mint rejected on tool_use — retrying once with no-tools instruction`,
        );
        const retryResponse = await runAttempt(
          withNoToolsLine(request),
          'canonical-no-tools',
          keptSummaries.map((summary) => summary.id),
          keptSummaries.map((summary) => summary.level),
          canonicalCoverageHash,
        );
        let retryStopReason = this.compressionResponseStopReason(retryResponse);
        if (retryStopReason === 'end_turn') {
          response = retryResponse;
          canonicalStopReason = retryStopReason;
          successfulTrace = attemptTraces[attemptTraces.length - 1];
        } else if (retryStopReason === 'tool_use') {
          // The span out-pulls the sentence — remove the tools param so a
          // tool call is structurally impossible (see withoutToolsParam).
          console.warn(
            `[autobiographical] no-tools retry also rejected on tool_use — escalating to tools-less request`,
          );
          const toolslessResponse = await runAttempt(
            withoutToolsParam(withNoToolsLine(request)),
            'canonical-toolless',
            keptSummaries.map((summary) => summary.id),
            keptSummaries.map((summary) => summary.level),
            canonicalCoverageHash,
          );
          if (this.compressionResponseStopReason(toolslessResponse) === 'end_turn') {
            response = toolslessResponse;
            canonicalStopReason = 'end_turn';
            successfulTrace = attemptTraces[attemptTraces.length - 1];
          }
        }
      }
      if (canonicalStopReason !== 'end_turn') {
        const canonicalOutcome: CompressionAttemptOutcome =
          canonicalStopReason === 'refusal' ? 'refusal' : 'incomplete';
        const canonicalProviderInputTokens = this.compressionResponseInputTokens(response);
        fallbackPlan = this.compressionRefusalPlan(
          request,
          variants,
          canonicalProviderInputTokens,
        );
        quarantineRecord = this.compressionRefusalQuarantineRecord(
          chunk,
          model,
          canonicalRequestHash,
          request,
          keptSummaries,
          variants,
          fallbackPlan,
          canonicalProviderInputTokens,
        );
        const outcomes: CompressionRefusalOutcomeRecord[] = [{
          curveLabel: 'canonical',
          requestHash: canonicalRequestHash,
          outcome: canonicalOutcome,
          ...(canonicalStopReason !== undefined ? { stopReason: canonicalStopReason } : {}),
        }];
        attemptTraces[0]!.outcome = canonicalOutcome;
        successfulTrace = undefined;
        logCompressionCall({
          event: canonicalOutcome === 'refusal'
            ? 'compression:canonical-refused'
            : 'compression:canonical-incomplete',
          operation: 'compress_l1',
          metadata: attemptTraces[0],
        });
        let fallbackResponse: NormalizedResponse | undefined;
        for (const planned of fallbackPlan) {
          const variant = variants.find((candidate) =>
            candidate.parent.id === planned.parentId && candidate.requestHash === planned.requestHash,
          );
          if (!variant) continue;
          const parentIndex = keptSummaries.findIndex(
            (summary) => summary.id === variant.parent.id,
          );
          const variantFrontier = [
            ...keptSummaries.slice(0, parentIndex),
            ...variant.children,
            ...keptSummaries.slice(parentIndex + 1),
          ];
          const curveLabel = planned.curveLabel;
          const admittedTokens = planned.admittedTokens;
          const contextBudget = planned.budgetTokens;
          if (planned.disposition === 'admission_rejected') {
            const trace: CompressionAttemptTrace = {
              curveLabel,
              recallIds: variantFrontier.map((summary) => summary.id),
              recallLevels: variantFrontier.map((summary) => summary.level),
              expandedParentId: variant.parent.id,
              expandedChildIds: variant.children.map((child) => child.id),
              leafCoverageHash: variant.leafCoverageHash,
              requestHash: variant.requestHash,
              messageCount: variant.request.messages.length,
              estimatedTokens: this.estimateCompressionRequestTokens(variant.request),
              latencyMs: 0,
              persisted: false,
              outcome: 'admission_rejected',
              admittedTokens,
              budgetTokens: contextBudget,
            };
            attemptTraces.push(trace);
            outcomes.push({
              curveLabel,
              requestHash: variant.requestHash,
              outcome: 'admission_rejected',
              admittedTokens,
              budgetTokens: contextBudget,
            });
            logCompressionCall({
              event: 'compression:curve-attempt', operation: 'compress_l1', metadata: trace,
            });
            continue;
          }
          let variantResponse: unknown;
          try {
            variantResponse = await runAttempt(
              variant.request,
              curveLabel,
              variantFrontier.map((summary) => summary.id),
              variantFrontier.map((summary) => summary.level),
              variant.leafCoverageHash,
              variant.parent.id,
              variant.children.map((child) => child.id),
            );
          } catch (error) {
            if (error instanceof Error && error.name === 'CompressionBranchDiscard') throw error;
            if (!this.isCompressionBranchCurrent(sourceBranch)) {
              this.logCompressionBranchDiscard(sourceBranch, `${curveLabel}:error`, quarantineRecord);
              throw Object.assign(new Error('Compression error crossed a branch boundary'), {
                name: 'CompressionBranchDiscard',
              });
            }
            const errorType = error && typeof error === 'object' && 'type' in error
              ? String((error as { type: unknown }).type)
              : error instanceof Error ? error.name : typeof error;
            const trace: CompressionAttemptTrace = {
              curveLabel,
              recallIds: variantFrontier.map((summary) => summary.id),
              recallLevels: variantFrontier.map((summary) => summary.level),
              expandedParentId: variant.parent.id,
              expandedChildIds: variant.children.map((child) => child.id),
              leafCoverageHash: variant.leafCoverageHash,
              requestHash: variant.requestHash,
              messageCount: variant.request.messages.length,
              estimatedTokens: this.estimateCompressionRequestTokens(variant.request),
              latencyMs: 0,
              persisted: false,
              outcome: 'provider_error',
              errorType,
              admittedTokens,
              budgetTokens: contextBudget,
            };
            attemptTraces.push(trace);
            outcomes.push({
              curveLabel,
              requestHash: variant.requestHash,
              outcome: 'provider_error',
              errorType,
              admittedTokens,
              budgetTokens: contextBudget,
            });
            logCompressionCall({
              event: 'compression:curve-attempt', operation: 'compress_l1', metadata: trace,
            });
            continue;
          }
          const trace = attemptTraces[attemptTraces.length - 1]!;
          trace.admittedTokens = admittedTokens;
          trace.budgetTokens = contextBudget;
          logCompressionCall({
            event: 'compression:curve-attempt',
            operation: 'compress_l1',
            metadata: trace,
          });
          const assessment = this.assessFallbackCompressionResponse(variantResponse);
          if (assessment.outcome === 'refusal') {
            trace.outcome = 'refusal';
            outcomes.push({
              curveLabel,
              requestHash: variant.requestHash,
              outcome: 'refusal',
              stopReason: assessment.stopReason,
              admittedTokens,
              budgetTokens: contextBudget,
            });
            continue;
          }
          if (assessment.outcome !== 'valid') {
            trace.outcome = assessment.outcome;
            if (assessment.outcome === 'provider_error') trace.errorType = assessment.errorType;
            outcomes.push({
              curveLabel,
              requestHash: variant.requestHash,
              outcome: assessment.outcome,
              stopReason: assessment.stopReason,
              ...(assessment.outcome === 'provider_error'
                ? { errorType: assessment.errorType }
                : {}),
              admittedTokens,
              budgetTokens: contextBudget,
            });
            continue;
          }
          trace.outcome = 'success';
          fallbackResponse = assessment.response;
          response = assessment.response;
          successfulTrace = trace;
          break;
        }

        if (!fallbackResponse) {
          if (!this.isCompressionBranchCurrent(sourceBranch)) {
            this.logCompressionBranchDiscard(sourceBranch, 'before_exhaustion', quarantineRecord);
            return;
          }
          await this.exhaustCompressionRequestFamily(sourceBranch, quarantineRecord, outcomes);
          if (!this.isCompressionBranchCurrent(sourceBranch)) return;
          logCompressionCall({
            event: 'compression:curve-exhausted',
            operation: 'compress_l1',
            metadata: {
              quarantine_key: quarantineRecord.key,
              model,
              chunk_message_ids: chunk.messages.map((message) => message.id),
              canonical_request_hash: canonicalRequestHash,
              fallback_limit: quarantineRecord.fallbackLimit,
              plan: quarantineRecord.plan,
              outcomes,
            },
          });
          return;
        }
      }

      // `content` stays text-only (merge inputs, grep, viewers), but the
      // verbatim response blocks — including signed thinking — are captured
      // on the entry: Fable-5/Sonnet-5-class models require the encrypted
      // reasoning returned alongside generated text, and summaries are
      // replayed in the agent's own voice (see captureResponseContent).
      let acceptedResponse = response as NormalizedResponse;
      const extractSummaryText = (r: NormalizedResponse): string =>
        stripThinkingPreamble(
          r.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map(b => b.text)
            .join('\n'),
        );
      let summaryText = extractSummaryText(acceptedResponse);

      // A generation whose whole text was a literal <thinking> wrapper strips
      // to empty (Opus-3-class habit — see PLAIN_PROSE_RETRY_LINE). The memory
      // content exists; ask once, explicitly, for it as plain prose before
      // giving up. Retry-only: first attempts stay byte-canonical.
      if (!summaryText.trim()) {
        console.warn(
          `[autobiographical] L1 summary stripped to empty (thinking-wrapped generation) — retrying once with plain-prose instruction`,
        );
        const proseResponse = await runAttempt(
          withPlainProseLine(request),
          'canonical-plain-prose',
          keptSummaries.map((summary) => summary.id),
          keptSummaries.map((summary) => summary.level),
          canonicalCoverageHash,
        );
        if (this.compressionResponseStopReason(proseResponse) === 'end_turn') {
          const proseText = extractSummaryText(proseResponse as NormalizedResponse);
          if (proseText.trim()) {
            acceptedResponse = proseResponse as NormalizedResponse;
            summaryText = proseText;
            successfulTrace = attemptTraces[attemptTraces.length - 1];
          }
        }
      }

      const responseContent = captureResponseContent(acceptedResponse.content);
      logResponse = summaryText;

      // A bugged/empty generation (summarizer returned no text — spent budget on
      // thinking, truncated, etc.) must NOT be stored: recalled later it becomes
      // an empty assistant text block → Anthropic 400 "content must be non-empty".
      // Leave the chunk raw rather than poisoning memory with an empty summary.
      if (!summaryText.trim()) {
        console.warn(`[autobiographical] empty L1 summary for chunk of ${chunk.messages.length} msgs — quarantining (chunk stays raw)`);
        // Durable accounting (cm #55): without it, an all-thinking chunk
        // that survived the prose retry was re-attempted on every
        // maintenance pass forever (canonical + retry per cycle). Same
        // exhaustion path as the refusal curves; the record is sticky by
        // chunk hash and clears via success-clear / sweep / operator.
        if (this.isCompressionBranchCurrent(sourceBranch)) {
          await this.exhaustCompressionRequestFamily(sourceBranch, quarantineRecord, [
            { curveLabel: 'canonical', outcome: 'unusable_empty', requestHash: canonicalRequestHash },
            { curveLabel: 'canonical-plain-prose', outcome: 'unusable_empty', requestHash: canonicalRequestHash },
          ]);
        }
        return;
      }

      if (!this.isCompressionBranchCurrent(sourceBranch)) {
        this.logCompressionBranchDiscard(sourceBranch, 'before_summary_persist', quarantineRecord);
        return;
      }

      // Re-check the dedup guard AFTER the await: summary state may have
      // changed while the LLM call was in flight (persisted-state reload,
      // or any future concurrent producer). Discarding a paid-for result
      // is cheaper than storing a duplicate L1 over the same messages.
      const postExisting = this.findExactL1(chunkIdKey);
      if (postExisting) {
        chunk.compressed = true;
        chunk.summaryId = postExisting.id;
        // Adoption covers the span just as a fresh summary does — pay off
        // any quarantine debt (see the success path below).
        await this.clearQuarantineForCompressedChunk(chunk);
        return;
      }

      const messageIds = chunk.messages.map(m => m.id);
      const entry: SummaryEntry = {
        id: `L1-${this.nextSummaryIdCounter()}`,
        level: 1,
        content: summaryText,
        // Exact when available (2026-07-12): the compression response's own
        // usage.outputTokens IS the true token count of what it just wrote —
        // the single most-reused number in the pyramid (fold floor, middle
        // budget, recall caps). Estimate only as fallback. Since 2026-07-15
        // reasoning blocks are REPLAYED with the summary (responseContent),
        // so outputTokens — which includes thinking — is the right emission
        // cost with or without reasoning present.
        tokens:
          acceptedResponse.usage?.outputTokens && acceptedResponse.usage.outputTokens > 0
            ? acceptedResponse.usage.outputTokens
            : Math.ceil(summaryText.length / 3),
        sourceLevel: 0,
        sourceIds: messageIds,
        sourceRange: {
          first: messageIds[0],
          last: messageIds[messageIds.length - 1],
        },
        created: Date.now(),
        phaseType: chunk.phaseType,
        ...(this.chunkIsWitnessed(chunk) ? { witnessed: true } : {}),
        ...(responseContent ? { responseContent } : {}),
        // Terminal-disposition provenance: which request authored this
        // memory and how the generation ended (always 'end_turn' post-gate;
        // the field's presence marks the entry as gate-verified).
        ...(successfulTrace
          ? {
              provenance: {
                stopReason: successfulTrace.stopReason ?? 'end_turn',
                requestHash: successfulTrace.requestHash,
                model,
              },
            }
          : {}),
      };

      this.pushSummary(entry);
      chunk.compressed = true;
      chunk.summaryId = entry.id;
      this.markChunkRecordCompressed(chunk.recordId, entry.id);
      this._compressionCount++;
      logSummaryId = entry.id;
      // Success pays off quarantine debt recorded against this chunk under
      // EARLIER request shapes (e.g. pre-carrier text-only requests) — the
      // klaxon must go quiet the moment the span is actually covered, or
      // stale records alarm forever and bury the real alarms.
      await this.clearQuarantineForCompressedChunk(chunk);
      if (successfulTrace) successfulTrace.persisted = true;
      if (successfulTrace?.expandedParentId) {
        logCompressionCall({
          event: 'compression:curve-succeeded',
          operation: 'compress_l1',
          metadata: successfulTrace,
        });
      }

      this.checkMergeThreshold();
    } catch (error) {
      if (error instanceof Error && error.name === 'CompressionBranchDiscard') return;
      if (!this.isCompressionBranchCurrent(sourceBranch)) {
        this.logCompressionBranchDiscard(sourceBranch, 'canonical_error', quarantineRecord);
        return;
      }
      console.error('Failed to compress chunk (hierarchical):', error);
      logError = error instanceof Error ? error.message : String(error);
      inFlightError = error;
      throw error;
    } finally {
      settleInFlight({ ...(inFlightError !== undefined ? { error: inFlightError } : {}) });
      if (inFlight.get(inFlightKey) === inFlightCompletion) inFlight.delete(inFlightKey);
      for (const trace of attemptTraces) {
        logCompressionCall({
          event: 'compression:attempt',
          operation: 'compress_l1',
          metadata: {
            chunk_message_ids: chunk.messages.map((message) => message.id),
            chunk_hash: quarantineRecord.chunkSourceHash,
            model,
            ...trace,
          },
        });
      }
      logCompressionCall({
        operation: 'compress_l1',
        system: null,
        messages: summarizeTelemetryMessages(cleaned),
        metadata: {
          chunk_message_ids: chunk.messages.map((m) => m.id),
          chunk_size: chunk.messages.length,
          prior_summary_count: priorSummaries.length,
          prior_summary_count_kept: keptSummaries.length,
          prior_summary_tokens: recallTokens,
          has_doc_context: docContext !== null,
          doc_context: docContext,
          target_tokens: targetTokens,
          model,
          latency_ms: Date.now() - callStart,
          summary_id: logSummaryId,
        },
        response: summarizeTelemetryText(logResponse),
        error: logError,
      });
    }
  }

  /**
   * Check if unmerged summary counts exceed the merge threshold.
   * Enqueues merge operations if so.
   *
   * Skips L1s/L2s that are already in a pending merge — without this guard,
   * each new summary above threshold re-enqueues a merge for the same
   * already-eligible siblings, producing N near-identical higher-level
   * summaries when the queue eventually drains.
   */
  /**
   * Pick merge sources as the oldest CONTIGUOUS run (2026-07-12 fix).
   *
   * The old rule merged "whatever N are unmerged" in creation order. On a
   * store whose frontier held both June L2s and a July L2, that minted an
   * L3 spanning months of already-merged history (mythos L3-415, 0-3853 of
   * 3995 messages) — a group whose range straddles the recent window can
   * never fold (group-atomicity vs the raw zone), so the whole deep lineage
   * above it went unusable and the fold floor stopped fitting the budget.
   *
   * Rules: order candidates by live source position; break runs where the
   * positional gap exceeds `mergeContiguityGapLimit` (holes from wiped/
   * pruned nodes are fine, cross-era bridges are not); exclude candidates
   * whose OWN span exceeds the level-scaled `mergeMaxSourceSpanMessages`
   * limit (replay-era wide-span summaries would bridge anything they join);
   * merge the oldest run that still has `threshold` members.
   */

  /**
   * Deduped LOUD log for merge-candidate exclusions. A silently-dropped
   * candidate is a silently-stalled pyramid: the flat wide-span quarantine
   * kept every mythos L4 out of the candidate pool for weeks with no
   * externally visible signal — the merge queue simply read as empty while
   * the fold floor sat ~23k tokens too high (found 2026-08-17, subagent
   * store-clone expedition). One warn per summary id per process.
   */
  private _mergeExclusionWarned = new Set<string>();
  protected warnMergeExclusion(id: string, detail: string): void {
    if (this._mergeExclusionWarned.has(id)) return;
    this._mergeExclusionWarned.add(id);
    console.warn(`[autobiographical] merge-candidate excluded: ${detail}`);
  }

  protected contiguousMergeCandidates(
    unmerged: SummaryEntry[],
    threshold: number,
  ): SummaryEntry[] | null {
    if (unmerged.length < threshold) return null;
    const messageOrder = new Map<MessageId, number>();
    let seq = 0;
    for (const ch of this.chunks) {
      for (const m of ch.messages) messageOrder.set(m.id, seq++);
    }
    const gapLimit = this.config.mergeContiguityGapLimit ?? 300;
    const spanBase = this.config.mergeMaxSourceSpanMessages ?? 1500;
    const mergeK = this.config.mergeThreshold ?? 6;
    const withPos: Array<{ s: SummaryEntry; first: number; last: number }> = [];
    for (const s of unmerged) {
      const first = messageOrder.get(s.sourceRange.first);
      const last = messageOrder.get(s.sourceRange.last);
      if (first === undefined || last === undefined) {
        // Pruned/missing source messages: the candidate can NEVER merge.
        // This was a silent drop (rev-5 review: "frontier debt, no log").
        this.warnMergeExclusion(
          s.id,
          `L${s.level} ${s.id}: source position unresolved (pruned source messages?) — permanently unmergeable, frontier debt`,
        );
        continue;
      }
      // Wide-span quarantine, scaled by level. Legitimate spans grow ~k× per
      // level, so a FLAT limit silently forbids all consolidation above the
      // level where it matches a healthy node's span: mythos 2026-08 — every
      // L4 spans 3.0k–6.9k messages > 1500, so an L5 was structurally
      // impossible at any store state and the fold floor sat ~23k above
      // where one L5 puts it. The damage signature this guard exists for
      // (replay-era bridge summaries, 2026-07-12) is "wide FOR ITS LEVEL",
      // not absolute width. Limits for L1–L3 are unchanged from the flat
      // default; L4 gets base×k, L5 base×k², …
      const spanLimit = spanBase * Math.pow(mergeK, Math.max(0, (s.level ?? 1) - 3));
      const span = Math.abs(last - first);
      if (span > spanLimit) {
        this.warnMergeExclusion(
          s.id,
          `L${s.level} ${s.id}: wide-span quarantine — span ${span} msgs > limit ${spanLimit} (base ${spanBase} × ${mergeK}^${Math.max(0, (s.level ?? 1) - 3)})`,
        );
        continue;
      }
      withPos.push({ s, first: Math.min(first, last), last: Math.max(first, last) });
    }
    withPos.sort((a, b) => a.first - b.first);

    // Split into contiguous runs (a gap larger than `gapLimit` starts a new one).
    const runs: Array<typeof withPos> = [];
    let run: typeof withPos = [];
    let runEnd = -Infinity;
    for (const x of withPos) {
      if (run.length > 0 && x.first - runEnd > gapLimit) {
        runs.push(run);
        run = [];
        runEnd = -Infinity;
      }
      run.push(x);
      runEnd = Math.max(runEnd, x.last);
    }
    if (run.length > 0) runs.push(run);
    if (runs.length === 0) return null;

    // ONLY THE NEWEST RUN CAN GROW (2026-07-12 starvation fix). Summaries are
    // always produced at the live end, so any INTERIOR run is stranded: it can
    // never reach `threshold` members, and waiting for it froze the whole
    // pyramid (mythos: L1 frontier [913-981]x5 + [4039-4131]x5 separated by a
    // 3058-message hole from the poison-node surgery — 10 unmerged L1s, 8
    // unmerged L2s, merge queue empty, fold floor climbing to 117k until the
    // picker died). Interior runs consolidate as soon as they have 2 members;
    // only the newest run waits for the full threshold.
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const isNewest = i === runs.length - 1;
      if (r.length >= threshold) return r.slice(0, threshold).map((x) => x.s);
      if (!isNewest && r.length >= 2) return r.slice(0, threshold).map((x) => x.s);
    }
    return null;
  }

  protected checkMergeThreshold(): void {
    this.requireBranchMutation('checkMergeThreshold');
    phaseChannel.report('merge-threshold'); // liveness-watchdog phase
    if (this.config.speculativeProduction) {
      this.checkMergeThresholdRecursive();
      return;
    }

    const threshold = this.config.mergeThreshold ?? 6;

    // IDs that are already part of a queued merge — exclude them from
    // eligibility so we don't re-enqueue.
    const queuedL1 = new Set<string>();
    const queuedL2 = new Set<string>();
    for (const m of this.mergeQueue) {
      const set = m.level === 2 ? queuedL1 : queuedL2;
      for (const id of m.sourceIds) set.add(id);
    }

    // Check L1 → L2
    const unmergedL1 = this.summaries.filter(
      s => s.level === 1 && !s.mergedInto && !queuedL1.has(s.id),
    );
    const l1Run = this.contiguousMergeCandidates(unmergedL1, threshold);
    if (l1Run) {
      this.enqueueMerge({
        level: 2,
        sourceIds: l1Run.map(s => s.id),
      });
    }

    // Check L2 → L3
    const unmergedL2 = this.summaries.filter(
      s => s.level === 2 && !s.mergedInto && !queuedL2.has(s.id),
    );
    const l2Run = this.contiguousMergeCandidates(unmergedL2, threshold);
    if (l2Run) {
      this.enqueueMerge({
        level: 3,
        sourceIds: l2Run.map(s => s.id),
      });
    }
  }

  /**
   * Bottom-up speculative pre-producer (design doc §3.5 / §7.2).
   *
   * Recursive variant of `checkMergeThreshold` for the unbounded L_n
   * design. Walks every level present in the archive; for any level k
   * with ≥ N orphans (no parent), enqueues an L_{k+1} merge. After that
   * L_{k+1} is produced and `executeMerge` calls this again, the recursion
   * naturally cascades: 6 L1s → 1 L2; 6 L2s → 1 L3; 6 L3s → 1 L4; ...
   *
   * Only fires when `config.speculativeProduction` is true. Default true
   * for adaptiveResolution=true, false otherwise. The non-speculative path
   * (above) preserves the original L1→L2→L3 behavior for non-adaptive
   * deployments.
   */
  protected checkMergeThresholdRecursive(): void {
    this.requireBranchMutation('checkMergeThresholdRecursive');
    const threshold = this.config.mergeThreshold ?? 6;

    // Build per-level sets of source-ids already enqueued for merging,
    // so we don't re-enqueue them while a merge is pending.
    const queuedSources = new Map<number, Set<string>>();
    for (const m of this.mergeQueue) {
      // m.level is the TARGET level; the sources are at level (m.level - 1).
      const sourceLevel = m.level - 1;
      if (!queuedSources.has(sourceLevel)) queuedSources.set(sourceLevel, new Set());
      for (const id of m.sourceIds) queuedSources.get(sourceLevel)!.add(id);
    }

    // Walk every level present in the archive. Iterate from low to high
    // so when an L_{k+1} merge is enqueued and immediately produced, this
    // same check sees the new L_{k+1} on the next call and can roll up.
    let maxLevel = 0;
    for (const s of this.summaries) {
      if (s.level > maxLevel) maxLevel = s.level;
    }
    for (let level = 1; level <= maxLevel; level++) {
      const queued = queuedSources.get(level) ?? new Set();
      const unmerged = this.summaries.filter(
        s => s.level === level && !getSummaryParentId(s) && !queued.has(s.id),
      );
      const run = this.contiguousMergeCandidates(unmerged, threshold);
      if (run) {
        this.enqueueMerge({
          level: level + 1,
          sourceIds: run.map(s => s.id),
        });
      }
    }
  }

  /**
   * Merge N summaries at one level into a single summary at the next level.
   * Uses self-voice consolidation prompt.
   */
  protected async executeMerge(
    targetLevel: SummaryLevel,
    sourceIds: string[],
    ctx: StrategyContext
  ): Promise<void> {
    const sourceBranch = this.requireLoadedBranch('executeMerge');
    if (!ctx.membrane) {
      throw new Error('No membrane instance for merge');
    }

    const sources = sourceIds
      .map(id => this.summaries.find(s => s.id === id))
      .filter((s): s is SummaryEntry => s != null);

    if (sources.length !== sourceIds.length) {
      console.warn('executeMerge: some source summaries not found, skipping');
      return;
    }

    // Defensive: if every source is already mergedInto something, this is a
    // stale queue entry (could happen if multiple merges for the same
    // sourceIds were enqueued before the dedup fix in checkMergeThreshold).
    // Skip rather than produce a redundant near-identical higher-level entry.
    if (sources.every(s => s.mergedInto)) {
      console.warn(
        `executeMerge: all sources already merged into ${sources[0].mergedInto}, skipping (stale queue entry)`,
      );
      return;
    }

    const targetTokens = this.config.summaryTargetTokens ?? 2000;
    const participant = this.config.summaryParticipant ?? 'Claude';

    // Build the merge prompt with one-level-deeper target expansion +
    // prefix of older context:
    //
    //   1. PREFIX — head messages + prior L1 recall pairs for content
    //      that comes chronologically BEFORE the merge range. "Fill
    //      lower orbitals first" per the spec: regardless of how
    //      compressed the live view is, the summarizer always gets L1
    //      fidelity for prior content. Older L2/L3 markers exist for
    //      live-view compactness, not for the summarizer.
    //
    //   2. TARGET — the sources expanded ONE LEVEL DEEPER than they
    //      themselves are. For L2 merge (sources at L1): expand to
    //      raw L0 messages — the model sees the actual conversation
    //      that the 6 L1s consolidate. For L3 merge (sources at L2):
    //      expand to the L1s under each L2 (36 L1s as recall pairs).
    //      For L_n merge (sources at L_{n-1}): expand to L_{n-2}.
    //      This gives the model substantively more content to ground
    //      the consolidation in than just the 6 surface summaries.
    //
    //   3. INSTRUCTION — "consolidate N memories preserving the
    //      through-line, in first person".
    //
    // No tail-after-merge: same as-of principle as L1 compression. The
    // consolidation is being formed at the moment the last source was
    // ready, so nothing after that is visible.
    const llmMessages: Array<{ participant: string; content: ContentBlock[] }> = [];

    // Build lookup maps
    const summariesById = new Map<string, SummaryEntry>();
    for (const s of this.summaries) summariesById.set(s.id, s);
    const allMessages = ctx.messageStore.getAll();
    const messageById = new Map<MessageId, typeof allMessages[number]>();
    for (const m of allMessages) messageById.set(m.id, m);

    // Compute every leaf message id covered by this merge's lineage —
    // these are part of the TARGET and must not also appear in the
    // PREFIX as head content.
    const sourceLeafIds = new Set<MessageId>();
    const collectLeaves = (s: SummaryEntry): void => {
      if (s.sourceLevel === 0) {
        for (const id of s.sourceIds) sourceLeafIds.add(id);
      } else {
        for (const childId of s.sourceIds) {
          const child = summariesById.get(childId);
          if (child) collectLeaves(child);
        }
      }
    };
    for (const src of sources) collectLeaves(src);

    // Find the start of the merge range in the message store.
    const mergeFirstMsgId = sources[0].sourceRange.first;
    const mergeStartIdx = allMessages.findIndex((m) => m.id === mergeFirstMsgId);

    // ---- 1a. PRIOR RECALL SET (chronologically before merge range) ----
    // Computed BEFORE the head emission because the head loop needs the
    // leaf coverage of live summaries (one-to-one rule, see the L1 site).
    //
    // The unmerged frontier of summaries whose source range is before the
    // merge range and which aren't part of the merge tree. Originally this
    // was filtered to `level === 1` (the "L1 fidelity for prior content"
    // intent) but at 4000+ messages that produces hundreds of L1s and
    // overflows the model window. Switching to the unmerged frontier
    // (`!mergedInto`) lets a merged L1 drop out in favour of its L2/L3
    // parent — the same rule used everywhere else and now in
    // `compressChunkHierarchical`. The cap below is the defense-in-depth.
    const priorSummariesAll = this.summaries
      // Skip empty-content summaries (see compressChunkHierarchical): an empty
      // text block in the merge recall header 400s and stalls compression.
      .filter((s) => !s.mergedInto && !!s.content && s.content.trim().length > 0)
      .filter((s) => {
        for (const lid of s.sourceIds) if (sourceLeafIds.has(lid)) return false;
        const firstIdx = allMessages.findIndex((m) => m.id === s.sourceRange.first);
        return firstIdx >= 0 && (mergeStartIdx < 0 || firstIdx < mergeStartIdx);
      })
      .sort((a, b) => {
        const ai = allMessages.findIndex((m) => m.id === a.sourceRange.first);
        const bi = allMessages.findIndex((m) => m.id === b.sourceRange.first);
        return ai - bi;
      });

    // Leaf coverage of every live summary — the rendering authority
    // (one-to-one invariant; see compressChunkHierarchical). Uses the
    // full frontier, not the budget-capped set: a budget-dropped recall
    // pair doesn't make its underlying raw messages reappear.
    //
    // Critical: `sourceIds` on an L2+ summary points at L1 IDs, not raw
    // message IDs. The dedup happens against raw message IDs, so we must
    // recursively expand each summary down to its leaf message IDs.
    // Without this, every message under any L2 leaks back in as raw text
    // (Bug 10: 525-message merge requests on a 4234-msg conversation).
    // Also expand merged L1s as defense in depth.
    const priorSummaryMessageIds = new Set<MessageId>();
    for (const s of this.summaries) {
      if (s.level === 1) this.expandSummaryToLeafMessageIds(s, summariesById, priorSummaryMessageIds);
    }
    for (const s of priorSummariesAll) {
      this.expandSummaryToLeafMessageIds(s, summariesById, priorSummaryMessageIds);
    }

    // ---- 1b. HEAD WINDOW (raw, FIRST, ownership-capped) ----
    //
    // The head window is the foundational identity anchor — the actual
    // opening of the chronicle. It establishes who is speaking to whom.
    // Without it, when the merge target's content is heavily first-person
    // from someone other than the agent, the agent loses its first-person
    // grounding and drifts into the content author's voice.
    //
    // ONE-TO-ONE INVARIANT (see compressChunkHierarchical): ownership
    // wins over the token-derived head boundary. A head-range message
    // covered by a live summary renders via its recall pair; one inside
    // the merge tree renders in the TARGET expansion. Never raw here too.
    const headStartIdx = this.getHeadWindowStartIndex(ctx.messageStore);
    const headEndIdx = this.getHeadWindowEnd(ctx.messageStore);
    let headCoveredSkipped = 0;
    for (let i = headStartIdx; i < headEndIdx && i < allMessages.length; i++) {
      const m = allMessages[i];
      if (priorSummaryMessageIds.has(m.id) || sourceLeafIds.has(m.id)) {
        headCoveredSkipped++;
        continue;
      }
      llmMessages.push({ participant: m.participant, content: stripThinkingBlocks(m.content) });
    }
    if (headCoveredSkipped > 0) {
      console.warn(
        `autobio: ${headCoveredSkipped} head-window message(s) are covered by live summaries or ` +
          `the merge tree; rendering them via recall pairs / target expansion (ownership wins).`,
      );
      logCompressionCall({
        event: 'head-ownership-overlap',
        site: 'merge',
        targetLevel,
        skipped: headCoveredSkipped,
        headStartIdx,
        headEndIdx,
      });
    }

    // Recall budget shrinks by half per prior failed attempt on this same
    // queue entry. The wire limit is enforced by the PROVIDER, not our
    // estimator (which can under-read a big merge prompt by 10-20%): when a
    // merge 400s with context_length, retrying the identical request fails
    // identically forever (opus4 2026-08-03: 442 consecutive 400s at ~6s —
    // "189583 + 16000 > 200000" — after a lineage wipe returned 97 summaries
    // to the frontier and the prior-recall set ballooned). Halving the
    // recall budget per attempt makes each bounded retry (see the
    // non-retryable branch in the tick catch) MEANINGFULLY smaller, so the
    // pair converges instead of looping. attempts lives on the persisted
    // queue entry; reference-equality on sourceIds scopes this to the
    // queue-driven path.
    const mergeAttempts =
      this.mergeQueue[0]?.sourceIds === sourceIds ? (this.mergeQueue[0]?.attempts ?? 0) : 0;
    const configuredRecallBudget = this.config.compressionRecallBudgetTokens ?? 100_000;
    const mergeRecallBudget = Math.max(
      8_000,
      Math.round(configuredRecallBudget * 0.5 ** Math.min(mergeAttempts, 4)),
    );
    if (mergeRecallBudget < configuredRecallBudget) {
      console.warn(
        `[autobiographical] L${targetLevel} merge retry ${mergeAttempts}: recall budget shrunk ` +
          `${configuredRecallBudget} -> ${mergeRecallBudget} tokens (halved per failed attempt)`,
      );
    }
    const { kept: keptPriorSummaries, keptTokens: mergeRecallTokens } = this.capRecallPairs(
      priorSummariesAll,
      mergeRecallBudget,
    );
    if (keptPriorSummaries.length < priorSummariesAll.length) {
      const dropped = priorSummariesAll.length - keptPriorSummaries.length;
      console.warn(
        `autobio: merge recall-pair budget capped (${keptPriorSummaries.length}/${priorSummariesAll.length} summaries kept, ` +
          `~${mergeRecallTokens} tokens, budget ${mergeRecallBudget}; ${dropped} oldest dropped this merge).`,
      );
      logCompressionCall({
        event: 'recall-budget-capped',
        site: 'merge',
        targetLevel,
        kept: keptPriorSummaries.length,
        total: priorSummariesAll.length,
        tokens: mergeRecallTokens,
        budgetTokens: mergeRecallBudget,
      });
    }

    // (Leaf coverage `priorSummaryMessageIds` is computed above, before
    // the head emission — shared by the head loop and the raw middle.)

    for (const s of keptPriorSummaries) {
      llmMessages.push({
        participant: 'Context Manager',
        content: [{ type: 'text', text: `[CM] Recall memory ${s.id}.` }],
      });
      // Carriers ride merge recall pairs too — see the L1 site rationale.
      llmMessages.push({
        participant,
        content: this.summaryAnswerContent(s),
      });
    }

    // Raw middle: any messages between the head window and the merge
    // range that aren't covered by a prior summary or the merge tree.
    // Usually empty (chunking is contiguous).
    if (mergeStartIdx >= 0) {
      for (let i = headEndIdx; i < mergeStartIdx; i++) {
        const m = allMessages[i];
        if (priorSummaryMessageIds.has(m.id)) continue;
        if (sourceLeafIds.has(m.id)) continue;
        llmMessages.push({ participant: m.participant, content: stripThinkingBlocks(m.content) });
      }
    }

    // ---- 2. TARGET: expand sources one level deeper ----
    // For L2 (sources at L1, sourceLevel=0): expand to raw L0 messages.
    // For L3+ (sources at L_{n-1}, sourceLevel=n-2): expand to L_{n-2}
    //   summaries as recall pairs.
    //
    // REFUSAL FALLBACK (retry-only): a classifier-refused merge is refused
    // on the INPUT — deterministically, every retry — when the one-level-
    // deeper raw replay carries enough cumulative trigger mass (labclaude
    // 2026-08-06: L2 over the walk-day span, reasoning_extraction at 4
    // output tokens, 5/5 identical; bisected sub-slices all PASSED, so the
    // mass is diffuse, not one strikeable span — vocabulary substitution
    // has no target). The remedy is to shrink what the summarizer is shown:
    // on a retry after a refusal rejection, emit the SOURCES THEMSELVES as
    // recall pairs instead of expanding a level deeper. Bench-verified on
    // the captured live request: raw replay refused, source-level payload
    // minted a grounded L2 whose threads match the raw-slice control arms.
    // First attempts stay byte-identical (KV/behavior stability); bounded
    // fidelity loss only on the degraded retry, and the summaries shown are
    // the agent's own words, so nothing is falsified.
    const refusalFallback =
      this.mergeQueue[0]?.sourceIds === sourceIds &&
      (this.mergeQueue[0]?.attempts ?? 0) > 0 &&
      (this.mergeQueue[0]?.hadRefusal === true ||
        this.mergeQueue[0]?.lastStopReason === 'refusal');
    if (refusalFallback) {
      console.warn(
        `[autobiographical] L${targetLevel} merge retry after refusal rejection — ` +
          `source-level fallback payload (sources shown as recall pairs, no deeper expansion)`,
      );
      logCompressionCall({
        event: 'merge-refusal-fallback',
        site: 'merge',
        targetLevel,
        sources: sourceIds,
      });
    }
    for (const src of sources) {
      if (refusalFallback) {
        // Emit the source itself as a recall pair, whatever its level.
        llmMessages.push({
          participant: 'Context Manager',
          content: [{ type: 'text', text: `[CM] Recall memory ${src.id}.` }],
        });
        llmMessages.push({
          participant,
          content: this.summaryAnswerContent(src),
        });
      } else if (src.sourceLevel === 0) {
        // Source is an L1; its sourceIds are raw message ids. Emit them raw.
        for (const messageId of src.sourceIds) {
          const m = messageById.get(messageId);
          if (m) {
            llmMessages.push({ participant: m.participant, content: stripThinkingBlocks(m.content) });
          }
        }
      } else {
        // Source is L2+; its sourceIds point to summaries one level
        // below. Emit each as a recall pair.
        for (const childId of src.sourceIds) {
          const child = summariesById.get(childId);
          if (!child) continue;
          llmMessages.push({
            participant: 'Context Manager',
            content: [{ type: 'text', text: `[CM] Recall memory ${child.id}.` }],
          });
          // Carriers ride merge source expansions too — see the L1 site.
          llmMessages.push({
            participant,
            content: this.summaryAnswerContent(child),
          });
        }
      }
    }

    // ---- 3. INSTRUCTION ----
    // sourceLevelShown is the level of content the model actually sees
    // (one level below the sources themselves).
    const sourceLevelShown =
      sources[0].sourceLevel === 0 ? 0 : sources[0].level - 1;

    // Reading-mode detection: when ALL the merge's leaf messages are
    // shards of the same bodyGroup, we know the agent was reading a
    // substantially larger message rather than conversing. The
    // reading-mode merge instruction asks what reading the stretch was
    // like instead of asking for an impersonal consolidation, which
    // forces the agent's vantage point and prevents drift into the
    // content author's voice. Same principle as the L1 case.
    let mergeReadingContext: { totalTokens: number } | null = null;
    if (sourceLeafIds.size > 0) {
      const leafBodyGroupIds = new Set<string | undefined>();
      for (const leafId of sourceLeafIds) {
        const m = messageById.get(leafId);
        leafBodyGroupIds.add(m?.bodyGroupId);
      }
      if (leafBodyGroupIds.size === 1) {
        const groupId = [...leafBodyGroupIds][0];
        if (groupId) {
          let totalTokens = 0;
          for (const m of allMessages) {
            if (m.bodyGroupId === groupId) {
              totalTokens += ctx.messageStore.estimateTokens(m);
            }
          }
          mergeReadingContext = { totalTokens };
        }
      }
    }
    let mergeInstructionText = this.applyIdentityReminder(
      refusalFallback
        ? // Fallback payload shows the sources THEMSELVES, so the "content
          // one level deeper" description the standard getters derive would
          // be wrong — call the formatters with the sources' own level.
          // Reading-mode is skipped too: it narrates raw shards the model
          // is no longer being shown.
          sources.length > 0 && sources.every((s) => s.witnessed)
          ? formatWitnessedMergeInstruction(targetLevel, sources[0].level, targetTokens)
          : formatMergeInstruction(targetLevel, sources[0].level, targetTokens)
        : mergeReadingContext
          ? this.getReadingMergeInstruction(
              targetLevel,
              sources,
              mergeReadingContext.totalTokens,
              targetTokens,
            )
          : this.getMergeInstruction(targetLevel, sources, targetTokens),
    );
    // Retry-only no-tools line. The summarizer request declares the agent's
    // live tools (classifier requirement, see `tools: ctx.tools` below), and
    // a model whose recent spans are tool-heavy can answer the merge prompt
    // on-pattern — a `think` call carrying the summary draft, which the
    // single-shot compression path cannot continue past (lena 2026-08-04:
    // 97 merges rejected unusable_empty/stop=tool_use, pyramid frozen,
    // 46h outage). Forbidding tools structurally (tool_choice:none) makes
    // the same model emit NOTHING (bench-verified), so the remedy is this
    // sentence — and only on a retry after a tool_use rejection, keeping
    // first-attempt prompts byte-identical for KV/behavior stability.
    const retryAfterToolUse =
      this.mergeQueue[0]?.sourceIds === sourceIds &&
      (this.mergeQueue[0]?.attempts ?? 0) > 0 &&
      this.mergeQueue[0]?.lastStopReason === 'tool_use';
    if (retryAfterToolUse) {
      console.warn(
        `[autobiographical] L${targetLevel} merge retry after tool_use rejection — appending no-tools instruction`,
      );
      mergeInstructionText += NO_TOOLS_RETRY_LINE;
    }
    // Retry rung for thinking-wrapped generations: an unusable_empty whose
    // text was all <thinking> preamble fails identically on every bare
    // retry (Opus-3 wrap habit — see PLAIN_PROSE_RETRY_LINE). Ask plainly.
    const retryAfterEmpty =
      this.mergeQueue[0]?.sourceIds === sourceIds &&
      (this.mergeQueue[0]?.attempts ?? 0) > 0 &&
      this.mergeQueue[0]?.lastOutcome === 'unusable_empty';
    if (retryAfterEmpty) {
      console.warn(
        `[autobiographical] L${targetLevel} merge retry after empty generation — appending plain-prose instruction`,
      );
      mergeInstructionText += PLAIN_PROSE_RETRY_LINE;
    }
    llmMessages.push({
      participant: 'Context Manager',
      content: [{
        type: 'text',
        text: mergeInstructionText,
      }],
    });

    // Same bundled-tool-cycle defense as compressChunkHierarchical.
    const split = splitMixedToolMessages(llmMessages);
    const collapsed = this.collapseConsecutiveMessages(split);
    const cleaned = stripUnpairedToolBlocks(collapsed);

    // Byte wall on the MERGE prompt too (2026-07-12). A merge expands its
    // sources ONE LEVEL DEEPER — an L2 merge therefore replays the RAW
    // messages under its L1s, images and all (including screenshots nested in
    // tool_results). This is the path that kept tripping membrane's transport
    // shed at 27MB after the L1 site was already capped. Own it here.
    this.capCompressionImageBytes(
      cleaned as Array<{ content: ContentBlock[] }>,
      this.config.maxCompressionImageBytes ??
        AutobiographicalStrategy.DEFAULT_MAX_COMPRESSION_IMAGE_BYTES,
    );

    // Final wire-shape messages. Sanitize: strip empty text blocks and drop
    // any message left with no content (empty text reaches the API as a 400
    // that stalls ALL compression — see the twin note on the request below).
    // Seams count only `keptPriorSummaries` pairs as stable prefix — the
    // expanded SOURCE pairs below the prior ladder are this merge's payload.
    const mintMessages = cleaned
      .map(m => ({ participant: m.participant, content: stripEmptyTextBlocks(m.content) }))
      .filter(m => m.content.length > 0);
    const mintSeamed = this.applyMintCacheSeams(
      mintMessages,
      keptPriorSummaries,
      keptPriorSummaries.length < priorSummariesAll.length,
    );

    // NO system prompt — identity is established by the head window
    // (present at the start of llmMessages above) and by the prior
    // recall pairs. Same rationale as compressChunkHierarchical.
    const request: NormalizedRequest = {
      // EXPLICIT image-loss opt-in (2026-07-12): summarizer prompts replay
      // raw history that can carry more inline image bytes than the API's
      // request cap. Dropping the OLDEST images from the summarizer's view is
      // acceptable policy here — the summary describes the span, it does not
      // preserve pixels — and membrane error-logs every exercised shed. All
      // other callers fail loudly instead (no silent transport mutation).
      shedOversizeImages: true,
      // NOTE (2026-07-16): thinking is stripped from RAW messages at their
      // llmMessages insertion sites, not in the mintMessages sanitize — a
      // blanket strip would also remove the recall-pair reasoning carriers,
      // which must reach the API verbatim (see the recall-pair sites).
      messages: mintMessages,
      // 1h TTL on the seam markers: steady-state mint cadence exceeds the
      // 5-minute cache window, where markers cost more than they save. Only
      // attached when a seam was actually placed — a marker-less request
      // must keep its pre-seam shape (canonical hash, quarantine identity).
      ...(mintSeamed ? { cacheTtl: this.config.compressionCacheTtl } : {}),
      config: {
        model: this.requireCompressionModel(),
        // Generous output ceiling so a memory-write is never truncated mid-thought:
        // targetTokens is a *target*, not a cap, and adaptive models routinely
        // overshoot a ~2k target. Was `* 1.5` (=3000 at the 2k default), which cut
        // off rich memories (stop=max_tokens).
        maxTokens: this.capCompressionTokens(Math.max(16000, Math.round(targetTokens * 1.5))),
      },
      // Declare the agent's live tools. A summarizer request that replays
      // tool_use/tool_result history with NO tools param reads to Anthropic's
      // safety classifier as a foreign agent trace being duplicated ->
      // deterministic reasoning_extraction refusal of every memory-write
      // (labclaude incident, 2026-07-09; 268 refusals). Declaring the same
      // tools the live instance runs with is also strictly MORE faithful to
      // the original context, so it is the KV-honest choice, not a
      // workaround. Undefined before the first activation of a session --
      // acceptable: those chunks stay raw and are retried after the agent's
      // first turn (see the defer guard in compressChunkHierarchical).
      tools: ctx.tools,
    };

    // Escalation past the no-tools sentence: if the line-carrying retry has
    // itself been rejected on tool_use (attempts ≥ 2 with a tool_use last
    // stop), drop the tools param so a tool call is structurally impossible
    // — same rationale as the L1 site's 'canonical-toolless' stage.
    const toollessEscalation =
      retryAfterToolUse && (this.mergeQueue[0]?.attempts ?? 0) >= 2;
    const dispatchRequest = toollessEscalation
      ? withoutToolsParam(request)
      : request;
    if (toollessEscalation) {
      console.warn(
        `[autobiographical] L${targetLevel} merge retry ${this.mergeQueue[0]?.attempts} — escalating to tools-less request`,
      );
    }

    // Request identity — persisted on the authored summary (provenance) and
    // stamped on every failure receipt, so any parent can be traced back to
    // the exact llm-calls log entry that authored it.
    const requestHash = sha256Json(dispatchRequest);

    const callStart = Date.now();
    let logResponse: string | undefined;
    let logError: string | undefined;
    let logNewSummaryId: string | undefined;

    try {
      let response: NormalizedResponse;
      try {
        response = await ctx.membrane.complete(dispatchRequest, { formatter: this.nativeFormatter });
      } catch (error) {
        // Same degraded-mode fallback as the L1 ladder: transport rejected
        // the carrier blocks → retry once text-only, loudly.
        if (!isCarrierTransportRejection(error) || !requestCarriesReasoning(dispatchRequest)) throw error;
        console.error(
          `[autobiographical] transport rejected reasoning carriers on L${targetLevel} merge ` +
            `(${String(error).slice(0, 200)}) — retrying ONCE with text-only recall pairs (degraded mode)`,
        );
        logCompressionCall({
          event: 'compression:carrier-transport-fallback',
          operation: `merge_l${targetLevel}`,
          metadata: { error: String(error).slice(0, 300) },
        });
        response = await ctx.membrane.complete(stripReasoningFromRequest(dispatchRequest), { formatter: this.nativeFormatter });
      }
      if (!this.isCompressionBranchCurrent(sourceBranch)) return;

      // Terminal-disposition gate (2026-08-01): a consolidation may become
      // canonical only after a COMPLETE accepted disposition — `end_turn` +
      // nonempty text. This path used to persist ANY nonempty text, which is
      // exactly how a 163-character refusal preamble became the L4 parent
      // over six real L3 children. Refusal, max_tokens truncation, tool_use,
      // abort, empty, and malformed responses all reject: children stay
      // unmerged, a durable receipt is logged, and tick() applies the
      // bounded retry/quarantine policy (never an immediate retry loop).
      const assessment = this.assessFallbackCompressionResponse(response);
      if (assessment.outcome !== 'valid') {
        const stopReason = 'stopReason' in assessment ? assessment.stopReason : undefined;
        const errorType = assessment.outcome === 'provider_error' ? assessment.errorType : undefined;
        console.warn(
          `[autobiographical] L${targetLevel} merge response rejected (${assessment.outcome}` +
            `${stopReason ? `, stop=${stopReason}` : ''}${errorType ? `, ${errorType}` : ''}) — ` +
            `${sources.length} sources left unmerged`,
        );
        logCompressionCall({
          event: 'merge:disposition-rejected',
          operation: `merge_l${targetLevel}`,
          metadata: {
            target_level: targetLevel,
            source_ids: sourceIds,
            outcome: assessment.outcome,
            stop_reason: stopReason ?? null,
            error_type: errorType ?? null,
            request_hash: requestHash,
            model: this.requireCompressionModel(),
          },
        });
        throw new MergeDispositionRejection(
          targetLevel, assessment.outcome, requestHash, stopReason, errorType,
        );
      }

      // `content` stays text-only; verbatim blocks (incl. signed thinking)
      // are captured for replay — see the L1 site / captureResponseContent.
      const mergedText = stripThinkingPreamble(assessment.text);
      const responseContent = captureResponseContent(assessment.response.content);
      logResponse = mergedText;

      // The disposition gate guarantees nonempty PRE-strip text; a
      // generation that was entirely a literal <thinking> preamble strips
      // to nothing. This must be a COUNTED rejection, not a silent skip —
      // a bare return here retried the identical prompt forever (the
      // Opus-3 wrap habit fails it identically every time; see
      // PLAIN_PROSE_RETRY_LINE). Riding the ladder gives the retry the
      // prose line, bounded attempts, and quarantine.
      if (!mergedText.trim()) {
        console.warn(
          `[autobiographical] L${targetLevel} merge generation was all <thinking> preamble — ` +
            `rejecting for retry (${sources.length} sources left unmerged)`,
        );
        throw new MergeDispositionRejection(
          targetLevel, 'unusable_empty', requestHash, 'end_turn',
        );
      }

      // Compute source range from constituent summaries
      const sourceRange = {
        first: sources[0].sourceRange.first,
        last: sources[sources.length - 1].sourceRange.last,
      };

      const sourceLevel = (targetLevel - 1) as 0 | 1 | 2;
      const newEntry: SummaryEntry = {
        id: `L${targetLevel}-${this.nextSummaryIdCounter()}`,
        level: targetLevel,
        content: mergedText,
        // Exact when available — see the L1 site (reasoning is replayed, so
        // outputTokens is the right emission cost either way).
        tokens:
          response.usage?.outputTokens && response.usage.outputTokens > 0
            ? response.usage.outputTokens
            : Math.ceil(mergedText.length / 3),
        sourceLevel,
        sourceIds,
        sourceRange,
        created: Date.now(),
        ...(sources.length > 0 && sources.every((s) => s.witnessed) ? { witnessed: true } : {}),
        ...(responseContent ? { responseContent } : {}),
        // Terminal-disposition provenance (see SummaryEntry.provenance):
        // always 'end_turn' post-gate; presence marks the entry gate-verified.
        provenance: {
          stopReason: 'end_turn',
          requestHash,
          model: this.requireCompressionModel(),
        },
      };
      logNewSummaryId = newEntry.id;

      // Append the new merged entry first, then mark sources. Persist each
      // mergedInto edit individually so chronicle reflects the same shape as
      // the in-memory mirror. (If the process crashes mid-loop, restart sees
      // the new entry plus a partial set of marked sources; un-marked sources
      // would re-trigger a merge — accept the rare duplicate over data loss.)
      this.pushSummary(newEntry);

      for (const source of sources) {
        this.setMergedInto(source, newEntry.id);
      }

      // Check if this merge triggers a further merge
      this.checkMergeThreshold();
    } catch (error) {
      // Disposition rejections already warned + receipted above — don't
      // double-log them as crashes; tick() consumes them for retry policy.
      if (!(error instanceof MergeDispositionRejection)) {
        console.error(`Failed to merge summaries into L${targetLevel}:`, error);
      }
      logError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      logCompressionCall({
        operation: `merge_l${targetLevel}`,
        system: null,
        messages: summarizeTelemetryMessages(cleaned),
        metadata: {
          target_level: targetLevel,
          source_ids: sourceIds,
          source_level: sources[0]?.level ?? null,
          source_level_shown: sourceLevelShown,
          target_tokens: targetTokens,
          model: this.requireCompressionModel(),
          latency_ms: Date.now() - callStart,
          summary_id: logNewSummaryId,
        },
        response: summarizeTelemetryText(logResponse),
        error: logError,
      });
    }
  }

  // ============================================================================
  // Adaptive resolution (picker-driven) path
  // ============================================================================

  /**
   * Select context entries using the adaptive-resolution picker.
   *
   * Builds per-message PickerChunks from compressible messages, runs the
   * configured FoldingSolver under token-budget pressure, and emits the
   * resulting per-message resolutions as ContextEntry[]. Adjacent messages
   * sharing the same L_k ancestor emit the recall pair once.
   *
   * See `docs/adaptive-resolution-design.md` §3, §5.
   */
  protected selectAdaptive(
    store: MessageStoreView,
    budget: TokenBudget,
    opts?: SelectOptions,
  ): ContextEntry[] {
    const dryRun = opts?.dryRun === true;
    phaseChannel.report('context-build'); // liveness-watchdog phase
    this.rsBegin();
    const entries: ContextEntry[] = [];
    const maxTokens = budget.maxTokens - budget.reserveForResponse;
    const overBudgetGraceRatio = Math.max(0, this.config.overBudgetGraceRatio ?? 0);
    const rejectionBudget = Math.floor(maxTokens * (1 + overBudgetGraceRatio));
    // Closed-loop calibration: apply the persisted multiplier BEFORE any
    // estimate is taken this compile.
    const _diag = typeof process !== 'undefined' && !!process.env?.CM_CACHE_DIAG;
    let _t = _diag ? Date.now() : 0;
    this.loadCalibration(store);
    const messages = store.getAll();
    if (_diag) { console.error(`[cm-cache] selectAdaptive: calibration+getAll ${Date.now() - _t}ms`); _t = Date.now(); }
    const msgCap = this.config.maxMessageTokens;
    // Post-strip estimates (see postStripEstimates): every budgeting site in
    // this method prices a message the way the stripped render will cost it.
    const pse = this.postStripEstimates(store);
    if (_diag) { console.error(`[cm-cache] selectAdaptive: pse ${Date.now() - _t}ms`); _t = Date.now(); }

    // ----- 1. Build head/tail sets and reserve the tail before emitting -----
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = this.getRecentWindowStart(store);

    const headMessageIds = new Set<MessageId>();
    const tailMessageIds = new Set<MessageId>();
    let headTokens = 0;
    let tailTokens = 0;

    // Compute the fixed raw windows first. They are hard reservations, not
    // best-effort phases: foldable history may use only the space left after
    // every head and tail message has been accounted for.
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const tokens = msgCap > 0 ? Math.min(pse[i], msgCap + 50) : pse[i];
      headMessageIds.add(msg.id);
      headTokens += tokens;
    }
    const effectiveRecentStart = Math.max(recentStart, headEnd);
    for (let i = effectiveRecentStart; i < messages.length; i++) {
      const msg = messages[i];
      const tokens = msgCap > 0 ? Math.min(pse[i], msgCap + 50) : pse[i];
      tailMessageIds.add(msg.id);
      tailTokens += tokens;
    }

    if (headTokens + tailTokens > rejectionBudget) {
      throw new OverBudgetError({
        budget: rejectionBudget,
        actual: headTokens + tailTokens,
        diagnostics: {
          headTokens,
          tailTokens,
          middleTokens: 0,
          middleChunkCount: Math.max(0, effectiveRecentStart - headEnd),
          deepestLevel: 0,
        },
      });
    }

    const prefixBudget = rejectionBudget - tailTokens;
    let totalTokens = 0;

    // Emit the already-reserved head entries verbatim.
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
      const tokens = msgCap > 0 ? Math.min(pse[i], msgCap + 50) : pse[i];
      entries.push({
        index: entries.length,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content,
      });
      totalTokens += tokens;
      this.rsRaw('head', tokens);
    }
    // (Cache breakpoints are placed in one pass over the FINAL ordered entries
    // below — see placeCacheMarkers — capturing the stable folded prefix, not
    // just the head boundary.)

    // ----- 2. Build PickerChunks for messages in the middle -----
    // For each compressible (non-head, non-tail) message we create one
    // PickerChunk. Its l1Id is determined by the existing chunks that
    // group messages into L1 summaries.
    const chunksByMessageId = new Map<MessageId, Chunk>();
    for (const ch of this.chunks) {
      for (const m of ch.messages) {
        chunksByMessageId.set(m.id, ch);
      }
    }

    // Pinned-position set so the picker doesn't fold messages the user
    // explicitly marked as keep-raw. Built once and reused.
    const pinnedSet = this.pinnedPositions(messages);
    // V2 dynamic-pin fold-depth bounds (level / maxLevel). A position with a
    // bound is NOT a classic force-raw pin — the KV-stable controller must be
    // able to move it to/within its bound — so it renders as `pinned: false`
    // carrying `pinLevel` / `pinMaxLevel` instead.
    const pinBounds = this.pinLevelBounds(messages);

    // O(1) summary lookup for findAncestorAt — avoids O(summaries) find()
    // calls during emission.
    const summariesById = new Map<string, SummaryEntry>();
    for (const s of this.summaries) summariesById.set(s.id, s);

    // Fold-path fallback (2026-08-04). Chunk records are the PRODUCTION
    // ledger, not the coverage authority: a released or boundary-drifted
    // chunk (repair surgery; the covered-under-different-boundaries dedup
    // guard) leaves `ch.summaryId` unset, and its messages then had NO fold
    // path — permanently raw middle mass — while live L1s covering those
    // messages (under different boundaries) rendered recalls right above
    // them: semantic double-representation AND unfoldable tokens (opus4:
    // 233 raw messages pinned under re-merged L4s; the June c-279 chunk had
    // been in this deadlock silently). L1 `sourceIds` IS the coverage
    // authority — fall back to it when the ledger has no pointer.
    const l1ByMessage = new Map<MessageId, SummaryId>();
    for (const s of this.summaries) {
      if (s.level !== 1) continue;
      for (const mid of s.sourceIds) {
        if (!l1ByMessage.has(mid)) l1ByMessage.set(mid, s.id);
      }
    }

    // The foldable middle is everything outside the LIVE head window and the
    // reserved tail — INCLUDING [0, headStart) after a head-window reset.
    // Excluding that zone made pre-transition history invisible to the picker
    // (never planned, never rendered): the adaptive variant of the frontier
    // gap the coverage invariant exists to refuse.
    const middleSegments: ReadonlyArray<readonly [number, number]> = headStart > 0
      ? [[0, headStart], [headEnd, effectiveRecentStart]]
      : [[headEnd, effectiveRecentStart]];

    const pickerChunks: PickerChunk[] = [];
    for (const [segStart, segEnd] of middleSegments)
    for (let i = segStart; i < segEnd && i < messages.length; i++) {
      const msg = messages[i];
      const ch = chunksByMessageId.get(msg.id);
      const tokens = msgCap > 0
        ? Math.min(pse[i], msgCap + 50)
        : pse[i];
      const bound = pinBounds.get(i);
      pickerChunks.push({
        id: msg.id,
        sequence: i,
        rawTokens: tokens,
        currentResolution: this.resolutions.get(msg.id) ?? 0,
        lockedByAgent: this.locked.has(msg.id),
        // A classic pin (in pinnedSet with no level bound) stays force-raw. A
        // leveled pin is not force-raw; it carries its bound instead.
        pinned: pinnedSet.has(i) && bound === undefined,
        pinLevel: bound?.level,
        pinMaxLevel: bound?.maxLevel,
        l1Id: ch?.summaryId ?? l1ByMessage.get(msg.id),
        salience: AutobiographicalStrategy.staticSalience(msg),
      });
    }

    // Also include head and tail in PickerChunks (so token accounting matches)
    // — but mark them as in-head/in-tail so the picker won't fold them.
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const tokens = msgCap > 0
        ? Math.min(pse[i], msgCap + 50)
        : pse[i];
      pickerChunks.push({
        id: msg.id,
        sequence: i,
        rawTokens: tokens,
        currentResolution: 0,
        lockedByAgent: this.locked.has(msg.id),
        pinned: true, // treat head as pinned for picker purposes
        l1Id: undefined,
      });
    }
    for (let i = effectiveRecentStart; i < messages.length; i++) {
      const msg = messages[i];
      const tokens = msgCap > 0
        ? Math.min(pse[i], msgCap + 50)
        : pse[i];
      pickerChunks.push({
        id: msg.id,
        sequence: i,
        rawTokens: tokens,
        currentResolution: 0,
        lockedByAgent: this.locked.has(msg.id),
        pinned: true, // treat tail as pinned for picker purposes
        l1Id: undefined,
      });
    }

    // ----- 3. Build summaries map and recall-pair tokens -----
    const summariesMap = new Map<SummaryId, SummaryEntry>();
    const recallPairTokens = new Map<SummaryId, number>();
    for (const s of this.summaries) {
      summariesMap.set(s.id, s);
      // Recall pair priced at its TRUE render cost (label + the full answer
      // content INCLUDING reasoning carriers). The old `s.tokens + 20`
      // approximation counted only the summary text; on a store whose
      // summaries carry `responseContent` (signed/redacted thinking round-trip)
      // the plan under-priced every pair by ~30% — the controller then judged
      // an over-budget frontier as fitting, never folded deeper, and emission
      // refused every compile (Mica, 2026-07-26: 38k tokens of drift on a
      // 304k budget — a permanent wedge).
      recallPairTokens.set(s.id, this.recallPairCost(s));
    }

    // ----- 4. Run the picker -----
    // The picker's token count ALREADY includes the pinned head+tail (it gets
    // headTokens/tailTokens in pickerInputs and result.finalTokens covers them).
    // So the budget it folds against is the full maxTokens — NOT maxTokens-head,
    // which double-counts the head (reserves it twice: once here, once because
    // finalTokens already includes it). The old form threw ~head-tokens early at
    // tight budgets and quietly under-used the budget by ~head everywhere.
    const totalBudget = maxTokens;
    const slack = this.config.compressionSlackRatio ?? 0.1;
    const foldingBudget: FoldingBudget = {
      totalBudget,
      targetBudget: totalBudget * (1 - slack),
      slack,
    };

    const headSetForPicker = new Set<ChunkId>(headMessageIds);
    const tailSetForPicker = new Set<ChunkId>(tailMessageIds);

    const pickerInputs: PickerInputs = {
      chunks: pickerChunks,
      summaries: summariesMap,
      recallPairTokens,
      headChunkIds: headSetForPicker,
      tailChunkIds: tailSetForPicker,
      headTokens,
      tailTokens,
    };
    const preparedTotal = this.preparedWindowTokens === undefined
      ? undefined
      : Math.min(totalBudget, this.preparedWindowTokens);
    const picker = this.buildPicker(
      pickerInputs,
      preparedTotal === undefined
        ? undefined
        : {
            totalBudget: preparedTotal,
            targetBudget: preparedTotal * (1 - slack),
          },
    );
    // NOTE: a dry run also disturbs transition bookkeeping below
    // (`lastFrontierTokens` feeds `prepared` in getHotContextSettings(), so a
    // low-budget preview could make a converging transition look prepared and
    // get it settled by the next real compile). That is restored by
    // previewContext's `finally`, which owns it for ALL throw paths — do not
    // also restore it here, or the two owners will disagree.
    if (_diag) { console.error(`[cm-cache] selectAdaptive: inputs-built ${Date.now() - _t}ms`); _t = Date.now(); }
    const result = picker.run(pickerInputs, foldingBudget);
    if (_diag) { console.error(`[cm-cache] selectAdaptive: picker.run ${Date.now() - _t}ms`); _t = Date.now(); }
    this.lastFrontierTokens = result.finalTokens;
    // PLANNER/EMITTER RECONCILIATION (2026-07-26). The picker plans against
    // estimates; the emitter then spends real tokens per entry. When the two
    // disagree the emitter can overrun a plan that "fit", and the overrun is
    // paid by whatever renders last — the recent window — which is how tail
    // eviction becomes reachable at all. Eviction is therefore a symptom of
    // plan drift, not of scarce foldable material: the picker either reaches
    // its target or raises OverBudgetError. Record the plan so rsEnd() can
    // compare it against what was actually committed.
    this._plannedTokens = result.finalTokens;
    this._plannedMeta = {
      budgetMet: result.budgetMet,
      exhausted: result.exhausted,
      moves: result.moves,
      solver: picker.solverName,
    };

    // Every trust-region override is loud (design §13.4) — silence was half
    // of the 2026-07-12 incident.
    const plan = this._lastKvStable?.lastPlan();
    this.transitionBlocked = plan?.blocked === 'reach-floor'
      ? 'transition-pace-floor'
      : plan?.blocked === 'target-floor'
        ? 'prepared-window-floor'
        : undefined;
    if (plan?.override) {
      console.error(
        `[kv-escalation] override=${plan.override} perturbation=${plan.perturbation}` +
          ` tokens=${plan.tokens} budget=${foldingBudget.totalBudget}` +
          ` (see adaptive-resolution-design.md §13.4)`,
      );
    }

    // Commit the new resolutions back to strategy state for next compile.
    // Persist to chronicle only if anything actually changed — avoids
    // unnecessary state-slot writes on no-op compiles (which is the common
    // case in steady state with slack).
    let resolutionsChanged = false;
    let deepestLevel = 0;
    for (const [id, level] of result.finalResolutions) {
      if (headMessageIds.has(id) || tailMessageIds.has(id)) continue;
      if (this.locked.has(id)) continue;
      const prev = this.resolutions.get(id) ?? 0;
      if (prev !== level) {
        // Dry run: compute deepestLevel for diagnostics but leave the live
        // resolution map untouched — this is the fold plan, and a preview
        // must not become the agent's next context.
        if (!dryRun) {
          this.resolutions.set(id, level);
          resolutionsChanged = true;
        }
      }
      if (level > deepestLevel) deepestLevel = level;
    }
    if (resolutionsChanged && !dryRun) {
      this.persistResolutions();
    }

    // Wire produce ops into the strategy's own production queues so that
    // requested-but-not-yet-existing summaries actually get built. The
    // speculative pre-producer covers most cases ambiently, but when it is
    // disabled (`speculativeProduction: false`) or hasn't reached the level
    // the picker just asked for, the request would otherwise be dropped and
    // the picker would re-emit it on every subsequent compile. Handling it
    // here makes the produce path observable and convergent.
    //
    // The actual compression/merge work runs asynchronously via the next
    // `tick()` invocation (or the speculative drain kicked from
    // `onNewMessage`). This call only enqueues; it does not await.
    // Dry run: never enqueue. `handleProducedOps` writes the mergeQueue state
    // slot and the background drain would then spend real LLM tokens on a
    // layout the operator was only looking at.
    if (result.produced.length > 0 && !dryRun) {
      this.handleProducedOps(result.produced);
    }

    // Standing production target (productionBudgetTokens): run a SHADOW pick
    // against the production budget on the same inputs. Pure CPU — no LLM
    // call, no state commit; only its produce ops are enqueued, speculatively,
    // so the drain keeps the forest deep enough to lower the live budget to
    // this level at any time without a fold-storm or an OverBudget dead end.
    // The guarantee holds only while the target is reachable at all — the
    // exhausted branch below is the standing check for that.
    const prodBudget = this.config.productionBudgetTokens;
    if (!dryRun && prodBudget !== undefined && prodBudget > 0 && prodBudget < totalBudget) {
      const liveKvStable = this._lastKvStable;
      try {
        const shadowResult = this.buildPicker(pickerInputs).run(pickerInputs, {
          totalBudget: prodBudget,
          targetBudget: prodBudget * (1 - slack),
          slack,
        });
        if (shadowResult.produced.length > 0) {
          this.handleProducedOps(shadowResult.produced, { speculative: true });
        } else if (shadowResult.exhausted) {
          console.warn(
            `autobio: production target ${prodBudget} unreachable even fully folded ` +
              `(${shadowResult.finalTokens} tokens); lowering the live budget to it ` +
              `would hard-fail with OverBudgetError`,
          );
        }
      } catch (err) {
        // A failing shadow pick must never break the live compile.
        console.warn('autobio: shadow production pick failed:', err);
      } finally {
        // The shadow pick is not a compile — keep §13.4 observability pointed
        // at the strategy instance behind the live pick.
        this._lastKvStable = liveKvStable;
      }
    }

    // Record what a dry run needs, then restore the transition bookkeeping the
    // pick just clobbered. Done before the over-budget check so an infeasible
    // preview still reports instead of leaving state disturbed.
    if (dryRun) {
      this._lastPreview = {
        finalTokens: result.finalTokens,
        budgetTokens: rejectionBudget,
        fits: result.finalTokens <= rejectionBudget,
        exhausted: result.exhausted,
        headTokens,
        tailTokens,
        middleTokens: Math.max(0, result.finalTokens - headTokens - tailTokens),
        middleChunkCount: pickerChunks.length - headMessageIds.size - tailMessageIds.size,
        deepestLevel,
        resolutions: Object.fromEntries(result.finalResolutions),
        moves: result.moves,
        producedCount: result.produced.length,
      };
    }

    // Hard-fail whenever the picker's current plan exceeds the hard budget.
    // A `produce` op only schedules a missing summary; it does not make the
    // current raw plan feasible and must never authorize an inference.
    // A dry run reports infeasibility via `_lastPreview.fits` instead: the
    // whole point of previewing an aggressive budget is to learn it won't fit
    // without taking the outage that learning it live would cause.
    if (result.finalTokens > rejectionBudget && !dryRun) {
      throw new OverBudgetError({
        budget: rejectionBudget,
        actual: result.finalTokens,
        diagnostics: {
          headTokens,
          tailTokens,
          middleTokens: Math.max(0, result.finalTokens - headTokens - tailTokens),
          middleChunkCount: pickerChunks.length - headMessageIds.size - tailMessageIds.size,
          deepestLevel,
        },
      });
    }

    // ----- 5. Emit middle entries in source order -----
    // Walk middle messages. Handle two cases:
    //  - bodyGroupId set: collect all consecutive shards from the same group,
    //    emit ONE combined entry with concatenated content (raw shards + inline
    //    summary text for folded shards). This preserves KV — the model sees
    //    one continuous user message instead of N turns.
    //  - bodyGroupId absent: emit normally (raw L0 message, or Q+A summary pair).
    const emittedAncestors = new Set<SummaryId>();
    const summaryLabel = this.config.summaryContextLabel ?? 'What do you remember from earlier?';
    const summaryParticipant = this.config.summaryParticipant ?? 'Claude';

    // Emission-overflow refusal: the picker planned this layout to fit, so an
    // overrun here is estimator drift. The grace window (prefixBudget derives
    // from rejectionBudget) absorbs it; beyond that the select refuses the
    // turn rather than silently dropping whatever happened to render last.
    const middleChunkCountDiag = pickerChunks.filter(
      c => !headMessageIds.has(c.id) && !tailMessageIds.has(c.id),
    ).length;
    const emissionOverBudget = (attempted: number, level: number): OverBudgetError =>
      new OverBudgetError({
        stage: 'Emission overran the plan (planner/emitter estimator drift)',
        budget: rejectionBudget,
        actual: attempted + tailTokens,
        diagnostics: {
          headTokens,
          tailTokens,
          middleTokens: Math.max(0, attempted - headTokens),
          middleChunkCount: middleChunkCountDiag,
          deepestLevel: level,
        },
      });

    for (const [segStart, segEnd] of middleSegments) {
    let i = segStart;
    while (i < segEnd && i < messages.length) {
      const msg = messages[i];

      if (msg.bodyGroupId) {
        // Collect the full run of consecutive shards sharing this bodyGroupId.
        const groupId = msg.bodyGroupId;
        const groupStart = i;
        while (
          i < segEnd &&
          i < messages.length &&
          messages[i].bodyGroupId === groupId
        ) {
          i++;
        }
        const groupMessages = messages.slice(groupStart, i);
        // Sort by shardIndex to ensure byte-faithful ordering.
        const sortedShards = [...groupMessages].sort(
          (a, b) => (a.shardIndex ?? 0) - (b.shardIndex ?? 0)
        );

        // Walk shards in order, accumulating "runs":
        //  - a 'raw' run is consecutive shards at L0; flushed as ONE User
        //    message with their text concatenated.
        //  - a 'summary' run is consecutive shards under the same L_k
        //    ancestor; flushed as a Q+A recall pair (Context Manager
        //    question + summaryParticipant answer), emitted once per
        //    distinct ancestor.
        // The run breaks (and the previous run flushes) when:
        //  - resolution transitions raw ↔ folded
        //  - the L_k ancestor changes
        type Run =
          | { kind: 'raw'; parts: string[]; ids: string[] }
          | { kind: 'summary'; ancestor: SummaryEntry };
        let currentRun: Run | null = null;
        const participant = sortedShards[0].participant;

        const flushRun = (): void => {
          if (!currentRun) return;
          if (currentRun.kind === 'raw') {
            const text = currentRun.parts.join('');
            const content: ContentBlock[] = [{ type: 'text', text }];
            // Deliberately do NOT apply maxMessageTokens here: the picker
            // is the authority on how much of the doc renders raw vs.
            // summarized. Truncating the composite would silently lose
            // doc content that the picker explicitly chose to keep raw.
            // (`maxMessageTokens` is for per-message caps on chat / tool
            // results, not for sharded bodyGroup composites.)
            const tokens = this.estimateTokens(content);
            if (totalTokens + tokens > prefixBudget) {
              throw emissionOverBudget(totalTokens + tokens, 0);
            }
            entries.push({
              index: entries.length,
              sourceMessageId: undefined,
              // Composite provenance: every shard whose text was concatenated
              // into this entry. Without this the coverage invariant reads the
              // absorbed shards as missing (the body-group-shard false
              // positive) — same fix as mergeAdjacentBodyGroupRaw.
              sourceMessageIds: [...currentRun.ids],
              sourceRelation: 'copy',
              participant,
              content,
            });
            totalTokens += tokens;
            this.rsRaw('middleRaw', tokens);
          } else {
            // summary run — emit Q+A pair, dedup at the strategy level
            const ancestor = currentRun.ancestor;
            if (!emittedAncestors.has(ancestor.id)) {
              emittedAncestors.add(ancestor.id);
              const questionEntry: ContextEntry = {
                index: entries.length,
                participant: 'Context Manager',
                content: [{ type: 'text', text: summaryLabel }],
                sourceRelation: 'derived',
              };
              const answerContent: ContentBlock[] = this.summaryAnswerContent(ancestor);
              const answerEntry: ContextEntry = {
                index: entries.length + 1,
                participant: summaryParticipant,
                content: msgCap > 0 ? this.truncateContent(answerContent, msgCap) : answerContent,
                sourceRelation: 'derived',
              };
              const pairTokens = this.estimateTokens(questionEntry.content) + this.estimateTokens(answerEntry.content);
              if (totalTokens + pairTokens > prefixBudget) {
                throw emissionOverBudget(totalTokens + pairTokens, ancestor.level);
              }
              entries.push(questionEntry);
              entries.push(answerEntry);
              totalTokens += pairTokens;
              this.rsSummary(ancestor.level, pairTokens, ancestor.id);
            }
          }
          currentRun = null;
        };

        for (const shard of sortedShards) {
          const resolution = result.finalResolutions.get(shard.id) ?? 0;
          if (resolution === 0) {
            if (currentRun?.kind !== 'raw') {
              flushRun();
              currentRun = { kind: 'raw', parts: [], ids: [] };
            }
            const rawRun = currentRun as { kind: 'raw'; parts: string[]; ids: string[] };
            rawRun.ids.push(shard.id);
            for (const block of shard.content) {
              if (block.type === 'text') rawRun.parts.push(block.text);
            }
          } else {
            const ancestor = this.findAncestorAt(shard.id, resolution, chunksByMessageId, summariesById, l1ByMessage);
            if (!ancestor) {
              // Fall back to raw
              if (currentRun?.kind !== 'raw') {
                flushRun();
                currentRun = { kind: 'raw', parts: [], ids: [] };
              }
              const rawRun = currentRun as { kind: 'raw'; parts: string[]; ids: string[] };
              rawRun.ids.push(shard.id);
              for (const block of shard.content) {
                if (block.type === 'text') rawRun.parts.push(block.text);
              }
              continue;
            }
            // If we're already in a summary run for the SAME ancestor, this
            // shard is covered — skip silently.
            if (currentRun?.kind === 'summary' && currentRun.ancestor.id === ancestor.id) {
              continue;
            }
            flushRun();
            currentRun = { kind: 'summary', ancestor };
          }
        }
        flushRun();
        continue;
      }

      // Non-shard path: existing behavior.
      const resolution = result.finalResolutions.get(msg.id) ?? 0;
      if (resolution === 0) {
        const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
        const tokens = msgCap > 0 ? Math.min(pse[i], msgCap + 50) : pse[i];
        if (totalTokens + tokens > prefixBudget) {
          throw emissionOverBudget(totalTokens + tokens, 0);
        }
        entries.push({
          index: entries.length,
          sourceMessageId: msg.id,
          sourceRelation: 'copy',
          participant: msg.participant,
          content,
        });
        totalTokens += tokens;
        this.rsRaw('middleRaw', tokens);
        i++;
      } else {
        const ancestor = this.findAncestorAt(msg.id, resolution, chunksByMessageId, summariesById, l1ByMessage);
        if (!ancestor) {
          const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
          const tokens = msgCap > 0 ? Math.min(pse[i], msgCap + 50) : pse[i];
          if (totalTokens + tokens > prefixBudget) {
            throw emissionOverBudget(totalTokens + tokens, 0);
          }
          entries.push({
            index: entries.length,
            sourceMessageId: msg.id,
            sourceRelation: 'copy',
            participant: msg.participant,
            content,
          });
          totalTokens += tokens;
          this.rsRaw('middleRaw', tokens);
          i++;
          continue;
        }
        if (emittedAncestors.has(ancestor.id)) {
          i++;
          continue;
        }
        emittedAncestors.add(ancestor.id);
        const questionEntry: ContextEntry = {
          index: entries.length,
          participant: 'Context Manager',
          content: [{ type: 'text', text: summaryLabel }],
          sourceRelation: 'derived',
        };
        const answerContent: ContentBlock[] = this.summaryAnswerContent(ancestor);
        const answerEntry: ContextEntry = {
          index: entries.length + 1,
          participant: summaryParticipant,
          content: msgCap > 0 ? this.truncateContent(answerContent, msgCap) : answerContent,
          sourceRelation: 'derived',
        };
        const pairTokens = this.estimateTokens(questionEntry.content) + this.estimateTokens(answerEntry.content);
        if (totalTokens + pairTokens > prefixBudget) {
          throw emissionOverBudget(totalTokens + pairTokens, ancestor.level);
        }
        entries.push(questionEntry);
        entries.push(answerEntry);
        totalTokens += pairTokens;
        this.rsSummary(ancestor.level, pairTokens, ancestor.id);
        i++;
      }
    }
    }

    // ----- 6. Emit the fully-reserved tail -----
    const tailStats = this.emitRecentNewestFirst(entries, store, messages, effectiveRecentStart, msgCap, rejectionBudget, totalTokens, pse);
    if (tailStats.messages !== messages.length - effectiveRecentStart) {
      throw new OverBudgetError({
        stage: 'Tail emission dropped reserved recent-window messages',
        budget: rejectionBudget,
        actual: totalTokens + tailTokens,
        diagnostics: {
          headTokens,
          tailTokens,
          middleTokens: totalTokens - headTokens,
          middleChunkCount: pickerChunks.length - headMessageIds.size - tailMessageIds.size,
          deepestLevel,
        },
      });
    }
    this.rsRaw('tail', tailStats.tokens, tailStats.messages);

    // ----- 7. Post-process: merge consecutive raw entries from the same bodyGroup -----
    // Both head and tail emission paths emit shards as separate ContextEntries.
    // The middle path already merges consecutive same-bodyGroup raw shards into
    // one composite entry, but head/tail don't. This pass closes that gap so
    // a sharded message renders as ONE API message regardless of which region
    // it falls into (preserves KV cache through region transitions).
    const merged = this.mergeAdjacentBodyGroupRaw(entries, store);

    this.assertFullCoverage(merged, messages, {
      headStart,
      headEnd,
      recentStart: effectiveRecentStart,
    });
    this.pruneToolEntries(merged);
    this.trimOrphanedToolUse(merged);
    // Full pairing invariant over the final rendered context — catches the
    // mid-list orphans the trailing/leading trims can't (bug 6.7). The adaptive
    // path has the same mid-list orphan producers as hierarchical (budget
    // `break`s between pair members, raw emission interleaved with recall
    // pairs), and FKM defaults autobiographical strategies onto this path — so
    // the guard has to run here too. It's a no-op on already-valid output.
    this.enforceToolPairing(merged);
    // Strip stale images BEFORE placing markers and committing stats, so both
    // describe the post-strip context the agent actually receives.
    this.applyImageStripping(merged, store);

    // The newest stored message is the triggering turn for this compile. A
    // structural repair may rewrite tool blocks, but it must never erase that
    // turn. Body-group shards merge under the first shard's source id, so any
    // surviving member of the same group proves the newest shard is present.
    const newest = messages[messages.length - 1];
    if (newest) {
      const newestGroupIds = newest.bodyGroupId
        ? new Set(messages.filter(m => m.bodyGroupId === newest.bodyGroupId).map(m => m.id))
        : new Set([newest.id]);
      const newestRetained = merged.some(
        entry => entry.sourceMessageId && newestGroupIds.has(entry.sourceMessageId),
      );
      if (!newestRetained) {
        throw new OverBudgetError({
          stage: 'Structural repair did not retain the newest turn',
          budget: rejectionBudget,
          actual: totalTokens + tailTokens,
          diagnostics: {
            headTokens,
            tailTokens,
            middleTokens: totalTokens - headTokens,
            middleChunkCount: pickerChunks.length - headMessageIds.size - tailMessageIds.size,
            deepestLevel,
          },
        });
      }
    }
    // Place ≤4 cache breakpoints across the FINAL ordered entries so the
    // provider can reuse the stable folded prefix — not just the head. With a
    // single head marker the cache hit is ~2%; well-placed breakpoints take the
    // real strategy to ~50% (docs/kv-stable-context-control.md — marker
    // placement is the dominant KV lever).
    this.placeCacheMarkers(merged, headMessageIds, tailMessageIds);
    this.assertMiddleCoverage();
    this.rsEnd();
    // Closed-loop calibration bookkeeping: the committed render stats total
    // (in CURRENT calibrated units) is what this compile claims the request
    // will cost — reportRealInputTokens compares provider usage against it.
    this._storeView = store;
    const rs = this.getRenderStats(store);
    this._lastCompileEstimate =
      rs.head.tokens + rs.tail.tokens + rs.middleRaw.tokens +
      rs.summaries.l1.tokens + rs.summaries.l2.tokens + rs.summaries.l3.tokens;
    this._calibrationArmed = true; // exactly one sample per compile
    return merged;
  }

  private _lastCompileEstimate = 0;
  private _storeView: MessageStoreView | null = null;

  /**
   * Closed-loop estimator calibration (2026-07-12). Feed the REAL input total
   * for a request built from the latest compile (fresh + cache_read +
   * cache_creation, minus non-window overhead the caller knows about, e.g.
   * tool schemas). Maintains an EMA of real/estimated and applies it as the
   * store's global multiplier, persisted across restarts. The per-class rates
   * carry the shape; this carries the residual level.
   */
  reportRealInputTokens(realTotal: number): void {
    this.requireLoadedBranch('reportRealInputTokens');
    if (!Number.isFinite(realTotal) || realTotal <= 0) return;
    const est = this._lastCompileEstimate;
    if (!est || est <= 0) return;

    // ARM-ONCE-PER-COMPILE (2026-07-12 regression fix). A turn makes MANY API
    // calls — tool-use rounds and max_tokens continuations each append to the
    // request — so only the FIRST completion after a compile was built from
    // the window this estimate describes. Feeding later calls compares a grown
    // request against the original estimate: ratios of 2.0-2.3 (est=224k
    // real=504k) drove the multiplier 1.0 -> 2.37 in minutes, inflating every
    // estimate (the fold floor went 62k -> 108k on unchanged content) and
    // exhausting the picker on every wake. One sample per compile, always.
    if (!this._calibrationArmed) return;
    this._calibrationArmed = false;

    const ratio = realTotal / est;
    // SANITY BAND: a representative sample sits near 1. Anything wilder is a
    // structural mismatch (a request we didn't compile, a partial compile, a
    // provider quirk) — never evidence about chars-per-token. Log, don't learn.
    if (ratio < 0.6 || ratio > 1.8) {
      console.error(
        `[estimator-calibration] REJECTED out-of-band sample real/est=${ratio.toFixed(2)} ` +
          `(est=${Math.round(est / 1000)}k real=${Math.round(realTotal / 1000)}k) — ` +
          `not a window-shaped request; multiplier stays ${this._calibration.toFixed(2)}`,
      );
      return;
    }

    const current = this._calibration;
    const observed = ratio * current; // back out the multiplier already applied
    const alpha = 0.2; // slow EMA: one wild request shouldn't yank the ruler
    const next = current + alpha * (observed - current);
    const clamped = Math.min(1.8, Math.max(0.6, next));
    if (Math.abs(clamped - current) / current > 0.02) {
      console.error(
        `[estimator-calibration] real/est=${ratio.toFixed(2)} ` +
          `multiplier ${current.toFixed(2)} -> ${clamped.toFixed(2)} (est=${Math.round(est / 1000)}k real=${Math.round(realTotal / 1000)}k)`,
      );
    }
    this._calibration = clamped;
    this.applyCalibration();
    try {
      this.store?.setStateJson(this.calibrationStateId, { multiplier: this._calibration, at: Date.now() });
    } catch { /* persistence is best-effort */ }
  }

  private _calibrationArmed = false;

  private _calibration = 1;
  private _calibrationLoaded = false;

  protected applyCalibration(): void {
    this._storeView?.setTokenCalibration?.(this._calibration);
  }

  /** Load the persisted multiplier once and push it into the store view. */
  protected loadCalibration(store: MessageStoreView): void {
    this._storeView = store;
    if (!this._calibrationLoaded) {
      this._calibrationLoaded = true;
      try {
        const saved = this.store?.getStateJson(this.calibrationStateId) as { multiplier?: number } | null;
        if (saved && Number.isFinite(saved.multiplier)) {
          this._calibration = Math.min(1.8, Math.max(0.6, saved.multiplier!));
        }
      } catch { /* absent slot is fine */ }
    }
    this.applyCalibration();
  }

  /**
   * Previous compile's per-entry cache identities (participant + content
   * bytes), used to find the measured stable-prefix boundary. In-memory only:
   * after a restart the first compile falls back to seam placement.
   */
  protected _prevCacheKeys?: string[];

  /**
   * Place up to three message-level `cache_control` breakpoints across the
   * final ordered entries: the head/system boundary, the MEASURED stable
   * prefix boundary, and the very end (pure-append reuse).
   *
   * The stable-prefix mark used to sit at the folded-history/tail seam
   * (`historyEnd`) on the assumption that the folded region is stable
   * turn-to-turn. Measured on mythos llm-calls 2026-08-13..17 that assumption
   * fails ~1.4×/hour in steady state: fold rotations rewrite the folded
   * region ABOVE the seam, and a seam marker then performs identically to no
   * mid marker at all (priced replay over logged bytes: seam ≈ end-only;
   * divergence-aligned ≈ −10%). So: diff this compile's entries against the
   * previous compile's (by content identity — bytes are what the provider
   * hashes) and mark the last entry of the SURVIVING prefix instead. In
   * steady state (append-only) this preserves the previous request endpoint
   * explicitly; relying on the new end marker's backward search would miss
   * that cache entry after more than 20 appended provider blocks. After a
   * rotation the marker drops to the deepest byte-stable point, so subsequent
   * requests re-read everything above the churn instead of re-writing it.
   * See docs/unified-solve-design.md §9.2b.
   *
   * Slot contract with membrane (the request compiler's side of it):
   * Anthropic allows 4 cache_control blocks per request INCLUDING any on
   * tools/system. The split is: **this strategy holds first claim, up to 3
   * message-level markers; membrane is residual claimant on whatever
   * remains**, spending it end-position-only — a tools+system fallback when
   * zero message markers arrive, and a floating marker on the newest
   * message when the native tool loop rebuilds the request between tool
   * rounds (which this strategy never sees: compile runs once per turn,
   * and without the float every tool round re-paid the whole appended
   * suffix at full input price — the qa-ops 2026-08-20 8M-token incident).
   *
   * An earlier revision of this comment justified the 3-cap with "membrane
   * marks the system block whenever prompt caching is on" — membrane has
   * not done that unconditionally for some time, which is exactly how a
   * whole free slot went unnoticed; the cap is now an asserted invariant
   * rather than a comment-enforced courtesy. Enforcement is asymmetric by
   * design: the supplier hard-fails at compile time (cheap, CI-catchable,
   * see below), while membrane enforces by counting — it withholds its own
   * residual marker (with a warning) rather than stripping ours, because
   * silently dropped markers are silently broken caching and an
   * over-budget request from our side is the loud 400 we prefer to silent
   * degradation (Rhys, 2026-07-26: "A maximum of 4 blocks with
   * cache_control may be provided. Found 5.").
   *
   * Idempotent; clears any pre-existing markers first.
   */
  protected placeCacheMarkers(
    entries: ContextEntry[],
    headMessageIds: ReadonlySet<MessageId>,
    tailMessageIds: ReadonlySet<MessageId>,
  ): void {
    for (const e of entries) if (e.cacheMarker) e.cacheMarker = false;
    const n = entries.length;
    if (n === 0) return;

    let lastHead = -1;
    let firstTail = n;
    for (let i = 0; i < n; i++) {
      const sid = entries[i].sourceMessageId;
      if (sid && headMessageIds.has(sid)) lastHead = i;
    }
    for (let i = 0; i < n; i++) {
      const sid = entries[i].sourceMessageId;
      if (sid && tailMessageIds.has(sid)) { firstTail = i; break; }
    }
    const historyEnd = firstTail - 1; // last middle (folded-history) entry

    // Measured stable prefix: first index where this compile's entry bytes
    // diverge from the previous compile's. No previous compile → seam
    // placement, the old bounded cold-start behavior. Later pure appends mark
    // the previous endpoint itself so reuse never depends on Anthropic finding
    // it within the new end marker's 20-block backward-search window.
    const keys = entries.map(
      (e) => `${e.participant} ${JSON.stringify(e.content)}`,
    );
    let firstDiff = n;
    const prev = this._prevCacheKeys;
    if (prev) {
      let i = 0;
      while (i < n && i < prev.length && keys[i] === prev[i]) i++;
      firstDiff = i;
    }
    this._prevCacheKeys = keys;
    const stableEnd = prev ? firstDiff - 1 : historyEnd;

    const marks = new Set<number>();
    if (lastHead >= 0) marks.add(lastHead);            // system / head block
    if (stableEnd > lastHead) marks.add(stableEnd);    // measured stable prefix (the big one)
    marks.add(n - 1);                                  // end → pure-append reuse

    // First-claim cap (see the slot contract above). Structurally ≤3 today;
    // this guards the invariant against a future fourth seam, because the
    // overrun would otherwise surface as either a hard 400 on every
    // inference or membrane silently losing its tool-loop floating marker.
    if (marks.size > 3) {
      throw new Error(
        `placeCacheMarkers: ${marks.size} message-level cache markers exceed ` +
        `the strategy's first-claim budget of 3 (Anthropic allows 4 total; ` +
        `the remainder is membrane's residual claim)`,
      );
    }

    for (const idx of marks) if (idx >= 0 && idx < n) entries[idx].cacheMarker = true;
  }

  /**
   * Walk an entries array; for every run of consecutive entries that
   *  (a) have sourceRelation: 'copy' (raw, not a synthesized recall pair)
   *  (b) have sourceMessageId pointing to messages in the same bodyGroup
   * merge them into one composite entry whose body is the byte-faithful
   * concatenation of their text content. Other entries pass through.
   *
   * Reindexes the returned array.
   */
  protected mergeAdjacentBodyGroupRaw(
    entries: ContextEntry[],
    store: MessageStoreView
  ): ContextEntry[] {
    if (entries.length === 0) return entries;

    // Look up bodyGroup metadata by sourceMessageId, memoized for the
    // duration of this pass. Entries reference the same messages repeatedly
    // (run-extension checks + the shardIndex sort comparator below), and
    // store.get() also resolves blobs — fetch each message at most once.
    const shardMeta = new Map<string, { groupId?: string; shardIndex?: number }>();
    const metaOf = (sourceMessageId?: string): { groupId?: string; shardIndex?: number } | undefined => {
      if (!sourceMessageId) return undefined;
      let meta = shardMeta.get(sourceMessageId);
      if (!meta) {
        const m = store.get(sourceMessageId);
        meta = { groupId: m?.bodyGroupId, shardIndex: m?.shardIndex };
        shardMeta.set(sourceMessageId, meta);
      }
      return meta;
    };
    const groupOf = (sourceMessageId?: string): string | undefined =>
      metaOf(sourceMessageId)?.groupId;

    const out: ContextEntry[] = [];
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      const groupId = entry.sourceRelation === 'copy' ? groupOf(entry.sourceMessageId) : undefined;
      if (!groupId) {
        out.push({ ...entry, index: out.length });
        i++;
        continue;
      }
      // Collect run of consecutive raw entries with same bodyGroupId.
      const run: ContextEntry[] = [entry];
      let j = i + 1;
      while (
        j < entries.length &&
        entries[j].sourceRelation === 'copy' &&
        groupOf(entries[j].sourceMessageId) === groupId
      ) {
        run.push(entries[j]);
        j++;
      }
      if (run.length === 1) {
        out.push({ ...entry, index: out.length });
        i++;
        continue;
      }
      // Sort the run by the underlying shardIndex to ensure byte-faithful
      // ordering. (Head/tail emission keeps chronological order, but defending
      // against reorderings is cheap.)
      const sortedRun = [...run].sort((a, b) => {
        const sa = metaOf(a.sourceMessageId)?.shardIndex ?? 0;
        const sb = metaOf(b.sourceMessageId)?.shardIndex ?? 0;
        return sa - sb;
      });
      // Build merged text content. Non-text blocks (rare in shards) are
      // preserved on the first shard's entry only.
      const mergedTextParts: string[] = [];
      const nonTextBlocks: ContentBlock[] = [];
      for (const r of sortedRun) {
        for (const block of r.content) {
          if (block.type === 'text') mergedTextParts.push(block.text);
          else nonTextBlocks.push(block);
        }
      }
      const mergedContent: ContentBlock[] = [
        ...nonTextBlocks,
        { type: 'text', text: mergedTextParts.join('') },
      ];
      out.push({
        index: out.length,
        sourceMessageId: sortedRun[0].sourceMessageId,
        // Keep every shard's id: this composite represents all of them, and
        // the coverage invariant reads provenance, not just the first source.
        sourceMessageIds: sortedRun
          .map(e => e.sourceMessageId)
          .filter((id): id is string => !!id),
        sourceRelation: 'copy',
        participant: sortedRun[0].participant,
        content: mergedContent,
      });
      i = j;
    }
    return out;
  }

  /** Get (lazily constructing) the configured picker instance. */
  protected getAdaptivePicker(): Picker {
    if (this._adaptivePicker) return this._adaptivePicker;
    const strategy: FoldingSolver =
      this.config.foldingStrategy === 'oldest-first'
        ? new OldestFirstStrategy()
        : new FlatProfileStrategy();
    this._adaptivePicker = new Picker(strategy);
    return this._adaptivePicker;
  }

  /**
   * Build the picker for this compile. Instance folding strategies (kv-stable)
   * need the per-compile `PickerInputs` at construction, so they're built fresh
   * here; stateless ones (flat-profile / oldest-first) reuse the memoized picker.
   */
  protected buildPicker(
    inputs: PickerInputs,
    preparedBudget?: { totalBudget: number; targetBudget: number },
  ): Picker {
    // Drift alarm: the live config must still name the solver chosen at
    // construction. Nothing legitimate rewrites foldingStrategy at runtime —
    // a mismatch means an override merge (or other mutation) clobbered it,
    // and THIS compile is about to run under the wrong cache policy. The
    // 2026-08-07 fable investigation found exactly one such compile
    // ([picker-unrealizable] solver=flat-profile in a kv-stable agent) with
    // no way to attribute it; this line is the attribution.
    if (this.config.foldingStrategy !== this._constructedFoldingStrategy) {
      console.error(
        `[picker-config-drift] foldingStrategy=${JSON.stringify(this.config.foldingStrategy)} ` +
          `differs from constructed=${JSON.stringify(this._constructedFoldingStrategy)} — ` +
          `a runtime mutation clobbered the solver choice; this compile runs the wrong solver`,
        new Error('picker-config-drift stack').stack,
      );
    }
    if (this.config.foldingStrategy === 'kv-stable') {
      const strategy = new KvStableStrategy({
        reachTokens: preparedBudget === undefined
          ? this.config.kvStableReachTokens
          : this.runtimeTransitionPaceTokens ?? this.config.kvStableReachTokens,
        qualityGapRatio: this.config.kvStableQualityGapRatio,
        mergeThreshold: this.config.mergeThreshold,
        goalTotalTokens: preparedBudget?.totalBudget,
        goalTargetTokens: preparedBudget?.targetBudget,
        strictReach: preparedBudget !== undefined,
      });
      this._lastKvStable = strategy;
      return new Picker(strategy);
    }
    this._lastKvStable = null;
    return this.getAdaptivePicker();
  }

  /** The kv-stable strategy instance behind the most recent compile — kept for
   *  `[kv-escalation]` observability (design §13.4: every override is loud). */
  private _lastKvStable: KvStableStrategy | null = null;

  /**
   * Static salience prior (design §13.3) — "is the window the only copy?".
   * Content whose payload is externalized folds cheap: tool blocks
   * (re-derivable), fenced code (usually written to disk), images (the file/
   * CDN keeps them), bare link drops. Conversation exists nowhere but the
   * chronicle, so it stays at 1. Returns a value in [0.2, 1]; cheap,
   * deterministic, computed per message at picker-input construction.
   */
  private static _salienceCache = new WeakMap<StoredMessage, number>();

  protected static staticSalience(msg: StoredMessage): number {
    const cached = this._salienceCache.get(msg);
    if (cached !== undefined) return cached;
    const result = this.computeStaticSalience(msg);
    this._salienceCache.set(msg, result);
    return result;
  }

  /** Pure per-message salience, cached on the msg object (immutable content).
   *  With getAll()'s view cache the same StoredMessage is reused across a
   *  compile's passes and across compiles, so the per-message JSON.stringify of
   *  tool payloads runs once instead of over every middle message every compile
   *  (Sol, 2026-07-31). */
  protected static computeStaticSalience(msg: StoredMessage): number {
    let totalChars = 0;
    let externalChars = 0;
    for (const block of msg.content) {
      const b = block as {
        type?: string;
        text?: string;
        input?: unknown;
        content?: unknown;
      };
      switch (b.type) {
        case 'text': {
          const t = b.text ?? '';
          totalChars += t.length;
          // Fenced code blocks.
          const fences = t.split('```');
          for (let i = 1; i < fences.length; i += 2) externalChars += fences[i].length;
          // Bare link-drop lines (the URL is the payload).
          for (const line of t.split('\n')) {
            const trimmed = line.trim();
            if (/^https?:\/\/\S+$/.test(trimmed)) externalChars += trimmed.length;
          }
          break;
        }
        case 'tool_use': {
          const n = JSON.stringify(b.input ?? {}).length;
          totalChars += n;
          externalChars += n;
          break;
        }
        case 'tool_result': {
          const n =
            typeof b.content === 'string'
              ? b.content.length
              : JSON.stringify(b.content ?? '').length;
          totalChars += n;
          externalChars += n;
          break;
        }
        case 'image': {
          // Estimate parity with the renderer's flat image cost; the payload
          // lives in the file/CDN, so it is fully externalized.
          totalChars += 6400; // ≈1600 tokens × 4 chars
          externalChars += 6400;
          break;
        }
        default: {
          const t = (b as { text?: string }).text ?? '';
          totalChars += t.length;
        }
      }
    }
    if (totalChars <= 0) return 1;
    const externalized = Math.min(1, externalChars / totalChars);
    // Fully-externalized content bottoms out at 0.2 — cheap, never free
    // (hard protections, not salience, are what make content unfoldable).
    return Math.max(0.2, 1 - 0.8 * externalized);
  }

  /** Memoized true render cost of a summary's recall pair (label + answer
   *  content including carriers). Keyed by id+tokens so a re-generated
   *  summary under a reused id re-prices. */
  private _pairCostCache = new Map<string, number>();

  protected recallPairCost(s: SummaryEntry): number {
    const key = `${s.id}:${s.tokens}`;
    const cached = this._pairCostCache.get(key);
    if (cached !== undefined) return cached;
    const label = this.config.summaryContextLabel ?? 'What do you remember from earlier?';
    const cost =
      this.estimateTokens([{ type: 'text', text: label }]) +
      this.estimateTokens(this.summaryAnswerContent(s));
    this._pairCostCache.set(key, cost);
    return cost;
  }

  /**
   * Walk the summary tree to find the L_k ancestor of a message.
   * Returns null if no ancestor exists at that level (e.g., L_k not yet produced).
   *
   * Takes a pre-built summariesById map to avoid O(summaries) lookups per
   * call — for a chronicle with thousands of summaries and hundreds of
   * middle messages, the O(n) `find` would dominate compile latency.
   */
  protected findAncestorAt(
    messageId: MessageId,
    level: number,
    chunksByMessageId: ReadonlyMap<MessageId, Chunk>,
    summariesById?: ReadonlyMap<string, SummaryEntry>,
    /** Fold-path fallback (see selectAdaptive): message → covering L1 id
     *  from L1 sourceIds, for released/boundary-drifted chunk records.
     *  MUST be passed wherever the planner used the same fallback, or the
     *  emitter renders raw what the plan priced folded (emission refusal). */
    l1Fallback?: ReadonlyMap<MessageId, SummaryId>,
  ): SummaryEntry | null {
    if (level <= 0) return null;
    const chunk = chunksByMessageId.get(messageId);
    const startId = chunk?.summaryId ?? l1Fallback?.get(messageId);
    if (!startId) return null;
    const lookup = (id: string): SummaryEntry | undefined =>
      summariesById ? summariesById.get(id) : this.summaries.find((s) => s.id === id);
    let current: SummaryEntry | undefined = lookup(startId);
    while (current && current.level < level) {
      const parentId = getSummaryParentId(current);
      if (!parentId) return null;
      current = lookup(parentId);
    }
    if (!current || current.level !== level) return null;
    return current;
  }

  /**
   * Recursively expand a summary's `sourceIds` down to the leaf message IDs
   * it covers, adding each leaf into `out`.
   *
   * Required because `SummaryEntry.sourceIds` are level-relative: an L1's
   * sourceIds are raw message IDs (sourceLevel=0), but an L2's sourceIds
   * are L1 IDs (sourceLevel=1), and so on. Any dedup that walks `sourceIds`
   * directly only works for L1s — once L2+ summaries enter the picture
   * (which happens as soon as `mergeThreshold` L1s accumulate during
   * interleaved compression+merge ticks), the dedup silently fails and
   * already-summarized messages leak back into the request as raw text.
   * That's how Bug 10 produced 200k+ token merge prompts on a 4234-msg
   * import.
   *
   * Callers should also expand merged L1s (not just the unmerged frontier)
   * as defense in depth — a stale `mergedInto` pointer or a partially
   * applied merge shouldn't surface raw messages.
   *
   * `visited` guards against pathological cycles in the summary graph (a
   * corrupted store or a future merge regression that lets a summary
   * reference itself). The hierarchy is a DAG by construction, but a
   * stack overflow during compression — exactly when the safety net is
   * supposed to save the session — is too steep a price for trusting that.
   */
  protected expandSummaryToLeafMessageIds(
    summary: SummaryEntry,
    summariesById: ReadonlyMap<string, SummaryEntry>,
    out: Set<MessageId>,
    visited: Set<string> = new Set(),
  ): void {
    if (visited.has(summary.id)) return;
    visited.add(summary.id);
    if (summary.sourceLevel === 0) {
      for (const id of summary.sourceIds) out.add(id);
      return;
    }
    for (const childId of summary.sourceIds) {
      const child = summariesById.get(childId);
      if (child) this.expandSummaryToLeafMessageIds(child, summariesById, out, visited);
    }
  }

  // ============================================================================
  // Hierarchical (threshold-driven) path
  // ============================================================================

  /**
   * Select context entries using hierarchical compression with budget carryover.
   * Matches moltbot's budget waterfall: L3 → L2 → L1 with unused budget flowing down.
   */
  protected selectHierarchical(store: MessageStoreView, budget: TokenBudget): ContextEntry[] {
    phaseChannel.report('context-build'); // liveness-watchdog phase
    this.rsBegin();
    const entries: ContextEntry[] = [];
    const maxTokens = budget.maxTokens - budget.reserveForResponse;
    const messages = store.getAll();
    const msgCap = this.config.maxMessageTokens;

    // Emission grace (coverage invariant, 76e95a0): selection below still
    // TARGETS maxTokens, but emission never silently drops content to fit —
    // it may overshoot up to the grace window, and beyond that the select
    // refuses the turn (OverBudgetError) rather than losing history.
    // enforceBudget=false disables the ceiling entirely (legacy behavior).
    const graceLimit = this.config.enforceBudget === false
      ? Number.POSITIVE_INFINITY
      : Math.floor(maxTokens * (1 + Math.max(0, this.config.overBudgetGraceRatio ?? 0)));

    let totalTokens = 0;

    // Phase 0: Head window — preserved verbatim (from headStart, not necessarily 0)
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    for (let i = headStart; i < headEnd && i < messages.length; i++) {
      const msg = messages[i];
      const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
      const tokens = msgCap > 0 ? Math.min(store.estimateTokens(msg), msgCap + 50) : store.estimateTokens(msg);
      // The head is verbatim by definition — truncating it mid-window drops
      // messages no summary covers. Refuse honestly beyond grace.
      if (totalTokens + tokens > graceLimit) {
        throw new OverBudgetError({
          budget: graceLimit,
          actual: totalTokens + tokens,
          diagnostics: {
            headTokens: totalTokens + tokens,
            tailTokens: 0,
            middleTokens: 0,
            middleChunkCount: 0,
            deepestLevel: 0,
          },
        });
      }

      entries.push({
        index: entries.length,
        sourceMessageId: msg.id,
        sourceRelation: 'copy',
        participant: msg.participant,
        content,
      });
      totalTokens += tokens;
      this.rsRaw('head', tokens);
    }
    // Mark the last head entry as a cache boundary (even if budget truncated the window)
    if (entries.length > 0) {
      entries[entries.length - 1].cacheMarker = true;
    }

    // Compute recent window exclusion set (also exclude head window messages)
    const recentStart = this.getRecentWindowStart(store);
    // The tail actually emitted below starts at max(recentStart, headEnd) —
    // when the recent window reaches back INTO or PAST the head window, the
    // region walks must bound the middle by this, not raw recentStart, or
    // [0, headStart) falls in neither region (head-reset drop, 2026-07-26).
    const effectiveRecentStart = Math.max(recentStart, headEnd);
    const excludeIds = new Set<string>();
    for (let i = headStart; i < headEnd; i++) excludeIds.add(messages[i].id);
    for (let i = recentStart; i < messages.length; i++) excludeIds.add(messages[i].id);

    // Get anti-redundant summaries
    const { shownL3, shownL2, shownL1 } = this.getAntiRedundantSummaries(excludeIds);

    // Budget carryover: L3 → L2 → L1
    const l3Budget = this.config.l3BudgetTokens ?? 30000;
    const l2Budget = this.config.l2BudgetTokens ?? 30000;
    const l1Budget = this.config.l1BudgetTokens ?? 30000;

    const selectedSummaries: SummaryEntry[] = [];
    let totalSummaryTokens = 0;

    // Phase 1: L3 within L3 budget
    let l3Used = 0;
    for (const s of shownL3) {
      if (l3Used + s.tokens > l3Budget) break;
      if (this.isOverBudget(totalTokens + totalSummaryTokens + s.tokens, maxTokens)) break;
      selectedSummaries.push(s);
      l3Used += s.tokens;
      totalSummaryTokens += s.tokens;
    }
    const l3Carryover = l3Budget - l3Used;

    // Phase 2: L2 within (L2 budget + carryover)
    let l2Used = 0;
    const l2Effective = l2Budget + l3Carryover;
    for (const s of shownL2) {
      if (l2Used + s.tokens > l2Effective) break;
      if (this.isOverBudget(totalTokens + totalSummaryTokens + s.tokens, maxTokens)) break;
      selectedSummaries.push(s);
      l2Used += s.tokens;
      totalSummaryTokens += s.tokens;
    }
    const l2Carryover = l2Effective - l2Used;

    // Phase 3: L1 within (L1 budget + carryover)
    const l1Effective = l1Budget + l2Carryover;
    const l1Remaining = maxTokens - totalTokens - totalSummaryTokens;
    const { selected: l1Selected, tokensUsed: l1Used } = this.selectL1Summaries(
      shownL1, l1Effective, l1Remaining
    );
    selectedSummaries.push(...l1Selected);
    totalSummaryTokens += l1Used;

    // Phase 3b: coverage repair (bug 6.9). getAntiRedundantSummaries excluded
    // an L2 (or L3) when ALL of its children were in the CANDIDATE shown-set —
    // computed before budget selection. If the budget then dropped some of
    // those children (e.g. KnowledgeStrategy's research L1 cap), the covered
    // history appears at NEITHER level: a silent memory hole. Re-include any
    // excluded L2/L3 whose children did not all make the final selection.
    // Some overlap with the children that DID survive is accepted — coverage
    // beats perfect dedup here.
    //
    // Repairs are additionally bounded by a per-level ALLOWANCE (a fraction of
    // that level's budget), not just the overall context budget. The
    // excluded-with-partially-dropped-children state only arises from a store
    // damaged mid-merge (the crash window at compressChunkHierarchical, or the
    // legacy setMergedInto index-desync). On such a store MANY L2s can be in
    // this state at once; without a cap, re-including all of them at full size
    // would starve the recent window via Phase 4's newest-first eviction. When
    // repairs exceed the allowance we stop re-including and warn — a corrupted
    // store announces itself instead of silently trading recent messages for
    // redundant summaries.
    {
      // Allowance = a fraction of the level budget, with a floor tied to the
      // overall budget so a strategy that zeroes a level budget (e.g.
      // KnowledgeStrategy prioritising L1) can still repair a handful of
      // covering summaries, while a corrupted store with dozens of them stays
      // bounded well short of the recent window.
      const REPAIR_ALLOWANCE_FRACTION = 0.25;
      const REPAIR_FLOOR_FRACTION = 0.05;
      const repairFloor = maxTokens * REPAIR_FLOOR_FRACTION;
      const l2RepairAllowance = Math.max(l2Budget * REPAIR_ALLOWANCE_FRACTION, repairFloor);
      const l3RepairAllowance = Math.max(l3Budget * REPAIR_ALLOWANCE_FRACTION, repairFloor);
      const selectedIds = new Set(selectedSummaries.map(s => s.id));
      const shownL2Ids = new Set(shownL2.map(s => s.id));
      const shownL3Ids = new Set(shownL3.map(s => s.id));
      let l2RepairTokens = 0;
      let l3RepairTokens = 0;
      let l2RepairsSkipped = 0;
      let l3RepairsSkipped = 0;
      // L2s excluded by anti-redundancy: unmerged, not in shownL2.
      for (const s of this.summaries) {
        if (s.level !== 2 || s.mergedInto || shownL2Ids.has(s.id)) continue;
        if (s.sourceIds.every(id => selectedIds.has(id))) continue; // truly redundant
        if (this.isOverBudget(totalTokens + totalSummaryTokens + s.tokens, maxTokens)) continue;
        if (l2RepairTokens + s.tokens > l2RepairAllowance) { l2RepairsSkipped++; continue; }
        selectedSummaries.push(s);
        totalSummaryTokens += s.tokens;
        l2RepairTokens += s.tokens;
        selectedIds.add(s.id);
      }
      // L3s excluded by anti-redundancy — after L2 repair, so a repaired L2
      // counts as selected coverage for its parent L3.
      for (const s of this.summaries) {
        if (s.level !== 3 || s.mergedInto || shownL3Ids.has(s.id)) continue;
        if (s.sourceIds.every(id => selectedIds.has(id))) continue;
        if (this.isOverBudget(totalTokens + totalSummaryTokens + s.tokens, maxTokens)) continue;
        if (l3RepairTokens + s.tokens > l3RepairAllowance) { l3RepairsSkipped++; continue; }
        selectedSummaries.push(s);
        totalSummaryTokens += s.tokens;
        l3RepairTokens += s.tokens;
        selectedIds.add(s.id);
      }
      if (l2RepairsSkipped > 0 || l3RepairsSkipped > 0) {
        console.warn(
          `[AutobiographicalStrategy] coverage-repair allowance exceeded — ` +
          `skipped ${l2RepairsSkipped} L2 and ${l3RepairsSkipped} L3 re-inclusions ` +
          `(store likely corrupted mid-merge). Some covered history may render at ` +
          `no summary level this pass.`,
        );
      }
    }

    // Emit summaries + pinned messages between head and recent windows.
    //
    // Default (positionedRecallPairs=true): one Q/A pair per summary,
    // interleaved with raw pinned messages, all sorted chronologically by
    // source-range / message position. Each memory appears in its temporal
    // place rather than as a wall of unrelated recollections.
    //
    // Legacy (positionedRecallPairs=false): summaries concatenated into one
    // Q/A pair between head and tail; pinned messages still emit raw, in
    // their chronological positions, after the combined recall pair.
    const positionOf = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      positionOf.set(messages[i].id, i);
    }
    const pinnedPositionsSet = this.pinnedPositions(messages);
    // Pinned messages between head and recent (head/recent pinned ones
    // already emit raw via Phase 0 / Phase 4).
    const pinnedInMiddle: { msg: StoredMessage; position: number }[] = [];
    const pinnedIdsInMiddle = new Set<string>();
    // The middle is everything before the recent window that is not the LIVE
    // head window — including [0, headStart) after a head-window reset, which
    // is compressible-but-often-unsummarized history, not head.
    const inLiveHead = (i: number): boolean => i >= headStart && i < headEnd;
    for (let i = 0; i < effectiveRecentStart && i < messages.length; i++) {
      if (inLiveHead(i)) continue;
      if (pinnedPositionsSet.has(i)) {
        pinnedInMiddle.push({ msg: messages[i], position: i });
        pinnedIdsInMiddle.add(messages[i].id);
      }
    }

    // Uncompressed-chunk fallback: messages in the middle region whose
    // chunk hasn't been summarized yet. Without this, a message that
    // rolled out of the recent window into a queued-but-not-yet-compressed
    // chunk would vanish from rendered context — there'd be no summary to
    // emit (compression hasn't run) and Phase 4 only walks recentStart
    // onwards. Mirrors selectLegacy's "Uncompressed: emit raw" behavior
    // around line 738, but here we interleave chronologically with
    // summaries and pins via the unified items list below.
    //
    // This matters because compile() was made non-blocking in commit
    // `3e42e98` (drops the prior `await readiness.pendingWork`); without
    // this fallback, the trade was silent data-loss for messages caught
    // in the queued-but-not-yet-compressed window. Now compile()'s
    // freshness contract is: summaries may lag the very latest L1, but
    // no message ever disappears.
    const uncompressedInMiddle: { msg: StoredMessage; position: number }[] = [];
    for (const chunk of this.chunks) {
      if (chunk.compressed) continue;
      for (const msg of chunk.messages) {
        const pos = positionOf.get(msg.id);
        if (pos === undefined) continue;
        if (inLiveHead(pos) || pos >= effectiveRecentStart) continue;
        if (pinnedIdsInMiddle.has(msg.id)) continue;
        uncompressedInMiddle.push({ msg, position: pos });
      }
    }

    // Merged list of raw messages to emit in the middle region —
    // either a pin or a message whose chunk hasn't compressed yet.
    // Both render identically (raw, at their chronological position).
    const middleRaw: { msg: StoredMessage; position: number }[] = [
      ...pinnedInMiddle,
      ...uncompressedInMiddle,
    ];

    // Phase 3c: coverage completion. Selection above (budgets, anti-redundancy,
    // repair allowance) is budget-guided PREFERENCE; under the fatal coverage
    // invariant it must never become silent loss. Two residual holes remain at
    // this point:
    //  (a) a middle message whose covering summary exists but was not selected
    //      ('covered-by-unemitted-summary') — force-include the claimer;
    //  (b) a middle message in NO chunk at all — the chunker's open frontier
    //      (a chunk only closes at targetChunkTokens AND >= 4 messages; the
    //      trailing partial is deliberately never a chunk) and, after a
    //      head-window reset, the pre-headStart zone. The uncompressed-chunk
    //      fallback above walks this.chunks so it cannot see these. Render
    //      them raw until compression catches up — same freshness contract as
    //      the fallback: summaries may lag, but no message ever disappears.
    {
      const sumById = new Map(this.summaries.map(s => [s.id, s]));
      const leafCache = new Map<string, string[]>();
      const leavesOf = (s: SummaryEntry): string[] => {
        const cached = leafCache.get(s.id);
        if (cached) return cached;
        const out: string[] = [];
        const stack: string[] = [s.id];
        const seen = new Set<string>();
        while (stack.length > 0) {
          const id = stack.pop();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const sum = sumById.get(id);
          if (!sum) continue;
          if (sum.sourceLevel === 0) out.push(...sum.sourceIds);
          else stack.push(...sum.sourceIds);
        }
        leafCache.set(s.id, out);
        return out;
      };
      // Highest-level live claimer per leaf (coarsest representation is the
      // cheapest way to restore coverage). Empty summaries represent nothing.
      const claimedBy = new Map<string, SummaryEntry>();
      for (const s of this.summaries) {
        if (s.mergedInto) continue;
        if (!s.content || !s.content.trim()) continue;
        for (const leaf of leavesOf(s)) {
          const cur = claimedBy.get(leaf);
          if (!cur || s.level > cur.level) claimedBy.set(leaf, s);
        }
      }
      const covered = new Set<string>();
      for (const s of selectedSummaries) for (const leaf of leavesOf(s)) covered.add(leaf);
      const rawPlanned = new Set<string>();
      for (let i = headStart; i < headEnd && i < messages.length; i++) rawPlanned.add(messages[i].id);
      for (let i = effectiveRecentStart; i < messages.length; i++) rawPlanned.add(messages[i].id);
      for (const p of middleRaw) rawPlanned.add(p.msg.id);
      const selectedIdSet = new Set(selectedSummaries.map(s => s.id));
      for (let i = 0; i < effectiveRecentStart && i < messages.length; i++) {
        if (inLiveHead(i)) continue;
        const m = messages[i];
        if (rawPlanned.has(m.id) || covered.has(m.id)) continue;
        const claimer = claimedBy.get(m.id);
        if (claimer) {
          if (!selectedIdSet.has(claimer.id)) {
            selectedSummaries.push(claimer);
            selectedIdSet.add(claimer.id);
            for (const leaf of leavesOf(claimer)) covered.add(leaf);
            totalSummaryTokens += claimer.tokens;
          }
        } else {
          middleRaw.push({ msg: m, position: i });
          rawPlanned.add(m.id);
        }
      }
    }

    if (selectedSummaries.length > 0 || middleRaw.length > 0) {
      const summaryParticipant = this.config.summaryParticipant ?? 'Claude';

      if (this.config.positionedRecallPairs !== false) {
        // Build a unified, chronologically-sorted item list.
        type Item =
          | { kind: 'summary'; position: number; summary: SummaryEntry }
          | { kind: 'pin'; position: number; msg: StoredMessage };

        const items: Item[] = [];
        for (const s of selectedSummaries) {
          const pos = positionOf.get(s.sourceRange.first) ?? Number.MAX_SAFE_INTEGER;
          items.push({ kind: 'summary', position: pos, summary: s });
        }
        for (const p of middleRaw) {
          items.push({ kind: 'pin', position: p.position, msg: p.msg });
        }
        items.sort((a, b) => a.position - b.position);

        for (const item of items) {
          if (item.kind === 'summary') {
            const summary = item.summary;
            // Defensive: never emit a recall pair for an empty/bugged summary — an
            // empty assistant text block triggers a 400. (Production guards too,
            // but a legacy empty summary may already exist in the store.)
            if (!summary.content || !summary.content.trim()) continue;
            const headerText = this.buildRecallHeader(summary);
            const questionEntry: ContextEntry = {
              index: entries.length,
              participant: 'Context Manager',
              content: [{ type: 'text', text: headerText }],
              sourceRelation: 'derived',
            };
            const answerContent: ContentBlock[] = this.summaryAnswerContent(summary);
            const answerEntry: ContextEntry = {
              index: entries.length + 1,
              participant: summaryParticipant,
              content: msgCap > 0 ? this.truncateContent(answerContent, msgCap) : answerContent,
              sourceRelation: 'derived',
            };
            const pairTokens =
              this.estimateTokens(questionEntry.content) +
              this.estimateTokens(answerEntry.content);
            // Never silently drop a selected representation: everything in
            // this list either covers history (summaries) or IS uncovered
            // history (pins / uncompressed / frontier raw). Emit within
            // grace; refuse the turn beyond it.
            if (totalTokens + pairTokens > graceLimit) {
              throw new OverBudgetError({
                budget: graceLimit,
                actual: totalTokens + pairTokens,
                diagnostics: {
                  headTokens: 0,
                  tailTokens: 0,
                  middleTokens: totalTokens + pairTokens,
                  middleChunkCount: items.length,
                  deepestLevel: summary.level,
                },
              });
            }
            entries.push(questionEntry);
            entries.push(answerEntry);
            totalTokens += pairTokens;
            this.rsSummary(summary.level, pairTokens, summary.id);
          } else {
            const msg = item.msg;
            const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
            const tokens = msgCap > 0
              ? Math.min(store.estimateTokens(msg), msgCap + 50)
              : store.estimateTokens(msg);
            if (totalTokens + tokens > graceLimit) {
              throw new OverBudgetError({
                budget: graceLimit,
                actual: totalTokens + tokens,
                diagnostics: {
                  headTokens: 0,
                  tailTokens: 0,
                  middleTokens: totalTokens + tokens,
                  middleChunkCount: items.length,
                  deepestLevel: 0,
                },
              });
            }
            entries.push({
              index: entries.length,
              sourceMessageId: msg.id,
              sourceRelation: 'copy',
              participant: msg.participant,
              content,
            });
            totalTokens += tokens;
            this.rsRaw('middleRaw', tokens);
          }
        }
      } else {
        // Legacy combined-pair mode for summaries; pins still emit raw at
        // their positions after the combined pair.
        if (selectedSummaries.length > 0) {
          const contextLabel = this.config.summaryContextLabel ?? 'What do you remember from earlier?';

          const questionEntry: ContextEntry = {
            index: entries.length,
            participant: 'Context Manager',
            content: [{ type: 'text', text: contextLabel }],
            sourceRelation: 'derived',
          };
          // Synthesised summary turns must respect maxMessageTokens. With L1+L2+L3
          // budgets defaulting to 30k each, an unconstrained concatenation can push
          // a single assistant turn past 90k tokens, eating the inference budget
          // and starving recent messages (postmortem 2026-05-04, bug B).
          //
          // Per-summary blocks (verbatim reasoning + text when captured) are
          // concatenated with the legacy '---' separators as interstitial
          // text blocks — signed thinking must ride along here too.
          const answerContent: ContentBlock[] = [];
          selectedSummaries.forEach((s, idx) => {
            if (idx > 0) answerContent.push({ type: 'text', text: '\n\n---\n\n' });
            answerContent.push(...this.summaryAnswerContent(s));
          });
          const answerEntry: ContextEntry = {
            index: entries.length + 1,
            participant: summaryParticipant,
            content: msgCap > 0 ? this.truncateContent(answerContent, msgCap) : answerContent,
            sourceRelation: 'derived',
          };

          const pairTokens = this.estimateTokens(questionEntry.content) +
                             this.estimateTokens(answerEntry.content);

          entries.push(questionEntry);
          entries.push(answerEntry);
          totalTokens += pairTokens;
          for (const s of selectedSummaries) this.rsSummary(s.level, s.tokens, s.id);
        }

        // Sort by position so uncompressed-middle messages and pins both
        // appear in their chronological place after the combined recall pair.
        const middleRawSorted = [...middleRaw].sort((a, b) => a.position - b.position);
        for (let mi = 0; mi < middleRawSorted.length; mi++) {
          const { msg } = middleRawSorted[mi]!;
          const content = msgCap > 0 ? this.truncateContent(msg.content, msgCap) : msg.content;
          const tokens = msgCap > 0
            ? Math.min(store.estimateTokens(msg), msgCap + 50)
            : store.estimateTokens(msg);
          if (totalTokens + tokens > graceLimit) {
            // These messages are the UNCOMPRESSED middle — no summary covers
            // them (see the middleRaw construction above). Dropping them
            // removes them from the agent's context with no representation at
            // all, so beyond the grace window the select refuses the turn
            // rather than returning a plausible-looking window.
            throw new OverBudgetError({
              budget: graceLimit,
              actual: totalTokens + tokens,
              diagnostics: {
                headTokens: 0,
                tailTokens: 0,
                middleTokens: totalTokens + tokens,
                middleChunkCount: middleRawSorted.length,
                deepestLevel: 0,
              },
            });
          }
          entries.push({
            index: entries.length,
            sourceMessageId: msg.id,
            sourceRelation: 'copy',
            participant: msg.participant,
            content,
          });
          totalTokens += tokens;
          this.rsRaw('middleRaw', tokens);
        }
      }
    }

    // Phase 4: Recent uncompressed messages (skip head window overlap).
    // Newest-first eviction so that when summaries/head consume most of the
    // budget, the latest messages (the ones the agent actually needs to act
    // on) are preserved and the oldest recent-window messages are dropped.
    // Tail eviction is loss (no summary covers the recent window) — give it
    // the grace window before it records drops and the invariant refuses.
    const tailStats = this.emitRecentNewestFirst(entries, store, messages, effectiveRecentStart, msgCap, graceLimit, totalTokens);
    this.rsRaw('tail', tailStats.tokens, tailStats.messages);

    this.assertFullCoverage(entries, messages, { headStart, headEnd, recentStart: effectiveRecentStart });
    this.assertMiddleCoverage();
    this.trimOrphanedToolUse(entries);
    // Full pairing invariant over the final rendered context — catches the
    // mid-list orphans the trailing/leading trims can't (bug 6.7).
    this.enforceToolPairing(entries);
    this.pruneToolEntries(entries);
    // Strip stale images before committing stats so RenderStats.total reflects
    // the post-strip context (this path places no cache markers).
    this.applyImageStripping(entries, store);
    this.rsEnd();
    return entries;
  }

  // ============================================================================
  // Overridable hooks (for subclass customization)
  // ============================================================================

  /**
   * Build the compression instruction for an L1 chunk in the hierarchical
   * path. Override in subclasses for domain-specific prompts (e.g.,
   * phase-aware prompts in KnowledgeStrategy).
   *
   * Default returns the KV-preserving first-person instruction matching
   * the hermes-autobio spec. The doc/reading-mode variant is exposed via
   * {@link getReadingChunkInstruction}.
   */
  /**
   * As-of perspective pin: true when the chunk's messages are all strictly
   * before the agent's first own turn (witnessedBeforeSequence) — inherited
   * record, not lived experience. Drives both the L1 instruction and the
   * `witnessed` stamp on the minted summary (which merge consolidation
   * honors and propagates upward).
   */
  protected chunkIsWitnessed(chunk: Chunk): boolean {
    const pin = this.config.witnessedBeforeSequence;
    return (
      pin !== undefined &&
      chunk.messages.length > 0 &&
      chunk.messages.every((m) => {
        const seq = (m as { sequence?: number }).sequence;
        return typeof seq === 'number' && seq < pin;
      })
    );
  }

  /**
   * Append the configured identity reminder (if any) to a compression or
   * merge instruction. Applied at the two llmMessages call sites (L1 chunk
   * and merge) rather than inside the format functions so subclass
   * instruction overrides are covered too. See
   * `AutobiographicalConfig.identityReminder` for rationale (identity flip
   * over pure-witness chunks in multi-resident channels).
   */
  protected applyIdentityReminder(instruction: string): string {
    const reminder = this.config.identityReminder?.trim();
    return reminder ? `${instruction}\n\n${reminder}` : instruction;
  }

  protected getCompressionInstruction(chunk: Chunk, targetTokens: number): string {
    if (this.chunkIsWitnessed(chunk)) {
      const custom = this.config.witnessedInstruction;
      if (custom) return custom.replace('{targetTokens}', String(targetTokens));
      return formatWitnessedInstruction(targetTokens);
    }
    return formatInstruction(targetTokens);
  }

  /**
   * Build the compression instruction for an L1 chunk that is part of a
   * substantially larger sharded message (reading mode). Override in
   * subclasses if domain logic needs to vary the reading-mode prompt.
   *
   * Default returns the reading-mode instruction that asks the model to
   * reflect on what reading was like rather than form a memory "of what
   * the chunk contained", which prevents voice drift into the content
   * author's perspective.
   */
  protected getReadingChunkInstruction(
    chunk: Chunk,
    totalTokens: number,
    targetTokens: number,
  ): string {
    return formatReadingChunkInstruction(totalTokens, targetTokens);
  }

  /**
   * If the chunk is part of a substantially larger sharded message (total
   * bodyGroup tokens ≥ 2× the chunk's own tokens), return reading-context
   * metadata for the reading instruction. The 2× threshold means the
   * chunk represents a portion of something significantly larger — the
   * agent is reading, not conversing.
   *
   * Returns null when the chunk is a whole message (no bodyGroup), or
   * when bodyGroup total is < 2× chunk size (degenerate case — chunk
   * effectively IS the whole message). In those cases the standard
   * (non-reading) instruction is appropriate.
   */
  protected detectDocContext(
    chunk: Chunk,
    ctx: StrategyContext,
  ): { totalTokens: number; chunkTokens: number } | null {
    if (chunk.messages.length === 0) return null;
    const firstGroupId = chunk.messages[0].bodyGroupId;
    if (!firstGroupId) return null;
    // All messages in the chunk must share the same bodyGroupId
    for (const m of chunk.messages) {
      if (m.bodyGroupId !== firstGroupId) return null;
    }
    // Total tokens of the original message (sum of all shards in the bodyGroup).
    const allMessages = ctx.messageStore.getAll();
    let totalTokens = 0;
    for (const m of allMessages) {
      if (m.bodyGroupId === firstGroupId) {
        totalTokens += ctx.messageStore.estimateTokens(m);
      }
    }
    // Tokens in this chunk specifically.
    let chunkTokens = 0;
    for (const m of chunk.messages) {
      chunkTokens += ctx.messageStore.estimateTokens(m);
    }
    // Reading-mode threshold: the original message must be substantially
    // larger than this chunk. 2× means the chunk is at most half of the
    // whole — clearly a portion of something bigger.
    if (chunkTokens === 0 || totalTokens < 2 * chunkTokens) return null;
    return {
      totalTokens,
      chunkTokens,
    };
  }

  /**
   * Build the merge instruction for combining summaries into a higher level.
   * Override in subclasses for domain-specific merge prompts.
   *
   * Default returns the KV-preserving merge instruction. The reading-mode
   * variant (used when all leaves share a bodyGroup of substantial size)
   * is exposed via {@link getReadingMergeInstruction}.
   */
  protected getMergeInstruction(
    targetLevel: SummaryLevel,
    sources: SummaryEntry[],
    targetTokens: number
  ): string {
    const sourceLevelShown = sources.length > 0 ? Math.max(0, sources[0].level - 1) : 0;
    // Witnessed pin propagation: consolidating all-witnessed sources must keep
    // the witnessed voice, or the merge re-first-persons inherited lives.
    if (sources.length > 0 && sources.every((s) => s.witnessed)) {
      return formatWitnessedMergeInstruction(targetLevel, sourceLevelShown, targetTokens);
    }
    return formatMergeInstruction(targetLevel, sourceLevelShown, targetTokens);
  }

  /**
   * Build the reading-mode merge instruction. Used when all leaf messages
   * underlying the merge share a bodyGroup of substantial size — the agent
   * has been reading a doc rather than conversing. Override in subclasses
   * if domain logic needs to vary the reading-mode merge prompt.
   */
  protected getReadingMergeInstruction(
    targetLevel: SummaryLevel,
    sources: SummaryEntry[],
    totalTokens: number,
    targetTokens: number,
  ): string {
    const sourceLevelShown = sources.length > 0 ? Math.max(0, sources[0].level - 1) : 0;
    return formatReadingMergeInstruction(targetLevel, sourceLevelShown, totalTokens, targetTokens);
  }

  /**
   * Select L1 summaries within a budget. Returns selected summaries and tokens used.
   * Override in subclasses for asymmetric budget allocation (e.g., cap research, prioritize synthesis).
   */
  protected selectL1Summaries(
    shownL1: SummaryEntry[],
    budget: number,
    maxTokens: number
  ): { selected: SummaryEntry[]; tokensUsed: number } {
    const selected: SummaryEntry[] = [];
    let used = 0;
    for (const s of shownL1) {
      if (used + s.tokens > budget) break;
      if (this.isOverBudget(used + s.tokens, maxTokens)) break;
      selected.push(s);
      used += s.tokens;
    }
    return { selected, tokensUsed: used };
  }

  /**
   * True if `projectedTotal` exceeds `max` AND the strategy is configured
   * to enforce budget. When `enforceBudget: false`, always returns false
   * — the rendering pipeline emits the full ideal context regardless of
   * budget overage. Caller's API will reject if it exceeds the model's
   * context window; the philosophy is "surface overage, don't hide it."
   */
  protected isOverBudget(projectedTotal: number, max: number): boolean {
    if (this.config.enforceBudget === false) return false;
    return projectedTotal > max;
  }

  /**
   * Sort selected summaries by source-range start position, so per-pair
   * recall emission appears in chronological order. Falls back to the
   * created timestamp for summaries whose source-range first message is
   * no longer in the store.
   */
  protected sortSummariesChronologically(
    summaries: SummaryEntry[],
    messages: StoredMessage[],
  ): SummaryEntry[] {
    const positionOf = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      positionOf.set(messages[i].id, i);
    }
    return [...summaries].sort((a, b) => {
      const posA = positionOf.get(a.sourceRange.first) ?? Number.MAX_SAFE_INTEGER;
      const posB = positionOf.get(b.sourceRange.first) ?? Number.MAX_SAFE_INTEGER;
      if (posA !== posB) return posA - posB;
      return a.created - b.created;
    });
  }

  /**
   * Render the per-pair recall header from the configured template.
   * Substitutions: {id} {level} {first} {last}.
   */
  protected buildRecallHeader(summary: SummaryEntry): string {
    const template = this.config.recallHeaderTemplate ?? '[Recall {id}]';
    return template
      .replace(/\{id\}/g, summary.id)
      .replace(/\{level\}/g, String(summary.level))
      .replace(/\{first\}/g, summary.sourceRange.first)
      .replace(/\{last\}/g, summary.sourceRange.last);
  }

  // ============================================================================
  // Head window reset / topic transition
  // ============================================================================

  /**
   * Reset the head window to start from a new message ID.
   * Old head window messages become compressible on the next chunk rebuild.
   */
  resetHeadWindow(newStartId: string | null): void {
    this.requireLoadedBranch('resetHeadWindow');
    this.headWindowStartId = newStartId;
    this._cachedHeadStartIndex = null;
  }

  /**
   * Generate a transition summary from the current head window + top summaries.
   * Used when `/newtopic` is called without explicit context.
   */
  async generateTransitionSummary(ctx: StrategyContext): Promise<string> {
    const sourceBranch = this.requireLoadedBranch('generateTransitionSummary');
    if (!ctx.membrane) {
      throw new Error('No membrane instance for transition summary generation');
    }

    const messages = ctx.messageStore.getAll();
    const headStart = this.getHeadWindowStartIndex(ctx.messageStore);
    const headEnd = this.getHeadWindowEnd(ctx.messageStore);
    const headMessages = messages.slice(headStart, headEnd);

    // Format head content, truncated to ~2000 tokens (~8000 chars)
    const MAX_HEAD_CHARS = 8000;
    let headContent = '';
    for (const m of headMessages) {
      const entry = `${m.participant}: ${this.extractText(m.content)}`;
      if (headContent.length + entry.length > MAX_HEAD_CHARS) {
        headContent += '\n\n[...truncated...]';
        break;
      }
      headContent += (headContent ? '\n\n' : '') + entry;
    }

    // Gather top summaries for broader context
    const topSummaries = this.summaries
      .filter(s => s.level >= 2)
      .slice(-3)
      .map(s => s.content)
      .join('\n\n---\n\n');

    const instruction = [
      'Summarize the prior conversation context in 2-3 paragraphs, focusing on:',
      '- What was the original objective and what was accomplished',
      '- Key findings, decisions, and unresolved questions',
      '- Any cross-references or context that may be relevant going forward',
      '',
      'Prior context:',
      '',
      headContent,
      topSummaries ? `\nHigher-level summaries:\n${topSummaries}` : '',
      '',
      'Write a concise transition summary.',
    ].join('\n');

    const request: NormalizedRequest = {
      messages: [{ participant: 'Context Manager', content: [{ type: 'text', text: instruction }] }],
      system: 'You are forming a transition summary between conversation topics. Write concisely.',
      config: {
        model: this.requireCompressionModel(),
        maxTokens: 1500,
      },
    };

    const response = await ctx.membrane.complete(request, { formatter: this.nativeFormatter });
    if (!this.isCompressionBranchCurrent(sourceBranch)) {
      throw new Error('Transition summary crossed a branch generation; reinitialize before retrying');
    }
    // Text-only on purpose: summarizer scratch thinking is not agent history
    return response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }

  /**
   * Check if a message is a topic transition marker.
   */
  protected isTopicTransitionMessage(message: StoredMessage): boolean {
    return message.participant === 'Context Manager' &&
      message.content.some(b =>
        b.type === 'text' && (b as { type: 'text'; text: string }).text.startsWith('[Topic Transition]')
      );
  }

  /**
   * Extract plain text from content blocks.
   */
  protected extractText(content: ContentBlock[]): string {
    return content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }

  // ============================================================================
  // Shared utilities
  // ============================================================================

  /**
   * Get messages in the compressible zone: outside both head window and
   * recent window AND not inside any pinned range. Returns messages from
   * [0, headStart) ∪ [headEnd, recentStart) minus any positions covered
   * by a pin or document mark.
   */
  protected getCompressibleMessages(store: MessageStoreView): StoredMessage[] {
    const messages = store.getAll();
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = this.getRecentWindowStart(store);
    const pinned = this.pinnedPositions(messages);
    const out: StoredMessage[] = [];
    for (let i = 0; i < recentStart; i++) {
      if (i >= headStart && i < headEnd) continue;
      if (pinned.has(i)) continue;
      out.push(messages[i]);
    }
    return out;
  }

  /**
   * Rebuild the chunk list: persisted records own the past; the running-sum
   * chunker only extends at the frontier, and a chunk is only ever created
   * once it CLOSES (reaches targetChunkTokens). The trailing partial chunk
   * is never created and never compressed — eager partial-tail compression
   * minted a new near-duplicate L1 per rebuild while the tail grew (the
   * prefix-generation families found fleet-wide in the 2026-07 audit).
   */
  protected rebuildChunks(store: MessageStoreView): void {
    this.chunks = [];
    this.compressionQueue = [];

    // ---- 1. Materialize persisted records (they OWN their messages). ----
    const byId = new Map<string, StoredMessage>();
    for (const m of store.getAll()) byId.set(m.id, m);

    const consumed = new Set<string>();
    let orphaned = 0;
    for (const rec of this.chunkRecords) {
      const msgs: StoredMessage[] = [];
      for (const id of rec.sourceIds) {
        const m = byId.get(id);
        if (m) msgs.push(m);
      }
      if (msgs.length === 0) { orphaned++; continue; }
      for (const m of msgs) consumed.add(m.id);
      const chunk: Chunk = {
        index: this.chunks.length,
        startIndex: -1, // record-derived; filtered-array indices are not meaningful
        endIndex: -1,
        messages: msgs,
        tokens: msgs.reduce((sum, m) => sum + (this.config.attachmentsIgnoreSize
          ? this.estimateTextOnlyTokens(m)
          : store.estimateTokens(m)), 0),
        compressed: rec.compressed,
        summaryId: rec.summaryId,
        phaseType: rec.phaseType,
        recordId: rec.id,
      };
      this.chunks.push(chunk);
    }

    // ---- 2. Fail closed on the chain-break signature. ----
    // Most records resolving to zero live messages means message identity
    // has been rebuilt/renumbered underneath us. Chunking "fresh" ground now
    // would re-compress already-lived history into duplicate memories.
    // Halt ALL compression until an operator reconciles the store.
    if (this.chunkPersistenceEnabled && this.chunkRecords.length >= 3 &&
        orphaned / this.chunkRecords.length > 0.5) {
      this.chunkRecordsOrphaned = true;
      this.compressionQueue = [];
      if (!this._orphanWarned) {
        this._orphanWarned = true;
        console.error(
          `[autobiographical] FAIL-CLOSED: ${orphaned}/${this.chunkRecords.length} chunk ` +
          `records resolve to zero live messages (messages chain break / store ` +
          `reconciliation signature). Compression halted to prevent duplicate ` +
          `memory formation — reconcile the store before resuming.`,
        );
      }
      return;
    }
    this.chunkRecordsOrphaned = false;

    // Queue uncompressed record-backed chunks (crash-recovery: record was
    // appended but the process died before its L1 landed).
    for (const chunk of this.chunks) {
      if (!chunk.compressed && !(chunk.recordId && this._overlapBlocked.has(chunk.recordId))) {
        this.compressionQueue.push(chunk.index);
      }
    }

    // ---- 3. Chunk the frontier: compressible messages not owned by any record. ----
    const messagesToChunk = this.getCompressibleMessages(store)
      .filter(m => !consumed.has(m.id));

    let currentChunk: StoredMessage[] = [];
    let currentTokens = 0;
    let chunkFilteredStart = 0;

    // Close the running chunk over [chunkFilteredStart, endExclusive). Shared
    // by the size-based close and the subclass boundary hint below — both
    // persist the boundary identically.
    const closeCurrent = (endExclusive: number): void => {
      const chunk: Chunk = {
        index: this.chunks.length,
        startIndex: chunkFilteredStart,
        endIndex: endExclusive,
        messages: [...currentChunk],
        tokens: currentTokens,
        compressed: false,
      };
      // Persist the boundary the moment it closes — from here on this
      // span is owned and never re-keyed by config drift or restarts.
      if (this.chunkPersistenceEnabled) {
        const record: ChunkRecord = {
          id: `c-${this.chunkIdCounter++}`,
          sourceIds: chunk.messages.map(m => m.id),
          compressed: false,
        };
        this.appendChunkRecord(record);
        chunk.recordId = record.id;
      }
      this.chunks.push(chunk);
      this.compressionQueue.push(chunk.index);

      currentChunk = [];
      currentTokens = 0;
      chunkFilteredStart = endExclusive;
    };

    for (let i = 0; i < messagesToChunk.length; i++) {
      const msg = messagesToChunk[i];
      let msgTokens = store.estimateTokens(msg);

      if (this.config.attachmentsIgnoreSize) {
        msgTokens = this.estimateTextOnlyTokens(msg);
      }

      // Subclass boundary hint: close BEFORE appending `msg` when the
      // subclass marks a semantic boundary between the running chunk's last
      // message and this one (e.g. a chat-topic transition). An undersized
      // boundary chunk is deliberate — a semantic boundary outranks the size
      // target — but the chunker's minimum message count and the tool_use
      // pairing guard below still apply.
      if (
        currentChunk.length >= 4 &&
        !this.lastMessageContainsToolUse(currentChunk) &&
        this.chunkBoundaryHint(currentChunk[currentChunk.length - 1], msg, currentChunk)
      ) {
        closeCurrent(i);
      }

      currentChunk.push(msg);
      currentTokens += msgTokens;

      const shouldClose =
        currentTokens >= this.config.targetChunkTokens &&
        currentChunk.length >= 4;

      // Don't close a chunk on a message containing a tool_use block —
      // the matching tool_result lives in the immediately-following user
      // message, and the Anthropic API rejects a request where a tool_use
      // isn't immediately followed by its tool_result. Defer the close
      // by one iteration so the result rides along in the same chunk.
      // The stripUnpairedToolBlocks runtime pass is a safety net for the
      // rare case where a tool_use is the very last message in the store.
      if (shouldClose && this.lastMessageContainsToolUse(currentChunk)) {
        continue;
      }

      if (shouldClose) {
        closeCurrent(i + 1);
      }
    }

    // NOTE: no trailing-partial chunk. An unclosed chunk is not a chunk —
    // it compresses only after the running sum closes it.

    // ---- 4. L1 holdback: keep the newest X closed chunks out of the
    // speculative queue (default 1). The chunk at the live edge is the one
    // most likely to still be in motion (edits, tool-result landings, the
    // episode it belongs to still resolving); summarize it once a newer chunk
    // has closed behind it. The queue is rebuilt on every message, so a
    // held-back chunk is released automatically the moment it ages out of the
    // window. Demand overrides: a picker `produce` op (enqueueL1ForRange)
    // marks the chunk demanded, and demanded chunks are never held back —
    // when folding actually NEEDS the L1, production must not be blocked.
    const holdback = this.config.l1HoldbackChunks ?? 1;
    if (holdback > 0 && this.chunks.length > 0) {
      const cutoff = this.chunks.length - holdback;
      this.compressionQueue = this.compressionQueue.filter((idx) => {
        if (idx < cutoff) return true;
        const ch = this.chunks[idx];
        const lastId = ch?.messages[ch.messages.length - 1]?.id;
        return lastId !== undefined && this._demandedL1Chunks.has(lastId);
      });
    }
  }

  /**
   * Subclass seam consulted between two adjacent frontier messages during
   * chunking: return true to close the running chunk BEFORE `next` is
   * appended — e.g. at a conversation-topic transition — even though the
   * running sum has not reached `targetChunkTokens`. Keeping unrelated
   * topics out of one chunk keeps their summaries from being fused.
   *
   * Consulted only once the running chunk has the chunker's minimum message
   * count, and never overrides the tool_use pairing guard. The base never
   * hints, so boundaries are unchanged for strategies that don't override
   * this. Hinted closes persist chunk records exactly like size-based ones.
   */
  protected chunkBoundaryHint(
    prev: StoredMessage,
    next: StoredMessage,
    currentChunk: readonly StoredMessage[],
  ): boolean {
    void prev; void next; void currentChunk;
    return false;
  }

  /**
   * Returns true if the last message in the chunk-in-progress contains a
   * `tool_use` block. Used by `rebuildChunks` to defer chunk closure until
   * the matching `tool_result` (in the immediately-following user message)
   * is pulled into the same chunk. See `stripUnpairedToolBlocks` for the
   * runtime safety net.
   */
  protected lastMessageContainsToolUse(chunk: StoredMessage[]): boolean {
    const last = chunk[chunk.length - 1];
    if (!last) return false;
    return last.content.some((b) => b.type === 'tool_use');
  }

  protected createChunk(
    index: number,
    startIndex: number,
    endIndex: number,
    messages: StoredMessage[],
    tokens: number,
    existingCompressed: Map<string, Chunk>
  ): Chunk {
    const chunk: Chunk = {
      index,
      startIndex,
      endIndex,
      messages: [...messages],
      tokens,
      compressed: false,
    };

    const key = this.chunkKey(chunk);
    const existing = existingCompressed.get(key);
    if (existing) {
      chunk.compressed = true;
      chunk.summaryId = existing.summaryId;
    }

    // In hierarchical mode, also check if a summary exists for this chunk
    if (this.config.hierarchical && !chunk.compressed) {
      const summary = this.summaries.find(
        s => s.level === 1 && s.sourceIds.join(':') === key
      );
      if (summary) {
        chunk.compressed = true;
        chunk.summaryId = summary.id;
      }
    }

    return chunk;
  }

  protected chunkKey(chunk: Chunk): string {
    return chunk.messages.map((m) => m.id).join(':');
  }

  /** True if any content block is a live image. */
  protected hasImageBlock(content: ContentBlock[]): boolean {
    return content.some((b) => b.type === 'image');
  }

  /** Message index marking the image-strip depth boundary: walks newest→oldest
   *  summing the same per-message estimate as getRecentWindowStart, and returns
   *  the index of the first message still within `depthTokens`. Messages before
   *  this index have their images stripped to placeholders. */
  protected getImageStripStart(store: MessageStoreView, depthTokens: number): number {
    const messages = store.getAll();
    let tokens = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += store.estimateTokens(messages[i]);
      if (tokens > depthTokens) return i + 1;
    }
    return 0;
  }

  /** Text substituted for an image block once it leaves the live-image window. */
  private static readonly IMAGE_PLACEHOLDER = '[image dropped from live context]';

  /** Post-pass over compiled entries: replace image blocks with a text
   *  placeholder once they fall outside the live-image window — either deeper
   *  than `imageStripDepthTokens` from the newest message, or beyond the
   *  `maxLiveImages` most-recent images (counted newest-first). Summaries are
   *  already text, so they're naturally unaffected. The adjacent
   *  "[image attachment: <name>]" text added at ingest preserves the filename,
   *  so the placeholder itself stays terse. Reduces tokens, so it never pushes
   *  a compiled context back over budget.
   *
   *  Runs INSIDE each select path, *before* `rsEnd()` and `placeCacheMarkers`,
   *  so the committed render stats (and the cache breakpoints) describe the
   *  post-strip context. As it strips, it decrements the matching raw bucket of
   *  the in-progress render stats by the reclaimed tokens, keeping
   *  `RenderStats.total` equal to the real rendered size. */
  protected applyImageStripping(entries: ContextEntry[], store: MessageStoreView): void {
    const maxLive = this.config.maxLiveImages ?? 0;             // 0 = unlimited count
    const depthTokens = this.config.imageStripDepthTokens ?? 0; // 0 = no depth strip
    const maxLiveBytes = this.config.maxLiveImageBytes ?? AutobiographicalStrategy.DEFAULT_MAX_LIVE_IMAGE_BYTES;
    if (maxLive === 0 && depthTokens === 0 && maxLiveBytes === 0) return; // policy disabled

    const messages = store.getAll();
    const posById = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) posById.set(messages[i].id, i);
    const stripStart = depthTokens > 0 ? this.getImageStripStart(store, depthTokens) : 0;

    // Same region windows select() bucketed by, so a stripped image's reclaimed
    // tokens come back out of the bucket it was originally tallied into.
    const headStart = this.getHeadWindowStartIndex(store);
    const headEnd = this.getHeadWindowEnd(store);
    const recentStart = Math.max(this.getRecentWindowStart(store), headEnd);
    const bucketAt = (pos: number): 'head' | 'tail' | 'middleRaw' => {
      if (pos < 0) return 'middleRaw'; // no resolvable region — keep total == Σbuckets
      if (pos >= headStart && pos < headEnd) return 'head';
      if (pos >= recentStart) return 'tail';
      return 'middleRaw';
    };
    const placeholderTokens = Math.ceil(AutobiographicalStrategy.IMAGE_PLACEHOLDER.length / 4);

    // Image-bearing entries, newest-first by source position. Entries with no
    // resolvable source position sort last (pos -1) and never count as "live".
    const ordered = entries
      .map((entry, idx) => ({
        idx,
        pos: entry.sourceMessageId !== undefined ? posById.get(entry.sourceMessageId) ?? -1 : -1,
      }))
      .filter(({ idx }) => this.hasImageBlock(entries[idx].content))
      .sort((a, b) => b.pos - a.pos);

    let keptImages = 0;
    let keptImageBytes = 0;
    for (const { idx, pos } of ordered) {
      const entry = entries[idx];
      const tooDeep = depthTokens > 0 && (pos < 0 || pos < stripStart);
      const bucket = bucketAt(pos);
      entry.content = entry.content.map((block) => {
        if (block.type !== 'image') return block;
        const blockBytes = AutobiographicalStrategy.imageBlockBytes(block);
        const overCount = maxLive > 0 && keptImages >= maxLive;
        const overBytes = maxLiveBytes > 0 && keptImageBytes + blockBytes > maxLiveBytes;
        if (tooDeep || overCount || overBytes) {
          // Stats-neutral (2026-07-12): every budgeting site now tallies at
          // POST-STRIP prices (see postStripEstimates), so the bucket never
          // charged this image at full weight — reclaiming here would
          // double-decrement. The strip pass only swaps the block.
          void bucket;
          void placeholderTokens;
          return { type: 'text', text: AutobiographicalStrategy.IMAGE_PLACEHOLDER } as ContentBlock;
        }
        keptImages++;
        keptImageBytes += blockBytes;
        return block;
      });
    }
  }

  /**
   * Post-strip token estimate per message index (2026-07-12 tail-starvation
   * fix). Mirrors `applyImageStripping`: an image beyond the `maxLiveImages`
   * newest (counted newest-first) or deeper than `imageStripDepthTokens` of
   * raw estimate from the live end renders as a placeholder — so every place
   * that BUDGETS messages (recent-window walk-back, head/tail sums, middle
   * chunk sizes) must cost it as one. Pricing stripped images at their full
   * estimate collapsed an image-dense tail to a fraction of its configured
   * size (42k rendered of a 120k window), and pricing them post-strip in the
   * walk-back alone made the picker's raw-priced tail overflow the budget
   * (318k) — the estimate must be consistent EVERYWHERE.
   */
  protected postStripEstimates(store: MessageStoreView): number[] {
    const messages = store.getAll();
    const out = new Array<number>(messages.length);
    const stripDepth = this.config.imageStripDepthTokens ?? 0;
    const maxLive = this.config.maxLiveImages ?? 0;
    const maxLiveBytes = this.config.maxLiveImageBytes ?? AutobiographicalStrategy.DEFAULT_MAX_LIVE_IMAGE_BYTES;
    const stripActive = stripDepth > 0 || maxLive > 0 || maxLiveBytes > 0;
    const placeholderTokens = Math.ceil(AutobiographicalStrategy.IMAGE_PLACEHOLDER.length / 4);
    let liveImagesSeen = 0;
    let liveImageBytes = 0;
    let rawDepth = 0; // raw-estimate depth from the newest message (mirrors getImageStripStart)
    for (let i = messages.length - 1; i >= 0; i--) {
      const raw = store.estimateTokens(messages[i]);
      let est = raw;
      if (stripActive) {
        for (const b of messages[i].content) {
          if (b.type !== 'image') continue;
          const bytes = AutobiographicalStrategy.imageBlockBytes(b);
          const beyondDepth = stripDepth > 0 && rawDepth > stripDepth;
          const beyondCount = maxLive > 0 && liveImagesSeen >= maxLive;
          const beyondBytes = maxLiveBytes > 0 && liveImageBytes + bytes > maxLiveBytes;
          if (beyondDepth || beyondCount || beyondBytes) {
            const imgEst = (b as { tokenEstimate?: number }).tokenEstimate ?? 1600;
            est -= Math.max(0, imgEst - placeholderTokens);
          } else {
            liveImagesSeen++;
            liveImageBytes += bytes;
          }
        }
      }
      rawDepth += raw;
      out[i] = est;
    }
    return out;
  }

  /** Byte wall default: 20MB of base64 (API total-request cap is 32MB). */
  protected static readonly DEFAULT_MAX_LIVE_IMAGE_BYTES = 20 * 1024 * 1024;

  /** Compression prompts carry head + recall frontier + raw chunk alongside
   *  their images, so they get a tighter image budget than the live window. */
  protected static readonly DEFAULT_MAX_COMPRESSION_IMAGE_BYTES = 12 * 1024 * 1024;

  /** Base64 payload size of an image block (0 for non-base64 sources). */
  protected static imageBlockBytes(b: unknown): number {
    const src = (b as { source?: { data?: string } }).source;
    return typeof src?.data === 'string' ? src.data.length : 0;
  }

  /**
   * Cap inline image bytes in a COMPRESSION prompt (2026-07-12). The main
   * window enforces `maxLiveImageBytes` through the strip policy; the
   * summarizer's raw-chunk replay had no such wall and leaned on membrane's
   * byte shed instead — which is a transport backstop, not a policy owner
   * (it fired at 27MB on a live merge). Keep images newest-first within the
   * budget; older ones become the same loud placeholder the window uses, so
   * the summarizer is told plainly that it is not seeing them.
   * Returns the number of images replaced.
   */
  protected capCompressionImageBytes(
    messages: Array<{ content: ContentBlock[] }>,
    capBytes: number,
  ): number {
    if (capBytes <= 0) return 0;
    let kept = 0;
    let dropped = 0;
    // Recurse into tool_result content: an agent that drives a shell/plotter/
    // browser carries most of its image bytes NESTED in tool results, not as
    // top-level blocks. Capping only the top level left those untouched and
    // membrane's transport shed kept firing at 27MB (2026-07-12).
    const capBlocks = (blocks: ContentBlock[]): ContentBlock[] =>
      blocks.map((b) => {
        if (b.type === 'image') {
          const bytes = AutobiographicalStrategy.imageBlockBytes(b);
          if (kept + bytes <= capBytes) {
            kept += bytes;
            return b;
          }
          dropped++;
          return { type: 'text', text: AutobiographicalStrategy.IMAGE_PLACEHOLDER } as ContentBlock;
        }
        const nested = (b as { type: string; content?: unknown }).content;
        if (b.type === 'tool_result' && Array.isArray(nested)) {
          return { ...b, content: capBlocks(nested as ContentBlock[]) } as ContentBlock;
        }
        return b;
      });
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!Array.isArray(m.content)) continue;
      m.content = capBlocks(m.content);
    }
    if (dropped > 0) {
      console.error(
        `[autobiographical] compression prompt: replaced ${dropped} older image(s) with placeholders ` +
          `to stay under the ${Math.round(capBytes / 1e6)}MB image-byte budget (kept ${Math.round(kept / 1e6)}MB, newest-first)`,
      );
    }
    return dropped;
  }

  protected getRecentWindowStart(store: MessageStoreView): number {
    const messages = store.getAll();
    const pse = this.postStripEstimates(store);
    let tokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += pse[i];
      if (tokens > this.config.recentWindowTokens) {
        let boundary = i + 1;
        // Don't split a tool_use/tool_result pair: if the message at the boundary
        // is a tool_result, include the preceding tool_use with it (retreat by 1).
        if (boundary > 0 && boundary < messages.length && this.hasToolResult(messages[boundary])) {
          boundary--;
        }
        return boundary;
      }
    }

    return 0;
  }

  /**
   * Index of the first message in the head window.
   * When headWindowStartId is set, the head window starts from that message
   * instead of message 0 — old messages before it become compressible.
   */
  protected getHeadWindowStartIndex(store: MessageStoreView): number {
    if (!this.headWindowStartId) return 0;
    const messages = store.getAll();
    // Cache to avoid repeated O(n) scans within the same select/rebuild pass
    if (this._cachedHeadStartIndex
      && this._cachedHeadStartIndex.id === this.headWindowStartId
      && this._cachedHeadStartIndex.msgCount === messages.length) {
      return this._cachedHeadStartIndex.result;
    }
    const idx = messages.findIndex(m => m.id === this.headWindowStartId);
    const result = idx >= 0 ? idx : 0;
    this._cachedHeadStartIndex = { id: this.headWindowStartId, msgCount: messages.length, result };
    return result;
  }

  /**
   * Index of the first message AFTER the head window.
   * Messages [headStart, headEnd) are preserved verbatim.
   */
  protected getHeadWindowEnd(store: MessageStoreView): number {
    if (this.config.headWindowTokens <= 0) return 0;

    const messages = store.getAll();
    const startIdx = this.getHeadWindowStartIndex(store);
    let tokens = 0;

    for (let i = startIdx; i < messages.length; i++) {
      tokens += store.estimateTokens(messages[i]);
      if (tokens > this.config.headWindowTokens) {
        let boundary = i;
        // Don't split a tool_use/tool_result pair: if the boundary message's
        // predecessor has tool_use, pull back by one so the pair stays together.
        if (boundary > startIdx && this.hasToolUse(messages[boundary - 1])) {
          boundary--;
        }
        return boundary;
      }
    }

    return messages.length;
  }

  protected hasToolUse(message: StoredMessage): boolean {
    return message.content.some(block => block.type === 'tool_use');
  }

  protected hasToolResult(message: StoredMessage): boolean {
    return message.content.some(block => block.type === 'tool_result');
  }

  /**
   * Remove trailing entries that contain tool_use without a following tool_result.
   * This prevents orphaned tool_use blocks when a budget break cuts between
   * a tool_use message and its tool_result response.
   */
  private trimOrphanedToolUse(entries: ContextEntry[]): void {
    while (entries.length > 0) {
      const last = entries[entries.length - 1];
      const hasUse = last.content.some(b => b.type === 'tool_use');
      const hasResult = last.content.some(b => b.type === 'tool_result');
      if (hasUse && !hasResult) {
        entries.pop();
      } else {
        break;
      }
    }
  }

  /** Placeholder body for a stub tool_result inserted by enforceToolPairing. */
  private static readonly STUB_TOOL_RESULT_TEXT =
    '[tool result unavailable — omitted during context compression]';

  /**
   * Final post-selection tool-pairing validator (bug 6.7).
   *
   * The Anthropic API requires every `tool_use` block to be answered by a
   * matching `tool_result` in the immediately-following message, and every
   * `tool_result` to answer a `tool_use` in the immediately-preceding
   * message. Selection can violate this mid-list in ways the trailing
   * (`trimOrphanedToolUse`) and leading orphan trims don't catch:
   *
   *   - a budget `break` cutting between a raw pin pair's two messages;
   *   - the uncompressed-chunk fallback emitting a raw tool_result whose
   *     tool_use chunk already compressed (or vice versa);
   *   - a recall pair or pin interleaving between a tool_use and its result.
   *
   * Repair policy prefers preserving content over dropping:
   *
   *   - a tool_use whose result is missing from the next entry first triggers
   *     a short look-ahead: if the genuine (displaced) result is a few entries
   *     down it is MOVED up into position (see
   *     {@link relocateOrDropMissingResults}); only when no real result exists
   *     is a STUB tool_result emitted. Either way the result block is merged
   *     into the next entry when that entry already carries results for this
   *     cycle, or inserted as a new user entry;
   *   - a tool_result whose tool_use is not in the immediately-preceding
   *     entry (and was not relocated) is dropped — there is no safe way to
   *     stub a tool_use, so the result's information content survives only if
   *     its use is adjacent; an entry left empty is replaced with a
   *     placeholder text block.
   *
   * Runs as a structural pass over the rendered context in BOTH render
   * paths — `selectHierarchical` (downstream of `selectL1Summaries`, so
   * subclass overrides like KnowledgeStrategy are covered) and
   * `selectAdaptive` (the path FKM defaults onto). It's a no-op on
   * already-valid output.
   */
  protected enforceToolPairing(entries: ContextEntry[]): void {
    let prevUseIds = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // --- Rule A: every tool_result must answer a tool_use in the
      // immediately-preceding entry (and only once). Drop orphans/dupes. ---
      if (entry.content.some(b => b.type === 'tool_result')) {
        const seen = new Set<string>();
        const filtered = entry.content.filter(b => {
          if (b.type !== 'tool_result') return true;
          if (!prevUseIds.has(b.toolUseId) || seen.has(b.toolUseId)) return false;
          seen.add(b.toolUseId);
          return true;
        });
        if (filtered.length !== entry.content.length) {
          entry.content = filtered.length > 0
            ? filtered
            : [{ type: 'text', text: '[tool call omitted]' }];
        }
      }

      // --- Rule B: every tool_use in the PREVIOUS entry must be answered
      // by this entry. Stub any that aren't. ---
      if (prevUseIds.size > 0) {
        const answered = new Set<string>();
        for (const b of entry.content) {
          if (b.type === 'tool_result') answered.add(b.toolUseId);
        }
        const missing = [...prevUseIds].filter(id => !answered.has(id));
        if (missing.length > 0) {
          // Look-ahead relocation: the genuine result for a "missing" id is
          // often sitting a few entries down, displaced by an interleaved
          // recall pair / pin (it will otherwise be dropped as an orphan by
          // Rule A when we reach it). Move the real block up into position and
          // only stub the ids for which no real result exists — so tool output
          // is preserved, not silently replaced by a placeholder.
          const results = this.relocateOrDropMissingResults(entries, i, missing);
          if (answered.size > 0) {
            // This entry already carries results for the cycle — prepend the
            // relocated/stub results so all results for the preceding tool_use
            // sit together (the API wants tool_result blocks at the head of
            // the message).
            entry.content = [...results, ...entry.content];
          } else {
            // Not a results entry at all — insert a synthetic user entry
            // between the tool_use entry and this one.
            entries.splice(i, 0, {
              index: i,
              participant: 'user',
              sourceRelation: 'derived',
              content: results,
            });
            // The stub entry (no tool_use blocks) is now at index i; the
            // current entry moved to i+1 and is re-processed next iteration
            // with an empty prevUseIds (its orphan results, if any, were
            // already filtered above and none survived — Rule A matched
            // against the same prevUseIds and answered.size === 0).
            prevUseIds = new Set();
            continue;
          }
        }
      }

      prevUseIds = new Set();
      for (const b of entry.content) {
        if (b.type === 'tool_use') prevUseIds.add(b.id);
      }
    }

    // Tail: an entry that mixes tool_use with other blocks can survive
    // trimOrphanedToolUse (which only pops pure use-without-result tails).
    if (prevUseIds.size > 0) {
      entries.push({
        index: entries.length,
        participant: 'user',
        sourceRelation: 'derived',
        content: [...prevUseIds].map(id => ({
          type: 'tool_result' as const,
          toolUseId: id,
          content: AutobiographicalStrategy.STUB_TOOL_RESULT_TEXT,
        })),
      });
    }

    // Reindex after any splices/appends.
    for (let i = 0; i < entries.length; i++) entries[i].index = i;
  }

  /**
   * For each `missing` tool_use id (a use in the preceding entry with no
   * adjacent result), return the result block to place next to it:
   *
   *   - if the genuine result exists within a short look-ahead window after
   *     `afterIndex`, MOVE it up into position (removing it from its source
   *     entry — replacing a now-empty entry with a placeholder) so the real
   *     tool output survives the repair;
   *   - otherwise emit a stub.
   *
   * tool_use ids are unique, so the single result carrying a given id is
   * unambiguously the answer to that use — relocating it cannot break any
   * other pairing. Results for `missing` ids never sit at or before
   * `afterIndex` (that entry's results are already matched), so the search
   * starts at `afterIndex + 1`.
   */
  private relocateOrDropMissingResults(
    entries: ContextEntry[],
    afterIndex: number,
    missing: string[],
  ): ContentBlock[] {
    const LOOKAHEAD = 6;
    const end = Math.min(entries.length, afterIndex + 1 + LOOKAHEAD);
    return missing.map(id => {
      for (let j = afterIndex + 1; j < end; j++) {
        const src = entries[j];
        const bi = src.content.findIndex(
          b => b.type === 'tool_result' && b.toolUseId === id,
        );
        if (bi === -1) continue;
        const real = src.content[bi];
        const rest = src.content.filter((_, k) => k !== bi);
        src.content = rest.length > 0
          ? rest
          : [{ type: 'text', text: '[tool call omitted]' }];
        return real;
      }
      return {
        type: 'tool_result',
        toolUseId: id,
        content: AutobiographicalStrategy.STUB_TOOL_RESULT_TEXT,
      } as ContentBlock;
    });
  }

  /**
   * Prune tool_use / tool_result blocks in-place:
   *  1. Truncate `tool_use.input` blocks whose serialized JSON exceeds
   *     `toolUseInputMaxTokens`.
   *  2. For each tool name, keep only the last N `tool_result` blocks
   *     per `toolResultMaxLastN`; older ones get their `content` replaced
   *     with a brief marker referencing the tool name and how many newer
   *     results exist below.
   *
   * Both passes are no-ops when the corresponding config is unset/0.
   * Pruning runs AFTER selection and orphan-trimming, so it doesn't
   * affect chunk formation or the recall/pin layout.
   */
  protected pruneToolEntries(entries: ContextEntry[]): void {
    // Pass 1: build toolUseId → toolName map and apply input truncation
    const toolUseInputCap = this.config.toolUseInputMaxTokens ?? 0;
    const toolUseIdToName = new Map<string, string>();

    for (const entry of entries) {
      for (let i = 0; i < entry.content.length; i++) {
        const block = entry.content[i];
        if (block.type !== 'tool_use') continue;
        toolUseIdToName.set(block.id, block.name);

        if (toolUseInputCap > 0) {
          const inputJson = JSON.stringify(block.input);
          const inputTokens = Math.ceil(inputJson.length / 4);
          if (inputTokens > toolUseInputCap) {
            const keys = Object.keys(block.input).slice(0, 5);
            entry.content[i] = {
              ...block,
              input: {
                _truncated: true,
                _originalTokens: inputTokens,
                _keys: keys,
              },
            };
          }
        }
      }
    }

    // Pass 2: collect tool_result occurrences per tool name, in order
    const occurrencesByTool = new Map<string, Array<{ entry: ContextEntry; blockIndex: number }>>();
    for (const entry of entries) {
      for (let i = 0; i < entry.content.length; i++) {
        const block = entry.content[i];
        if (block.type !== 'tool_result') continue;
        const toolName = toolUseIdToName.get(block.toolUseId);
        if (!toolName) continue;
        let arr = occurrencesByTool.get(toolName);
        if (!arr) {
          arr = [];
          occurrencesByTool.set(toolName, arr);
        }
        arr.push({ entry, blockIndex: i });
      }
    }

    // Pass 3: apply per-tool max-last-N
    const cfg = this.config.toolResultMaxLastN;
    if (cfg === undefined) return;

    for (const [toolName, occs] of occurrencesByTool) {
      let limit: number | undefined;
      if (typeof cfg === 'number') limit = cfg;
      else if (typeof cfg === 'object') limit = cfg[toolName];
      if (limit === undefined || limit < 0) continue;

      const excessCount = occs.length - limit;
      if (excessCount <= 0) continue;

      for (let i = 0; i < excessCount; i++) {
        const { entry, blockIndex } = occs[i];
        const orig = entry.content[blockIndex];
        if (orig.type !== 'tool_result') continue;
        const fresherCount = occs.length - i - 1;
        entry.content[blockIndex] = {
          ...orig,
          content: `[Result truncated — tool '${toolName}' has ${fresherCount} more recent result${fresherCount === 1 ? '' : 's'} below]`,
        };
      }
    }
  }

  protected isChunkOldEnough(chunk: Chunk): boolean {
    return true;
  }

  protected formatChunkForCompression(chunk: Chunk): string {
    const lines: string[] = ['<earlier_in_conversation>'];

    for (const msg of chunk.messages) {
      lines.push(`# ${msg.participant.toUpperCase()}`);
      for (const block of msg.content) {
        if (block.type === 'text') {
          lines.push(block.text);
        } else if (block.type === 'tool_use') {
          lines.push(`[Tool: ${block.name}]`);
        } else if (block.type === 'tool_result') {
          lines.push(`[Tool Result]`);
        } else if (block.type === 'image') {
          lines.push(`[Image]`);
        }
      }
      lines.push('');
    }

    lines.push('</earlier_in_conversation>');
    return lines.join('\n');
  }

  /**
   * Collapse consecutive messages from the same participant into single messages.
   * Required because Claude API rejects consecutive same-role messages.
   */
  protected collapseConsecutiveMessages(
    messages: Array<{ participant: string; content: ContentBlock[] }>
  ): Array<{ participant: string; content: ContentBlock[] }> {
    if (messages.length === 0) return [];

    const result: Array<{ participant: string; content: ContentBlock[] }> = [
      { participant: messages[0].participant, content: [...messages[0].content] },
    ];

    for (let i = 1; i < messages.length; i++) {
      const last = result[result.length - 1];
      if (messages[i].participant === last.participant) {
        // Merge: add separator then content
        last.content.push({ type: 'text', text: '\n\n---\n\n' } as ContentBlock);
        last.content.push(...messages[i].content);
      } else {
        result.push({ participant: messages[i].participant, content: [...messages[i].content] });
      }
    }

    return result;
  }

  protected estimateTextOnlyTokens(msg: StoredMessage): number {
    let tokens = 0;
    for (const block of msg.content) {
      if (block.type === 'text') {
        tokens += Math.ceil(block.text.length / 4);
      } else if (block.type === 'thinking') {
        tokens += Math.ceil(block.thinking.length / 4);
      } else if (block.type === 'tool_use') {
        tokens += Math.ceil(JSON.stringify(block.input).length / 4) + 20;
      } else if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          tokens += Math.ceil(block.content.length / 4);
        }
      }
    }
    return tokens;
  }

  protected estimateTokens(content: ContentBlock[]): number {
    let tokens = 0;
    for (const block of content) {
      if (block.type === 'text') {
        tokens += Math.ceil(block.text.length / 4);
      } else if (block.type === 'thinking') {
        // Replayed summary reasoning (responseContent) must be priced or
        // fold/recall budgets silently overrun. Mirrors message-store: a
        // stamped estimate wins; a signed-but-empty block is a hidden full
        // CoT priced at the measured default; else price the visible text.
        const stamped = (block as { tokenEstimate?: number }).tokenEstimate;
        if (typeof stamped === 'number') {
          tokens += stamped;
        } else {
          const sig = (block as { signature?: string }).signature;
          const hasSignature = typeof sig === 'string' && sig.length > 0;
          if (hasSignature && (!block.thinking || block.thinking.length === 0)) {
            tokens += MessageStore.HIDDEN_THINKING_TOKENS_DEFAULT;
          } else {
            tokens += Math.ceil((block.thinking ?? '').length / 4);
          }
        }
      } else if (block.type === 'redacted_thinking') {
        // Encrypted reasoning carrier: stamped estimate wins, else price the
        // ciphertext at the measured carrier rate (matches the store
        // estimator — see ENCRYPTED_CARRIER_CHARS_PER_TOKEN).
        const stamped = (block as { tokenEstimate?: number }).tokenEstimate;
        const data = (block as { data?: string }).data;
        if (typeof stamped === 'number') {
          tokens += stamped;
        } else if (typeof data === 'string' && data.length > 0) {
          tokens += Math.round(data.length / MessageStore.ENCRYPTED_CARRIER_CHARS_PER_TOKEN);
        } else {
          tokens += MessageStore.HIDDEN_THINKING_TOKENS_DEFAULT;
        }
      }
    }
    return tokens;
  }

  /**
   * Truncate a message's content blocks to fit within maxMessageTokens.
   */
  /**
   * Build the assistant-turn content for a replayed summary. When the
   * entry carries verbatim `responseContent` (signed thinking /
   * redacted_thinking + text in provider order), replay it unmutated —
   * Fable-5/Sonnet-5-class models require the encrypted reasoning back
   * alongside their generated text, and the signatures only verify on
   * byte-identical blocks. Fallback for legacy/stub entries: a plain
   * text block from `content`.
   *
   * Returns a fresh array so callers can never mutate the stored entry.
   */
  protected summaryAnswerContent(summary: SummaryEntry): ContentBlock[] {
    if (summary.responseContent && summary.responseContent.length > 0) {
      return [...summary.responseContent];
    }
    return [{ type: 'text', text: summary.content }];
  }

  protected truncateContent(content: ContentBlock[], maxTokens: number): ContentBlock[] {
    if (maxTokens <= 0) return content;
    const est = this.estimateTextOnlyTokens({ content } as StoredMessage);
    if (est <= maxTokens) return content;

    const maxChars = maxTokens * 4;
    const result: ContentBlock[] = [];
    let remaining = maxChars;

    for (const block of content) {
      if (block.type === 'text') {
        if (remaining <= 0) continue;
        if (block.text.length <= remaining) {
          result.push(block);
          remaining -= block.text.length;
        } else {
          result.push({
            type: 'text',
            text: safeSlice(block.text, 0, remaining) + '\n\n[truncated — original was ' +
              Math.ceil(block.text.length / 4) + ' tokens]',
          });
          remaining = 0;
        }
      } else if (block.type === 'tool_result') {
        // tool_result blocks MUST always be included — the Anthropic API requires
        // every tool_use to have a matching tool_result.  Dropping one causes a 400.
        if (typeof block.content === 'string') {
          const text = block.content;
          if (remaining <= 0) {
            // Budget exhausted — include with minimal content to preserve pairing
            result.push({
              ...block,
              content: '[content omitted — context budget exceeded]',
            });
          } else if (text.length > remaining) {
            result.push({
              ...block,
              content: safeSlice(text, 0, remaining) + '\n\n[truncated — original was ' +
                Math.ceil(text.length / 4) + ' tokens]',
            });
            remaining = 0;
          } else {
            result.push(block);
            remaining -= text.length;
          }
        } else {
          result.push(block);
        }
      } else {
        result.push(block);
      }
    }

    return result;
  }
}
